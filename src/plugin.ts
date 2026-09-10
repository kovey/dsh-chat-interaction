/**
 * The cordis/dsh plugin entry — wires the whole layer together, mirroring
 * dsh-feishu's `apply()`:
 *
 *   config → adapters → hub → harness bridge → tools + prompt + approval
 *           → opt-in connection policy → teardown → service export
 *
 * Default policy, identical to dsh-feishu: NO connection is ever made on
 * startup (`role: 'off'`). The agent connects a channel only when the user
 * explicitly asks (`<name>_listener action=start`); a deployment may set
 * `channels.<name>.role: 'listener'` for 24×7 headless services.
 *
 * A broken plugin must never break the host session: every step is
 * defensive, and the top-level try/catch disables the layer on failure.
 * @module dsh-chat-interaction/plugin
 */
import fs from 'node:fs'
import { InteractionHub } from './hub.js'
import type { AckTextFn, HubOptions } from './hub.js'
import { DshBridge, harnessFromCordis, isHarnessContext } from './harness.js'
import type { CordisContextLike, HarnessContext } from './harness.js'
import { buildChannelTools } from './tools.js'
import type { ChannelToolDeps } from './tools.js'
import { buildPromptSection } from './prompt.js'
import { descriptorOf } from './channel.js'
import type { ChannelAdapter } from './channel.js'
import { PendingStore } from './pending.js'
import { askViaChannel, setupAuthorization } from './approval.js'
import { applyScoreConfig, createScorer, resolveScoringConfig } from './scoring.js'
import type { ResolvedScoringConfig, ScoringConfig } from './scoring.js'
import { createRouter, resolveRouterConfig } from './router.js'
import type { RouterConfig } from './router.js'
import { createFeishuChannel } from './adapters/feishu.js'
import type { FeishuChannelConfig } from './adapters/feishu.js'
import { createWeComChannel } from './adapters/wecom.js'
import type { WeComChannelConfig } from './adapters/wecom.js'
import { createWeComBotChannel } from './adapters/wecom-bot.js'
import type { WeComBotChannelConfig } from './adapters/wecom-bot.js'
import { expandHome, readFileSafe, statePaths, writeActiveChat, writeFileSafe } from './state.js'
import { log, setLogFile } from './log.js'
import type { LogFn } from './log.js'
import type { RetryOptions } from './retry.js'
import type { AuthState, FollowupContext, InboundMessage, ListenerStatus } from './types.js'

export const name = 'dsh-chat-interaction'
export const inject = ['tools', 'agents', 'systemPrompt']

/** Per-channel entry config shared by every adapter. */
export interface ChannelEntryConfig {
    /** Master switch for this channel (default true when listed). */
    enabled?: boolean
    /** `listener` = connect on startup (deployment decision); `off` = opt-in via the listener tool (default). */
    role?: 'listener' | 'off'
    /** Extra guidance lines for this channel's system-prompt section. */
    promptExtraLines?: string[]
    /** Include task-active / closing-card policy lines (default true). */
    promptTaskPolicy?: boolean
}

export type ChannelFactory = (cfg: Record<string, unknown>) => ChannelAdapter

export interface PluginConfig {
    /** Master switch; false = the layer does nothing at all. */
    enabled?: boolean
    logFile?: string
    /** JSONL tee of every inbound message. */
    spoolFile?: string
    /** Plugin pending Q&A store root (per-channel subdirs). */
    pendingDir?: string
    /** Instant receipt before agent wakeup (default on). */
    ack?: boolean | AckTextFn
    /** Model-failure redelivery guard (default on). */
    retry?: RetryOptions | false
    /** Message scoring → model routing (see scoring.ts). */
    scoring?: ScoringConfig
    /**
     * Built-in plugin autonomy: command execution / confirmation handling /
     * casual-chat replies / task continuity (see router.ts).
     * Default ON; every part degrades gracefully (no API key → rules only).
     */
    router?: RouterConfig
    permission?: {
        /** Default permission mode when no mode file exists. */
        mode?: 'auto' | 'manual'
        /** A bash call counts as channel-originated within this window after a followup. */
        activeWindowMs?: number
        /** Approval card answer timeout (fail closed). */
        answerTimeoutMs?: number
        /** L3: route ALL harness approval asks to channel cards (headless 24×7); default off. */
        bridgeHarnessApproval?: boolean
    }
    channels?: {
        feishu?: FeishuChannelConfig & ChannelEntryConfig
        /** 自建应用：HTTP 回调（加密 XML）或 feed() 推送。 */
        wecom?: WeComChannelConfig & ChannelEntryConfig
        /**
         * 智能机器人：WebSocket 长连接（wss://openws.work.weixin.qq.com），
         * 免公网回调；凭证是 botId + secret（不是 corpId/corpSecret）。
         */
        wecom_bot?: WeComBotChannelConfig & ChannelEntryConfig
    }
    /** Adapters for platforms beyond the built-ins, e.g. { dingtalk: (cfg) => ... }. */
    channelFactories?: Record<string, ChannelFactory>
    /** Custom logger override. */
    log?: LogFn
}

export interface ResolvedPluginConfig {
    enabled: boolean
    logFile: string
    spoolFile: string
    pendingDir: string
    permission: {
        mode: 'auto' | 'manual'
        activeWindowMs: number
        answerTimeoutMs: number
        bridgeHarnessApproval: boolean
    }
}

const CONFIG_DEFAULTS: ResolvedPluginConfig = {
    enabled: true,
    logFile: '~/.dsh/chat-interaction.log',
    spoolFile: '~/.dsh/chat-interaction-spool.jsonl',
    pendingDir: '~/.dsh/chat-pending',
    permission: {
        mode: 'auto',
        activeWindowMs: 600_000,
        answerTimeoutMs: 300_000,
        bridgeHarnessApproval: false,
    },
}

export function resolvePluginConfig(raw: PluginConfig = {}): ResolvedPluginConfig {
    return {
        enabled: raw.enabled !== false,
        logFile: raw.logFile || CONFIG_DEFAULTS.logFile,
        spoolFile: raw.spoolFile || CONFIG_DEFAULTS.spoolFile,
        pendingDir: raw.pendingDir || CONFIG_DEFAULTS.pendingDir,
        permission: { ...CONFIG_DEFAULTS.permission, ...(raw.permission || {}) },
    }
}

/** The assembled layer, returned by apply() and exported as a service. */
export interface DshChatLayer {
    name: string
    hub: InteractionHub
    bridge: DshBridge
    adapters: Map<string, ChannelAdapter>
    config: ResolvedPluginConfig
    scoring: ResolvedScoringConfig
    connect(channel: string): Promise<ListenerStatus>
    disconnect(channel: string): Promise<ListenerStatus>
    status(channel: string): ListenerStatus
    authState(channel: string): AuthState
    teardown(): void
}

const RETRYABLE_CODES = ['SERVER', 'TIMEOUT', 'TRANSPORT', 'RATE_LIMIT', 'EMPTY_RESPONSE'] as const

/**
 * Apply the layer to a harness context (cordis plugin entry point).
 *
 * `ctx` is either a REAL cordis context (services hang off it:
 * `ctx.agents.roots()`, `ctx.tools.register()`, `ctx.systemPrompt.section()`,
 * `ctx.effect()`, ...) or an already-flat `HarnessContext` (tests / custom
 * hosts). A real context is adapted automatically with `harnessFromCordis()`.
 *
 * Returns the assembled layer; never throws.
 */
export function apply(ctx: HarnessContext | CordisContextLike, config: PluginConfig = {}): DshChatLayer | null {
    const cfg = resolvePluginConfig(config)
    if (!cfg.enabled) return null
    setLogFile(expandHome(cfg.logFile))
    log('info', `${name} applying; channels: ${Object.keys(config.channels || {}).join(', ') || '(none)'}`)

    // Real cordis ctx → flat harness surface (the layer itself only knows the
    // flat contract; this is the single integration seam with the host).
    const harness: HarnessContext = isHarnessContext(ctx) ? ctx : harnessFromCordis(ctx)
    if (!isHarnessContext(ctx)) {
        log('info', 'cordis context detected; adapted via harnessFromCordis()')
    }

    const scoring = resolveScoringConfig(config.scoring)
    log('info', `scoring: ${scoring.enabled ? scoring.evaluator : 'disabled'}` +
        (scoring.enabled && scoring.evaluator !== 'rule' ? ` (eval model=${scoring.model})` : ''))

    const bridge = new DshBridge(harness, {
        log: config.log,
        annotateScore: scoring.annotateTurn,
        modelSelection: { restoreOnTurnEnd: scoring.restoreOnTurnEnd },
    })
    const pendingStore = new PendingStore({ dir: expandHome(cfg.pendingDir) })

    // Channel-origin tracking: agentId → { at, channel } (approval gate).
    const origin = new Map<string, { at: number; channel: string }>()

    // ---- adapters ----------------------------------------------------------
    const adapters = new Map<string, ChannelAdapter>()
    const buildAdapter = (name: string, channelCfg: ChannelEntryConfig & Record<string, unknown>): ChannelAdapter => {
        if (name === 'feishu') return createFeishuChannel(channelCfg as FeishuChannelConfig)
        if (name === 'wecom') return createWeComChannel(channelCfg as WeComChannelConfig)
        if (name === 'wecom_bot') return createWeComBotChannel(channelCfg as WeComBotChannelConfig)
        const factory = config.channelFactories?.[name]
        if (!factory) throw new Error(`no adapter for channel "${name}" (built-ins: feishu, wecom, wecom_bot; or pass channelFactories)`)
        return factory(channelCfg)
    }

    for (const [chName, chCfg] of Object.entries(config.channels || {})) {
        if (chCfg && chCfg.enabled === false) continue
        try {
            const entry = (chCfg || {}) as ChannelEntryConfig & Record<string, unknown>
            // Project-anchored media dir (agent session cwd → <repo>/.dsh/<channel>-media)
            if (entry.mediaDir === undefined) {
                entry.mediaDir = () => statePaths(chName, bridge.cwdOf()).mediaDir
            }
            adapters.set(chName, buildAdapter(chName, entry))
        } catch (e) {
            log('error', `channel ${chName} setup failed:`, (e as Error).message)
        }
    }
    // A registered factory alone enables the channel with default config.
    for (const [chName, factory] of Object.entries(config.channelFactories || {})) {
        if (adapters.has(chName) || !factory) continue
        try {
            adapters.set(chName, buildAdapter(chName, {}))
        } catch (e) {
            log('error', `channel ${chName} setup failed:`, (e as Error).message)
        }
    }
    if (adapters.size === 0) {
        log('error', `${name}: no channels enabled; layer disabled`)
        return null
    }

    // ---- hub ---------------------------------------------------------------
    const scorer = createScorer(scoring, config.log)
    const hubOpts: HubOptions = {
        log: config.log,
        spoolFile: expandHome(cfg.spoolFile),
        ack: config.ack,
        hasPendingQuestion: (channel, chatId) => pendingStore.has(channel, chatId),
        recordState: (msg: InboundMessage) => {
            const paths = statePaths(msg.channel, bridge.cwdOf())
            writeActiveChat(paths, msg.chatId, bridge.cwdOf())
            if (msg.chatType === 'p2p' && msg.chatId) {
                writeFileSafe(paths.p2pChat, msg.chatId + '\n')
            }
        },
        score: scoring.enabled ? (msg) => scorer.score(msg) : undefined,
        onFollowup: (msg: InboundMessage, followup?: FollowupContext) => {
            const adapter = adapters.get(msg.channel)
            if (!adapter) return false
            // Level → execution model mapping (fills score.model/provider/...).
            const score = followup && followup.score
                ? applyScoreConfig(scoring, followup.score)
                : undefined
            const ok = bridge.followup(descriptorOf(adapter), msg, {
                note: followup && followup.note,
                score,
            })
            if (ok) {
                const agent = bridge.pickRootAgent()
                if (agent) origin.set(agent.id, { at: Date.now(), channel: msg.channel })
            }
            return ok
        },
    }
    if (config.retry !== false) {
        const instrumentation = bridge.createOutcomeProbe(config.retry?.retryableCodes ?? RETRYABLE_CODES)
        hubOpts.retry = {
            ...(config.retry || {}),
            probe: instrumentation.probe,
            establishBaseline: instrumentation.baseline,
        }
    }
    const hub = new InteractionHub(hubOpts)
    for (const adapter of adapters.values()) hub.addChannel(adapter)

    // ---- plugin autonomy router (commands / confirmations / casual chat) ----
    const routerCfg = resolveRouterConfig(config.router)
    if (routerCfg.enabled) {
        // hub holds the options object by reference, so assigning after
        // construction is picked up by the next dispatch.
        hubOpts.router = createRouter({
            hub,
            pendingStore,
            config: { ...routerCfg, cwdOf: () => bridge.cwdOf() },
            log: config.log,
        })
        log('info', `router enabled (model=${routerCfg.model}, autoReply=${routerCfg.autoReply})`)
    }

    // ---- per-channel: tools + prompt + listener control --------------------
    const listenerControl = (channel: string, action: string): Promise<ListenerStatus & { ok: boolean }> => {
        if (action === 'start') return hub.connect(channel)
        if (action === 'stop') return hub.disconnect(channel)
        if (action === 'status') return Promise.resolve({ ...hub.status(channel), ok: true })
        return Promise.resolve({ ok: false, connected: false, error: `unknown action: ${action} (可选 start|stop|status)` })
    }

    const authState = (channel: string): AuthState => {
        try {
            const paths = statePaths(channel, bridge.cwdOf())
            const mode = readFileSafe(paths.modeFile)
            const channelEntries = (config.channels || {}) as Record<string, ChannelEntryConfig | undefined>
            return {
                ok: true,
                mode: mode === 'auto' || mode === 'manual' ? mode : cfg.permission.mode,
                allowlist: readFileSafe(paths.allowlist).split('\n').filter(Boolean),
                activeChat: readFileSafe(paths.activeChat),
                p2pChat: readFileSafe(paths.p2pChat),
                listenerRole: channelEntries[channel]?.role || 'off',
                listenerConnected: hub.status(channel).connected,
                pendingQuestions: pendingStore.listAll().filter((s) => s.startsWith(channel + ':')),
            }
        } catch (e) {
            return { ok: false, mode: 'auto', allowlist: [], activeChat: '', p2pChat: '', listenerRole: 'off', listenerConnected: false, pendingQuestions: [], error: (e as Error).message }
        }
    }

    for (const [chName, adapter] of adapters.entries()) {
        const desc = descriptorOf(adapter)
        const deps: ChannelToolDeps = {
            sendText: (chatId, text) => hub.sendText(chName, chatId, text),
            sendRichText: (chatId, title, body) => hub.sendRichText(chName, chatId, title, body),
            sendCard: (chatId, title, body, buttons) => hub.sendCard(chName, chatId, { title, body, buttons }),
            waitReply: (chatId, t, signal) => hub.waitReply(chName, chatId, t, signal),
            listenerControl: (action) => listenerControl(chName, action),
            authState: () => authState(chName),
        }
        try {
            for (const spec of buildChannelTools(desc, deps)) bridge.registerTool(spec)
            log('info', `${chName}_* tools registered`)
        } catch (e) {
            log('error', `${chName} tool registration failed:`, (e as Error).message)
        }

        try {
            const channelEntries = (config.channels || {}) as Record<string, ChannelEntryConfig | undefined>
            const entryCfg = channelEntries[chName] || {}
            bridge.promptSection(`${chName}-channel`,
                buildPromptSection(desc, {
                    extraLines: entryCfg.promptExtraLines,
                    taskPolicy: entryCfg.promptTaskPolicy,
                    scoring: scoring.enabled,
                }))
        } catch (e) {
            log('error', `${chName} prompt section failed:`, (e as Error).message)
        }
    }

    // ---- authorization (manual-mode gate + optional harness bridge) ---------
    type AgentLike = { id?: string; session?: { header?: { cwd?: string } } } | null | undefined
    const cwdOfAgent = (agent: AgentLike): string => {
        try {
            const cwd = agent && agent.session && agent.session.header && agent.session.header.cwd
            if (cwd) return cwd
        } catch { /* best effort */ }
        return bridge.cwdOf()
    }
    const channelOfAgent = (agent: AgentLike): string =>
        (agent && agent.id ? origin.get(agent.id)?.channel : undefined) || adapters.keys().next().value || 'feishu'

    setupAuthorization(bridge, {
        log: config.log || log,
        readMode: (agent) => {
            const t = readFileSafe(statePaths(channelOfAgent(agent), cwdOfAgent(agent)).modeFile)
            return t === 'auto' || t === 'manual' ? t : cfg.permission.mode
        },
        readAllowlist: (agent) =>
            readFileSafe(statePaths(channelOfAgent(agent), cwdOfAgent(agent)).allowlist)
                .split('\n').map((s) => s.trim()).filter(Boolean),
        addAllowlist: (agent, cmd) => {
            const f = statePaths(channelOfAgent(agent), cwdOfAgent(agent)).allowlist
            try {
                fs.appendFileSync(f, cmd + '\n')
                return true
            } catch {
                return false
            }
        },
        isOriginated: (agent) => {
            if (!agent || !agent.id) return false
            const m = origin.get(agent.id)
            return !!m && Date.now() - m.at < cfg.permission.activeWindowMs
        },
        askCard: async (agent, cmd, signal) => {
            const channel = channelOfAgent(agent)
            const adapter = adapters.get(channel)
            if (!adapter) return null
            const paths = statePaths(channel, cwdOfAgent(agent))
            const chatId = readFileSafe(paths.p2pChat) || readFileSafe(paths.activeChat)
            return askViaChannel({
                chatId,
                log: config.log || log,
                label: adapter.label,
                answerTimeoutMs: cfg.permission.answerTimeoutMs,
                sendCard: (id, title, body, buttons) => hub.sendCard(channel, id, { title, body, buttons }),
                waitReply: async (id, t, sig) => {
                    const r = await hub.waitReply(channel, id, t, sig)
                    if (!r.ok || r.timedOut) return null
                    return { channel, chatId: id, chatType: 'p2p', text: r.text, isCardAction: r.isCardAction }
                },
            }, cmd, signal)
        },
    }, { bridgeHarnessApproval: cfg.permission.bridgeHarnessApproval })

    // ---- teardown -----------------------------------------------------------
    let tornDown = false
    const teardown = () => {
        if (tornDown) return
        tornDown = true
        hub.teardown()
        bridge.dispose() // restore any transient model overrides + stop pollers
        log('info', `${name} torn down`)
    }
    bridge.onDispose(teardown)
    if (typeof process !== 'undefined' && typeof process.on === 'function') {
        for (const sig of ['SIGINT', 'SIGTERM'] as const) {
            try { process.once(sig, teardown) } catch { /* best effort */ }
        }
    }

    // ---- connection policy: opt-in by default ------------------------------
    for (const [chName, chCfg] of Object.entries(config.channels || {})) {
        if (chCfg?.role === 'listener') {
            log('info', `role=listener: connecting channel ${chName} at startup (deployment decision)`)
            void hub.connect(chName).then((s) => {
                if (!s.ok) log('error', `${chName} startup connect failed:`, s.error || '')
            })
        } else {
            log('info', `${chName} role=${chCfg?.role || 'off'}: 默认不连; 仅当用户明确要求时才连接 (${chName}_listener start)`)
        }
    }

    // ---- service export -----------------------------------------------------
    const layer: DshChatLayer = {
        name,
        hub,
        bridge,
        adapters,
        config: cfg,
        scoring,
        connect: (channel) => hub.connect(channel),
        disconnect: (channel) => hub.disconnect(channel),
        status: (channel) => hub.status(channel),
        authState,
        teardown,
    }
    if (typeof harness.provide === 'function') {
        harness.provide('chatInteraction', layer, true)
    } else {
        try { (ctx as unknown as Record<string, unknown>).chatInteraction = layer } catch { /* best effort */ }
    }

    log('info', `${name} ready`)
    return layer
}
