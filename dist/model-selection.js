/**
 * Scored-turn model routing — built on the OFFICIAL harness seam.
 *
 * dsh 0.2.2 moved the selection from a caller-owned `ModelSelectionRef` to the
 * agent itself: `agent.model` implements `Model` (`current()` / `select()`), and
 * `installModelSelection(agentCtx)` only installs the pre-step switch-notice
 * listener. So this module:
 *
 *  - resolves the agent-owned handle (`agent.model`) and installs the official
 *    notice listener once per agent context;
 *  - applies an override by `model.select({ provider, model, reasoningEffort })`
 *    (the selection must be COMPLETE — provider+model; missing pieces come from
 *    the agent's live options / current selection);
 *  - restores the agent's default route (its live options) when the scored turn
 *    ends, with an idle safety timer;
 *  - keeps every decision local: agents without the seam (old hosts) only log.
 *
 * What this module adds on top of the official API is the *policy* (which model
 * for which scored message, and when to restore), not the mechanism.
 * @module dsh-chat-interaction/model-selection
 */
import { installModelSelection } from '@deepseek-ai/dsh-agent';
import { hasSessionEvents, readSessionEvents } from './session-events.js';
import { log as defaultLog } from './log.js';
/** The efforts the official model catalog accepts. */
const EFFORTS = new Set(['off', 'low', 'high', 'max']);
export class ModelSelectionManager {
    log;
    restorePollMs;
    maxIdlePolls;
    restoreOnTurnEnd;
    /** Agent-owned model seam, resolved per agent id. */
    models = new Map();
    /** The agent objects, kept so `restoreAll()` can read their default route. */
    agents = new Map();
    /** Agents whose next step currently carries our override. */
    armed = new Set();
    /** Official pre-step switch-notice listeners (one per agent context). */
    disposers = new Map();
    pollers = new Map();
    lastSeq = new Map();
    idlePolls = new Map();
    /** True while the poller waits for the scored turn to actually START. */
    awaitingTurnStart = new Map();
    /** Warn once per agent about a host without the model seam. */
    warned = new Set();
    constructor(opts = {}) {
        this.log = opts.log || defaultLog;
        this.restorePollMs = opts.restorePollMs ?? 2000;
        this.maxIdlePolls = opts.maxIdlePolls ?? 60;
        this.restoreOnTurnEnd = opts.restoreOnTurnEnd !== false;
    }
    /** The agent's own default route (its live options), or null. */
    defaultOf(agent) {
        const opts = agent.options;
        if (!opts?.provider || !opts?.model)
            return null;
        const effort = typeof opts.reasoningEffort === 'string' && EFFORTS.has(opts.reasoningEffort)
            ? opts.reasoningEffort
            : undefined;
        return { provider: opts.provider, model: opts.model, ...(effort === undefined ? {} : { reasoningEffort: effort }) };
    }
    /**
     * Resolve the agent-owned model seam (idempotent per agent). Also installs
     * the official pre-step switch-notice listener on the agent context.
     * @returns the handle, or undefined when the host predates dsh 0.2.2.
     */
    handle(agent) {
        this.agents.set(agent.id, agent);
        const model = agent.model;
        if (!model || typeof model.select !== 'function') {
            if (!this.warned.has(agent.id)) {
                this.warned.add(agent.id);
                this.log('warn', `agent ${agent.id} has no model seam (host < dsh 0.2.2?); scored routing stays policy-only`);
            }
            return undefined;
        }
        this.models.set(agent.id, model);
        const ctx = agent.ctx;
        if (ctx && !this.disposers.has(agent.id)) {
            try {
                const disposer = installModelSelection(ctx);
                this.disposers.set(agent.id, disposer);
                this.log('info', `model-selection notice installed for agent ${agent.id} (official installModelSelection)`);
            }
            catch (e) {
                this.log('warn', 'installModelSelection failed:', e.message);
            }
        }
        return model;
    }
    /** Select a complete route (`null` = restore the agent's own default). */
    select(agent, selection) {
        const model = this.handle(agent);
        if (!model)
            return false;
        const target = selection ?? this.defaultOf(agent);
        if (!target) {
            this.log('warn', `cannot restore the default model for agent ${agent.id}: its options name no provider/model`);
            return false;
        }
        try {
            model.select(target);
            return true;
        }
        catch (e) {
            this.log('warn', `model.select failed for agent ${agent.id}:`, e.message);
            return false;
        }
    }
    /**
     * Apply an override for the agent's next step, or null to restore the default.
     * When `restoreOnTurnEnd`, a poller watches the session log: it first waits
     * for the scored turn to START (`turn/start`), then restores the default when
     * that turn ENDS (`turn/end`). Waiting for the start matters when the scored
     * followup is queued behind another running turn.
     */
    override(agent, selection) {
        this.stopPoller(agent.id);
        if (selection === null) {
            this.armed.delete(agent.id);
            this.select(agent, null);
            return;
        }
        const model = this.handle(agent);
        if (!model)
            return;
        const current = model.current();
        const provider = selection.provider ?? current?.provider ?? agent.options?.provider;
        const modelId = selection.model ?? current?.model ?? agent.options?.model;
        if (!provider || !modelId) {
            this.log('warn', `override for agent ${agent.id} names no provider/model; ignored`);
            return;
        }
        const effort = typeof selection.reasoningEffort === 'string' && EFFORTS.has(selection.reasoningEffort)
            ? selection.reasoningEffort
            : undefined;
        if (!this.select(agent, { provider, model: modelId, ...(effort === undefined ? {} : { reasoningEffort: effort }) }))
            return;
        this.armed.add(agent.id);
        if (!this.restoreOnTurnEnd || !hasSessionEvents(agent.session))
            return;
        // dsh 0.1.5+: the session log is read through snapshotEvents()
        // (legacy `events` arrays of ≤0.1.2 hosts also work — see session-events.ts).
        const events = readSessionEvents(agent.session);
        this.lastSeq.set(agent.id, events.length ? events[events.length - 1].seq ?? 0 : -1);
        this.idlePolls.set(agent.id, 0);
        this.awaitingTurnStart.set(agent.id, true);
        const timer = setInterval(() => {
            if (!this.armed.has(agent.id)) {
                this.stopPoller(agent.id);
                return;
            }
            const evs = readSessionEvents(agent.session);
            let sawEnd = false;
            let waitingStart = this.awaitingTurnStart.get(agent.id) !== false;
            if (evs.length) {
                const last = this.lastSeq.get(agent.id) ?? -1;
                for (const ev of evs) {
                    if (typeof ev.seq !== 'number' || ev.seq <= last)
                        continue;
                    if (waitingStart && ev.type === 'turn/start') {
                        waitingStart = false;
                        this.awaitingTurnStart.set(agent.id, false);
                    }
                    else if (!waitingStart && ev.type === 'turn/end') {
                        sawEnd = true;
                        break;
                    }
                }
                this.lastSeq.set(agent.id, evs[evs.length - 1].seq ?? last);
            }
            if (sawEnd) {
                this.log('info', 'scored turn ended; restoring host model for agent ' + agent.id);
                this.restore(agent.id);
                this.stopPoller(agent.id);
                return;
            }
            const idle = (this.idlePolls.get(agent.id) || 0) + 1;
            this.idlePolls.set(agent.id, idle);
            if (idle >= this.maxIdlePolls) {
                this.log('warn', 'no scored turn start/end observed for agent ' + agent.id + '; restoring host model (safety)');
                this.restore(agent.id);
                this.stopPoller(agent.id);
            }
        }, this.restorePollMs);
        if (typeof timer.unref === 'function')
            timer.unref();
        this.pollers.set(agent.id, timer);
    }
    /** Disarm one agent and restore its default route. */
    restore(agentId) {
        this.armed.delete(agentId);
        const agent = this.agents.get(agentId);
        if (agent)
            this.select(agent, null);
    }
    stopPoller(agentId) {
        const t = this.pollers.get(agentId);
        if (t) {
            clearInterval(t);
            this.pollers.delete(agentId);
        }
    }
    /** Clear every override immediately (restoring each agent's default route). */
    restoreAll() {
        for (const id of Array.from(this.armed))
            this.restore(id);
        for (const id of Array.from(this.pollers.keys()))
            this.stopPoller(id);
    }
    /** True when an override is currently armed for the agent. */
    hasOverride(agentId) {
        return this.armed.has(agentId);
    }
    dispose() {
        this.restoreAll();
        for (const [id, dispose] of this.disposers.entries()) {
            try {
                dispose();
            }
            catch (e) {
                this.log('warn', `model-selection dispose failed for ${id}:`, e.message);
            }
        }
        this.disposers.clear();
        this.models.clear();
        this.agents.clear();
        this.armed.clear();
        this.warned.clear();
        this.lastSeq.clear();
        this.idlePolls.clear();
        this.awaitingTurnStart.clear();
    }
}
