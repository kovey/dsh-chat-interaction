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
import fs from 'node:fs'
import path from 'node:path'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import { dshHome } from './state.js'
import { log as defaultLog } from './log.js'
import type { LogFn } from './log.js'
import { ModelSelectionManager } from './model-selection.js'
import type { ModelSelectionManagerOptions, ModelOverride } from './model-selection.js'
import { readSessionEvents } from './session-events.js'
import type { SessionEventsSource } from './session-events.js'
import type { FollowupContext, InboundMessage } from './types.js'
import { formatInbound } from './prompt.js'
import type { ChannelDescriptor } from './types.js'
import type { ToolSpec } from './tools.js'

// ---------------------------------------------------------------------------
// structural harness surface (the slice of the real ctx / Agent we use)
// ---------------------------------------------------------------------------

/**
 * The agent slice the bridge uses. Structurally matches the real
 * `Agent` from @deepseek-ai/dsh-agent (runtime-types.d.ts): `ctx` is the
 * REAL cordis Context — the official installModelSelection seam needs it.
 * `session` carries the official 0.1.5+ event accessors (snapshotEvents /
 * eventAt) with the legacy `events` array kept for older hosts.
 */
export interface HarnessAgent {
    id: string
    followup(message: unknown): unknown
    /** Agent-scoped context (official model-selection install target). */
    ctx?: Context
    session?: SessionEventsSource
}

/**
 * The context slice the bridge needs — the verified cordis v4 extension
 * points of a real harness ctx (ctx.agents.roots(), ctx.tools.register(),
 * ctx.systemPrompt.section(), ctx.effect(), ctx.on(), ctx.provide()).
 *
 * A REAL cordis context does not have this shape (its services hang off the
 * context: `ctx.agents.roots()`, `ctx.tools.register()`, ...). `apply()`
 * accepts either form and adapts a real context with `harnessFromCordis()`.
 */
export interface HarnessContext {
    /** List root agents. */
    roots(): HarnessAgent[]
    /** Register one compiled tool. */
    registerTool(tool: unknown): void
    /** Add a system-prompt section. */
    promptSection(spec: { name: string; order?: number; text: string }): void
    /** Register a teardown cleanup. */
    onDispose(cleanup: () => void): void
    /** Optional waterfall events (tools/pre-execute, approval/request). */
    on?(event: string, listener: (...args: any[]) => unknown): void
    /** Optional service export. */
    provide?(key: string, value: unknown, override?: boolean): void
}

/** True when the value already implements the flat HarnessContext contract. */
export function isHarnessContext(ctx: unknown): ctx is HarnessContext {
    return !!ctx && typeof (ctx as HarnessContext).roots === 'function' &&
        typeof (ctx as HarnessContext).registerTool === 'function'
}

/** Structural slice of a real cordis context (its host services). */
export interface CordisContextLike {
    agents?: { roots?: () => unknown }
    tools?: { register?: (tool: unknown) => unknown }
    systemPrompt?: { section?: (spec: { name: string; order?: number; text: string }) => unknown }
    /** cordis v4 fiber teardown. */
    effect?: (execute: () => unknown, label?: string) => unknown
    /** Event bus (waterfall listeners). */
    on?: (event: string, listener: (...args: any[]) => unknown) => unknown
    /** Service export. */
    provide?: (key: string, value: unknown, override?: boolean) => unknown
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
export function harnessFromCordis(ctx: CordisContextLike | null | undefined): HarnessContext {
    return {
        roots: () => {
            try {
                const roots = ctx?.agents?.roots?.()
                return Array.isArray(roots) ? (roots as HarnessAgent[]) : []
            } catch {
                return []
            }
        },
        registerTool: (tool: unknown) => {
            ctx?.tools?.register?.(tool)
        },
        promptSection: (spec) => {
            ctx?.systemPrompt?.section?.(spec)
        },
        onDispose: (cleanup: () => void) => {
            if (typeof ctx?.effect === 'function') {
                ctx.effect(() => cleanup, 'dsh-chat-interaction teardown')
                return
            }
            // cordis v3 fallback / plain-object test contexts.
            if (typeof ctx?.on === 'function') ctx.on('dispose', cleanup)
        },
        on: (event: string, listener: (...args: any[]) => unknown) => {
            ctx?.on?.(event, listener)
        },
        provide: (key: string, value: unknown, override?: boolean) => {
            ctx?.provide?.(key, value, override)
        },
    }
}

export interface DshBridgeOptions {
    log?: LogFn
    /** State file of the active session (e.g. dsh-nvim-tui-state.json). */
    activeSessionFile?: string
    /** Annotate scored turns with 消息评分 lines (default true). */
    annotateScore?: boolean
    /** Model-override manager options (scored-turn routing). */
    modelSelection?: ModelSelectionManagerOptions
}

// ---------------------------------------------------------------------------
// the bridge
// ---------------------------------------------------------------------------

export class DshBridge {
    readonly ctx: HarnessContext
    readonly log: LogFn
    /** Transient model overrides for scored turns (official seam inside). */
    readonly models: ModelSelectionManager
    private readonly activeSessionFile: string
    private readonly annotateScore: boolean

    constructor(ctx: HarnessContext, opts: DshBridgeOptions = {}) {
        this.ctx = ctx
        this.log = opts.log || defaultLog
        this.activeSessionFile = opts.activeSessionFile
            ? path.resolve(opts.activeSessionFile)
            : path.join(dshHome(), 'dsh-nvim-tui-state.json')
        this.annotateScore = opts.annotateScore !== false
        this.models = new ModelSelectionManager({
            log: this.log,
            ...(opts.modelSelection || {}),
        })
    }

    roots(): HarnessAgent[] {
        try { return this.ctx.roots() } catch { return [] }
    }

    /**
     * The currently-active session (dsh-nvim-tui writes its state file on
     * every switch): used to route remote wakeups to the session the user is
     * looking at, instead of blindly taking roots()[0] (the oldest restored
     * session — which used to steal background tasks).
     */
    activeSessionIdOf(): string | undefined {
        try {
            const raw = fs.readFileSync(this.activeSessionFile, 'utf8')
            const j = JSON.parse(raw) as { sessionId?: string }
            if (j && typeof j.sessionId === 'string' && j.sessionId) return j.sessionId
        } catch { /* file absent */ }
        return undefined
    }

    pickRootAgent(): HarnessAgent | undefined {
        const roots = this.roots()
        if (roots.length === 0) return undefined
        const activeId = this.activeSessionIdOf()
        if (activeId !== undefined) {
            const hit = roots.find((a) => a.session && a.session.id === activeId)
            if (hit) return hit
        }
        // fallback: newest registered root (registration order, last = newest)
        return roots[roots.length - 1] ?? roots[0]
    }

    /** Project cwd of the active root agent's session, else process.cwd(). */
    cwdOf(): string {
        try {
            const agent = this.pickRootAgent()
            const cwd = agent && agent.session && agent.session.header && agent.session.header.cwd
            if (cwd) return cwd
        } catch { /* best effort */ }
        return process.cwd()
    }

    /** Official user-message construction (id + frozen, dsh-llm). */
    buildUserMessage(text: string): unknown {
        return createUserMessage({
            content: [{ type: 'text', text }],
            source: { kind: 'user' },
        })
    }

    /** Official tool compilation (schema-spec → registry-ready, dsh-tools). */
    registerTool(spec: ToolSpec): void {
        // ToolSpec is our loose schema-spec dialect (emitted by the tool
        // factory); defineTool compiles and validates it into the official
        // registry-ready definition.
        const compile = defineTool as (options: unknown) => unknown
        this.ctx.registerTool(compile(spec))
    }

    promptSection(name: string, text: string, order = 900): void {
        try { this.ctx.promptSection({ name, order, text }) } catch (e) {
            this.log('error', 'promptSection failed:', (e as Error).message)
        }
    }

    onDispose(cleanup: () => void): void {
        try { this.ctx.onDispose(cleanup) } catch (e) {
            this.log('warn', 'onDispose registration failed:', (e as Error).message)
        }
    }

    on(event: string, listener: (...args: any[]) => unknown): void {
        if (typeof this.ctx.on === 'function') {
            try { this.ctx.on(event, listener) } catch (e) {
                this.log('warn', `on(${event}) failed:`, (e as Error).message)
            }
        }
    }

    provide(key: string, value: unknown, override = false): void {
        if (typeof this.ctx.provide === 'function') {
            try { this.ctx.provide(key, value, override) } catch (e) {
                this.log('warn', 'provide failed:', (e as Error).message)
            }
        }
    }

    /**
     * Deliver one inbound message to the agent as an ordinary user turn.
     * When `ctx.score` carries a model, a transient model override is applied
     * through the official installModelSelection seam (restored when the turn
     * ends). Returns whether the followup was delivered (retry arm signal).
     */
    followup(desc: ChannelDescriptor, msg: InboundMessage, ctx?: FollowupContext): boolean {
        let agent: HarnessAgent | undefined
        try {
            agent = this.pickRootAgent()
        } catch {
            agent = undefined
        }
        if (!agent) {
            this.log('warn', 'no root agent to wake; message parked in spool:', msg.messageId || '')
            return false
        }
        try {
            // Scored-turn model routing: apply (or clear) the transient override.
            // The official runtime injects provider/effort only when defined,
            // so a model-only override keeps the agent's default route.
            const score = ctx && ctx.score
            const selection: ModelOverride | null = score && score.model
                ? {
                    ...(score.provider !== undefined ? { provider: score.provider } : {}),
                    model: score.model,
                    ...(score.reasoningEffort !== undefined ? { reasoningEffort: score.reasoningEffort } : {}),
                }
                : null
            try {
                this.models.override(agent, selection)
                if (selection) {
                    this.log('info', `model override for ${agent.id}: ${selection.provider ? selection.provider + '/' : ''}${selection.model} (score=${score!.score.toFixed(2)})`)
                }
            } catch (e) {
                this.log('warn', 'model override failed; continuing with host model:', (e as Error).message)
            }

            const userMsg = this.buildUserMessage(formatInbound(
                desc,
                msg,
                ctx && ctx.note,
                this.annotateScore ? score : undefined
            ))
            agent.followup(userMsg)
            this.log('info', 'followup delivered:', msg.messageId || '', 'agent=' + agent.id)
            return true
        } catch (e) {
            this.log('error', 'followup failed:', (e as Error).message)
            return false
        }
    }

    /** Release transient model overrides, their pollers, and the installed refs. */
    dispose(): void {
        try { this.models.dispose() } catch (e) {
            this.log('warn', 'model selection dispose failed:', (e as Error).message)
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
    createOutcomeProbe(retryableCodes: readonly string[]): {
        probe: () => 'retryable-error' | 'settled' | null
        baseline: () => void
    } {
        let lastSeq = -1
        let established = false
        const readEvents = (): Array<{ seq?: number; type?: string; data?: unknown }> => {
            let session: HarnessAgent['session']
            try {
                session = this.pickRootAgent()?.session
            } catch {
                session = undefined
            }
            return readSessionEvents(session)
        }
        const baseline = (): void => {
            if (established) return
            established = true
            const events = readEvents()
            if (events.length) lastSeq = events[events.length - 1].seq ?? 0
        }
        const probe = (): 'retryable-error' | 'settled' | null => {
            if (!established) baseline()
            const events = readEvents()
            if (events.length === 0) return null
            let outcome: 'retryable-error' | 'settled' | null = null
            for (let i = events.length - 1; i >= 0; i--) {
                const ev = events[i]
                if (typeof ev.seq !== 'number' || ev.seq <= lastSeq) break
                if (ev.type === 'turn/end') {
                    const reason = ((ev.data as { reason?: { kind?: string; error?: { code?: string } } }) || {}).reason || {}
                    if (reason.kind === 'error') {
                        const code = (reason.error && reason.error.code) || ''
                        outcome = retryableCodes.includes(code) ? 'retryable-error' : 'settled'
                    } else {
                        outcome = 'settled'
                    }
                    break
                }
            }
            const latest = events[events.length - 1].seq
            if (typeof latest === 'number') lastSeq = latest
            return outcome
        }
        return { probe, baseline }
    }
}
