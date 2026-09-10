import type { Context } from '@deepseek-ai/cordis';
import type { LogFn } from './log.js';
import { ModelSelectionManager } from './model-selection.js';
import type { ModelSelectionManagerOptions } from './model-selection.js';
import type { SessionEventsSource } from './session-events.js';
import type { FollowupContext, InboundMessage } from './types.js';
import type { ChannelDescriptor } from './types.js';
import type { ToolSpec } from './tools.js';
/**
 * The agent slice the bridge uses. Structurally matches the real
 * `Agent` from @deepseek-ai/dsh-agent (runtime-types.d.ts): `ctx` is the
 * REAL cordis Context — the official installModelSelection seam needs it.
 * `session` carries the official 0.1.5+ event accessors (snapshotEvents /
 * eventAt) with the legacy `events` array kept for older hosts.
 */
export interface HarnessAgent {
    id: string;
    followup(message: unknown): unknown;
    /** Agent-scoped context (official model-selection install target). */
    ctx?: Context;
    session?: SessionEventsSource;
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
    roots(): HarnessAgent[];
    /** Register one compiled tool. */
    registerTool(tool: unknown): void;
    /** Add a system-prompt section. */
    promptSection(spec: {
        name: string;
        order?: number;
        text: string;
    }): void;
    /** Register a teardown cleanup. */
    onDispose(cleanup: () => void): void;
    /** Optional waterfall events (tools/pre-execute, approval/request). */
    on?(event: string, listener: (...args: any[]) => unknown): void;
    /** Optional service export. */
    provide?(key: string, value: unknown, override?: boolean): void;
}
/** True when the value already implements the flat HarnessContext contract. */
export declare function isHarnessContext(ctx: unknown): ctx is HarnessContext;
/** Structural slice of a real cordis context (its host services). */
export interface CordisContextLike {
    agents?: {
        roots?: () => unknown;
    };
    tools?: {
        register?: (tool: unknown) => unknown;
    };
    systemPrompt?: {
        section?: (spec: {
            name: string;
            order?: number;
            text: string;
        }) => unknown;
    };
    /** cordis v4 fiber teardown. */
    effect?: (execute: () => unknown, label?: string) => unknown;
    /** Event bus (waterfall listeners). */
    on?: (event: string, listener: (...args: any[]) => unknown) => unknown;
    /** Service export. */
    provide?: (key: string, value: unknown, override?: boolean) => unknown;
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
export declare function harnessFromCordis(ctx: CordisContextLike | null | undefined): HarnessContext;
export interface DshBridgeOptions {
    log?: LogFn;
    /** State file of the active session (e.g. dsh-nvim-tui-state.json). */
    activeSessionFile?: string;
    /** Annotate scored turns with 消息评分 lines (default true). */
    annotateScore?: boolean;
    /** Model-override manager options (scored-turn routing). */
    modelSelection?: ModelSelectionManagerOptions;
}
export declare class DshBridge {
    readonly ctx: HarnessContext;
    readonly log: LogFn;
    /** Transient model overrides for scored turns (official seam inside). */
    readonly models: ModelSelectionManager;
    private readonly activeSessionFile;
    private readonly annotateScore;
    constructor(ctx: HarnessContext, opts?: DshBridgeOptions);
    roots(): HarnessAgent[];
    /**
     * The currently-active session (dsh-nvim-tui writes its state file on
     * every switch): used to route remote wakeups to the session the user is
     * looking at, instead of blindly taking roots()[0] (the oldest restored
     * session — which used to steal background tasks).
     */
    activeSessionIdOf(): string | undefined;
    pickRootAgent(): HarnessAgent | undefined;
    /** Project cwd of the active root agent's session, else process.cwd(). */
    cwdOf(): string;
    /** Official user-message construction (id + frozen, dsh-llm). */
    buildUserMessage(text: string): unknown;
    /** Official tool compilation (schema-spec → registry-ready, dsh-tools). */
    registerTool(spec: ToolSpec): void;
    promptSection(name: string, text: string, order?: number): void;
    onDispose(cleanup: () => void): void;
    on(event: string, listener: (...args: any[]) => unknown): void;
    provide(key: string, value: unknown, override?: boolean): void;
    /**
     * Deliver one inbound message to the agent as an ordinary user turn.
     * When `ctx.score` carries a model, a transient model override is applied
     * through the official installModelSelection seam (restored when the turn
     * ends). Returns whether the followup was delivered (retry arm signal).
     */
    followup(desc: ChannelDescriptor, msg: InboundMessage, ctx?: FollowupContext): boolean;
    /** Release transient model overrides, their pollers, and the installed refs. */
    dispose(): void;
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
        probe: () => 'retryable-error' | 'settled' | null;
        baseline: () => void;
    };
}
