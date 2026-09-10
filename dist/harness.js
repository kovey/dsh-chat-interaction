/**
 * The harness bridge — the DSH-facing half of the interaction layer.
 *
 * This package IS a dsh plugin, so the bridge uses the official runtime APIs
 * directly, exactly like dsh-feishu does:
 *
 *  - `createUserMessage` from @deepseek-ai/dsh-llm   (message with id/role,
 *    frozen before publication)
 *  - `defineTool` from @deepseek-ai/dsh-tools        (schema-spec → compiled
 *    registry-ready definition)
 *  - `installModelSelection` via model-selection.ts   (official scored-turn
 *    model switching seam)
 *  - `agent.followup(UserMessage)`                   (dsh-agent runtime types)
 *  - `ctx.tools.register / ctx.systemPrompt.section / ctx.provide / ctx.on`
 *    (cordis v4 extension points, wrapped by the structural `HarnessContext`
 *    below)
 *
 * The plugin entry re-exports this module (`dsh-chat-interaction/plugin`).
 * @module dsh-chat-interaction/harness
 */
import fs from 'node:fs';
import path from 'node:path';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { dshHome } from './state.js';
import { log as defaultLog } from './log.js';
import { ModelSelectionManager } from './model-selection.js';
import { readSessionEvents } from './session-events.js';
import { formatInbound } from './prompt.js';
/** True when the value already implements the flat HarnessContext contract. */
export function isHarnessContext(ctx) {
    return !!ctx && typeof ctx.roots === 'function' &&
        typeof ctx.registerTool === 'function';
}
/**
 * Adapt a REAL cordis context (as handed to a plugin's `apply`) into the flat
 * `HarnessContext` the bridge uses:
 *
 *   ctx.agents.roots()        → roots()
 *   ctx.tools.register()      → registerTool()
 *   ctx.systemPrompt.section()→ promptSection()
 *   ctx.effect(() => ...)     → onDispose()   (cordis v4; `ctx.on('dispose')`
 *                                              is the v3 API and never fires)
 *   ctx.on / ctx.provide      → on / provide
 *
 * Every accessor is optional-guarded: a partially available host degrades to a
 * no-op for that surface instead of throwing during plugin startup.
 */
export function harnessFromCordis(ctx) {
    return {
        roots: () => {
            try {
                const roots = ctx?.agents?.roots?.();
                return Array.isArray(roots) ? roots : [];
            }
            catch {
                return [];
            }
        },
        registerTool: (tool) => {
            ctx?.tools?.register?.(tool);
        },
        promptSection: (spec) => {
            ctx?.systemPrompt?.section?.(spec);
        },
        onDispose: (cleanup) => {
            if (typeof ctx?.effect === 'function') {
                ctx.effect(() => cleanup, 'dsh-chat-interaction teardown');
                return;
            }
            // cordis v3 fallback / plain-object test contexts.
            if (typeof ctx?.on === 'function')
                ctx.on('dispose', cleanup);
        },
        on: (event, listener) => {
            ctx?.on?.(event, listener);
        },
        provide: (key, value, override) => {
            ctx?.provide?.(key, value, override);
        },
    };
}
// ---------------------------------------------------------------------------
// the bridge
// ---------------------------------------------------------------------------
export class DshBridge {
    ctx;
    log;
    /** Transient model overrides for scored turns (official seam inside). */
    models;
    activeSessionFile;
    annotateScore;
    constructor(ctx, opts = {}) {
        this.ctx = ctx;
        this.log = opts.log || defaultLog;
        this.activeSessionFile = opts.activeSessionFile
            ? path.resolve(opts.activeSessionFile)
            : path.join(dshHome(), 'dsh-nvim-tui-state.json');
        this.annotateScore = opts.annotateScore !== false;
        this.models = new ModelSelectionManager({
            log: this.log,
            ...(opts.modelSelection || {}),
        });
    }
    roots() {
        try {
            return this.ctx.roots();
        }
        catch {
            return [];
        }
    }
    /**
     * The currently-active session (dsh-nvim-tui writes its state file on
     * every switch): used to route remote wakeups to the session the user is
     * looking at, instead of blindly taking roots()[0] (the oldest restored
     * session — which used to steal background tasks).
     */
    activeSessionIdOf() {
        try {
            const raw = fs.readFileSync(this.activeSessionFile, 'utf8');
            const j = JSON.parse(raw);
            if (j && typeof j.sessionId === 'string' && j.sessionId)
                return j.sessionId;
        }
        catch { /* file absent */ }
        return undefined;
    }
    pickRootAgent() {
        const roots = this.roots();
        if (roots.length === 0)
            return undefined;
        const activeId = this.activeSessionIdOf();
        if (activeId !== undefined) {
            const hit = roots.find((a) => a.session && a.session.id === activeId);
            if (hit)
                return hit;
        }
        // fallback: newest registered root (registration order, last = newest)
        return roots[roots.length - 1] ?? roots[0];
    }
    /** Project cwd of the active root agent's session, else process.cwd(). */
    cwdOf() {
        try {
            const agent = this.pickRootAgent();
            const cwd = agent && agent.session && agent.session.header && agent.session.header.cwd;
            if (cwd)
                return cwd;
        }
        catch { /* best effort */ }
        return process.cwd();
    }
    /** Official user-message construction (id + frozen, dsh-llm). */
    buildUserMessage(text) {
        return createUserMessage({
            content: [{ type: 'text', text }],
            source: { kind: 'user' },
        });
    }
    /** Official tool compilation (schema-spec → registry-ready, dsh-tools). */
    registerTool(spec) {
        // ToolSpec is our loose schema-spec dialect (emitted by the tool
        // factory); defineTool compiles and validates it into the official
        // registry-ready definition.
        const compile = defineTool;
        this.ctx.registerTool(compile(spec));
    }
    promptSection(name, text, order = 900) {
        try {
            this.ctx.promptSection({ name, order, text });
        }
        catch (e) {
            this.log('error', 'promptSection failed:', e.message);
        }
    }
    onDispose(cleanup) {
        try {
            this.ctx.onDispose(cleanup);
        }
        catch (e) {
            this.log('warn', 'onDispose registration failed:', e.message);
        }
    }
    on(event, listener) {
        if (typeof this.ctx.on === 'function') {
            try {
                this.ctx.on(event, listener);
            }
            catch (e) {
                this.log('warn', `on(${event}) failed:`, e.message);
            }
        }
    }
    provide(key, value, override = false) {
        if (typeof this.ctx.provide === 'function') {
            try {
                this.ctx.provide(key, value, override);
            }
            catch (e) {
                this.log('warn', 'provide failed:', e.message);
            }
        }
    }
    /**
     * Deliver one inbound message to the agent as an ordinary user turn.
     * When `ctx.score` carries a model, a transient model override is applied
     * through the official installModelSelection seam (restored when the turn
     * ends). Returns whether the followup was delivered (retry arm signal).
     */
    followup(desc, msg, ctx) {
        let agent;
        try {
            agent = this.pickRootAgent();
        }
        catch {
            agent = undefined;
        }
        if (!agent) {
            this.log('warn', 'no root agent to wake; message parked in spool:', msg.messageId || '');
            return false;
        }
        try {
            // Scored-turn model routing: apply (or clear) the transient override.
            // The official runtime injects provider/effort only when defined,
            // so a model-only override keeps the agent's default route.
            const score = ctx && ctx.score;
            const selection = score && score.model
                ? {
                    ...(score.provider !== undefined ? { provider: score.provider } : {}),
                    model: score.model,
                    ...(score.reasoningEffort !== undefined ? { reasoningEffort: score.reasoningEffort } : {}),
                }
                : null;
            try {
                this.models.override(agent, selection);
                if (selection) {
                    this.log('info', `model override for ${agent.id}: ${selection.provider ? selection.provider + '/' : ''}${selection.model} (score=${score.score.toFixed(2)})`);
                }
            }
            catch (e) {
                this.log('warn', 'model override failed; continuing with host model:', e.message);
            }
            const userMsg = this.buildUserMessage(formatInbound(desc, msg, ctx && ctx.note, this.annotateScore ? score : undefined));
            agent.followup(userMsg);
            this.log('info', 'followup delivered:', msg.messageId || '', 'agent=' + agent.id);
            return true;
        }
        catch (e) {
            this.log('error', 'followup failed:', e.message);
            return false;
        }
    }
    /** Release transient model overrides, their pollers, and the installed refs. */
    dispose() {
        try {
            this.models.dispose();
        }
        catch (e) {
            this.log('warn', 'model selection dispose failed:', e.message);
        }
    }
    /**
     * Retry-guard outcome instrumentation, split into two idempotent parts:
     *
     *  - `baseline()`: fix the scan baseline to the current end of the
     *    session log. Called at arm time (and only then) — events already
     *    present are never classified, and concurrent cycles cannot steal
     *    each other's outcomes.
     *  - `probe()`: classify the newest turn/end appended AFTER the baseline.
     *    Self-establishes the baseline on first use (direct callers).
     *
     * Reads the session log through the 0.1.5+ snapshotEvents accessor
     * (see session-events.ts); the `turn/end` envelope and the
     * `reason.kind === 'error'` + `reason.error.code` shape are unchanged
     * in 0.1.5-rc.1, so the retryable-code classification carries over.
     */
    createOutcomeProbe(retryableCodes) {
        let lastSeq = -1;
        let established = false;
        const readEvents = () => {
            let session;
            try {
                session = this.pickRootAgent()?.session;
            }
            catch {
                session = undefined;
            }
            return readSessionEvents(session);
        };
        const baseline = () => {
            if (established)
                return;
            established = true;
            const events = readEvents();
            if (events.length)
                lastSeq = events[events.length - 1].seq ?? 0;
        };
        const probe = () => {
            if (!established)
                baseline();
            const events = readEvents();
            if (events.length === 0)
                return null;
            let outcome = null;
            for (let i = events.length - 1; i >= 0; i--) {
                const ev = events[i];
                if (typeof ev.seq !== 'number' || ev.seq <= lastSeq)
                    break;
                if (ev.type === 'turn/end') {
                    const reason = (ev.data || {}).reason || {};
                    if (reason.kind === 'error') {
                        const code = (reason.error && reason.error.code) || '';
                        outcome = retryableCodes.includes(code) ? 'retryable-error' : 'settled';
                    }
                    else {
                        outcome = 'settled';
                    }
                    break;
                }
            }
            const latest = events[events.length - 1].seq;
            if (typeof latest === 'number')
                lastSeq = latest;
            return outcome;
        };
        return { probe, baseline };
    }
}
