/**
 * WeCom smart-bot (智能机器人) channel adapter — the WebSocket long-connection
 * transport, distinct from the self-built-app callback transport in wecom.ts.
 *
 * Official capability (verified 2026-09 against the WeCom developer docs and
 * the official Node SDK `@wecom/aibot-node-sdk`):
 *
 *   - transport: `wss://openws.work.weixin.qq.com` (private deployments get
 *     their own URL from the admin console) — **no public callback URL needed**
 *   - credentials: bot id + secret (NOT corpId/corpSecret of a self-built app)
 *   - SDK handles auth frame, heartbeat, ack tracking and exponential-backoff
 *     reconnect; we only normalize frames and drive replies
 *   - inbound events: message.text / image / mixed / voice / file / video,
 *     event.enter_chat / template_card_event / feedback_event
 *   - outbound: `sendMessage(chatid, body)` — text / markdown / template_card
 *     (single chat: chatid = the user's userid; group chat: the group chatid)
 *
 * The SDK is an optional peer, loaded lazily (injectable for tests), so the
 * package keeps working without it.
 * @module dsh-chat-interaction/adapters/wecom-bot
 */
import fs from 'node:fs';
import path from 'node:path';
import { BaseChannel } from '../channel.js';
import { log } from '../log.js';
import { dshHome, expandHome, projStateDir, pruneOldFiles } from '../state.js';
/**
 * Resolve smart-bot credentials field by field:
 *
 *   config → credsFile → <项目>/.dsh/wecom-bot.json → ~/.dsh/wecom-bot.json
 *          → <项目>/.dsh/wecom-app.json → ~/.dsh/wecom-app.json → env
 *
 * File keys: `bot_id` / `bot_secret` (aliases: `aibot_id`, `secret`).
 * Env: `WECOM_BOT_ID` / `WECOM_BOT_SECRET`.
 */
export function resolveWeComBotCreds(cwd, cfg) {
    const candidates = [
        cfg.credsFile ? expandHome(cfg.credsFile) : '',
        path.join(projStateDir(cwd), 'wecom-bot.json'),
        path.join(dshHome(), 'wecom-bot.json'),
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
            // keep merging: wecom-bot.json may hold only bot creds while
            // wecom-app.json holds the rest — both are valid sources
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
        botId: pick(cfg.botId, ['bot_id', 'botId', 'aibot_id', 'aibotid'], ['WECOM_BOT_ID', 'WECOM_AIBOT_ID']),
        secret: pick(cfg.secret, ['bot_secret', 'botSecret', 'aibot_secret'], ['WECOM_BOT_SECRET', 'WECOM_AIBOT_SECRET']),
    };
}
// ---------------------------------------------------------------------------
// adapter
// ---------------------------------------------------------------------------
export class WeComBotChannel extends BaseChannel {
    name = 'wecom_bot';
    label = '企业微信机器人';
    capabilities = {
        cards: true,
        richText: true,
        images: true,
        inbound: true,
    };
    cfg;
    client = null;
    sdk = null;
    disposed = false;
    credsCache = null;
    constructor(cfg = {}) {
        super();
        this.cfg = cfg;
    }
    creds() {
        if (!this.credsCache)
            this.credsCache = resolveWeComBotCreds(process.cwd(), this.cfg);
        return this.credsCache;
    }
    mediaDir() {
        if (typeof this.cfg.mediaDir === 'function')
            return this.cfg.mediaDir();
        if (typeof this.cfg.mediaDir === 'string')
            return expandHome(this.cfg.mediaDir);
        return path.join(projStateDir(process.cwd()), `${this.name}-media`);
    }
    /** Lazy SDK load: injected mock or dynamic import of the official package. */
    async loadSdk() {
        if (this.sdk)
            return this.sdk;
        if (this.cfg.sdk) {
            this.sdk = this.cfg.sdk;
            return this.sdk;
        }
        const mod = (await import('@wecom/aibot-node-sdk'));
        this.sdk = {
            WSClient: mod.WSClient ?? mod.default?.WSClient,
            generateReqId: mod.generateReqId ?? mod.default?.generateReqId,
        };
        if (!this.sdk.WSClient) {
            throw new Error('WeCom smart-bot SDK not found: install @wecom/aibot-node-sdk');
        }
        return this.sdk;
    }
    async connect() {
        if (this.disposed)
            return { ok: false, connected: false, error: 'adapter disposed' };
        if (this.client)
            return { ok: true, connected: true, message: 'already connected' };
        const creds = this.creds();
        if (!creds.botId || !creds.secret) {
            return {
                ok: false,
                connected: false,
                error: 'missing bot credentials (config botId/secret, <project>/.dsh/wecom-bot.json, ' +
                    '~/.dsh/wecom-bot.json, or env WECOM_BOT_ID / WECOM_BOT_SECRET)',
            };
        }
        try {
            const sdk = await this.loadSdk();
            const client = new sdk.WSClient({
                botId: creds.botId,
                secret: creds.secret,
                ...(this.cfg.wsUrl ? { wsUrl: this.cfg.wsUrl } : {}),
                ...(this.cfg.heartbeatInterval ? { heartbeatInterval: this.cfg.heartbeatInterval } : {}),
                ...(this.cfg.reconnectInterval ? { reconnectInterval: this.cfg.reconnectInterval } : {}),
                ...(this.cfg.maxReconnectAttempts !== undefined ? { maxReconnectAttempts: this.cfg.maxReconnectAttempts } : {}),
                logger: {
                    debug: (...a) => log('debug', '[aibot]', ...a),
                    info: (...a) => log('info', '[aibot]', ...a),
                    warn: (...a) => log('warn', '[aibot]', ...a),
                    error: (...a) => log('error', '[aibot]', ...a),
                },
            });
            this.registerHandlers(client);
            client.connect();
            this.client = client;
            this.setConnected(true);
            log('info', `wecom smart-bot ws connecting (botId=${creds.botId.slice(0, 8)}...)`);
            return { ok: true, connected: true, message: '已连接企业微信智能机器人长连接' };
        }
        catch (e) {
            this.client = null;
            this.setConnected(false);
            return { ok: false, connected: false, error: e.message };
        }
    }
    async disconnect() {
        const client = this.client;
        this.client = null;
        this.setConnected(false);
        if (!client)
            return { ok: true, connected: false, message: '本来就没有连接' };
        try {
            if (typeof client.disconnect === 'function')
                client.disconnect();
            else if (typeof client.close === 'function')
                client.close();
            else
                log('warn', 'aibot client has no disconnect()/close()');
        }
        catch (e) {
            log('warn', 'aibot disconnect failed:', e.message);
        }
        return { ok: true, connected: false, message: '已断开企业微信智能机器人长连接' };
    }
    status() {
        return {
            ok: true,
            connected: this.isConnected,
            message: this.isConnected ? 'connected (ws long connection)' : 'not connected (默认不连; 用户明确要求时才连接)',
        };
    }
    registerHandlers(client) {
        const on = (event, handler) => {
            try {
                client.on(event, handler);
            }
            catch (e) {
                log('warn', `aibot client.on(${event}) failed:`, e.message);
            }
        };
        on('authenticated', () => {
            this.setConnected(true);
            log('info', 'wecom smart-bot authenticated');
        });
        on('disconnected', () => {
            this.setConnected(false);
            log('warn', 'wecom smart-bot disconnected');
        });
        on('error', (frame) => log('error', 'wecom smart-bot error:', JSON.stringify(frame).slice(0, 300)));
        on('message', (frame) => {
            void this.normalizeMessage(frame).then((msg) => { if (msg)
                this.emit(msg); });
        });
        on('event.template_card_event', (frame) => {
            const msg = this.normalizeCardEvent(frame);
            if (msg)
                this.emit(msg);
        });
        // enter_chat / feedback_event are not agent turns
        on('event.enter_chat', () => { });
        on('event.feedback_event', () => { });
    }
    /** chatid is present for group chats; single chats address the userid. */
    chatIdOf(body) {
        const chatType = String(body.chattype || '');
        if (chatType === 'group')
            return String(body.chatid || '');
        return String(body.from?.userid || body.chatid || '');
    }
    async normalizeMessage(frame) {
        const body = (frame.body || {});
        const chatId = this.chatIdOf(body);
        if (!chatId) {
            log('warn', 'wecom smart-bot message without chat id; dropped');
            return null;
        }
        const msgType = String(body.msgtype || 'text');
        const imagePaths = [];
        const imageErrors = [];
        if (msgType === 'image' || (msgType === 'mixed' && body.image)) {
            const url = String(body.image?.url || '');
            const aesKey = body.image?.aeskey ? String(body.image.aeskey) : undefined;
            if (url) {
                const local = await this.downloadImage(url, aesKey);
                if (local)
                    imagePaths.push(local);
                else
                    imageErrors.push(`${url.slice(-12)}: 图片下载/解密失败`);
            }
        }
        const text = this.textOf(msgType, body);
        return {
            channel: this.name,
            chatId,
            chatType: String(body.chattype) === 'group' ? 'group' : 'p2p',
            messageId: String(body.msgid || ''),
            messageType: msgType,
            senderId: String(body.from?.userid || ''),
            text,
            isCardAction: false,
            isBotMentioned: false, // the smart bot is addressed directly
            imagePaths,
            imageErrors,
            timestamp: body.create_time ? String(body.create_time) : '',
            raw: frame,
        };
    }
    textOf(msgType, body) {
        switch (msgType) {
            case 'text':
                return String(body.text?.content || '');
            case 'mixed': {
                const parts = [];
                if (body.text?.content)
                    parts.push(String(body.text.content));
                if (body.image)
                    parts.push('[图片]');
                return parts.join(' ') || '[图文消息]';
            }
            case 'image':
                return '[图片]';
            case 'voice':
                return '[语音消息]';
            case 'file':
                return `[文件] ${body.file?.filename || ''}`.trim();
            case 'video':
                return '[视频消息]';
            default:
                return body.text?.content ? String(body.text.content) : `[${msgType}消息]`;
        }
    }
    normalizeCardEvent(frame) {
        const body = (frame.body || {});
        const chatId = this.chatIdOf(body);
        const eventKey = String(body.event?.event_key || '');
        if (!chatId || !eventKey) {
            log('warn', 'wecom smart-bot card event without chat id / event_key; dropped');
            return null;
        }
        return {
            channel: this.name,
            chatId,
            chatType: String(body.chattype) === 'group' ? 'group' : 'p2p',
            messageId: String(body.msgid || ''),
            messageType: 'template_card_event',
            senderId: String(body.from?.userid || ''),
            text: eventKey,
            isCardAction: true,
            timestamp: body.create_time ? String(body.create_time) : '',
            raw: frame,
        };
    }
    /** Download + decrypt (AES per message) an inbound image via the SDK. */
    async downloadImage(url, aesKey) {
        const client = this.client;
        if (!client || typeof client.downloadFile !== 'function')
            return null;
        const dir = this.mediaDir();
        try {
            fs.mkdirSync(dir, { recursive: true });
            pruneOldFiles(dir, (this.cfg.mediaRetentionDays ?? 7) * 24 * 60 * 60 * 1000);
            const { buffer, filename } = await client.downloadFile(url, aesKey);
            if (!buffer || buffer.length === 0)
                return null;
            const ext = filename && path.extname(filename) ? path.extname(filename) : '.img';
            const file = path.join(dir, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`);
            fs.writeFileSync(file, buffer);
            return file;
        }
        catch (e) {
            log('warn', 'wecom smart-bot image download failed:', e.message);
            return null;
        }
    }
    // ---- outbound ---------------------------------------------------------
    async requireClient() {
        if (this.client)
            return this.client;
        const sdk = await this.loadSdk();
        const creds = this.creds();
        this.client = new sdk.WSClient({
            botId: creds.botId,
            secret: creds.secret,
            ...(this.cfg.wsUrl ? { wsUrl: this.cfg.wsUrl } : {}),
        });
        this.registerHandlers(this.client);
        this.client.connect();
        return this.client;
    }
    async send(chatId, body) {
        try {
            const client = await this.requireClient();
            const res = await client.sendMessage(chatId, body);
            if (res && typeof res.errcode === 'number' && res.errcode !== 0) {
                return { ok: false, error: `${res.errcode} ${res.errmsg || ''}`.trim() };
            }
            return { ok: true, messageId: res?.headers?.req_id ? String(res.headers.req_id) : '' };
        }
        catch (e) {
            return { ok: false, error: e.message };
        }
    }
    async sendText(chatId, text) {
        const content = String(text ?? '');
        const plain = await this.send(chatId, { msgtype: 'text', text: { content } });
        if (plain.ok)
            return plain;
        // older deployments may only accept markdown for bots
        log('warn', `wecom smart-bot text send failed (${plain.error}); retrying as markdown`);
        return this.send(chatId, { msgtype: 'markdown', markdown: { content } });
    }
    sendRichText(chatId, title, body) {
        const content = title ? `**${title}**\n\n${String(body ?? '')}` : String(body ?? '');
        return this.send(chatId, { msgtype: 'markdown', markdown: { content } });
    }
    sendCard(chatId, card) {
        const buttons = (card.buttons || []).map((b, i) => {
            if (typeof b === 'string') {
                const parts = b.split('|');
                return { value: parts[0] || '', label: parts[1] || parts[0] || '', type: (parts[2] || 'default') };
            }
            return { ...b, value: b.value || String(i) };
        });
        const taskId = `task_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        return this.send(chatId, {
            msgtype: 'template_card',
            template_card: {
                card_type: 'button_interaction',
                main_title: { title: String(card.title || '').slice(0, 64) },
                ...(card.body ? { sub_title_text: String(card.body).slice(0, 1000) } : {}),
                button_list: buttons.map((b) => ({
                    text: String(b.label || b.value).slice(0, 10),
                    style: b.type === 'danger' ? 2 : 1,
                    key: String(b.value).slice(0, 128),
                })),
                task_id: taskId,
            },
        });
    }
    dispose() {
        this.disposed = true;
        void this.disconnect();
        super.dispose();
    }
}
/** Convenience factory. */
export function createWeComBotChannel(cfg = {}) {
    return new WeComBotChannel(cfg);
}
