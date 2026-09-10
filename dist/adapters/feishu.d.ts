import { BaseChannel } from '../channel.js';
import type { ButtonSpec, CardSpec, ListenerStatus, SendResult } from '../types.js';
export interface LarkEventDispatcherLike {
    register(handlers: Record<string, (data: unknown) => unknown>): unknown;
}
export interface LarkClientLike {
    im?: {
        v1?: {
            message?: {
                create(opts: unknown): Promise<unknown>;
            };
        };
    };
    request?(opts: {
        method: string;
        url: string;
        params?: unknown;
        responseType?: string;
        timeout?: number;
    }): Promise<unknown>;
}
export interface LarkWsClientLike {
    start(opts: {
        eventDispatcher: unknown;
    }): unknown;
    close(opts?: {
        force?: boolean;
    }): unknown;
}
export interface LarkSdkLike {
    WSClient?: new (opts: Record<string, unknown>) => LarkWsClientLike;
    Client?: new (opts: Record<string, unknown>) => LarkClientLike;
    EventDispatcher?: new (opts: Record<string, unknown>) => LarkEventDispatcherLike;
    LoggerLevel?: {
        error: unknown;
    };
}
export interface FeishuChannelConfig {
    appId?: string;
    appSecret?: string;
    /** Explicit credential file; default = the feishu-app.json chain. */
    credsFile?: string;
    /** Where sent-card stashes live (message_id-keyed JSON). */
    cardStoreDir?: string;
    cardStoreTtlMs?: number;
    /** Download dir for inbound images; default `<project>/.dsh/feishu-media`. */
    mediaDir?: string | (() => string);
    mediaRetentionDays?: number;
    /** Injectable SDK (tests / mocks). */
    sdk?: LarkSdkLike;
    /** Fetch timeout for API calls. */
    timeoutMs?: number;
}
/** Extract Feishu doc/wiki links from text. */
export declare function extractDocIds(text: string): Array<{
    url: string;
    docId: string;
}>;
/** Flatten text/post content into plain text. */
export declare function parseContent(msgType: string, rawContent: string): string;
export declare function extractMentions(msg: {
    mentions?: unknown;
}): Array<{
    key?: string;
    openId?: string;
    name?: string;
}>;
/** Extract image references from image / media / post message contents. */
export declare function extractImageRefs(msgType: string, rawContent: string): Array<{
    key: string;
    type: string;
    name: string;
}>;
/** Rebuild a clicked card: original header + body, button row replaced by the choice. */
export declare function buildUpdatedCard(cardStoreDir: string, messageId: string, choice: string): unknown | null;
/** Resolve Feishu credentials: config → explicit file → project → home → env. */
export declare function resolveFeishuCreds(cwd: string, cfg: FeishuChannelConfig): {
    appId: string;
    appSecret: string;
};
/** Normalize `"value|label|type"` specs into ButtonSpec objects (idempotent). */
export declare function normalizeButtons(buttons: CardSpec['buttons']): ButtonSpec[];
/** Build the Feishu interactive-card JSON (header + markdown body + buttons). */
export declare function buildCardContent(title: string, body: string, buttons: CardSpec['buttons']): string;
export declare class FeishuChannel extends BaseChannel {
    readonly name = "feishu";
    readonly label = "\u98DE\u4E66";
    readonly capabilities: {
        cards: boolean;
        richText: boolean;
        images: boolean;
        inbound: boolean;
    };
    private readonly cfg;
    private creds;
    private lark;
    private wsClient;
    private apiClient;
    private botOpenId;
    private disposed;
    constructor(cfg?: FeishuChannelConfig);
    /** Lazy SDK: injected mock or dynamic import of @larksuiteoapi/node-sdk. */
    private loadSdk;
    private cardStoreDir;
    private mediaDir;
    connect(): Promise<ListenerStatus>;
    disconnect(): Promise<ListenerStatus>;
    status(): ListenerStatus;
    private resolveCreds;
    private normalizeReceive;
    private handleCardAction;
    private send;
    private ensureApiClient;
    private stashCard;
    sendText(chatId: string, text: string): Promise<SendResult>;
    sendRichText(chatId: string, title: string, body: string): Promise<SendResult>;
    sendCard(chatId: string, card: CardSpec): Promise<SendResult>;
    dispose(): void;
}
/** Convenience factory. */
export declare function createFeishuChannel(cfg?: FeishuChannelConfig): FeishuChannel;
