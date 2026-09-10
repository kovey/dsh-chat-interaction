import { BaseChannel } from '../channel.js';
import type { CardSpec, InboundMessage, ListenerStatus, SendResult } from '../types.js';
export interface WeComChannelConfig {
    corpId?: string;
    corpSecret?: string;
    agentId?: string;
    /** Callback verification token (required for the built-in server). */
    token?: string;
    /** Callback EncodingAESKey (43 chars; required for the built-in server). */
    aesKey?: string;
    /** Explicit credential file JSON; default = the wecom-app.json chain. */
    credsFile?: string;
    /** Built-in callback server settings. Omit to use feed() only. */
    callback?: {
        host?: string;
        port?: number;
        path?: string;
    };
    /** API base; override for tests/proxies. */
    baseUrl?: string;
    accessTokenTtlMs?: number;
    /** Where task_id → {chatId,card} mappings persist. */
    taskStoreDir?: string;
    taskStoreTtlMs?: number;
    /** Download dir for inbound images; default `<project>/.dsh/wecom-media`. */
    mediaDir?: string | (() => string);
    mediaRetentionDays?: number;
    timeoutMs?: number;
    /** Injectable decryptor for tests: { decrypt(aesKey, encrypt), getSignature(token, timestamp, nonce, encrypt) }. */
    cryptoModule?: WeComCryptoLike;
    /** Injectable fetch for tests. */
    fetchImpl?: typeof fetch;
    /**
     * Forward non-message platform events (contact changes, batch-job results,
     * ...) to the agent as `[事件: xxx]` turns. Default false: only human
     * actions in a chat (click / view / scancode_push / template cards) are
     * delivered.
     */
    emitUnknownEvents?: boolean;
}
export interface WeComCryptoLike {
    getSignature?(token: string, timestamp: string, nonce: string, encrypt: string): string;
    decrypt?(aesKey: string, encrypt: string): {
        message: string;
        id?: string;
    } | string;
}
/** sha1(sort(token, timestamp, nonce, encrypt)) — the callback signature. */
export declare function wecomSignature(token: string, timestamp: string, nonce: string, encrypt: string): string;
/** AES-256-CBC decrypt of a WeCom payload: random16 + len4 + msg + receiveid. */
export declare function wecomDecrypt(aesKey: string, encrypt: string): {
    message: string;
    id: string;
};
/** Parse the flat `<xml>...</xml>` the platform sends. Values may be CDATA. */
export declare function parseWeComXml(xml: string): Record<string, string>;
/** Effective WeCom credentials after the resolution chain. */
export interface WeComCreds {
    corpId: string;
    corpSecret: string;
    agentId: string;
    token: string;
    aesKey: string;
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
export declare function resolveWeComCreds(cwd: string, cfg: WeComChannelConfig): WeComCreds;
export declare class WeComChannel extends BaseChannel {
    readonly name = "wecom";
    readonly label = "\u4F01\u4E1A\u5FAE\u4FE1";
    readonly capabilities: {
        cards: boolean;
        richText: boolean;
        images: boolean;
        inbound: boolean;
    };
    private readonly cfg;
    private tokenCache;
    private tokenPromise;
    private server;
    private disposed;
    /** chatId → 'single'|'group', learned from inbound events (single chats need touser=). */
    private readonly knownChatTypes;
    constructor(cfg?: WeComChannelConfig);
    private get baseUrl();
    private credsCache;
    /**
     * Effective credentials (config → credsFile → project/home wecom-app.json
     * → env WECOM_*), resolved lazily once per adapter instance.
     */
    private creds;
    private taskStoreDir;
    private mediaDir;
    private fetchJson;
    /** Access token with cache + concurrent-request coalescing. */
    getAccessToken(): Promise<string>;
    private apiJson;
    /** 'single' chats need `touser`, group chats need `chatid`. */
    private recipientOf;
    sendText(chatId: string, text: string): Promise<SendResult>;
    sendRichText(chatId: string, title: string, body: string): Promise<SendResult>;
    sendCard(chatId: string, card: CardSpec): Promise<SendResult>;
    private stashTask;
    private loadTask;
    connect(): Promise<ListenerStatus>;
    disconnect(): Promise<ListenerStatus>;
    status(): ListenerStatus;
    private get callbackPath();
    private cryptoOf;
    private handleCallback;
    private verifySignature;
    private decryptPayload;
    /**
     * Feed one decrypted event (XML string) or an already-parsed object into
     * the adapter — the integration point for external middleware.
     * Resolves with the normalized message, or null when there is nothing to emit.
     */
    feed(payload: string | Record<string, string>): Promise<InboundMessage | null>;
    /** Best effort: PicUrl direct fetch first, then the media API. */
    private tryDownloadImage;
    dispose(): void;
}
/** Convenience factory. */
export declare function createWeComChannel(cfg?: WeComChannelConfig): WeComChannel;
