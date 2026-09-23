/**
 * Authorization, generalized from dsh-feishu's P3 approval module.
 *
 * L2 manual-mode gate: a `tools/pre-execute` waterfall listener. For bash
 * calls made during channel-originated task turns while the project's
 * permission mode is `manual`, the command is put to an inline yes/no/always
 * card on the originating channel. `always` appends the exact command to the
 * project allowlist. Timeout / no recorded chat → deny (fail closed).
 *
 * L3 harness-approval bridge (default OFF): an `approval/request` answerer
 * that routes ANY harness approval ask to a channel card — for headless 24×7
 * deployments without a local answerer.
 *
 * Everything is channel-agnostic: decisions are pure functions, side effects
 * arrive through injected deps, so this module is trivially unit-testable
 * and reusable for Feishu, WeCom, or any future adapter.
 * @module dsh-chat-interaction/approval
 */
import type { InboundMessage, ButtonSpec } from './types.js';
import type { LogFn } from './log.js';
export declare const CMD_MAX_CHARS = 800;
export interface GateInput {
    /** `auto` | `manual` */
    mode: string;
    allowlist: string[];
    cmd: string;
    /** True while the executing agent handles a channel-originated turn. */
    originated: boolean;
}
export interface GateOutput {
    ask: boolean;
    allowed?: boolean;
}
/** Decide whether one command needs the manual-mode card. */
export declare function evaluateGate({ mode, allowlist, cmd, originated }: GateInput): GateOutput;
export interface AnswerDecision {
    decision: 'allow' | 'deny';
    always: boolean;
    /** Who decided (platform user id). Absent for text answers. */
    by?: string;
    /** Platform message id of the card/message carrying the decision. */
    messageId?: string;
    /** Decision time (epoch ms). */
    at?: number;
    /** The one-shot token the card carried, when it was a button click. */
    nonce?: string;
}
/** The fence the engineering suite uses to embed machine-readable fields. */
export declare const APPROVAL_CONTEXT_FENCE = "approval-context";
/** Fields a card renders; mirrors `dsh-eng-core`'s `ApprovalContext`. */
export interface ApprovalContext {
    kind?: string;
    missionId?: string;
    title?: string;
    revision?: number | string;
    risk?: string;
    artifacts?: string[];
    facts?: Record<string, string | number>;
    channelHints?: {
        buttons?: string[];
        requiresReason?: boolean;
    };
}
/**
 * Read the suite's `approval-context` block out of a reason.
 *
 * A standalone copy of the same convention (this plugin does not depend on
 * `dsh-eng-core`): prose for a text answerer, fenced JSON for a card.
 */
export declare function parseApprovalContext(reason: string): ApprovalContext | undefined;
/** The reason without its machine block: what a text answerer should show. */
export declare function proseOf(reason: string): string;
/**
 * Resolve an approval artifact to an ABSOLUTE path that is provably inside
 * `root`, or return null.
 *
 * The artifact list comes from the approval payload (`approval-context` block),
 * which the suite writes but a model can also influence — so an absolute path or
 * a `../` traversal must not be able to hand the chat an arbitrary local file
 * (e.g. `~/.dsh/feishu-app.json`, which holds app credentials).
 *
 * Symlinks are resolved first, so a link inside the project pointing outside is
 * rejected as well. Directories and missing files are not artifacts.
 */
export declare function resolveContainedPath(root: string, requested: string): string | null;
/** One ledger row per decision (or refusal) — the IM half of the audit trail. */
export interface ApprovalLedgerEntry {
    at: number;
    chatId: string;
    userId?: string;
    decision: 'allow' | 'deny' | 'timeout' | 'send-failed' | 'unauthorized' | 'stale-click'
    /** A text answer refused because the flow demands a button click. */
     | 'text-rejected';
    /** How the decision arrived: a nonce-bound click, or a typed answer. */
    via?: 'click' | 'text';
    /** The tool that asked, when the payload carried one. */
    toolName?: string;
    nonce: string;
    messageId?: string;
    missionId?: string;
}
/** Parse the card answer into a decision + always flag. */
export declare function parseAnswer(text: string): AnswerDecision | null;
/** The standard approval card (buttons: yes / no / always). */
export declare function buildApprovalCard(cmd: string, nonce?: string, allowAlways?: boolean): {
    body: string;
    buttons: ButtonSpec[];
};
/**
 * The card for a suite approval (spec / delivery / standards / dependency).
 *
 * The fields come from the `approval-context` block, so a card says WHAT is being
 * decided instead of pasting an essay — and the buttons stay nonce-bound.
 */
export declare function buildContextCard(context: ApprovalContext, prose: string, nonce: string, allowAlways?: boolean): {
    body: string;
    buttons: ButtonSpec[];
};
/** What a `tools/pre-execute` payload looks like (structural, dsh-compatible). */
export interface PreExecutePayload {
    name: string;
    agent?: {
        id?: string;
    } | null;
    arguments?: {
        command?: string;
    } | Record<string, unknown>;
    signal?: AbortSignal;
}
/** What an `approval/request` payload looks like (structural). */
export interface ApprovalRequestPayload {
    toolName?: string;
    callId?: string;
    reason?: string;
    agent?: {
        id?: string;
    } | null;
    signal?: AbortSignal;
}
/** Decisions this plugin returns to the harness approval seam (see the suite's contract). */
export type HarnessApprovalReply = 'allowed-once' | 'rejected' | {
    decision: 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable';
    by?: string;
    messageId?: string;
    at?: number;
    source?: string;
};
export interface ApprovalDeps {
    log: LogFn;
    /** Current permission mode for the agent's project. */
    readMode(agent: PreExecutePayload['agent']): string;
    readAllowlist(agent: PreExecutePayload['agent']): string[];
    addAllowlist(agent: PreExecutePayload['agent'], cmd: string): boolean;
    /** True while the agent is inside a channel-originated task window. */
    isOriginated(agent: PreExecutePayload['agent']): boolean;
    /**
     * Put the command to an inline card on the originating channel and wait
     * for the answer. Resolve null on timeout / send failure (fail closed).
     */
    askCard(agent: PreExecutePayload['agent'], cmd: string, signal?: AbortSignal, 
    /** The asking tool, for the card heading (suite approvals). */
    subject?: string): Promise<AnswerDecision | null>;
}
/** Minimal structural slice of the harness context that approval needs. */
export interface ApprovalHarness {
    on?(event: string, listener: (payload: any, next: () => any) => any): void;
}
/**
 * Register the L2 manual-mode pre-execute gate and (optionally) the L3
 * approval bridge. Returns the registered listeners' unregister function
 * (via harness.on when it supports it; otherwise a no-op teardown).
 */
export declare function setupAuthorization(harness: ApprovalHarness, deps: ApprovalDeps, cfg?: {
    bridgeHarnessApproval?: boolean;
}): () => void;
/** Ask via one channel, wait for the card click, parse the answer. */
export interface AskViaChannelOptions {
    chatId: string | null;
    sendCard: (chatId: string, title: string, body: string, buttons: ButtonSpec[]) => Promise<{
        ok: boolean;
        error?: string;
    }>;
    waitReply: (chatId: string, timeoutMs: number, signal?: AbortSignal) => Promise<InboundMessage | null>;
    log: LogFn;
    label: string;
    answerTimeoutMs: number;
    /** Card heading detail, e.g. the asking tool. */
    subject?: string;
    /**
     * Ids allowed to decide. EMPTY means "anyone in the bound chat", which keeps
     * the historical behaviour; a filled list is the strict mode a project opts
     * into (`.dsh`-side file, one id per line).
     */
    approvers?: string[];
    /** Every decision/refusal is reported here (JSONL ledger in the plugin). */
    onDecision?: (entry: ApprovalLedgerEntry) => void;
    /** Reply into the chat (answering an unauthorised or stale click). */
    respond?: (text: string) => Promise<unknown>;
    /** Deliver one approval artifact. */
    sendFile?: (file: {
        path: string;
        name?: string;
    }) => Promise<{
        ok: boolean;
        error?: string;
    }>;
    /** Send the artifacts named in the context block (default true when sendFile exists). */
    sendArtifacts?: boolean;
    /** Offer "始终允许" (command approvals only). */
    allowAlways?: boolean;
    /**
     * Accept ONLY nonce-bound card clicks. A typed `yes`/`同意` then no longer
     * decides anything (it is answered and recorded as `text-rejected`), which is
     * what the replay-protection story promises. Default false keeps the
     * historical behaviour where a typed answer still works.
     */
    requireTokenClick?: boolean;
}
export declare function askViaChannel(opts: AskViaChannelOptions, cmd: string, signal?: AbortSignal): Promise<AnswerDecision | null>;
