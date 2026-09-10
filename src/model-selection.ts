/**
 * Scored-turn model routing — built on the OFFICIAL harness seam.
 *
 * The transient model override is applied through
 * `installModelSelection(agentCtx, selectionRef)` from @deepseek-ai/dsh-agent
 * (the same public API the harness's own entry points use): it couples a
 * mutable `ModelSelectionRef` to the agent-scoped context so the next step's
 * prompt assembly and request routing pick up the selected provider/model.
 *
 * What this module adds on top is the *policy*:
 *  - each scored followup sets `ref.current` (or clears it) right before the
 *    agent is woken;
 *  - when the scored turn ends (a `turn/end` event appears on the agent's
 *    session), the override is restored so the user's next local turn keeps
 *    the session default model;
 *  - a safety idle timer restores the default even if no turn/end is ever
 *    observed (e.g. the session surface does not expose events).
 * @module dsh-chat-interaction/model-selection
 */
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import type { ModelSelection, ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import type { HarnessAgent } from './harness.js'
import { hasSessionEvents, readSessionEvents } from './session-events.js'
import type { LogFn } from './log.js'
import { log as defaultLog } from './log.js'

export type { ModelSelection, ModelSelectionRef }

/**
 * Our convenience override shape: provider/reasoningEffort are optional
 * because the official runtime injects them conditionally — a model-only
 * override keeps the agent's default provider route and effort.
 */
export interface ModelOverride {
    provider?: string
    model?: string
    reasoningEffort?: string
}

export interface ModelSelectionManagerOptions {
    log?: LogFn
    /** Poll interval watching for turn end (override restore). */
    restorePollMs?: number
    /** Stop watching after this many polls without new events (safety). */
    maxIdlePolls?: number
    /** Disable the turn-end restore entirely (deployment choice). */
    restoreOnTurnEnd?: boolean
}

export class ModelSelectionManager {
    readonly log: LogFn
    private readonly restorePollMs: number
    private readonly maxIdlePolls: number
    private readonly restoreOnTurnEnd: boolean

    private readonly refs = new Map<string, ModelSelectionRef>()
    private readonly disposers = new Map<string, () => void>()
    private readonly pollers = new Map<string, NodeJS.Timeout>()
    private readonly lastSeq = new Map<string, number>()
    private readonly idlePolls = new Map<string, number>()
    /** True while the poller waits for the scored turn to actually START. */
    private readonly awaitingTurnStart = new Map<string, boolean>()

    constructor(opts: ModelSelectionManagerOptions = {}) {
        this.log = opts.log || defaultLog
        this.restorePollMs = opts.restorePollMs ?? 2000
        this.maxIdlePolls = opts.maxIdlePolls ?? 60
        this.restoreOnTurnEnd = opts.restoreOnTurnEnd !== false
    }

    /**
     * Install the official selection ref onto the agent-scoped context
     * (idempotent per agent). Agents without a context just track the ref
     * locally — the override is recorded but cannot influence requests.
     */
    private ensureInstalled(agent: HarnessAgent): ModelSelectionRef {
        let ref = this.refs.get(agent.id)
        if (ref) return ref
        ref = { current: undefined, assembled: undefined }
        this.refs.set(agent.id, ref)

        const ctx = agent.ctx as Context | undefined
        if (ctx && !this.disposers.has(agent.id)) {
            try {
                const disposer = installModelSelection(ctx, ref)
                this.disposers.set(agent.id, disposer)
                this.log('info', `model-selection installed for agent ${agent.id} (official installModelSelection)`)
            } catch (e) {
                this.log('warn', 'installModelSelection failed:', (e as Error).message)
            }
        }
        return ref
    }

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
    override(agent: HarnessAgent, selection: ModelOverride | null): void {
        const ref = this.ensureInstalled(agent)
        // Official ModelSelection requires provider+model as strings, but the
        // runtime injects each field only when defined — partially-specified
        // overrides are legal at runtime, so the cast bridges the stricter type.
        ref.current = (selection ?? undefined) as ModelSelection | undefined
        this.stopPoller(agent.id)
        if (selection && this.restoreOnTurnEnd && hasSessionEvents(agent.session)) {
            // dsh 0.1.5+: the session log is read through snapshotEvents()
            // (legacy `events` arrays of ≤0.1.2 hosts also work — see
            // session-events.ts).
            const events = readSessionEvents(agent.session)
            this.lastSeq.set(agent.id, events.length ? events[events.length - 1].seq ?? 0 : -1)
            this.idlePolls.set(agent.id, 0)
            this.awaitingTurnStart.set(agent.id, true)
            const timer = setInterval(() => {
                const current = this.refs.get(agent.id)
                if (!current || current.current === undefined) {
                    this.stopPoller(agent.id)
                    return
                }
                const evs = readSessionEvents(agent.session)
                let sawEnd = false
                let waitingStart = this.awaitingTurnStart.get(agent.id) !== false
                if (evs.length) {
                    const last = this.lastSeq.get(agent.id) ?? -1
                    for (const ev of evs) {
                        if (typeof ev.seq !== 'number' || ev.seq <= last) continue
                        if (waitingStart && ev.type === 'turn/start') {
                            waitingStart = false
                            this.awaitingTurnStart.set(agent.id, false)
                        } else if (!waitingStart && ev.type === 'turn/end') {
                            sawEnd = true
                            break
                        }
                    }
                    this.lastSeq.set(agent.id, evs[evs.length - 1].seq ?? last)
                }
                if (sawEnd) {
                    this.log('info', 'scored turn ended; restoring host model for agent ' + agent.id)
                    current.current = undefined
                    this.stopPoller(agent.id)
                    return
                }
                const idle = (this.idlePolls.get(agent.id) || 0) + 1
                this.idlePolls.set(agent.id, idle)
                if (idle >= this.maxIdlePolls) {
                    this.log('warn', 'no scored turn start/end observed for agent ' + agent.id + '; restoring host model (safety)')
                    current.current = undefined
                    this.stopPoller(agent.id)
                }
            }, this.restorePollMs)
            if (typeof timer.unref === 'function') timer.unref()
            this.pollers.set(agent.id, timer)
        }
    }

    private stopPoller(agentId: string): void {
        const t = this.pollers.get(agentId)
        if (t) {
            clearInterval(t)
            this.pollers.delete(agentId)
        }
    }

    /** Clear every override immediately. */
    restoreAll(): void {
        for (const ref of this.refs.values()) ref.current = undefined
        for (const id of Array.from(this.pollers.keys())) this.stopPoller(id)
    }

    /** True when an override is currently armed for the agent. */
    hasOverride(agentId: string): boolean {
        const ref = this.refs.get(agentId)
        return !!ref && ref.current !== undefined
    }

    dispose(): void {
        this.restoreAll()
        for (const [id, dispose] of this.disposers.entries()) {
            try { dispose() } catch (e) {
                this.log('warn', `model-selection dispose failed for ${id}:`, (e as Error).message)
            }
        }
        this.disposers.clear()
        this.refs.clear()
        this.lastSeq.clear()
        this.idlePolls.clear()
        this.awaitingTurnStart.clear()
    }
}
