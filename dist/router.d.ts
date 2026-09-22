import type { MessageRouter, InteractionHub } from './hub.js';
import type { PendingStore } from './pending.js';
import type { LogFn } from './log.js';
import type { InboundMessage } from './types.js';
export interface RouterConfig {
    enabled?: boolean;
    /**
     * Classification evaluator: 'auto' (model when a key is configured, rules
     * otherwise), 'model' (never fall back to rules for classification), or
     * 'rule' (never spend a model call on classification).
     */
    evaluator?: 'auto' | 'model' | 'rule';
    /** Evaluation + casual-chat model. */
    model?: string;
    baseURL?: string;
    apiKey?: string;
    evaluationTimeoutMs?: number;
    commandTimeoutMs?: number;
    commandMaxOutputChars?: number;
    /** Answer casual messages in-plugin (default true when a key is present). */
    autoReply?: boolean;
    /**
     * Post the permission-mode card (A 全自动 / B 需审批) when a task arrives
     * and no question is open (default true). The answer is resolved in-plugin
     * and written to <项目>/.dsh/<渠道>-permission-mode.txt.
     */
    autoPermissionCard?: boolean;
    /**
     * Post the disambiguation card (1 新指令 / 2 闲聊忽略 / 3 其它) when a
     * message cannot be classified and no model is available to answer it
     * (default true).
     */
    autoDisambiguation?: boolean;
    chatTimeoutMs?: number;
    /** Per-chat conversation memory size (turns). */
    chatHistoryTurns?: number;
    /** Where per-chat memory lives; default ~/.dsh/chat-history. */
    chatDir?: string;
    /** Idle TTL for the task-active marker (default 8h). */
    taskActiveTtlMs?: number;
    /**
     * Create the task-active marker automatically when a task starts
     * (requirement/bugfix), so task continuity does not depend on the agent
     * remembering to write it (default true).
     */
    autoTaskMarker?: boolean;
    /**
     * Absolute cap on task mode regardless of activity (default 12h;
     * 0/negative = unlimited). Guards against a chat getting stuck in
     * "everything is a task supplement" forever.
     */
    maxTaskMs?: number;
    /** Command execution directory; default = hub/bridge project cwd. */
    cwdOf?: () => string;
    /** Injectable fetch (tests). */
    fetchImpl?: typeof fetch;
}
export interface ResolvedRouterConfig {
    enabled: boolean;
    evaluator: 'auto' | 'model' | 'rule';
    model: string;
    baseURL: string;
    apiKey: string;
    evaluationTimeoutMs: number;
    commandTimeoutMs: number;
    commandMaxOutputChars: number;
    autoReply: boolean;
    autoPermissionCard: boolean;
    autoDisambiguation: boolean;
    chatTimeoutMs: number;
    chatHistoryTurns: number;
    chatDir: string;
    taskActiveTtlMs: number;
    autoTaskMarker: boolean;
    maxTaskMs: number;
    cwdOf?: () => string;
    fetchImpl?: typeof fetch;
}
export declare function resolveRouterConfig(raw: RouterConfig | undefined): ResolvedRouterConfig;
export interface Classification {
    mode: 'task' | 'confirmation' | 'command' | 'requirement' | 'bugfix' | 'chat';
    confidence: number;
    reasoning: string;
    commands?: string[];
    summary?: string;
}
/** Deterministic classification (always available, no API key needed). */
export declare function classifyByRules(msg: InboundMessage, hasPending: boolean): Classification;
export interface PendingResolution {
    /** The message answered the open question. */
    resolved: boolean;
    /** Chosen option value (A / 1 / answer / ...). */
    choice?: string | null;
    label?: string;
    /** The user cancelled the question. */
    cancelled?: boolean;
    /** The message looks like a NEW instruction rather than an answer. */
    ambiguous?: boolean;
    /** Free-form answer text (goes to the agent). */
    freeform?: string;
}
/**
 * Decide what an inbound message means while a question is open.
 * (Ported from the dsh-feishu router's category-0 matching rules.)
 */
export declare function resolvePending(pending: {
    kind: string;
    options?: Array<{
        value: string;
        label?: string;
    }>;
}, text: string): PendingResolution;
/** The permission-mode card posted when a task arrives (A 全自动 / B 需审批). */
export declare function permissionModeCard(summary: string): {
    title: string;
    body: string;
    buttons: Array<{
        value: string;
        label: string;
        type: 'primary' | 'danger';
    }>;
};
/** The disambiguation card posted when a message cannot be classified. */
export declare function disambiguationCard(text: string): {
    title: string;
    body: string;
    buttons: Array<{
        value: string;
        label: string;
        type?: 'primary' | 'default';
    }>;
};
export interface SecurityVerdict {
    ok: boolean;
    reason?: string;
}
/** Whitelist-prefix + blacklist-pattern safety gate for in-plugin commands. */
export declare function securityCheck(cmd: string): SecurityVerdict;
export interface CommandResult {
    cmd: string;
    ok: boolean;
    output: string;
    error?: string;
}
/** Run one whitelisted command; output is truncated. Never throws. */
export declare function runCommand(cmd: string, cwd: string, timeoutMs: number, maxChars: number): Promise<CommandResult>;
export interface RouterDeps {
    hub: InteractionHub;
    pendingStore: PendingStore;
    config: ResolvedRouterConfig;
    log?: LogFn;
}
export declare function createRouter(deps: RouterDeps): MessageRouter;
