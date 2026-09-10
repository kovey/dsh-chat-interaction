import { BaseChannel } from '../channel.js';
import type { CardSpec, ListenerStatus, SendResult } from '../types.js';
export interface AiBotFrameLike {
    cmd?: string;
    headers?: {
        req_id?: string;
        [k: string]: unknown;
    };
    body?: Record<string, any>;
    errcode?: number;
    errmsg?: string;
}
export interface AiBotClientLike {
    on(event: string, listener: (frame: AiBotFrameLike) => unknown): unknown;
    connect(): unknown;
    disconnect?(): unknown;
    close?(): unknown;
    sendMessage(chatid: string, body: Record<string, unknown>): Promise<AiBotFrameLike>;
    downloadFile?(url: string, aesKey?: string): Promise<{
        buffer: Buffer;
        filename?: string;
    }>;
}
export interface AiBotSdkLike {
    WSClient: new (options: Record<string, unknown>) => AiBotClientLike;
    generateReqId?: (prefix: string) => string;
}
export interface WeComBotChannelConfig {
    /** 智能机器人 ID（企业微信后台获取）。 */
    botId?: string;
    /** 智能机器人 Secret。 */
    secret?: string;
    /** Explicit credential file JSON; default = the wecom-bot.json chain. */
    credsFile?: string;
    /** Long-connection endpoint override (private deployments). */
    wsUrl?: string;
    /** Heartbeat / reconnect tuning passed through to the SDK. */
    heartbeatInterval?: number;
    reconnectInterval?: number;
    maxReconnectAttempts?: number;
    /** Download dir for inbound images; default <项目>/.dsh/wecom_bot-media. */
    mediaDir?: string | (() => string);
    mediaRetentionDays?: number;
    /** Injectable SDK (tests / mocks). */
    sdk?: AiBotSdkLike;
}
/** Effective smart-bot credentials after the resolution chain. */
export interface WeComBotCreds {
    botId: string;
    secret: string;
}
/**
 * Resolve smart-bot credentials field by field:
 *
 *   config → credsFile → <项目>/.dsh/wecom-bot.json → ~/.dsh/wecom-bot.json
 *          → <项目>/.dsh/wecom-app.json → ~/.dsh/wecom-app.json → env
 *
 * File keys: `bot_id` / `bot_secret` (aliases: `aibot_id`, `secret`).
 * Env: `WECOM_BOT_ID` / `WECOM_BOT_SECRET`.
 */
export declare function resolveWeComBotCreds(cwd: string, cfg: WeComBotChannelConfig): WeComBotCreds;
export declare class WeComBotChannel extends BaseChannel {
    readonly name = "wecom_bot";
    readonly label = "\u4F01\u4E1A\u5FAE\u4FE1\u673A\u5668\u4EBA";
    readonly capabilities: {
        cards: boolean;
        richText: boolean;
        images: boolean;
        inbound: boolean;
    };
    private readonly cfg;
    private client;
    private sdk;
    private disposed;
    private credsCache;
    constructor(cfg?: WeComBotChannelConfig);
    private creds;
    private mediaDir;
    /** Lazy SDK load: injected mock or dynamic import of the official package. */
    private loadSdk;
    connect(): Promise<ListenerStatus>;
    disconnect(): Promise<ListenerStatus>;
    status(): ListenerStatus;
    private registerHandlers;
    /** chatid is present for group chats; single chats address the userid. */
    private chatIdOf;
    private normalizeMessage;
    private textOf;
    private normalizeCardEvent;
    /** Download + decrypt (AES per message) an inbound image via the SDK. */
    private downloadImage;
    private requireClient;
    private send;
    sendText(chatId: string, text: string): Promise<SendResult>;
    sendRichText(chatId: string, title: string, body: string): Promise<SendResult>;
    sendCard(chatId: string, card: CardSpec): Promise<SendResult>;
    dispose(): void;
}
/** Convenience factory. */
export declare function createWeComBotChannel(cfg?: WeComBotChannelConfig): WeComBotChannel;
