/**
 * Model-turn failure retry manager, generalized from dsh-feishu.
 *
 * When an inbound message was handed to the agent (`followup`) but the turn
 * ends in a *retryable* failure (SERVER / TIMEOUT / TRANSPORT / RATE_LIMIT /
 * EMPTY_RESPONSE), the guard re-delivers the original message with
 * exponential backoff — up to `maxAttempts` times, then notifies the user.
 *
 * Any success evidence (the agent sends a message through the hub, or a turn
 * settles normally) resets all cycles. The turn-outcome probe is injected by
 * the harness bridge: this module knows nothing about dsh sessions.
 * @module dsh-chat-interaction/retry
 */
import type { InboundMessage } from './types.js';
import type { LogFn } from './log.js';
/** Polled per round: latest-turn outcome, or null when nothing is known. */
export type OutcomeProbe = () => 'retryable-error' | 'settled' | null;
export interface RetryOptions {
    /** Total attempts including the first delivery. */
    maxAttempts?: number;
    /** First backoff delay. */
    baseDelayMs?: number;
    /** Backoff cap. */
    capDelayMs?: number;
    /** Poll interval while cycles are armed. */
    pollMs?: number;
    /** Error codes that count as retryable. */
    retryableCodes?: readonly string[];
    /**
     * Inject the turn-outcome probe (harness bridge provides one). The probe
     * classifies turn endings that appeared AFTER its baseline was fixed.
     */
    probe?: OutcomeProbe;
    /**
     * Idempotent baseline fixer, run at arm time: events already present when
     * a cycle starts are never classified (mirrors the original plugin's
     * retryLastSeq initialization at followup time — no poll window, and no
     * cross-cycle outcome stealing).
     */
    establishBaseline?: () => void;
}
export interface RetryDeps {
    /** Redeliver one message to the agent; returns whether it was delivered. */
    redeliver(msg: InboundMessage, note: string): boolean;
    /** Called when a cycle exhausts its attempts (e.g. send a warning). */
    notifyExhausted(msg: InboundMessage, attempts: number): void;
    log: LogFn;
}
export declare class RetryGuard {
    private readonly opts;
    private readonly probe?;
    private readonly establishBaseline?;
    private readonly deps;
    private cycles;
    private poller;
    private armSeq;
    constructor(opts: RetryOptions | undefined, deps: RetryDeps);
    private keyOf;
    private delayMs;
    /**
     * Arm a retry cycle for one delivered message. The outcome baseline is
     * fixed HERE (not at the first poll), so events that already exist at
     * arm time are never classified — the exact timing of the original
     * plugin, and it keeps concurrent cycles from stealing each other's
     * outcomes.
     */
    arm(msg: InboundMessage, note?: string): void;
    /** Any success evidence — clear every cycle. */
    markSuccess(): void;
    resetAll(reason: string): void;
    private stopPoller;
    private ensurePoller;
    /** True when at least one cycle is armed. */
    get active(): boolean;
    dispose(): void;
}
