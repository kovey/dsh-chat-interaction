/**
 * WeCom (企业微信) channel adapter.
 *
 * WeCom has no push WebSocket: self-built apps receive inbound events through
 * a callback URL the platform POSTs encrypted XML to. This adapter therefore
 * ships two inbound transports, both normalizing into the same
 * `InboundMessage`:
 *
 *  1. built-in node:http callback server (configure `callback.port` +
 *     `token` + `aesKey`) — URL verification, signature check and AES
 *     decryption included;
 *  2. `feed(payload)` push API — feed it the *decrypted* event XML (or an
 *     already-parsed object) from any middleware (Express / Nest / your
 *     gateway), and it does the rest.
 *
 * Outbound mirrors the Feishu adapter's surface:
 *   - sendText    text message (auto-chunked to the 2048-byte platform cap)
 *   - sendRichText markdown (group chats; falls back to text elsewhere)
 *   - sendCard    `template_card` button_interaction; task_id → chat mapping
 *                 is persisted so click events (which carry no ChatId) can be
 *                 routed back to the right chat
 *
 * Message decryption prefers the official `@wecom/crypto` package when
 * installed and falls back to a built-in implementation of the documented
 * algorithm (AES-256-CBC, PKCS7, 16-byte random prefix + 4-byte length).
 * @module dsh-chat-interaction/adapters/wecom
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import { randomUUID } from 'node:crypto';
import { BaseChannel } from '../channel.js';
import { log } from '../log.js';
import { dshHome, expandHome, projStateDir, pruneOldFiles } from '../state.js';
// ---------------------------------------------------------------------------
// message-crypto fallback (documented WeCom algorithm)
// ---------------------------------------------------------------------------
/** sha1(sort(token, timestamp, nonce, encrypt)) — the callback signature. */
export function wecomSignature(token, timestamp, nonce, encrypt) {
    const sorted = [token, timestamp, nonce, encrypt].sort().join('');
    return crypto.createHash('sha1').update(sorted, 'utf8').digest('hex');
}
/** AES-256-CBC decrypt of a WeCom payload: random16 + len4 + msg + receiveid. */
export function wecomDecrypt(aesKey, encrypt) {
    const key = Buffer.from(aesKey + '=', 'base64'); // 43 chars + padding → 32 bytes
    const iv = key.subarray(0, 16);
    const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
    decipher.setAutoPadding(false);
    const raw = Buffer.concat([decipher.update(encrypt, 'base64'), decipher.final()]);
    // strip PKCS7
    const pad = raw[raw.length - 1];
    if (pad < 1 || pad > 32)
        throw new Error('invalid pkcs7 padding');
    const unpadded = raw.subarray(0, raw.length - pad);
    const msgLen = unpadded.readUInt32BE(16);
    const message = unpadded.subarray(20, 20 + msgLen).toString('utf8');
    const id = unpadded.subarray(20 + msgLen).toString('utf8');
    return { message, id };
}
// ---------------------------------------------------------------------------
// XML (WeCom callbacks are flat XML with CDATA)
// ---------------------------------------------------------------------------
/** Parse the flat `<xml>...</xml>` the platform sends. Values may be CDATA. */
export function parseWeComXml(xml) {
    const out = {};
    // strip XML declaration + the outer <xml> wrapper
    let inner = xml.replace(/^\s*<\?xml[^>]*\?>\s*/i, '').trim();
    const wrap = /^<xml>([\s\S]*)<\/xml>$/.exec(inner);
    if (wrap)
        inner = wrap[1];
    const re = /<(\w+)>(?:(?:<!\[CDATA\[([\s\S]*?)\]\]>)|([^<]*))<\/\1>/g;
    let m;
    while ((m = re.exec(inner)) !== null) {
        out[m[1]] = m[2] !== undefined ? m[2] : String(m[3] || '').trim();
    }
    return out;
}
/**
 * Resolve WeCom credentials field by field:
 *
 *   config → credsFile → <项目>/.dsh/wecom-app.json → ~/.dsh/wecom-app.json → env
 *
 * File keys: `corp_id` / `corp_secret` / `agent_id` / `token` / `aes_key`
 * (camelCase aliases accepted). Env: `WECOM_CORP_ID` / `WECOM_CORP_SECRET` /
 * `WECOM_AGENT_ID` / `WECOM_TOKEN` / `WECOM_AES_KEY`.
 *
 * The first existing credential file wins (project overrides home); each
 * field falls back independently, so e.g. corpId can live in the file while
 * the callback token comes from the environment. Mirrors the Feishu chain.
 */
export function resolveWeComCreds(cwd, cfg) {
    const candidates = [
        cfg.credsFile ? expandHome(cfg.credsFile) : '',
        path.join(projStateDir(cwd), 'wecom-app.json'),
        path.join(dshHome(), 'wecom-app.json'),
    ];
    const fromFile = {};
    for (const f of candidates) {
        if (!f)
            continue;
        try {
            if (!fs.existsSync(f))
                continue;
            const j = JSON.parse(fs.readFileSync(f, 'utf8'));
            for (const [k, v] of Object.entries(j)) {
                if (typeof v === 'string' && v)
                    fromFile[k] = v;
                else if (typeof v === 'number' && Number.isFinite(v))
                    fromFile[k] = String(v);
            }
            break; // first existing credential file wins
        }
        catch { /* try next */ }
    }
    const pick = (cfgVal, fileKeys, envKeys) => {
        if (cfgVal !== undefined && cfgVal !== null && String(cfgVal))
            return String(cfgVal);
        for (const k of fileKeys) {
            const v = fromFile[k];
            if (v)
                return v;
        }
        for (const k of envKeys) {
            const v = process.env[k];
            if (v)
                return v;
        }
        return '';
    };
    return {
        corpId: pick(cfg.corpId, ['corp_id', 'corpId'], ['WECOM_CORP_ID', 'WECOM_CORPID']),
        corpSecret: pick(cfg.corpSecret, ['corp_secret', 'corpSecret', 'secret'], ['WECOM_CORP_SECRET']),
        agentId: pick(cfg.agentId, ['agent_id', 'agentId'], ['WECOM_AGENT_ID']),
        token: pick(cfg.token, ['token'], ['WECOM_TOKEN']),
        aesKey: pick(cfg.aesKey, ['aes_key', 'aesKey', 'encoding_aes_key'], ['WECOM_AES_KEY']),
    };
}
export class WeComChannel extends BaseChannel {
    name = 'wecom';
    label = '企业微信';
    capabilities = {
        cards: true,
        richText: true,
        images: true,
        inbound: true,
    };
    cfg;
    tokenCache = null;
    tokenPromise = null;
    server = null;
    disposed = false;
    /** chatId → 'single'|'group', learned from inbound events (single chats need touser=). */
    knownChatTypes = new Map();
    constructor(cfg = {}) {
        super();
        this.cfg = {
            ...cfg,
            taskStoreTtlMs: cfg.taskStoreTtlMs ?? 3 * 24 * 60 * 60 * 1000,
            mediaRetentionDays: cfg.mediaRetentionDays ?? 7,
            timeoutMs: cfg.timeoutMs ?? 30000,
        };
    }
    get baseUrl() {
        return this.cfg.baseUrl || 'https://qyapi.weixin.qq.com';
    }
    credsCache = null;
    /**
     * Effective credentials (config → credsFile → project/home wecom-app.json
     * → env WECOM_*), resolved lazily once per adapter instance.
     */
    creds() {
        if (!this.credsCache)
            this.credsCache = resolveWeComCreds(process.cwd(), this.cfg);
        return this.credsCache;
    }
    taskStoreDir() {
        return expandHome(this.cfg.taskStoreDir || `~/.dsh/${this.name}-tasks`);
    }
    mediaDir() {
        if (typeof this.cfg.mediaDir === 'function')
            return this.cfg.mediaDir();
        if (typeof this.cfg.mediaDir === 'string')
            return expandHome(this.cfg.mediaDir);
        return path.join(projStateDir(process.cwd()), `${this.name}-media`);
    }
    // ---- auth -------------------------------------------------------------
    async fetchJson(url, init) {
        const f = this.cfg.fetchImpl || fetch;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.cfg.timeoutMs);
        try {
            const res = await f(url, { ...(init || {}), signal: controller.signal });
            return (await res.json());
        }
        finally {
            clearTimeout(timer);
        }
    }
    /** Access token with cache + concurrent-request coalescing. */
    async getAccessToken() {
        if (this.tokenCache && Date.now() < this.tokenCache.expiresAt)
            return this.tokenCache.token;
        if (this.tokenPromise)
            return this.tokenPromise;
        const creds = this.creds();
        if (!creds.corpId || !creds.corpSecret) {
            throw new Error('wecom: missing corpId/corpSecret (set them in config, <project>/.dsh/wecom-app.json, ' +
                '~/.dsh/wecom-app.json, or env WECOM_CORP_ID / WECOM_CORP_SECRET)');
        }
        this.tokenPromise = (async () => {
            const url = `${this.baseUrl}/cgi-bin/gettoken?corpid=${encodeURIComponent(creds.corpId)}&corpsecret=${encodeURIComponent(creds.corpSecret)}`;
            const j = await this.fetchJson(url);
            if (j.errcode !== 0)
                throw new Error(`wecom gettoken failed: ${j.errcode} ${j.errmsg}`);
            const ttl = Math.max(60, (Number(j.expires_in) || 7200) - 120) * 1000;
            this.tokenCache = { token: String(j.access_token), expiresAt: Date.now() + ttl };
            log('info', 'wecom access token refreshed');
            return this.tokenCache.token;
        })().finally(() => {
            this.tokenPromise = null;
        });
        return this.tokenPromise;
    }
    async apiJson(pathname, body) {
        const token = await this.getAccessToken();
        const url = `${this.baseUrl}${pathname}?access_token=${encodeURIComponent(token)}`;
        return this.fetchJson(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
        });
    }
    // ---- outbound ---------------------------------------------------------
    /** 'single' chats need `touser`, group chats need `chatid`. */
    recipientOf(chatId) {
        return this.knownChatTypes.get(chatId) === 'single' ? { touser: chatId } : { chatid: chatId };
    }
    async sendText(chatId, text) {
        const t = String(text ?? '');
        // WeCom caps text at 2048 bytes; chunk without splitting UTF-8 pairs.
        const chunks = [];
        let rest = t;
        while (Buffer.byteLength(rest, 'utf8') > 2048) {
            let cut = 2048;
            // back off to a character boundary
            while (cut > 0 && Buffer.byteLength(rest.slice(0, cut), 'utf8') > 2048)
                cut -= 1;
            chunks.push(rest.slice(0, cut));
            rest = rest.slice(cut);
        }
        if (rest)
            chunks.push(rest);
        if (chunks.length === 0)
            chunks.push('');
        let lastId = '';
        try {
            for (const chunk of chunks) {
                const j = await this.apiJson('/cgi-bin/message/send', {
                    ...this.recipientOf(chatId),
                    msgtype: 'text',
                    text: { content: chunk },
                    ...(this.creds().agentId ? { agentid: Number(this.creds().agentId) } : {}),
                });
                if (j.errcode !== 0)
                    return { ok: false, error: `wecom send failed: ${j.errcode} ${j.errmsg}` };
                lastId = String(j.msgid || '');
            }
            return { ok: true, messageId: lastId };
        }
        catch (e) {
            return { ok: false, error: e.message };
        }
    }
    async sendRichText(chatId, title, body) {
        const content = `${title || ''}\n\n${String(body ?? '')}`.trim();
        try {
            const j = await this.apiJson('/cgi-bin/message/send', {
                ...this.recipientOf(chatId),
                msgtype: 'markdown',
                markdown: { content },
                ...(this.creds().agentId ? { agentid: Number(this.creds().agentId) } : {}),
            });
            if (j.errcode === 0)
                return { ok: true, messageId: String(j.msgid || '') };
            // markdown is only valid in some sessions → graceful text fallback
            log('warn', `wecom markdown failed (${j.errcode} ${j.errmsg}); falling back to text`);
            return this.sendText(chatId, content);
        }
        catch (e) {
            return { ok: false, error: e.message };
        }
    }
    async sendCard(chatId, card) {
        const buttons = (card.buttons || []).map((b, i) => {
            if (typeof b === 'string') {
                const parts = b.split('|');
                return { value: parts[0] || '', label: parts[1] || parts[0] || '', type: (parts[2] || 'default') };
            }
            return { ...b, value: b.value || String(i) };
        });
        const taskId = 'tsk-' + randomUUID();
        try {
            const j = await this.apiJson('/cgi-bin/message/send', {
                ...this.recipientOf(chatId),
                msgtype: 'template_card',
                template_card: {
                    card_type: 'button_interaction',
                    main_title: { title: String(card.title || '').slice(0, 20) },
                    ...(card.body ? { sub_title_text: String(card.body).slice(0, 2000) } : {}),
                    button_list: buttons.map((b) => ({
                        text: String(b.label || b.value).slice(0, 10),
                        style: b.type === 'danger' ? 2 : 1,
                        key: String(b.value).slice(0, 128),
                    })),
                    task_id: taskId,
                },
                ...(this.creds().agentId ? { agentid: Number(this.creds().agentId) } : {}),
            });
            if (j.errcode !== 0)
                return { ok: false, error: `wecom send failed: ${j.errcode} ${j.errmsg}` };
            this.stashTask(taskId, chatId, card);
            return { ok: true, messageId: taskId };
        }
        catch (e) {
            return { ok: false, error: e.message };
        }
    }
    stashTask(taskId, chatId, card) {
        try {
            const dir = this.taskStoreDir();
            fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(path.join(dir, taskId + '.json'), JSON.stringify({
                chatId,
                title: card.title,
                body: card.body || '',
                buttons: card.buttons || [],
            }));
            pruneOldFiles(dir, this.cfg.taskStoreTtlMs);
        }
        catch (e) {
            log('error', 'task store failed:', e.message);
        }
    }
    loadTask(taskId) {
        try {
            const j = JSON.parse(fs.readFileSync(path.join(this.taskStoreDir(), taskId + '.json'), 'utf8'));
            if (j.chatId)
                return { chatId: j.chatId, buttons: j.buttons || [] };
        }
        catch { /* not found */ }
        return null;
    }
    // ---- inbound ----------------------------------------------------------
    async connect() {
        if (this.disposed)
            return { ok: false, connected: false, error: 'adapter disposed' };
        if (this.server)
            return { ok: true, connected: true, message: 'callback server already running' };
        const cb = this.cfg.callback;
        if (!cb || !cb.port) {
            return {
                ok: true,
                connected: false,
                message: '未配置回调服务; 本适配器通过 feed() 接入外部回调中间件',
            };
        }
        const creds = this.creds();
        if (!creds.token || !creds.aesKey) {
            return {
                ok: false,
                connected: false,
                error: 'callback server needs token + aesKey (config / wecom-app.json / env WECOM_TOKEN + WECOM_AES_KEY)',
            };
        }
        try {
            const server = http.createServer((req, res) => {
                void this.handleCallback(req, res);
            });
            await new Promise((resolve, reject) => {
                server.once('error', reject);
                server.listen(cb.port, cb.host || '0.0.0.0', () => resolve());
            });
            this.server = server;
            this.setConnected(true);
            log('info', `wecom callback server listening on ${cb.host || '0.0.0.0'}:${cb.port}${cb.path || '/'}`);
            return { ok: true, connected: true, message: `回调服务已启动 :${cb.port}` };
        }
        catch (e) {
            return { ok: false, connected: false, error: e.message };
        }
    }
    async disconnect() {
        const server = this.server;
        this.server = null;
        this.setConnected(false);
        if (!server)
            return { ok: true, connected: false, message: '本来就没有回调服务' };
        await new Promise((resolve) => server.close(() => resolve()));
        return { ok: true, connected: false, message: '回调服务已停止' };
    }
    status() {
        return {
            ok: true,
            connected: this.isConnected,
            message: this.isConnected ? 'callback server listening' : 'not connected (默认不连; 用户明确要求时才连接)',
        };
    }
    get callbackPath() {
        return this.cfg.callback?.path || '/';
    }
    async cryptoOf() {
        if (this.cfg.cryptoModule)
            return this.cfg.cryptoModule;
        try {
            const mod = (await import('@wecom/crypto'));
            if (mod.decrypt || mod.getSignature)
                return mod;
        }
        catch { /* fall through to built-in */ }
        return { decrypt: (k, e) => wecomDecrypt(k, e), getSignature: wecomSignature };
    }
    async handleCallback(req, res) {
        const url = new URL(req.url || '/', 'http://localhost');
        if (url.pathname !== this.callbackPath) {
            res.statusCode = 404;
            res.end();
            return;
        }
        try {
            if (req.method === 'GET') {
                // URL verification: check signature, decrypt echostr, echo it back.
                const q = url.searchParams;
                const [sig, ts, nonce, echostr] = [q.get('msg_signature') || '', q.get('timestamp') || '', q.get('nonce') || '', q.get('echostr') || ''];
                if (!sig || !ts || !nonce || !echostr) {
                    res.statusCode = 400;
                    res.end('missing params');
                    return;
                }
                const cryptoMod = await this.cryptoOf();
                if (!this.verifySignature(cryptoMod, sig, ts, nonce, echostr)) {
                    res.statusCode = 403;
                    res.end('signature mismatch');
                    return;
                }
                const plain = this.decryptPayload(cryptoMod, echostr);
                res.statusCode = 200;
                res.end(plain);
                return;
            }
            if (req.method === 'POST') {
                const chunks = [];
                for await (const c of req)
                    chunks.push(c);
                const body = Buffer.concat(chunks).toString('utf8');
                const q = url.searchParams;
                const xml = parseWeComXml(body);
                const encrypt = xml.Encrypt || '';
                const sig = q.get('msg_signature') || '';
                const ts = q.get('timestamp') || '';
                const nonce = q.get('nonce') || '';
                const cryptoMod = await this.cryptoOf();
                if (!this.verifySignature(cryptoMod, sig, ts, nonce, encrypt)) {
                    log('warn', 'wecom callback signature mismatch; dropped');
                    res.statusCode = 403;
                    res.end('signature mismatch');
                    return;
                }
                const plain = this.decryptPayload(cryptoMod, encrypt);
                await this.feed(plain);
                res.statusCode = 200;
                res.end('');
                return;
            }
            res.statusCode = 405;
            res.end();
        }
        catch (e) {
            log('error', 'wecom callback error:', e.message);
            res.statusCode = 500;
            res.end('');
        }
    }
    verifySignature(cryptoMod, sig, ts, nonce, encrypt) {
        const token = this.creds().token;
        const calc = cryptoMod.getSignature
            ? cryptoMod.getSignature(token, ts, nonce, encrypt)
            : wecomSignature(token, ts, nonce, encrypt);
        return calc === sig;
    }
    decryptPayload(cryptoMod, encrypt) {
        const aesKey = this.creds().aesKey;
        const r = cryptoMod.decrypt ? cryptoMod.decrypt(aesKey, encrypt) : wecomDecrypt(aesKey, encrypt);
        return typeof r === 'string' ? r : r.message;
    }
    /**
     * Feed one decrypted event (XML string) or an already-parsed object into
     * the adapter — the integration point for external middleware.
     * Resolves with the normalized message, or null when there is nothing to emit.
     */
    async feed(payload) {
        const xml = typeof payload === 'string' ? parseWeComXml(payload) : payload;
        const msgType = xml.MsgType || '';
        const event = xml.Event || '';
        // Card click: template_card_event carries TaskId + EventKey, NOT ChatId.
        if (msgType === 'event' && event === 'template_card_event') {
            const task = this.loadTask(xml.TaskId || '');
            if (!task) {
                log('warn', 'template_card_event with unknown task_id:', xml.TaskId || '');
                return null;
            }
            const choice = xml.EventKey || '';
            let label = choice;
            for (const b of task.buttons) {
                if (b.value === choice) {
                    label = b.label || choice;
                    break;
                }
            }
            const msg = {
                channel: this.name,
                chatId: task.chatId,
                chatType: this.knownChatTypes.get(task.chatId) === 'single' ? 'p2p' : 'group',
                messageId: xml.TaskId || '',
                messageType: 'template_card_event',
                senderId: xml.FromUserName || '',
                text: choice,
                isCardAction: true,
                timestamp: xml.CreateTime || '',
                raw: xml,
            };
            log('info', `wecom card click: chat=${task.chatId} choice=${choice} (label=${label})`);
            this.emit(msg);
            return msg;
        }
        const chatId = xml.ChatId || '';
        const chatType = xml.ChatType === 'group' ? 'group' : 'single';
        if (!chatId) {
            log('warn', 'wecom event without ChatId; dropped:', msgType, event);
            return null;
        }
        if (chatType === 'group')
            this.knownChatTypes.set(chatId, 'group');
        else
            this.knownChatTypes.set(chatId, 'single');
        let text = '';
        const imagePaths = [];
        const imageErrors = [];
        if (msgType === 'text') {
            text = xml.Content || '';
        }
        else if (msgType === 'image') {
            const mediaId = xml.MediaId || '';
            const picUrl = xml.PicUrl || '';
            const local = await this.tryDownloadImage(mediaId, picUrl);
            if (local)
                imagePaths.push(local);
            else if (mediaId)
                imageErrors.push(`${mediaId.slice(-8)}: 图片下载失败`);
            text = '[图片]';
        }
        else if (msgType === 'voice') {
            text = '[语音消息]';
        }
        else if (msgType === 'file') {
            text = '[文件消息]';
        }
        else if (msgType === 'link') {
            text = `${xml.Title || '[链接]'} ${xml.Description || ''}`.trim();
        }
        else if (msgType === 'location') {
            text = `[位置] ${xml.Label || ''}`;
        }
        else if (msgType === 'event') {
            // Platform callbacks that are NOT user chat messages (contact
            // changes, batch-job results, ...) must not become agent turns —
            // only events a human triggered in this chat are interesting.
            const isUserAction = event === 'click' || event === 'view' || event === 'scancode_push';
            if (!isUserAction) {
                log('info', `wecom: ignoring non-message event "${event || 'unknown'}" in chat ${chatId} (set emitUnknownEvents to forward)`);
                if (!this.cfg.emitUnknownEvents)
                    return null;
            }
            text = `[事件: ${event}]`;
        }
        else {
            text = xml.Content || `[${msgType || '未知'}消息]`;
        }
        const msg = {
            channel: this.name,
            chatId,
            chatType: chatType === 'group' ? 'group' : 'p2p',
            messageId: xml.MsgId || '',
            messageType: msgType,
            senderId: xml.FromUserName || '',
            text,
            isCardAction: false,
            isBotMentioned: false, // WeCom app callbacks do not expose mentions
            imagePaths,
            imageErrors,
            timestamp: xml.CreateTime || '',
            raw: xml,
        };
        this.emit(msg);
        return msg;
    }
    /** Best effort: PicUrl direct fetch first, then the media API. */
    async tryDownloadImage(mediaId, picUrl) {
        const dir = this.mediaDir();
        if (!dir)
            return null;
        try {
            fs.mkdirSync(dir, { recursive: true });
            pruneOldFiles(dir, this.cfg.mediaRetentionDays * 24 * 60 * 60 * 1000);
        }
        catch {
            return null;
        }
        const target = path.join(dir, `${Date.now()}-${mediaId.slice(-12) || 'img'}.img`);
        const f = this.cfg.fetchImpl || fetch;
        const attempt = async (url) => {
            const r = await f(url, { signal: AbortSignal.timeout(this.cfg.timeoutMs) });
            if (!r.ok)
                throw new Error(`http ${r.status}`);
            const buf = Buffer.from(await r.arrayBuffer());
            if (buf.length === 0)
                throw new Error('empty image body');
            return buf;
        };
        try {
            if (picUrl) {
                const buf = await attempt(picUrl);
                fs.writeFileSync(target, buf);
                return target;
            }
        }
        catch (e) {
            log('warn', 'wecom image PicUrl download failed, trying media api:', e.message);
        }
        try {
            const token = await this.getAccessToken();
            const buf = await attempt(`${this.baseUrl}/cgi-bin/media/get?access_token=${encodeURIComponent(token)}&media_id=${encodeURIComponent(mediaId)}`);
            fs.writeFileSync(target, buf);
            return target;
        }
        catch (e) {
            log('warn', 'wecom image media download failed:', e.message);
            return null;
        }
    }
    dispose() {
        this.disposed = true;
        void this.disconnect();
        super.dispose();
    }
}
/** Convenience factory. */
export function createWeComChannel(cfg = {}) {
    return new WeComChannel(cfg);
}
