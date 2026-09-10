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
import type { InboundMessage } from './types.js'
import type { LogFn } from './log.js'

/** Polled per round: latest-turn outcome, or null when nothing is known. */
export type OutcomeProbe = () => 'retryable-error' | 'settled' | null

export interface RetryOptions {
    /** Total attempts including the first delivery. */
    maxAttempts?: number
    /** First backoff delay. */
    baseDelayMs?: number
    /** Backoff cap. */
    capDelayMs?: number
    /** Poll interval while cycles are armed. */
    pollMs?: number
    /** Error codes that count as retryable. */
    retryableCodes?: readonly string[]
    /**
     * Inject the turn-outcome probe (harness bridge provides one). The probe
     * classifies turn endings that appeared AFTER its baseline was fixed.
     */
    probe?: OutcomeProbe
    /**
     * Idempotent baseline fixer, run at arm time: events already present when
     * a cycle starts are never classified (mirrors the original plugin's
     * retryLastSeq initialization at followup time — no poll window, and no
     * cross-cycle outcome stealing).
     */
    establishBaseline?: () => void
}

export interface RetryDeps {
    /** Redeliver one message to the agent; returns whether it was delivered. */
    redeliver(msg: InboundMessage, note: string): boolean
    /** Called when a cycle exhausts its attempts (e.g. send a warning). */
    notifyExhausted(msg: InboundMessage, attempts: number): void
    log: LogFn
}

const DEFAULTS: Required<Omit<RetryOptions, 'probe' | 'establishBaseline'>> = {
    maxAttempts: 10,
    baseDelayMs: 30_000,
    capDelayMs: 10 * 60_000,
    pollMs: 5_000,
    retryableCodes: ['SERVER', 'TIMEOUT', 'TRANSPORT', 'RATE_LIMIT', 'EMPTY_RESPONSE'],
}

interface Cycle {
    msg: InboundMessage
    note?: string
    failures: number
    timer: NodeJS.Timeout | null
}

export class RetryGuard {
    private readonly opts: Required<Omit<RetryOptions, 'probe' | 'establishBaseline'>>
    private readonly probe?: OutcomeProbe
    private readonly establishBaseline?: () => void
    private readonly deps: RetryDeps
    private cycles = new Map<string, Cycle>()
    private poller: NodeJS.Timeout | null = null
    private armSeq = 0

    constructor(opts: RetryOptions | undefined, deps: RetryDeps) {
        const { probe, establishBaseline, ...rest } = opts || {}
        this.opts = { ...DEFAULTS, ...rest }
        this.probe = probe
        this.establishBaseline = establishBaseline
        this.deps = deps
    }

    private keyOf(msg: InboundMessage): string {
        const id = String(msg.messageId || '')
        // Messages without a platform id still get a cycle (key fallback is
        // unique per arm — they only collide if redelivered, which never
        // happens for id-less messages).
        if (id) return `${String(msg.channel || '')}:${id}`
        this.armSeq += 1
        return `${String(msg.channel || '')}:${String(msg.chatId || '')}:nomid-${this.armSeq}`
    }

    private delayMs(failures: number): number {
        return Math.min(this.opts.baseDelayMs * Math.pow(2, failures - 1), this.opts.capDelayMs)
    }

    /**
     * Arm a retry cycle for one delivered message. The outcome baseline is
     * fixed HERE (not at the first poll), so events that already exist at
     * arm time are never classified — the exact timing of the original
     * plugin, and it keeps concurrent cycles from stealing each other's
     * outcomes.
     */
    arm(msg: InboundMessage, note?: string): void {
        try {
            if (this.establishBaseline) this.establishBaseline()
            else this.probe?.() // direct-probe users: first call self-establishes
        } catch { /* best effort */ }
        this.cycles.set(this.keyOf(msg), { msg, note, failures: 0, timer: null })
        this.ensurePoller()
    }

    /** Any success evidence — clear every cycle. */
    markSuccess(): void {
        if (this.cycles.size === 0) return
        for (const e of this.cycles.values()) {
            if (e.timer) clearTimeout(e.timer)
        }
        this.cycles.clear()
        this.stopPoller()
        this.deps.log('info', 'retry: cycles reset (success evidence)')
    }

    resetAll(reason: string): void {
        if (this.cycles.size === 0) return
        for (const e of this.cycles.values()) {
            if (e.timer) clearTimeout(e.timer)
        }
        this.cycles.clear()
        this.stopPoller()
        this.deps.log('info', 'retry: cycles reset (' + reason + ')')
    }

    private stopPoller(): void {
        if (this.poller) {
            clearInterval(this.poller)
            this.poller = null
        }
    }

    private ensurePoller(): void {
        if (this.poller || this.cycles.size === 0) return
        this.poller = setInterval(() => {
            if (this.cycles.size === 0) {
                this.stopPoller()
                return
            }
            const outcome = this.probe ? this.probe() : null
            if (outcome === 'settled') {
                this.resetAll('turn settled')
                return
            }
            if (outcome !== 'retryable-error') return
            for (const [key, e] of Array.from(this.cycles.entries())) {
                if (e.timer) continue // a redelivery is already scheduled
                e.failures += 1
                if (e.failures >= this.opts.maxAttempts) {
                    this.cycles.delete(key)
                    this.deps.log('error', `retry: exhausted after ${this.opts.maxAttempts} failures:`, e.msg.messageId || '')
                    try { this.deps.notifyExhausted(e.msg, e.failures) } catch { /* best effort */ }
                    continue
                }
                const delay = this.delayMs(e.failures)
                this.deps.log(
                    'warn',
                    'retry: scheduling redelivery',
                    e.msg.messageId || '',
                    `failure=${e.failures}/${this.opts.maxAttempts}`,
                    `delayMs=${delay}`
                )
                e.timer = setTimeout(() => {
                    e.timer = null
                    this.cycles.delete(key)
                    const retryNote = (e.note ? e.note + ' ' : '') +
                        `⚠️ 模型调用失败，自动重试（第 ${e.failures}/${this.opts.maxAttempts} 次）`
                    ;(e.msg as InboundMessage & { __retryRedelivery?: boolean }).__retryRedelivery = true
                    if (this.deps.redeliver(e.msg, retryNote)) {
                        this.cycles.set(key, e) // turn restarted; keep counting
                        this.ensurePoller()
                    } else {
                        this.resetAll('redelivery failed')
                    }
                }, delay)
                if (typeof e.timer.unref === 'function') e.timer.unref()
            }
            if (this.cycles.size === 0) this.stopPoller()
        }, this.opts.pollMs)
        if (typeof this.poller.unref === 'function') this.poller.unref()
    }

    /** True when at least one cycle is armed. */
    get active(): boolean {
        return this.cycles.size > 0
    }

    dispose(): void {
        this.resetAll('dispose')
    }
}
