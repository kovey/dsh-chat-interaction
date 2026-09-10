/**
 * The interaction hub — the proven inbound/outbound pipeline of dsh-feishu,
 * lifted out of the plugin and generalized over channels.
 *
 * One hub instance serves every registered channel:
 *
 *   adapter → InboundMessage → dedupe → spool → state → waiter? → router
 *           → instant ack → agent followup (harness bridge) → retry guard
 *
 * and the agent-side tool surface:
 *
 *   send_text / send_richText / send_card / wait_reply / listener control
 *
 * The hub itself is platform- and harness-agnostic: channels implement
 * `ChannelAdapter`, the harness bridge implements `onFollowup`. That is what
 * makes Feishu, WeCom or any future platform a configuration choice, not a
 * rewrite.
 * @module dsh-chat-interaction/hub
 */
import fs from 'node:fs'
import path from 'node:path'
import type { ChannelAdapter } from './channel.js'
import { RetryGuard } from './retry.js'
import type { RetryOptions } from './retry.js'
import { log as defaultLog } from './log.js'
import type { LogFn } from './log.js'
import type {
    ButtonSpec,
    CardSpec,
    FollowupContext,
    InboundMessage,
    ListenerStatus,
    ScoreResult,
    SendResult,
    WaitResult,
} from './types.js'

/** The router's verdict for one inbound message. */
export interface RouterDecision {
    /** The plugin-side router handled it itself (no agent turn needed). */
    handled: boolean
    /** Wake the agent with this message. */
    followup: boolean
    /** Routing mode label, for logs / acks (command / chat / requirement / ...). */
    mode?: string
    /** Extra context appended to the agent turn. */
    followupNote?: string
    /**
     * Replace the text of the agent turn (e.g. a disambiguation replay: the
     * user clicked "1 新指令" on message X — the agent must see X, not "1").
     * The spool already holds the original inbound text.
     */
    followupText?: string
}

export type MessageRouter = (msg: InboundMessage) => RouterDecision | Promise<RouterDecision>

/** Instant-receipt text by mode; return null/'' to skip the ack. */
export type AckTextFn = (msg: InboundMessage, mode?: string) => string | null

export interface HubOptions {
    log?: LogFn
    /** JSONL tee: every inbound message is appended here. */
    spoolFile?: string
    /** Instant receipt before waking the agent (default on). */
    ack?: boolean | AckTextFn
    /**
     * Plugin-side routing (command autonomy / confirmations / casual chat).
     * Omitted = every message wakes the agent.
     */
    router?: MessageRouter
    /** Model-failure redelivery guard; false disables it. */
    retry?: RetryOptions | false
    /**
     * Plugin-side pending-question store check (bypasses wait_reply consumption).
     */
    hasPendingQuestion?: (channel: string, chatId: string) => boolean
    /** Called for every inbound message (active-chat / p2p-chat state). */
    recordState?: (msg: InboundMessage) => void
    /**
     * Score the message (complexity 0..1) to route it to an execution model.
     * Runs after the instant ack, before the followup; null = unscored.
     * A throwing scorer never blocks delivery.
     */
    score?: (msg: InboundMessage) => Promise<ScoreResult | null>
    /**
     * Wake the agent. Returns whether the followup was delivered. This is the
     * single seam to the harness — see `harness.ts` / `plugin.ts`.
     * `ctx.score` carries the scoring verdict when scoring produced one.
     */
    onFollowup?: (msg: InboundMessage, ctx?: FollowupContext) => boolean
    waitTimeoutDefaultMs?: number
    waitTimeoutMaxMs?: number
}

interface WaiterEntry {
    resolve: (r: WaitResult) => void
    reject: (e: Error) => void
    cleanup: () => void
}

const DEFAULT_ACK: AckTextFn = (msg, mode) => {
    const hasImages = !!(msg.imagePaths && msg.imagePaths.length)
    if (hasImages) return '收到图片，马上查看，稍等～'
    if (mode === 'bugfix') return '[处理中] 收到，正在排查，稍后在此闭环。'
    if (mode === 'requirement') return '收到需求，开始分析，稍后回复方案。'
    if (mode === 'task') return '收到，任务进行中，已转交处理～'
    if (msg.isCardAction) return '收到，开始处理～'
    return '收到，正在处理，稍后回复～'
}

function parseButtonSpec(spec: string): ButtonSpec {
    const parts = spec.split('|')
    return { value: parts[0] || '', label: parts[1] || parts[0] || '', type: (parts[2] as ButtonSpec['type']) || 'default' }
}

export class InteractionHub {
    readonly options: HubOptions
    readonly log: LogFn

    private readonly channels = new Map<string, ChannelAdapter>()
    private readonly seen = new Set<string>()
    private readonly waiters = new Map<string, WaiterEntry[]>()
    private readonly retry: RetryGuard | null
    private tornDown = false

    constructor(options: HubOptions = {}) {
        this.options = options
        this.log = options.log || defaultLog
        this.retry = options.retry === false
            ? null
            : new RetryGuard(options.retry, {
                redeliver: (msg, note) => this.wakeAgent(msg, { note }),
                notifyExhausted: (msg) => {
                    this.sendText(msg.channel, msg.chatId,
                        '⚠️ 模型调用连续失败，已停止自动重试。请稍后重新发送任务；若持续失败，请检查模型网关/密钥配置。')
                        .catch(() => { /* best effort */ })
                },
                log: this.log,
            })
    }

    // ------------------------------------------------------------------
    // channels
    // ------------------------------------------------------------------

    /** Attach one adapter. Fails loudly on duplicate names (config error). */
    addChannel(adapter: ChannelAdapter): void {
        if (this.channels.has(adapter.name)) {
            throw new Error(`channel already registered: ${adapter.name}`)
        }
        this.channels.set(adapter.name, adapter)
        adapter.setInboundHandler((msg) => {
            void this.dispatch(msg)
        })
        this.log('info', `channel registered: ${adapter.name} (${adapter.label})`)
    }

    getChannel(name: string): ChannelAdapter | undefined {
        return this.channels.get(name)
    }

    channelNames(): string[] {
        return Array.from(this.channels.keys())
    }

    private requireChannel(name: string): ChannelAdapter {
        const ch = this.channels.get(name)
        if (!ch) throw new Error(`unknown channel: ${name}`)
        return ch
    }

    connect(name: string): Promise<ListenerStatus> {
        return this.requireChannel(name).connect()
    }

    disconnect(name: string): Promise<ListenerStatus> {
        return this.requireChannel(name).disconnect()
    }

    status(name: string): ListenerStatus {
        return this.requireChannel(name).status()
    }

    // ------------------------------------------------------------------
    // outbound (agent tool surface)
    // ------------------------------------------------------------------

    /**
     * Send plain text through a channel. Any attempt is success evidence for
     * the retry guard (the agent is demonstrably alive), mirroring the
     * plugin's trackedReplier.
     */
    sendText(channel: string, chatId: string, text: string): Promise<SendResult> {
        this.markSuccess()
        return this.requireChannel(channel).sendText(chatId, String(text ?? ''))
    }

    async sendRichText(channel: string, chatId: string, title: string, body: string): Promise<SendResult> {
        this.markSuccess()
        const ch = this.requireChannel(channel)
        if (!ch.sendRichText) return { ok: false, error: `channel ${channel} does not support rich text` }
        return ch.sendRichText(chatId, title, String(body ?? ''))
    }

    async sendCard(channel: string, chatId: string, card: CardSpec): Promise<SendResult> {
        this.markSuccess()
        const ch = this.requireChannel(channel)
        if (!ch.sendCard) return { ok: false, error: `channel ${channel} does not support cards` }
        const buttons = (card.buttons || []).map((b) => (typeof b === 'string' ? parseButtonSpec(b) : b))
        return ch.sendCard(chatId, { ...card, buttons })
    }

    /**
     * Block until the user's next message in this chat on this channel.
     * The consumed message does NOT wake the agent — the consuming tool call
     * is the agent's handling. Messages in other chats flow normally.
     */
    waitReply(channel: string, chatId: string, timeoutMs?: number, signal?: AbortSignal): Promise<WaitResult> {
        const def = this.options.waitTimeoutDefaultMs ?? 120_000
        const max = this.options.waitTimeoutMaxMs ?? 600_000
        const t = Math.min(Math.max(Number(timeoutMs) || def, 1000), max)
        const key = `${channel}|${chatId}`
        return new Promise<WaitResult>((resolve, reject) => {
            const entry: WaiterEntry = {
                resolve,
                reject,
                cleanup: () => { /* replaced below */ },
            }
            let timer: NodeJS.Timeout | null = null
            const onAbort = () => {
                removeEntry()
                reject(new Error('aborted'))
            }
            const cleanup = () => {
                if (timer) clearTimeout(timer)
                if (signal) signal.removeEventListener('abort', onAbort)
            }
            const removeEntry = () => {
                cleanup()
                const list = this.waiters.get(key)
                if (!list) return
                const i = list.indexOf(entry)
                if (i >= 0) list.splice(i, 1)
                if (list.length === 0) this.waiters.delete(key)
            }
            entry.cleanup = cleanup
            timer = setTimeout(() => {
                removeEntry()
                resolve({ ok: true, timedOut: true, text: '', messageId: '', isCardAction: false })
            }, t)
            if (typeof timer.unref === 'function') timer.unref()
            if (signal) {
                if (signal.aborted) return onAbort()
                signal.addEventListener('abort', onAbort, { once: true })
            }
            const list = this.waiters.get(key) || []
            list.push(entry)
            this.waiters.set(key, list)
        })
    }

    private takeWaiter(channel: string, chatId: string): WaiterEntry | null {
        const key = `${channel}|${chatId}`
        const list = this.waiters.get(key)
        if (!list || list.length === 0) return null
        const entry = list.shift()!
        if (list.length === 0) this.waiters.delete(key)
        try { entry.cleanup() } catch { /* best effort */ }
        return entry
    }

    // ------------------------------------------------------------------
    // inbound pipeline
    // ------------------------------------------------------------------

    /**
     * The full inbound pipeline. Never throws: failures fall back to waking
     * the agent (exactly like the plugin's dispatch catch path).
     */
    async dispatch(msg: InboundMessage): Promise<void> {
        if (this.tornDown) return
        if (!msg || !msg.chatId) return

        // 1) dedupe by message id (platforms redeliver; card spool replay is safe)
        if (msg.messageId) {
            const key = `${msg.channel}|${msg.messageId}`
            if (this.seen.has(key)) return
            this.seen.add(key)
            if (this.seen.size > 500) {
                const it = this.seen.values()
                while (this.seen.size > 300) {
                    const v = it.next()
                    if (v.done) break
                    this.seen.delete(v.value)
                }
            }
        }

        // 2) spool tee (JSON lines)
        this.tee(msg)

        // 3) active-chat state maintenance
        try { this.options.recordState?.(msg) } catch (e) {
            this.log('error', 'state update failed:', (e as Error).message)
        }

        // 4) an agent-side waiter consumes the message — unless a plugin
        //    pending question needs it, or the message carries images
        //    (the agent must SEE them as a new turn).
        try {
            const hasImages = !!(msg.imagePaths && msg.imagePaths.length)
            const pending = !!this.options.hasPendingQuestion &&
                this.options.hasPendingQuestion(msg.channel, msg.chatId)
            if (!pending && !hasImages) {
                const waiter = this.takeWaiter(msg.channel, msg.chatId)
                if (waiter) {
                    this.log('info', `message consumed by wait_reply: ${msg.channel} ${msg.chatId}`, msg.messageId || '')
                    waiter.resolve({
                        ok: true,
                        timedOut: false,
                        text: msg.text,
                        messageId: msg.messageId || '',
                        isCardAction: !!msg.isCardAction,
                    })
                    return
                }
            }
        } catch (e) {
            this.log('error', 'waiter dispatch failed:', (e as Error).message)
        }

        // 5) plugin-side routing; anything not handled wakes the agent.
        let decision: RouterDecision
        try {
            decision = await (this.options.router ? this.options.router(msg) : { handled: false, followup: true, mode: 'followup' })
        } catch (e) {
            this.log('error', 'route failed; waking agent as fallback:', (e as Error).message)
            decision = { handled: false, followup: true, mode: 'fallback' }
        }
        this.log('info', `route result: ${decision.mode || '?'} handled=${decision.handled} followup=${decision.followup}`)

        const willWake = decision.followup || !decision.handled
        if (!willWake) return

        // 6) instant receipt before the agent wakeup (user feedback during the wait)
        this.sendAck(msg, decision.mode)

        // 6.5) score the message → execution model routing
        const score = await this.scoreMessage(msg)

        // 6.9) a replay may hand the agent different text than the click value
        if (decision.followup && typeof decision.followupText === 'string') {
            msg.text = decision.followupText
        }

        // 7) wake the agent
        this.wakeAgent(msg, { note: decision.followupNote, score: score ?? undefined })
    }

    /** Score once per message; the verdict is cached for retry redeliveries. */
    private async scoreMessage(msg: InboundMessage): Promise<ScoreResult | null> {
        const cached = (msg as InboundMessage & { __score?: ScoreResult }).__score
        if (cached) return cached
        if (!this.options.score) return null
        try {
            const r = await this.options.score(msg)
            if (r) {
                ;(msg as InboundMessage & { __score?: ScoreResult }).__score = r
                this.log('info', `message scored: ${r.score.toFixed(2)} (${r.level}) → ${r.model || '默认模型'} [${r.source}]`)
            }
            return r
        } catch (e) {
            this.log('warn', 'scoring failed; following up unscored:', (e as Error).message)
            return null
        }
    }

    private wakeAgent(msg: InboundMessage, ctx: FollowupContext = {}): boolean {
        try {
            // Retry redeliveries reuse the cached verdict (no re-scoring).
            const cached = (msg as InboundMessage & { __score?: ScoreResult }).__score
            const finalCtx: FollowupContext = {
                ...ctx,
                ...(ctx.score === undefined && cached ? { score: cached } : {}),
            }
            const ok = this.options.onFollowup ? this.options.onFollowup(msg, finalCtx) : false
            if (ok && this.retry && !(msg as InboundMessage & { __retryRedelivery?: boolean }).__retryRedelivery) {
                this.retry.arm(msg, ctx.note) // arm() fixes the outcome baseline itself
            }
            return ok
        } catch (e) {
            this.log('error', 'followup failed:', (e as Error).message)
            return false
        }
    }

    private markSuccess(): void {
        try { this.retry?.markSuccess() } catch { /* best effort */ }
    }

    private sendAck(msg: InboundMessage, mode?: string): void {
        const cfg = this.options.ack
        if (cfg === false) return
        const textFn: AckTextFn = typeof cfg === 'function' ? cfg : DEFAULT_ACK
        let text: string | null
        try {
            text = textFn(msg, mode)
        } catch {
            text = null
        }
        if (!text) return
        try {
            void this.requireChannel(msg.channel).sendText(msg.chatId, text).catch(() => { /* best effort */ })
        } catch { /* best effort */ }
    }

    private tee(msg: InboundMessage): void {
        const f = this.options.spoolFile
        if (!f) return
        try {
            fs.mkdirSync(path.dirname(f), { recursive: true })
            fs.appendFileSync(f, JSON.stringify(msg) + '\n')
        } catch (e) {
            this.log('error', 'spool tee failed:', (e as Error).message)
        }
    }

    // ------------------------------------------------------------------
    // lifecycle
    // ------------------------------------------------------------------

    /**
     * Release everything: disconnect all channels, settle pending waiters,
     * disarm the retry guard. Idempotent. This is what keeps the Node event
     * loop drainable on session exit.
     */
    teardown(): void {
        if (this.tornDown) return
        this.tornDown = true
        for (const ch of this.channels.values()) {
            try {
                const r = ch.dispose() as void | Promise<void>
                if (r && typeof r.then === 'function') r.catch(() => { /* best effort */ })
            } catch { /* best effort */ }
        }
        this.channels.clear()
        for (const list of this.waiters.values()) {
            for (const entry of list) {
                try { entry.cleanup() } catch { /* best effort */ }
                try { entry.reject(new Error('hub disposed')) } catch { /* best effort */ }
            }
        }
        this.waiters.clear()
        this.retry?.dispose()
        this.seen.clear()
        this.log('info', 'interaction hub torn down')
    }
}
