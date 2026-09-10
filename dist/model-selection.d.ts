import type { ModelSelection, ModelSelectionRef } from '@deepseek-ai/dsh-agent';
import type { HarnessAgent } from './harness.js';
import type { LogFn } from './log.js';
export type { ModelSelection, ModelSelectionRef };
/**
 * Our convenience override shape: provider/reasoningEffort are optional
 * because the official runtime injects them conditionally — a model-only
 * override keeps the agent's default provider route and effort.
 */
export interface ModelOverride {
    provider?: string;
    model?: string;
    reasoningEffort?: string;
}
export interface ModelSelectionManagerOptions {
    log?: LogFn;
    /** Poll interval watching for turn end (override restore). */
    restorePollMs?: number;
    /** Stop watching after this many polls without new events (safety). */
    maxIdlePolls?: number;
    /** Disable the turn-end restore entirely (deployment choice). */
    restoreOnTurnEnd?: boolean;
}
export declare class ModelSelectionManager {
    readonly log: LogFn;
    private readonly restorePollMs;
    private readonly maxIdlePolls;
    private readonly restoreOnTurnEnd;
    private readonly refs;
    private readonly disposers;
    private readonly pollers;
    private readonly lastSeq;
    private readonly idlePolls;
    /** True while the poller waits for the scored turn to actually START. */
    private readonly awaitingTurnStart;
    constructor(opts?: ModelSelectionManagerOptions);
    /**
     * Install the official selection ref onto the agent-scoped context
     * (idempotent per agent). Agents without a context just track the ref
     * locally — the override is recorded but cannot influence requests.
     */
    private ensureInstalled;
    /**
     * Apply an override for the agent's next step, or null to clear it.
     * When `restoreOnTurnEnd`, a poller watches the session log: it first
     * waits for the scored turn to START (`turn/start`), then restores the
     * default when that turn ENDS (`turn/end`). Waiting for the start first
     * matters when the scored followup is queued behind another running
     * turn — without it, the earlier turn's `turn/end` would clear the
     * override before the scored turn ever began.
     *
     * Remaining approximation: a LOCAL (TUI) turn interleaved between the
     * override and the scored turn is attributed to the scored turn. The
     * idle safety timer bounds the exposure (default 60 polls ≈ 2 min).
     */
    override(agent: HarnessAgent, selection: ModelOverride | null): void;
    private stopPoller;
    /** Clear every override immediately. */
    restoreAll(): void;
    /** True when an override is currently armed for the agent. */
    hasOverride(agentId: string): boolean;
    dispose(): void;
}
