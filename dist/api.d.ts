import type { InteractionHub } from './hub.js';
import type { LogFn } from './log.js';
import type { ChannelAdapter } from './channel.js';
import type { AuthState, ButtonSpec, CardSpec, ChannelCapabilities, InboundMessage, ListenerStatus, SendResult } from './types.js';
/** Bump when a breaking change lands in this contract. */
export declare const CHAT_INTERACTION_API_VERSION = 1;
export type ApiErrorCode = 'invalid-argument' | 'no-target' | 'channel-not-found' | 'channel-unsupported' | 'send-failed' | 'timeout' | 'aborted' | 'internal';
export type ApiResult<T> = {
    ok: true;
    value: T;
} | {
    ok: false;
    code: ApiErrorCode;
    message: string;
};
/** A place to talk to: explicit, or resolved from an agent / the active chat. */
export interface ChatTarget {
    channel?: string;
    chatId?: string;
    /** Resolve the chat this agent is bound to (multi-agent deployments). */
    agent?: {
        id: string;
    };
}
export interface ResolvedTarget {
    channel: string;
    chatId: string;
}
export interface SendOk {
    messageId?: string;
    channel: string;
    chatId: string;
}
export interface ChannelInfo {
    name: string;
    label: string;
    connected: boolean;
    capabilities: ChannelCapabilities;
}
export interface AskOption {
    /** Value returned to the caller (never shown to the user). */
    value: string;
    label?: string;
    type?: 'primary' | 'default' | 'danger';
}
export interface AskRequest extends ChatTarget {
    title?: string;
    body?: string;
    /** When present the answer must match one of these (value / label / 1-based index). */
    options?: AskOption[];
    timeoutMs?: number;
    signal?: AbortSignal;
    /** Answer to return on timeout instead of `{ok:false, code:'timeout'}`. */
    defaultOption?: string;
    /** Only accept answers from these platform user ids. */
    from?: string[];
}
export interface AskAnswer {
    /** Matched option value, or the raw text for a free-form answer. */
    value: string;
    text: string;
    label?: string;
    /** Platform user id of the answerer. */
    by?: string;
    messageId: string;
    via: 'click' | 'text';
    at: number;
}
export interface ConfirmResult {
    confirmed: boolean;
    timedOut: boolean;
    by?: string;
    messageId?: string;
}
export type NoticeLevel = 'info' | 'warn' | 'error' | 'success';
export interface NoticeRequest extends ChatTarget {
    title?: string;
    body?: string;
    level?: NoticeLevel;
    /** Buttons to show (cards) — pair with `waitForAction` + the returned token. */
    actions?: AskOption[];
    timeoutMs?: number;
}
export interface NoticeResult extends SendOk {
    /**
     * Token to pass to `waitForAction`. Present only when the notice carried
     * actions; buttons are sent as `act:<token>:<value>`.
     */
    actionToken?: string;
}
export interface ActionRequest extends ChatTarget {
    /** Token returned by `notify({actions})`. Required unless `values` is given. */
    token?: string;
    /** Explicit accepted values (used when no token was issued). */
    values?: string[];
    timeoutMs?: number;
    signal?: AbortSignal;
}
export interface ActionAnswer {
    value: string;
    text: string;
    by?: string;
    messageId: string;
    at: number;
}
export interface FileRequest extends ChatTarget {
    /** Absolute path, or a path inside `root` (see `root`). */
    path: string;
    /** Root used to contain relative paths (default: process.cwd()). */
    root?: string;
    name?: string;
}
export interface CommandContext {
    channel: string;
    chatId: string;
    /** Tokens after the command name (whitespace split). */
    args: string[];
    /** Full text of the message. */
    text: string;
    message: InboundMessage;
    reply: {
        text(text: string): Promise<SendResult>;
        richText(title: string, body: string): Promise<SendResult>;
        card(card: CardSpec): Promise<SendResult>;
    };
    log: LogFn;
}
export interface CommandReply {
    text?: string;
    richText?: {
        title: string;
        body: string;
    };
    card?: CardSpec;
}
export interface CommandSpec {
    /** Command name without the leading slash (case-insensitive). */
    name: string;
    description?: string;
    usage?: string;
    handler(ctx: CommandContext): Promise<CommandReply | void> | CommandReply | void;
}
export interface CommandInfo {
    name: string;
    description?: string;
    usage?: string;
}
/** Internal registry the router consults before its own classification. */
export interface CommandRegistry {
    match(text: string): {
        spec: CommandSpec;
        args: string[];
    } | null;
    run(match: {
        spec: CommandSpec;
        args: string[];
    }, msg: InboundMessage): Promise<boolean>;
}
export interface ApiInfo {
    apiVersion: number;
    pluginVersion: string;
    channels: ChannelInfo[];
}
export interface ChatInteractionApi {
    readonly apiVersion: number;
    info(): ApiInfo;
    channels(): ChannelInfo[];
    capabilities(channel: string): ApiResult<ChannelCapabilities>;
    status(channel: string): ListenerStatus;
    connect(channel: string): Promise<ListenerStatus>;
    disconnect(channel: string): Promise<ListenerStatus>;
    authState(channel: string): AuthState;
    sendText(target: ChatTarget, text: string): Promise<ApiResult<SendOk>>;
    sendRichText(target: ChatTarget, title: string, body: string): Promise<ApiResult<SendOk>>;
    sendCard(target: ChatTarget, card: CardSpec): Promise<ApiResult<SendOk>>;
    sendFile(target: FileRequest): Promise<ApiResult<SendOk>>;
    ask(request: AskRequest): Promise<ApiResult<AskAnswer>>;
    confirm(target: ChatTarget, question: {
        title?: string;
        body?: string;
    }, opts?: {
        timeoutMs?: number;
    }): Promise<ApiResult<ConfirmResult>>;
    notify(request: NoticeRequest): Promise<ApiResult<NoticeResult>>;
    waitForAction(request: ActionRequest): Promise<ApiResult<ActionAnswer>>;
    registerCommand(spec: CommandSpec): {
        dispose(): void;
    };
    commands(): CommandInfo[];
    onInbound(handler: (msg: InboundMessage) => void): {
        dispose(): void;
    };
    dispose(): void;
}
export interface ChatApiDeps {
    pluginVersion: string;
    hub: InteractionHub;
    log: LogFn;
    adapters: Map<string, ChannelAdapter>;
    /** Default chat for a channel (active chat file), or null. */
    resolveActive(channel?: string): ResolvedTarget | null;
    /** Chat bound to a specific agent. */
    resolveForAgent(agent: {
        id: string;
    }): ResolvedTarget | null;
    connect(channel: string): Promise<ListenerStatus>;
    disconnect(channel: string): Promise<ListenerStatus>;
    status(channel: string): ListenerStatus;
    authState(channel: string): AuthState;
}
/**
 * Contain a file path inside `root` (same rule as the approval artifacts):
 * absolute paths and `../` escapes outside the root are rejected, symlinks are
 * resolved first.
 */
export declare function containFilePath(root: string, requested: string): string | null;
/** Create the API object exposed as `layer.api` (see {@link ChatInteractionApi}). */
export declare function createChatApi(deps: ChatApiDeps): ChatInteractionApi;
/** Internal accessor for the plugin wiring (not part of the public contract). */
export declare function commandRegistryOf(api: ChatInteractionApi): CommandRegistry;
/** Re-exported for adapters/tests that need the token format. */
export declare function makeActionValue(token: string, value: string): string;
export declare function makeAskValue(nonce: string, value: string): string;
export type { ButtonSpec };
