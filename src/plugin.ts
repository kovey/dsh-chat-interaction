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
import path from 'node:path'
import { fileURLToPath } from 'node:url'
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
import { askViaChannel, resolveContainedPath, setupAuthorization } from './approval.js'
import { applyScoreConfig, createScorer, resolveScoringConfig } from './scoring.js'
import { readModelCatalog, reportDropped, sanitizeModelOverride } from './model-catalog.js'
import type { ResolvedScoringConfig, ScoringConfig } from './scoring.js'
import { createRouter, resolveRouterConfig } from './router.js'
import type { RouterConfig } from './router.js'
import { createFeishuChannel } from './adapters/feishu.js'
import type { FeishuChannelConfig } from './adapters/feishu.js'
import { createWeComChannel } from './adapters/wecom.js'
import type { WeComChannelConfig } from './adapters/wecom.js'
import { createWeComBotChannel } from './adapters/wecom-bot.js'
import type { WeComBotChannelConfig } from './adapters/wecom-bot.js'
import { ChannelLease } from './lease.js'
import type { InstanceRole } from './lease.js'
import { expandHome, readFileSafe, statePaths, writeActiveChat, writeFileSafe } from './state.js'
import { getLogFile, log, setLogFile } from './log.js'
import type { LogFn } from './log.js'
import type { RetryOptions } from './retry.js'
import type { AuthState, FollowupContext, InboundMessage, ListenerStatus } from './types.js'

export const name = 'dsh-chat-interaction'
export const inject = ['tools', 'agents', 'systemPrompt']

/**
 * The package version, for logs and support ("which version are you on?").
 * Walks up from the compiled module so it works both from `dist/` and from
 * the test build; never throws.
 */
const PACKAGE_VERSION: string = (() => {
    try {
        let dir = path.dirname(fileURLToPath(import.meta.url))
        for (let i = 0; i < 4; i++) {
            const candidate = path.join(dir, 'package.json')
            if (fs.existsSync(candidate)) {
                const j = JSON.parse(fs.readFileSync(candidate, 'utf8')) as { name?: string; version?: string }
                if (j && j.name === name && typeof j.version === 'string') return j.version
            }
            dir = path.dirname(dir)
        }
    } catch { /* fall through */ }
    return 'unknown'
})()

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
        /**
         * Require the clicker to be on the project's approver list
         * (`<project>/.dsh/<channel>-approvers.txt`, one platform user id per line).
         * Default false = anyone in the bound chat may decide, which is the
         * historical behaviour; a 24×7 service should turn this on.
         */
        requireApproverList?: boolean
        /** Deliver the artifacts an approval card names (default true when the channel supports files). */
        sendApprovalArtifacts?: boolean
        /**
         * Accept ONLY nonce-bound card clicks as approval answers (default false).
         * With it on, a typed `yes`/`同意` is answered and recorded as
         * `text-rejected` but never decides — turn it on when the replay story
         * must be literally true.
         */
        requireTokenClick?: boolean
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
    /**
     * Channel lease: only one instance owns a channel's connection at a time.
     * An `interactive` (TUI) instance preempts a `service` (24×7 headless)
     * holder; the service takes the channel back once the TUI releases or its
     * heartbeat expires — the launchd-service ⇄ TUI heartbeat takeover.
     */
    lease?: {
        enabled?: boolean
        /** Lease directory; default the DSH home (~/.dsh). */
        dir?: string
        /** A heartbeat older than this counts as a dead owner (default 90s). */
        ttlMs?: number
        /** Renewal interval (default 30s). */
        heartbeatMs?: number
        /**
         * This process's role. Default: `service` when any channel is
         * configured with `role: 'listener'` (a 24×7 deployment), else
         * `interactive`.
         */
        role?: InstanceRole
    }
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
        requireApproverList: boolean
        sendApprovalArtifacts: boolean
        requireTokenClick: boolean
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
        requireApproverList: false,
        sendApprovalArtifacts: true,
        requireTokenClick: false,
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
    /** Per-channel leases (heartbeat takeover); empty when disabled. */
    leases: Map<string, ChannelLease>
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
/** Resources created during startup, so a crash can clean them up. */
interface ApplyArtifacts {
    hub?: InteractionHub
    bridge?: DshBridge
    leases?: Map<string, ChannelLease>
}

/**
 * Apply the layer to a harness context (cordis plugin entry point).
 *
 * HARD RULE: this function NEVER throws. A plugin bug must not take the host
 * session down — any startup failure is logged with its stack (our own log
 * file) and the layer is disabled for that session.
 */
export function apply(ctx: HarnessContext | CordisContextLike, config: PluginConfig = {}): DshChatLayer | null {
    const artifacts: ApplyArtifacts = {}
    try {
        return applyInner(ctx, config, artifacts)
    } catch (e) {
        const err = e as Error
        // A crash may happen BEFORE the configured log file was applied
        // (e.g. a hostile config object) — fall back to the default log so the
        // stack is always recoverable. `log()` also mirrors errors to stderr,
        // which is what the host prints.
        try {
            if (!getLogFile()) setLogFile(expandHome('~/.dsh/chat-interaction.log'))
        } catch { /* best effort */ }
        try {
            log('error', `${name} startup CRASHED — plugin disabled, host continues. Stack:`, (err && err.stack) || String(err))
        } catch { /* logging must never throw */ }
        try { artifacts.hub?.teardown() } catch { /* best effort */ }
        try { artifacts.bridge?.dispose() } catch { /* best effort */ }
        try { for (const l of artifacts.leases?.values() ?? []) l.dispose() } catch { /* best effort */ }
        return null
    }
}

function applyInner(
    ctx: HarnessContext | CordisContextLike,
    config: PluginConfig,
    artifacts: ApplyArtifacts
): DshChatLayer | null {
    const cfg = resolvePluginConfig(config)
    if (!cfg.enabled) return null
    setLogFile(expandHome(cfg.logFile))
    log('info', `${name} v${PACKAGE_VERSION} applying; channels: ${Object.keys(config.channels || {}).join(', ') || '(none)'}`)

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
    artifacts.bridge = bridge
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
            // Level → execution model mapping (fills score.model/provider/...),
            // then guarded by the provider's declared catalog so a typo can
            // never point the scored turn at a non-existent model.
            let score = followup && followup.score
                ? applyScoreConfig(scoring, followup.score)
                : undefined
            if (score && (score.model || score.reasoningEffort)) {
                const { applied, dropped } = sanitizeModelOverride(readModelCatalog(), {
                    model: score.model,
                    provider: score.provider,
                    reasoningEffort: score.reasoningEffort,
                })
                if (dropped.length) reportDropped(dropped, config.log || log)
                score = { ...score, ...applied }
            }
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
    artifacts.hub = hub
    for (const adapter of adapters.values()) hub.addChannel(adapter)
    log('info', `channels ready: ${Array.from(adapters.keys()).join(', ')}`)

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

    // ---- channel lease (heartbeat takeover between service and TUI) --------
    const channelEntriesCfg = (config.channels || {}) as Record<string, ChannelEntryConfig | undefined>
    const serviceMode = Object.values(channelEntriesCfg).some((c) => c?.role === 'listener')
    const instanceRole: InstanceRole = (config.lease && config.lease.role) || (serviceMode ? 'service' : 'interactive')
    const leaseEnabled = config.lease?.enabled !== false
    const leases = new Map<string, ChannelLease>()

    /** Channels this instance is supposed to be serving (survives a takeover). */
    const desired = new Set<string>()

    const connectChannel = async (channel: string): Promise<ListenerStatus & { ok: boolean }> => {
        const lease = leases.get(channel)
        if (lease) {
            const r = lease.acquire()
            if (!r.ok) {
                log('warn', `connect(${channel}) refused: ${r.reason}`)
                return {
                    ok: false,
                    connected: false,
                    error: `${r.reason} — 另一个实例正在服务该渠道（可用 lease.enabled:false 关闭租约接管）`,
                }
            }
            lease.start() // renew + watch for preemption
        }
        const st = await hub.connect(channel)
        if (!st.ok && lease) lease.release() // never hold a lease for a dead connection
        if (st.ok) desired.add(channel)
        return st
    }

    const disconnectChannel = async (channel: string): Promise<ListenerStatus & { ok: boolean }> => {
        desired.delete(channel)
        const st = await hub.disconnect(channel)
        leases.get(channel)?.release()
        return st
    }

    // ---- per-channel: tools + prompt + listener control --------------------
    const listenerControl = (channel: string, action: string): Promise<ListenerStatus & { ok: boolean }> => {
        if (action === 'start') return connectChannel(channel)
        if (action === 'stop') return disconnectChannel(channel)
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
        askCard: async (agent, cmd, signal, subject) => {
            const channel = channelOfAgent(agent)
            const adapter = adapters.get(channel)
            if (!adapter) return null
            const paths = statePaths(channel, cwdOfAgent(agent))
            const chatId = readFileSafe(paths.p2pChat) || readFileSafe(paths.activeChat)
            // The approver list is PROJECT-local (no global fallback): a decision
            // that lands in the wrong chat is a decision about the wrong project.
            const approvers = cfg.permission.requireApproverList
                ? readFileSafe(paths.approvers)
                      .split('\n')
                      .map((s) => s.trim())
                      .filter(Boolean)
                : []
            return askViaChannel({
                chatId,
                log: config.log || log,
                label: adapter.label,
                ...(subject === undefined ? {} : { subject }),
                answerTimeoutMs: cfg.permission.answerTimeoutMs,
                approvers,
                requireTokenClick: cfg.permission.requireTokenClick,
                respond: async (text) => {
                    if (chatId) await hub.sendText(channel, chatId, text)
                },
                onDecision: (entry) => {
                    // Every decision (and every refusal) is a row: the IM half of
                    // the audit trail. A failure here must not change the decision.
                    try {
                        fs.appendFileSync(paths.approvalLedger, JSON.stringify(entry) + '\n')
                    } catch (e) {
                        (config.log || log)('error', 'approval ledger write failed:', (e as Error).message)
                    }
                },
                ...(adapter.sendFile
                    ? {
                          sendFile: async (file: { path: string }) => {
                              // Artifacts are workspace-relative in the suite's
                              // context block, but the block is payload data (a
                              // model can influence it): resolve it and prove it
                              // stays inside the project before shipping the file.
                              const contained = resolveContainedPath(cwdOfAgent(agent), file.path)
                              if (!contained) {
                                  (config.log || log)(
                                      'warn',
                                      `approval artifact outside the project rejected: ${file.path}`
                                  )
                                  return { ok: false, error: 'artifact outside the project workspace' }
                              }
                              return hub.sendFile(channel, chatId ?? '', { path: contained })
                          },
                          sendArtifacts: cfg.permission.sendApprovalArtifacts,
                      }
                    : {}),
                sendCard: (id, title, body, buttons) => hub.sendCard(channel, id, { title, body, buttons }),
                waitReply: async (id, t, sig) => {
                    const r = await hub.waitReply(channel, id, t, sig)
                    if (!r.ok || r.timedOut) return null
                    return { channel, chatId: id, chatType: 'p2p', text: r.text, isCardAction: r.isCardAction, senderId: r.senderId, messageId: r.messageId }
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
        for (const lease of leases.values()) lease.dispose() // stop heartbeats + release
        bridge.dispose() // restore any transient model overrides + stop pollers
        log('info', `${name} torn down`)
    }
    bridge.onDispose(teardown)
    if (typeof process !== 'undefined' && typeof process.on === 'function') {
        for (const sig of ['SIGINT', 'SIGTERM'] as const) {
            try { process.once(sig, teardown) } catch { /* best effort */ }
        }
    }

    // ---- leases: created for every channel, engaged on connect -------------
    if (leaseEnabled) {
        for (const chName of adapters.keys()) {
            const lease = new ChannelLease({
                channel: chName,
                role: instanceRole,
                dir: config.lease?.dir ? expandHome(config.lease.dir) : undefined,
                ttlMs: config.lease?.ttlMs,
                heartbeatMs: config.lease?.heartbeatMs,
                log: config.log,
            })
            lease.onLost(() => {
                // another instance took the channel over: stop serving it here,
                // keep wanting it (desired) so we take it back when they go away
                log('warn', `lease lost on ${chName}; disconnecting this instance's listener`)
                void hub.disconnect(chName).catch(() => { /* best effort */ })
            })
            lease.onAcquired(() => {
                // the other instance released (or went stale): take the channel back
                if (!desired.has(chName)) return
                log('info', `lease re-acquired on ${chName}; reconnecting this instance's listener`)
                void connectChannel(chName).catch(() => { /* best effort */ })
            })
            leases.set(chName, lease)
        }
        artifacts.leases = leases
        log('info', `channel lease enabled (role=${instanceRole}, takeover=${instanceRole === 'interactive' ? 'preempts service' : 'waits for free'})`)
    }

    // ---- connection policy: opt-in by default ------------------------------
    for (const [chName, chCfg] of Object.entries(config.channels || {})) {
        if (chCfg?.role === 'listener') {
            log('info', `role=listener: connecting channel ${chName} at startup (deployment decision)`)
            void connectChannel(chName).then((s) => {
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
        leases,
        config: cfg,
        scoring,
        connect: (channel) => connectChannel(channel),
        disconnect: (channel) => disconnectChannel(channel),
        status: (channel) => hub.status(channel),
        authState,
        teardown,
    }
    log('info', 'registering service export (chatInteraction)…')
    if (typeof harness.provide === 'function') {
        harness.provide('chatInteraction', layer, true)
    } else {
        try { (ctx as unknown as Record<string, unknown>).chatInteraction = layer } catch { /* best effort */ }
    }

    log('info', `${name} ready`)
    return layer
}
