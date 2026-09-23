import type { ChannelAdapter } from './channel.js';
import type { RetryOptions } from './retry.js';
import type { LogFn } from './log.js';
import type { CardSpec, FollowupContext, InboundMessage, ListenerStatus, ScoreResult, SendResult, WaitResult } from './types.js';
/** The router's verdict for one inbound message. */
export interface RouterDecision {
    /** The plugin-side router handled it itself (no agent turn needed). */
    handled: boolean;
    /** Wake the agent with this message. */
    followup: boolean;
    /** Routing mode label, for logs / acks (command / chat / requirement / ...). */
    mode?: string;
    /** Extra context appended to the agent turn. */
    followupNote?: string;
    /**
     * Replace the text of the agent turn (e.g. a disambiguation replay: the
     * user clicked "1 新指令" on message X — the agent must see X, not "1").
     * The spool already holds the original inbound text.
     */
    followupText?: string;
}
export type MessageRouter = (msg: InboundMessage) => RouterDecision | Promise<RouterDecision>;
/** Instant-receipt text by mode; return null/'' to skip the ack. */
export type AckTextFn = (msg: InboundMessage, mode?: string) => string | null;
export interface HubOptions {
    log?: LogFn;
    /** JSONL tee: every inbound message is appended here. */
    spoolFile?: string;
    /** Instant receipt before waking the agent (default on). */
    ack?: boolean | AckTextFn;
    /**
     * Plugin-side routing (command autonomy / confirmations / casual chat).
     * Omitted = every message wakes the agent.
     */
    router?: MessageRouter;
    /** Model-failure redelivery guard; false disables it. */
    retry?: RetryOptions | false;
    /**
     * Plugin-side pending-question store check (bypasses wait_reply consumption).
     */
    hasPendingQuestion?: (channel: string, chatId: string) => boolean;
    /** Called for every inbound message (active-chat / p2p-chat state). */
    recordState?: (msg: InboundMessage) => void;
    /**
     * Score the message (complexity 0..1) to route it to an execution model.
     * Runs after the instant ack, before the followup; null = unscored.
     * A throwing scorer never blocks delivery.
     */
    score?: (msg: InboundMessage) => Promise<ScoreResult | null>;
    /**
     * Wake the agent. Returns whether the followup was delivered. This is the
     * single seam to the harness — see `harness.ts` / `plugin.ts`.
     * `ctx.score` carries the scoring verdict when scoring produced one.
     */
    onFollowup?: (msg: InboundMessage, ctx?: FollowupContext) => boolean;
    waitTimeoutDefaultMs?: number;
    waitTimeoutMaxMs?: number;
}
export declare class InteractionHub {
    readonly options: HubOptions;
    readonly log: LogFn;
    private readonly channels;
    private readonly seen;
    private readonly waiters;
    private readonly retry;
    private tornDown;
    constructor(options?: HubOptions);
    /** Attach one adapter. Fails loudly on duplicate names (config error). */
    addChannel(adapter: ChannelAdapter): void;
    getChannel(name: string): ChannelAdapter | undefined;
    channelNames(): string[];
    private requireChannel;
    connect(name: string): Promise<ListenerStatus>;
    disconnect(name: string): Promise<ListenerStatus>;
    status(name: string): ListenerStatus;
    /**
     * Send plain text through a channel. Any attempt is success evidence for
     * the retry guard (the agent is demonstrably alive), mirroring the
     * plugin's trackedReplier.
     */
    sendText(channel: string, chatId: string, text: string): Promise<SendResult>;
    sendRichText(channel: string, chatId: string, title: string, body: string): Promise<SendResult>;
    /**
     * Deliver a local file (approval artifacts). Channels without the capability
     * answer `ok: false` — the caller decides whether text is enough.
     */
    sendFile(channel: string, chatId: string, file: {
        path: string;
        name?: string;
    }): Promise<SendResult>;
    sendCard(channel: string, chatId: string, card: CardSpec): Promise<SendResult>;
    /**
     * Block until the user's next message in this chat on this channel.
     * The consumed message does NOT wake the agent — the consuming tool call
     * is the agent's handling. Messages in other chats flow normally.
     */
    waitReply(channel: string, chatId: string, timeoutMs?: number, signal?: AbortSignal): Promise<WaitResult>;
    private takeWaiter;
    /**
     * The full inbound pipeline. Never throws: failures fall back to waking
     * the agent (exactly like the plugin's dispatch catch path).
     */
    dispatch(msg: InboundMessage): Promise<void>;
    /** Score once per message; the verdict is cached for retry redeliveries. */
    private scoreMessage;
    private wakeAgent;
    private markSuccess;
    private sendAck;
    private tee;
    /**
     * Release everything: disconnect all channels, settle pending waiters,
     * disarm the retry guard. Idempotent. This is what keeps the Node event
     * loop drainable on session exit.
     */
    teardown(): void;
}
