import type { Model, ModelSelection } from '@deepseek-ai/dsh-agent';
import type { HarnessAgent } from './harness.js';
import type { LogFn } from './log.js';
export type { Model, ModelSelection };
/**
 * Our convenience override shape: provider/reasoningEffort stay optional so a
 * model-only override keeps the agent's current route and effort.
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
    /** Agent-owned model seam, resolved per agent id. */
    private readonly models;
    /** The agent objects, kept so `restoreAll()` can read their default route. */
    private readonly agents;
    /** Agents whose next step currently carries our override. */
    private readonly armed;
    /** Official pre-step switch-notice listeners (one per agent context). */
    private readonly disposers;
    private readonly pollers;
    private readonly lastSeq;
    private readonly idlePolls;
    /** True while the poller waits for the scored turn to actually START. */
    private readonly awaitingTurnStart;
    /** Warn once per agent about a host without the model seam. */
    private readonly warned;
    constructor(opts?: ModelSelectionManagerOptions);
    /** The agent's own default route (its live options), or null. */
    private defaultOf;
    /**
     * Resolve the agent-owned model seam (idempotent per agent). Also installs
     * the official pre-step switch-notice listener on the agent context.
     * @returns the handle, or undefined when the host predates dsh 0.2.2.
     */
    private handle;
    /** Select a complete route (`null` = restore the agent's own default). */
    private select;
    /**
     * Apply an override for the agent's next step, or null to restore the default.
     * When `restoreOnTurnEnd`, a poller watches the session log: it first waits
     * for the scored turn to START (`turn/start`), then restores the default when
     * that turn ENDS (`turn/end`). Waiting for the start matters when the scored
     * followup is queued behind another running turn.
     */
    override(agent: HarnessAgent, selection: ModelOverride | null): void;
    /** Disarm one agent and restore its default route. */
    private restore;
    private stopPoller;
    /** Clear every override immediately (restoring each agent's default route). */
    restoreAll(): void;
    /** True when an override is currently armed for the agent. */
    hasOverride(agentId: string): boolean;
    dispose(): void;
}
