/**
 * Feishu (Lark) channel adapter — a typed port of the dsh-feishu plugin's
 * in-process WS listener + API replier.
 *
 *  - inbound: `im.message.receive_v1` + `card.action.trigger` via WSClient;
 *    card clicks rebuild the sent card in place and synthesize a message
 *    event (the click becomes an ordinary [飞书卡片点击] user turn)
 *  - images: downloaded to `<project>/.dsh/feishu-media/` so the agent can
 *    read them with read_image; failures land in `imageErrors`, never block
 *    the message
 *  - outbound: text / post / interactive card via the Lark Client API;
 *    sent cards are stashed (message_id-keyed) so clicks can rebuild them
 *
 * The Lark SDK is lazy-loaded (`@larksuiteoapi/node-sdk`, optional peer), so
 * the package builds and tests run without it; `connect()`/`send*()` only
 * need it at runtime. Tests may inject a mock SDK via `config.sdk`.
 * @module dsh-chat-interaction/adapters/feishu
 */
import fs from 'node:fs';
import path from 'node:path';
import { BaseChannel } from '../channel.js';
import { log, sdkLogger } from '../log.js';
import { dshHome, expandHome, projStateDir, pruneOldFiles } from '../state.js';
const DOC_LINK_RE = /https?:\/\/[a-z0-9-]+\.(?:feishu\.cn|larksuite\.com)\/(?:docx|wiki|docs\/doccn)\/([A-Za-z0-9]+)/g;
/** Extract Feishu doc/wiki links from text. */
export function extractDocIds(text) {
    const matches = [];
    let m;
    while ((m = DOC_LINK_RE.exec(text)) !== null) {
        matches.push({ url: m[0], docId: m[1] });
    }
    DOC_LINK_RE.lastIndex = 0;
    return matches;
}
/** Flatten text/post content into plain text. */
export function parseContent(msgType, rawContent) {
    try {
        const parsed = JSON.parse(rawContent);
        if (msgType === 'text')
            return String(parsed.text || '');
        if (msgType === 'post') {
            const lines = [];
            const title = parsed.title;
            if (title)
                lines.push(String(title));
            for (const line of parsed.content || []) {
                for (const seg of line || []) {
                    if (seg.tag === 'text')
                        lines.push(String(seg.text || ''));
                    if (seg.tag === 'a')
                        lines.push(String(seg.href || ''));
                }
            }
            return lines.join(' ');
        }
        return rawContent;
    }
    catch {
        return rawContent;
    }
}
export function extractMentions(msg) {
    const out = [];
    for (const m of msg.mentions || []) {
        const id = (m?.id || {});
        out.push({
            key: String(m?.key || ''),
            openId: String(id.open_id || ''),
            name: String(m?.name || ''),
        });
    }
    return out;
}
/** Extract image references from image / media / post message contents. */
export function extractImageRefs(msgType, rawContent) {
    const refs = [];
    try {
        const parsed = JSON.parse(rawContent || '{}');
        if (msgType === 'image' && parsed.image_key) {
            refs.push({ key: String(parsed.image_key), type: 'image', name: '' });
        }
        else if (msgType === 'media' && typeof parsed.mime_type === 'string' && parsed.mime_type.startsWith('image/')) {
            refs.push({ key: String(parsed.file_key || ''), type: 'file', name: String(parsed.file_name || '') });
        }
        else if (msgType === 'post') {
            for (const line of parsed.content || []) {
                if (!Array.isArray(line))
                    continue;
                for (const seg of line) {
                    if (seg && seg.tag === 'img' && seg.image_key) {
                        refs.push({ key: String(seg.image_key), type: 'image', name: '' });
                    }
                }
            }
        }
    }
    catch { /* malformed content */ }
    return refs.filter((r) => r.key);
}
/** Magic-number sniffing → extension (with dot); '' when unknown. */
function sniffExt(buf) {
    if (!buf || buf.length < 12)
        return '';
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47)
        return '.png';
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff)
        return '.jpg';
    if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46)
        return '.gif';
    if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP')
        return '.webp';
    return '';
}
async function downloadImage(apiClient, messageId, ref, mediaDir, index, timeoutMs) {
    const url = '/open-apis/im/v1/messages/' + encodeURIComponent(messageId) + '/resources/' + encodeURIComponent(ref.key);
    const resp = (await apiClient.request({
        method: 'GET',
        url,
        params: { type: ref.type },
        responseType: 'arraybuffer',
        timeout: timeoutMs,
    }));
    const buf = Buffer.isBuffer(resp) ? resp : Buffer.from(resp);
    if (!buf || buf.length === 0)
        throw new Error('空响应体');
    if (buf[0] === 0x7b) {
        let reason = '接口返回错误';
        try {
            const j = JSON.parse(buf.toString('utf8'));
            const m = (j && (j.msg || j.message)) || '';
            if (m)
                reason = m;
            if (j && j.code)
                reason = 'code ' + j.code + ': ' + reason;
        }
        catch { /* keep default */ }
        throw new Error(reason);
    }
    const ext = sniffExt(buf) || '.img';
    const file = path.join(mediaDir, messageId + '-' + index + ext);
    fs.writeFileSync(file, buf);
    return file;
}
/** Rebuild a clicked card: original header + body, button row replaced by the choice. */
export function buildUpdatedCard(cardStoreDir, messageId, choice) {
    if (!messageId)
        return null;
    let stored;
    try {
        stored = JSON.parse(fs.readFileSync(path.join(cardStoreDir, messageId + '.json'), 'utf8'));
    }
    catch {
        return null;
    }
    const buttons = stored.buttons || [];
    let label = choice;
    for (const b of buttons) {
        if (b.value === choice) {
            label = b.label || choice;
            break;
        }
    }
    const elements = [];
    if (stored.body && String(stored.body).trim()) {
        elements.push({ tag: 'div', text: { tag: 'lark_md', content: stored.body } });
    }
    elements.push({ tag: 'hr' });
    elements.push({ tag: 'div', text: { tag: 'lark_md', content: '**✅ 已选择:** ' + label } });
    return {
        config: { wide_screen_mode: true, update_multi: true },
        header: { title: { tag: 'plain_text', content: stored.title || '' }, template: 'blue' },
        elements,
    };
}
/** Resolve Feishu credentials: config → explicit file → project → home → env. */
export function resolveFeishuCreds(cwd, cfg) {
    if (cfg.appId && cfg.appSecret)
        return { appId: String(cfg.appId), appSecret: String(cfg.appSecret) };
    const candidates = [
        cfg.credsFile ? expandHome(cfg.credsFile) : '',
        path.join(projStateDir(cwd), 'feishu-app.json'),
        path.join(dshHome(), 'feishu-app.json'),
    ];
    for (const f of candidates) {
        if (!f)
            continue;
        try {
            if (fs.existsSync(f)) {
                const j = JSON.parse(fs.readFileSync(f, 'utf8'));
                if (j.app_id && j.app_secret)
                    return { appId: String(j.app_id), appSecret: String(j.app_secret) };
            }
        }
        catch { /* try next */ }
    }
    return { appId: process.env.FEISHU_APP_ID || '', appSecret: process.env.FEISHU_APP_SECRET || '' };
}
function normalizeNewlines(text) {
    return text.replace(/\\n/g, '\n');
}
function buildPostContent(title, body) {
    const lines = body.split('\n');
    const content = [];
    for (const line of lines) {
        if (line === '')
            content.push([{ tag: 'text', text: ' ' }]);
        else
            content.push([{ tag: 'text', text: line }]);
    }
    return JSON.stringify({ zh_cn: { title, content } });
}
/** Normalize `"value|label|type"` specs into ButtonSpec objects (idempotent). */
export function normalizeButtons(buttons) {
    return (buttons || []).map((b) => {
        if (typeof b === 'string') {
            const parts = b.split('|');
            return {
                value: parts[0] || '',
                label: parts[1] || parts[0] || '',
                type: (parts[2] || 'default'),
            };
        }
        return b;
    });
}
/** Build the Feishu interactive-card JSON (header + markdown body + buttons). */
export function buildCardContent(title, body, buttons) {
    const elements = [];
    if (body && String(body).trim()) {
        elements.push({ tag: 'div', text: { tag: 'lark_md', content: body } });
        elements.push({ tag: 'hr' });
    }
    const actions = [];
    for (const b of normalizeButtons(buttons)) {
        actions.push({
            tag: 'button',
            text: { tag: 'plain_text', content: b.label || b.value },
            type: b.type || 'default',
            value: { choice: b.value },
        });
    }
    if (actions.length)
        elements.push({ tag: 'action', actions });
    return JSON.stringify({
        config: { wide_screen_mode: true, update_multi: true },
        header: { title: { tag: 'plain_text', content: title || '' }, template: 'blue' },
        elements,
    });
}
// ---------------------------------------------------------------------------
// adapter
// ---------------------------------------------------------------------------
export class FeishuChannel extends BaseChannel {
    name = 'feishu';
    label = '飞书';
    capabilities = {
        cards: true,
        richText: true,
        images: true,
        inbound: true,
    };
    cfg;
    creds = null;
    lark = null;
    wsClient = null;
    apiClient = null;
    botOpenId = '';
    disposed = false;
    constructor(cfg = {}) {
        super();
        this.cfg = {
            ...cfg,
            cardStoreTtlMs: cfg.cardStoreTtlMs ?? 3 * 24 * 60 * 60 * 1000,
            mediaRetentionDays: cfg.mediaRetentionDays ?? 7,
            timeoutMs: cfg.timeoutMs ?? 30000,
        };
    }
    /** Lazy SDK: injected mock or dynamic import of @larksuiteoapi/node-sdk. */
    async loadSdk() {
        if (this.lark)
            return this.lark;
        if (this.cfg.sdk) {
            this.lark = this.cfg.sdk;
            return this.lark;
        }
        const mod = (await import('@larksuiteoapi/node-sdk'));
        this.lark = {
            WSClient: mod.WSClient ?? mod.default?.WSClient,
            Client: mod.Client ?? mod.default?.Client,
            EventDispatcher: mod.EventDispatcher ?? mod.default?.EventDispatcher,
            LoggerLevel: mod.LoggerLevel ?? mod.default?.LoggerLevel,
        };
        if (!this.lark.WSClient || !this.lark.Client || !this.lark.EventDispatcher) {
            throw new Error('Feishu SDK not found: install @larksuiteoapi/node-sdk');
        }
        return this.lark;
    }
    cardStoreDir(cwd) {
        return expandHome(this.cfg.cardStoreDir || `~/.dsh/${this.name}-cards`);
    }
    mediaDir(cwd) {
        if (typeof this.cfg.mediaDir === 'function')
            return this.cfg.mediaDir();
        if (typeof this.cfg.mediaDir === 'string')
            return expandHome(this.cfg.mediaDir);
        return path.join(projStateDir(cwd), `${this.name}-media`);
    }
    async connect() {
        if (this.disposed)
            return { ok: false, connected: false, error: 'adapter disposed' };
        if (this.wsClient)
            return { ok: true, connected: true, message: 'already connected' };
        try {
            const sdk = await this.loadSdk();
            const creds = this.resolveCreds();
            if (!creds.appId || !creds.appSecret) {
                return {
                    ok: false,
                    connected: false,
                    error: 'no Feishu credentials found (feishu-app.json chain / env FEISHU_APP_ID+FEISHU_APP_SECRET / config)',
                };
            }
            this.creds = creds;
            const logger = sdkLogger('lark');
            this.wsClient = new sdk.WSClient({
                appId: creds.appId,
                appSecret: creds.appSecret,
                loggerLevel: sdk.LoggerLevel?.error,
                logger,
            });
            // Bot's own open_id — for @-mention matching; same client downloads images.
            this.apiClient = new sdk.Client({
                appId: creds.appId,
                appSecret: creds.appSecret,
                loggerLevel: sdk.LoggerLevel?.error,
                logger,
            });
            // Discovery is best-effort: an SDK build without `request` (or a
            // failing API call) must not fail the connection itself.
            if (typeof this.apiClient.request === 'function') {
                this.apiClient.request({ method: 'GET', url: '/open-apis/bot/v3/info' })
                    .then((r) => {
                    const bot = (r.bot) || {};
                    if (bot.open_id) {
                        this.botOpenId = String(bot.open_id);
                        log('info', 'bot open_id discovered:', this.botOpenId);
                    }
                    else {
                        log('warn', 'bot open_id discovery returned no id; mention routing disabled');
                    }
                })
                    .catch((e) => log('warn', 'bot open_id discovery failed:', e.message));
            }
            else {
                log('warn', 'lark client has no request(); bot open_id discovery skipped');
            }
            const dispatcher = new sdk.EventDispatcher({ loggerLevel: sdk.LoggerLevel?.error, logger })
                .register({
                'im.message.receive_v1': (data) => {
                    void this.normalizeReceive(data)
                        .then((msg) => this.emit(msg))
                        .catch((e) => log('error', 'receive_v1 normalize failed:', e.message));
                },
                'card.action.trigger': (data) => this.handleCardAction(data),
            });
            this.wsClient.start({ eventDispatcher: dispatcher });
            this.setConnected(true);
            log('info', 'feishu ws listener started (app=' + creds.appId.slice(0, 8) + '...)');
            return { ok: true, connected: true, message: '已连接飞书 WebSocket' };
        }
        catch (e) {
            this.wsClient = null;
            this.apiClient = null;
            return { ok: false, connected: false, error: e.message };
        }
    }
    async disconnect() {
        const client = this.wsClient;
        this.wsClient = null;
        this.setConnected(false);
        if (!client)
            return { ok: true, connected: false, message: '本来就没有连接' };
        try {
            if (typeof client.close === 'function')
                client.close({ force: true });
            else
                log('warn', 'wsClient has no close() method');
        }
        catch (e) {
            log('warn', 'ws close failed:', e.message);
        }
        return { ok: true, connected: false, message: '已断开飞书 WebSocket' };
    }
    status() {
        return {
            ok: true,
            connected: this.isConnected,
            message: this.isConnected ? 'connected' : 'not connected (默认不连; 用户明确要求时才连接)',
        };
    }
    resolveCreds() {
        return resolveFeishuCreds(process.cwd(), this.cfg);
    }
    async normalizeReceive(data) {
        const msg = (data.message || {});
        const sender = (data.sender || {});
        const msgType = String(msg.message_type || 'unknown');
        const rawContent = String(msg.content || '{}');
        const text = parseContent(msgType, rawContent);
        const mentions = extractMentions({ mentions: msg.mentions });
        let botMentioned = false;
        if (this.botOpenId) {
            botMentioned = mentions.some((m) => m.openId === this.botOpenId);
        }
        // Image landing: download into <project>/.dsh/feishu-media/, attach paths.
        const imagePaths = [];
        const imageErrors = [];
        const imageRefs = extractImageRefs(msgType, rawContent);
        if (imageRefs.length && this.apiClient && typeof this.apiClient.request === 'function' && msg.message_id) {
            const mediaDir = this.mediaDir(process.cwd());
            if (mediaDir) {
                try {
                    fs.mkdirSync(mediaDir, { recursive: true });
                    pruneOldFiles(mediaDir, this.cfg.mediaRetentionDays * 24 * 60 * 60 * 1000);
                    let i = 0;
                    for (const ref of imageRefs) {
                        try {
                            const p = await downloadImage(this.apiClient, String(msg.message_id), ref, mediaDir, i, this.cfg.timeoutMs);
                            imagePaths.push(p);
                            i += 1;
                        }
                        catch (e) {
                            const err = e;
                            log('warn', 'image download failed:', ref.key, err.message);
                            imageErrors.push((ref.key || '?').slice(-8) + ': ' + err.message);
                        }
                    }
                }
                catch (e) {
                    log('error', 'image media dir setup failed:', e.message);
                }
            }
        }
        return {
            channel: this.name,
            chatId: String(msg.chat_id || ''),
            chatType: msg.chat_type === 'group' ? 'group' : msg.chat_type === 'p2p' ? 'p2p' : 'unknown',
            messageId: String(msg.message_id || ''),
            messageType: msgType,
            senderId: String((sender.sender_id || {}).user_id || ''),
            text,
            docLinks: extractDocIds(text),
            mentions: mentions.map((m) => ({ id: m.openId, name: m.name })),
            isBotMentioned: botMentioned,
            imagePaths,
            imageErrors,
            timestamp: String(msg.create_time || ''),
            raw: data,
        };
    }
    handleCardAction(data) {
        try {
            const ev = (data.event || data || {});
            const act = (ev.action || {});
            const c = (ev.context || {});
            const op = (ev.operator || {});
            const value = (act.value || {});
            const choice = String(value.choice || '');
            const chatId = String(c.open_chat_id || '');
            if (!chatId || !choice) {
                log('warn', 'card-action empty chatId or choice; data=' + JSON.stringify(data).substring(0, 300));
                return {};
            }
            // Rebuild the card so the click visibly sticks.
            const updatedCard = buildUpdatedCard(this.cardStoreDir(process.cwd()), String(c.open_message_id || ''), choice);
            const cardResponse = (toastContent) => {
                const resp = { toast: { type: 'success', content: toastContent } };
                if (updatedCard)
                    resp.card = { type: 'raw', data: updatedCard };
                return resp;
            };
            // Synthesize a message event so the agent handles the click like a typed reply.
            this.emit({
                channel: this.name,
                chatId,
                chatType: 'p2p',
                messageId: String(c.open_message_id || ''),
                messageType: 'text',
                senderId: String(op.user_id || ''),
                text: choice,
                isCardAction: true,
                timestamp: String(Date.now()),
            });
            return cardResponse('已收到: ' + choice);
        }
        catch (e) {
            log('error', 'card-action error:', e.message);
            return {};
        }
    }
    // ---- outbound ---------------------------------------------------------
    async send(chatId, text, opts = {}) {
        try {
            const api = await this.ensureApiClient();
            let msgType;
            let content;
            if (opts.cardTitle !== null && opts.cardTitle !== undefined) {
                msgType = 'interactive';
                let body = text || '';
                if (body.length > 8000)
                    body = body.substring(0, 8000) + '\n\n... (truncated)';
                content = buildCardContent(opts.cardTitle, body, opts.cardButtons || []);
            }
            else {
                let t = String(text || '');
                if (t.length > 25000)
                    t = t.substring(0, 25000) + '\n\n... (truncated)';
                if (opts.postTitle) {
                    msgType = 'post';
                    content = buildPostContent(opts.postTitle, t);
                }
                else {
                    msgType = 'text';
                    content = JSON.stringify({ text: t });
                }
            }
            const res = (await api.im.v1.message.create({
                params: { receive_id_type: 'chat_id' },
                data: { receive_id: chatId, msg_type: msgType, content },
            }));
            if (res && res.code === 0) {
                const messageId = (res.data && res.data.message_id) || '';
                if (opts.cardTitle !== null && opts.cardTitle !== undefined) {
                    this.stashCard(opts.cardTitle, text, opts.cardButtons || [], messageId);
                }
                log('info', `sent ${msgType} to ${chatId}${messageId ? ' (message_id=' + messageId + ')' : ''}`);
                return { ok: true, messageId };
            }
            const err = (res && res.msg) || JSON.stringify(res);
            log('error', 'send failed:', err);
            return { ok: false, error: String(err) };
        }
        catch (e) {
            const err = e;
            log('error', 'send threw:', err.message);
            return { ok: false, error: err.message };
        }
    }
    async ensureApiClient() {
        if (this.apiClient)
            return this.apiClient;
        const sdk = await this.loadSdk();
        const creds = this.resolveCreds();
        this.apiClient = new sdk.Client({
            appId: creds.appId,
            appSecret: creds.appSecret,
            loggerLevel: sdk.LoggerLevel?.error,
            logger: sdkLogger('lark-api'),
        });
        return this.apiClient;
    }
    stashCard(title, body, buttons, messageId) {
        if (!messageId)
            return;
        try {
            const dir = this.cardStoreDir(process.cwd());
            fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(path.join(dir, messageId + '.json'), JSON.stringify({ title, body: body || '', buttons: buttons || [] }));
            pruneOldFiles(dir, this.cfg.cardStoreTtlMs);
        }
        catch (e) {
            log('error', 'card store failed:', e.message);
        }
    }
    sendText(chatId, text) {
        return this.send(chatId, normalizeNewlines(String(text ?? '')));
    }
    sendRichText(chatId, title, body) {
        return this.send(chatId, normalizeNewlines(String(body ?? '')), { postTitle: title });
    }
    sendCard(chatId, card) {
        return this.send(chatId, normalizeNewlines(String(card.body ?? '')), {
            cardTitle: card.title,
            cardButtons: normalizeButtons(card.buttons),
        });
    }
    dispose() {
        this.disposed = true;
        void this.disconnect();
        super.dispose();
    }
}
/** Convenience factory. */
export function createFeishuChannel(cfg = {}) {
    return new FeishuChannel(cfg);
}
