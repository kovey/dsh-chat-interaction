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
}
/** Parse the card answer into a decision + always flag. */
export declare function parseAnswer(text: string): AnswerDecision | null;
/** The standard approval card (buttons: yes / no / always). */
export declare function buildApprovalCard(cmd: string): {
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
    askCard(agent: PreExecutePayload['agent'], cmd: string, signal?: AbortSignal): Promise<AnswerDecision | null>;
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
export declare function askViaChannel(opts: {
    chatId: string | null;
    sendCard: (chatId: string, title: string, body: string, buttons: ButtonSpec[]) => Promise<{
        ok: boolean;
        error?: string;
    }>;
    waitReply: (chatId: string, timeoutMs: number, signal?: AbortSignal) => Promise<InboundMessage | null>;
    log: LogFn;
    label: string;
    answerTimeoutMs: number;
}, cmd: string, signal?: AbortSignal): Promise<AnswerDecision | null>;
