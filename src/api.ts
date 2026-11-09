/**
 * Public interaction API for OTHER DSH plugins.
 *
 * A plugin that wants to talk to IM (ask a question, post a card with actions,
 * notify a human, register a `/command`) should depend on this package and use
 * this API instead of re-implementing channels, dedupe, waiters, cards and
 * token hygiene. The contract is intentionally small, typed and versioned:
 *
 * ```ts
 * const chat = ctx.get('chatInteraction')?.api          // service lookup
 * if (chat?.apiVersion >= 1) {
 *     const ans = await chat.ask({ chatId, body: '继续吗？', options: [
 *         { value: 'yes', label: '继续', type: 'primary' },
 *         { value: 'no', label: '停止', type: 'danger' },
 *     ], timeoutMs: 60_000 })
 *     if (ans.ok && ans.value.value === 'yes') { … }
 * }
 * ```
 *
 * Design rules:
 *  - **Never throw for expected failures** — return `ApiResult` with a stable
 *    `code` (`no-target`, `channel-unsupported`, `timeout`, …).
 *  - **One-shot tokens** — every button this API sends carries
 *    `ask:<nonce>:<value>` / `act:<nonce>:<value>`, so a stale card from an
 *    earlier request (or a forwarded message) can never resolve a newer wait.
 *  - **Capability negotiation** — a channel without cards gets a numbered text
 *    menu; without files the call returns `channel-unsupported` instead of
 *    silently dropping the payload.
 *  - **Disposables** — every registration returns a disposer, and `dispose()`
 *    releases all of them (HMR-safe).
 * @module dsh-chat-interaction/api
 */
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { InteractionHub } from './hub.js'
import type { LogFn } from './log.js'
import type { ChannelAdapter } from './channel.js'
import type {
    AuthState,
    ButtonSpec,
    CardSpec,
    ChannelCapabilities,
    InboundMessage,
    ListenerStatus,
    SendResult,
} from './types.js'

/** Bump when a breaking change lands in this contract. */
export const CHAT_INTERACTION_API_VERSION = 1

// ---------------------------------------------------------------------------
// results and errors
// ---------------------------------------------------------------------------

export type ApiErrorCode =
    | 'invalid-argument'
    | 'no-target'
    | 'channel-not-found'
    | 'channel-unsupported'
    | 'send-failed'
    | 'timeout'
    | 'aborted'
    | 'unknown-chat'
    | 'internal'

export type ApiResult<T> = { ok: true; value: T } | { ok: false; code: ApiErrorCode; message: string }

const ok = <T>(value: T): ApiResult<T> => ({ ok: true, value })
const fail = (code: ApiErrorCode, message: string): ApiResult<never> => ({ ok: false, code, message })

/** A place to talk to: explicit, or resolved from an agent / the active chat. */
export interface ChatTarget {
    channel?: string
    chatId?: string
    /** Resolve the chat this agent is bound to (multi-agent deployments). */
    agent?: { id: string }
}

export interface ResolvedTarget {
    channel: string
    chatId: string
}

export interface SendOk {
    messageId?: string
    channel: string
    chatId: string
}

export interface ChannelInfo {
    name: string
    label: string
    connected: boolean
    capabilities: ChannelCapabilities
}

// ---------------------------------------------------------------------------
// ask / notify / waitForAction
// ---------------------------------------------------------------------------

export interface AskOption {
    /** Value returned to the caller (never shown to the user). */
    value: string
    label?: string
    type?: 'primary' | 'default' | 'danger'
}

export interface AskRequest extends ChatTarget {
    title?: string
    body?: string
    /** When present the answer must match one of these (value / label / 1-based index). */
    options?: AskOption[]
    timeoutMs?: number
    signal?: AbortSignal
    /** Answer to return on timeout instead of `{ok:false, code:'timeout'}`. */
    defaultOption?: string
    /** Only accept answers from these platform user ids. */
    from?: string[]
}

export interface AskAnswer {
    /** Matched option value, or the raw text for a free-form answer. */
    value: string
    text: string
    label?: string
    /** Platform user id of the answerer. */
    by?: string
    /** The chat the answer came from (provenance: "who, from which chat, which message"). */
    chatId: string
    /** The answer chat's kind, when the platform reported it. */
    chatKind?: 'p2p' | 'group'
    messageId: string
    via: 'click' | 'text'
    at: number
}

export interface ConfirmResult {
    confirmed: boolean
    timedOut: boolean
    by?: string
    messageId?: string
}

export type NoticeLevel = 'info' | 'warn' | 'error' | 'success'

export interface NoticeRequest extends ChatTarget {
    title?: string
    body?: string
    level?: NoticeLevel
    /** Buttons to show (cards) — pair with `waitForAction` + the returned token. */
    actions?: AskOption[]
    timeoutMs?: number
}

export interface NoticeResult extends SendOk {
    /**
     * Token to pass to `waitForAction`. Present only when the notice carried
     * actions; buttons are sent as `act:<token>:<value>`.
     */
    actionToken?: string
}

export interface ActionRequest extends ChatTarget {
    /** Token returned by `notify({actions})`. Required unless `values` is given. */
    token?: string
    /** Explicit accepted values (used when no token was issued). */
    values?: string[]
    timeoutMs?: number
    signal?: AbortSignal
}

export interface ActionAnswer {
    value: string
    text: string
    by?: string
    /** The chat the action came from. */
    chatId: string
    /** The action chat's kind, when the platform reported it. */
    chatKind?: 'p2p' | 'group'
    messageId: string
    at: number
}

/** Why an inbound message was looked at but not accepted as THE answer. */
export type IgnoredAnswerReason = 'sender-not-allowed' | 'option-mismatch'

/** A rejected answer attempt — observable so "someone tried to answer for them"
 *  does not silently look like a timeout in the audit trail. */
export interface IgnoredAnswer {
    channel: string
    chatId: string
    /** Platform user id of the sender, when known. */
    by?: string
    /** Raw text of the ignored message. */
    text: string
    messageId: string
    reason: IgnoredAnswerReason
    at: number
}

/** Counters for the API's asks (process-local). */
export interface ApiStats {
    /** Every ask() started. */
    askedQuestions: number
    /** Ignored answer attempts, all reasons. */
    ignoredAnswers: number
    /** Rejected because the sender was outside `from`. */
    ignoredBySender: number
    /** Rejected because the text matched no offered option. */
    ignoredByOptions: number
}

/** A resolved chat plus what the API knows about it. */
export interface ResolvedChat {
    channel: string
    chatId: string
    /** `p2p` / `group` when observed (or matched by the project p2p marker). */
    kind?: 'p2p' | 'group'
}

export interface FileRequest extends ChatTarget {
    /** Absolute path, or a path inside `root` (see `root`). */
    path: string
    /** Root used to contain relative paths (default: process.cwd()). */
    root?: string
    name?: string
}

// ---------------------------------------------------------------------------
// commands
// ---------------------------------------------------------------------------

export interface CommandContext {
    channel: string
    chatId: string
    /** Tokens after the command name (whitespace split). */
    args: string[]
    /** Full text of the message. */
    text: string
    message: InboundMessage
    reply: {
        text(text: string): Promise<SendResult>
        richText(title: string, body: string): Promise<SendResult>
        card(card: CardSpec): Promise<SendResult>
    }
    log: LogFn
}

export interface CommandReply {
    text?: string
    richText?: { title: string; body: string }
    card?: CardSpec
}

export interface CommandSpec {
    /** Command name without the leading slash (case-insensitive). */
    name: string
    description?: string
    usage?: string
    handler(ctx: CommandContext): Promise<CommandReply | void> | CommandReply | void
}

export interface CommandInfo {
    name: string
    description?: string
    usage?: string
}

/** Internal registry the router consults before its own classification. */
export interface CommandRegistry {
    match(text: string): { spec: CommandSpec; args: string[] } | null
    run(match: { spec: CommandSpec; args: string[] }, msg: InboundMessage): Promise<boolean>
}

// ---------------------------------------------------------------------------
// the API surface
// ---------------------------------------------------------------------------

export interface ApiInfo {
    apiVersion: number
    pluginVersion: string
    channels: ChannelInfo[]
}

export interface ChatInteractionApi {
    readonly apiVersion: number
    info(): ApiInfo
    channels(): ChannelInfo[]
    capabilities(channel: string): ApiResult<ChannelCapabilities>
    status(channel: string): ListenerStatus
    connect(channel: string): Promise<ListenerStatus>
    disconnect(channel: string): Promise<ListenerStatus>
    authState(channel: string): AuthState

    sendText(target: ChatTarget, text: string): Promise<ApiResult<SendOk>>
    sendRichText(target: ChatTarget, title: string, body: string): Promise<ApiResult<SendOk>>
    sendCard(target: ChatTarget, card: CardSpec): Promise<ApiResult<SendOk>>
    sendFile(target: FileRequest): Promise<ApiResult<SendOk>>

    ask(request: AskRequest): Promise<ApiResult<AskAnswer>>
    /** Observe answer attempts that were rejected (whitelist / option mismatch). */
    onAnswerIgnored(handler: (event: IgnoredAnswer) => void): { dispose(): void }
    /** Process-local counters for asks and ignored answers. */
    stats(): ApiStats
    /** The kind of a chat (observed inbound / project p2p marker), if known. */
    chatKind(target: ChatTarget): ApiResult<'p2p' | 'group'>
    /** Resolve a target and report what is known about the chat. */
    resolveChat(target: ChatTarget): ApiResult<ResolvedChat>
    confirm(target: ChatTarget, question: { title?: string; body?: string }, opts?: { timeoutMs?: number }): Promise<ApiResult<ConfirmResult>>
    notify(request: NoticeRequest): Promise<ApiResult<NoticeResult>>
    waitForAction(request: ActionRequest): Promise<ApiResult<ActionAnswer>>

    registerCommand(spec: CommandSpec): { dispose(): void }
    commands(): CommandInfo[]
    onInbound(handler: (msg: InboundMessage) => void): { dispose(): void }

    dispose(): void
}

export interface ChatApiDeps {
    pluginVersion: string
    hub: InteractionHub
    log: LogFn
    adapters: Map<string, ChannelAdapter>
    /** Default chat for a channel (active chat file), or null. */
    resolveActive(channel?: string): ResolvedTarget | null
    /** Chat bound to a specific agent. */
    resolveForAgent(agent: { id: string }): ResolvedTarget | null
    /**
     * Kind of a chat the plugin knows about (observed inbound messages, or the
     * project's p2p marker). Omitted → the API reports `unknown-chat`.
     */
    resolveChatKind?(channel: string, chatId: string): 'p2p' | 'group' | undefined
    connect(channel: string): Promise<ListenerStatus>
    disconnect(channel: string): Promise<ListenerStatus>
    status(channel: string): ListenerStatus
    authState(channel: string): AuthState
}

const DEFAULT_TIMEOUT_MS = 120_000
const MAX_TIMEOUT_MS = 600_000

/** Normalise a timeout, clamped to [1s, 10min]. */
function clampTimeout(ms: number | undefined): number {
    return Math.min(Math.max(Number(ms) || DEFAULT_TIMEOUT_MS, 1000), MAX_TIMEOUT_MS)
}

/** `ask:<nonce>:<value>` / `act:<nonce>:<value>` → parts, or null. */
function parseTokenValue(text: string): { kind: 'ask' | 'act'; token: string; value: string } | null {
    const m = /^(ask|act):([A-Za-z0-9_-]{4,64}):([\s\S]+)$/i.exec(String(text || '').trim())
    if (!m) return null
    return { kind: m[1]!.toLowerCase() as 'ask' | 'act', token: m[2]!, value: m[3]! }
}

/**
 * Match an inbound message against the offered options.
 * Accepts: token-bound click, exact value, label, or a 1-based index.
 */
function matchOption(text: string, options: AskOption[], nonce: string): { value: string; label?: string; via: 'click' | 'text' } | null {
    const raw = String(text || '').trim()
    const tokenised = parseTokenValue(raw)
    if (tokenised) {
        if (tokenised.kind !== 'ask' || tokenised.token !== nonce) return null // stale / foreign card
        const hit = options.find((o) => o.value === tokenised.value)
        return hit ? { value: hit.value, label: hit.label, via: 'click' } : { value: tokenised.value, via: 'click' }
    }
    const lower = raw.toLowerCase()
    const byValue = options.find((o) => o.value.toLowerCase() === lower)
    if (byValue) return { value: byValue.value, label: byValue.label, via: 'text' }
    const byLabel = options.find((o) => (o.label ?? '').toLowerCase() === lower)
    if (byLabel) return { value: byLabel.value, label: byLabel.label, via: 'text' }
    const index = Number(raw)
    if (Number.isInteger(index) && index >= 1 && index <= options.length) {
        const hit = options[index - 1]!
        return { value: hit.value, label: hit.label, via: 'text' }
    }
    return null
}

/**
 * Contain a file path inside `root` (same rule as the approval artifacts):
 * absolute paths and `../` escapes outside the root are rejected, symlinks are
 * resolved first.
 */
export function containFilePath(root: string, requested: string): string | null {
    try {
        const realRoot = fs.realpathSync(root)
        const candidate = path.isAbsolute(requested) ? requested : path.join(realRoot, requested)
        if (!fs.existsSync(candidate)) return null
        const real = fs.realpathSync(candidate)
        const prefix = realRoot.endsWith(path.sep) ? realRoot : realRoot + path.sep
        if (real === realRoot || !real.startsWith(prefix)) return null
        if (!fs.statSync(real).isFile()) return null
        return real
    } catch {
        return null
    }
}

/** Create the API object exposed as `layer.api` (see {@link ChatInteractionApi}). */
export function createChatApi(deps: ChatApiDeps): ChatInteractionApi {
    const { hub, log, adapters } = deps
    const disposers = new Set<() => void>()
    const commands = new Map<string, CommandSpec>()
    let disposed = false

    // ---- answer provenance bookkeeping ------------------------------------
    const counters = { askedQuestions: 0, ignoredAnswers: 0, ignoredBySender: 0, ignoredByOptions: 0 }
    const ignoredHandlers = new Set<(event: IgnoredAnswer) => void>()

    const recordIgnored = (event: IgnoredAnswer): void => {
        counters.ignoredAnswers += 1
        if (event.reason === 'sender-not-allowed') counters.ignoredBySender += 1
        else counters.ignoredByOptions += 1
        // Loud on purpose: an attempted answer by a non-whitelisted sender must not
        // look like a plain timeout in the log (that is the audit-trail hole).
        log('warn', `answer ignored (${event.reason}) on ${event.channel}/${event.chatId}` +
            `${event.by === undefined ? '' : ` by=${event.by}`}${event.messageId === '' ? '' : ` message=${event.messageId}`}`)
        for (const handler of ignoredHandlers) {
            try { handler(event) } catch (e) { log('error', 'answer-ignored handler failed:', (e as Error).message) }
        }
    }

    const kindOf = (channel: string, chatId: string, reply?: { chatType?: 'p2p' | 'group' }): 'p2p' | 'group' | undefined =>
        reply?.chatType ?? deps.resolveChatKind?.(channel, chatId)

    // ---- target resolution -------------------------------------------------
    const resolve = (target: ChatTarget | undefined): ApiResult<ResolvedTarget> => {
        if (target?.channel && target.chatId) return ok({ channel: target.channel, chatId: target.chatId })
        if (target?.agent) {
            const hit = deps.resolveForAgent(target.agent)
            if (!hit) return fail('no-target', `no chat bound to agent "${target.agent.id}"`)
            return ok(hit)
        }
        if (target?.channel && !target.chatId) {
            const hit = deps.resolveActive(target.channel)
            if (!hit) return fail('no-target', `no active chat recorded for channel "${target.channel}"`)
            return ok(hit)
        }
        const hit = deps.resolveActive()
        if (!hit) return fail('no-target', 'no channel/chatId given and no active chat is recorded')
        return ok(hit)
    }

    const adapterOf = (channel: string): ChannelAdapter | undefined => adapters.get(channel)

    const sendOk = (channel: string, chatId: string, r: SendResult): ApiResult<SendOk> =>
        r.ok ? ok({ channel, chatId, messageId: r.messageId }) : fail('send-failed', r.error || 'send failed')

    // ---- sending -----------------------------------------------------------
    const sendText = async (target: ChatTarget, text: string): Promise<ApiResult<SendOk>> => {
        if (disposed) return fail('internal', 'api disposed')
        const t = resolve(target)
        if (!t.ok) return t
        const { channel, chatId } = t.value
        const r = await hub.sendText(channel, chatId, String(text ?? ''))
        return sendOk(channel, chatId, r)
    }

    const sendRichText = async (target: ChatTarget, title: string, body: string): Promise<ApiResult<SendOk>> => {
        if (disposed) return fail('internal', 'api disposed')
        const t = resolve(target)
        if (!t.ok) return t
        const { channel, chatId } = t.value
        const adapter = adapterOf(channel)
        const text = title ? `${title}\n\n${body ?? ''}` : String(body ?? '')
        const r = adapter?.capabilities.richText
            ? await hub.sendRichText(channel, chatId, title, body)
            : await hub.sendText(channel, chatId, text)
        return sendOk(channel, chatId, r)
    }

    const sendCard = async (target: ChatTarget, card: CardSpec): Promise<ApiResult<SendOk>> => {
        if (disposed) return fail('internal', 'api disposed')
        const t = resolve(target)
        if (!t.ok) return t
        const { channel, chatId } = t.value
        const adapter = adapterOf(channel)
        if (!adapter) return fail('channel-not-found', `unknown channel "${channel}"`)
        if (!adapter.capabilities.cards) {
            // Graceful degradation: render the card as text instead of dropping it.
            const lines = [card.title, card.body].filter(Boolean)
            const buttons = (card.buttons || []).map((b, i) => `${i + 1}) ${typeof b === 'string' ? b : (b.label || b.value)}`)
            const r = await hub.sendText(channel, chatId, [...lines, ...buttons].join('\n'))
            return sendOk(channel, chatId, r)
        }
        const r = await hub.sendCard(channel, chatId, card)
        return sendOk(channel, chatId, r)
    }

    const sendFile = async (request: FileRequest): Promise<ApiResult<SendOk>> => {
        if (disposed) return fail('internal', 'api disposed')
        const t = resolve(request)
        if (!t.ok) return t
        const { channel, chatId } = t.value
        const adapter = adapterOf(channel)
        if (!adapter) return fail('channel-not-found', `unknown channel "${channel}"`)
        if (!adapter.sendFile || adapter.capabilities.files === false) {
            return fail('channel-unsupported', `channel "${channel}" does not support file delivery`)
        }
        const root = request.root || process.cwd()
        const contained = containFilePath(root, request.path)
        if (!contained) return fail('invalid-argument', `file "${request.path}" is missing or outside "${root}"`)
        const r = await hub.sendFile(channel, chatId, { path: contained, ...(request.name ? { name: request.name } : {}) })
        return sendOk(channel, chatId, r)
    }

    // ---- ask / confirm -----------------------------------------------------
    const ask = async (request: AskRequest): Promise<ApiResult<AskAnswer>> => {
        if (disposed) return fail('internal', 'api disposed')
        const t = resolve(request)
        if (!t.ok) return t
        const { channel, chatId } = t.value
        const adapter = adapterOf(channel)
        if (!adapter) return fail('channel-not-found', `unknown channel "${channel}"`)
        counters.askedQuestions += 1
        const options = request.options ?? []
        const nonce = randomUUID().replace(/-/g, '').slice(0, 16)
        const title = request.title ?? '需要确认'
        const body = request.body ?? ''

        const sent = options.length > 0 && adapter.capabilities.cards
            ? await hub.sendCard(channel, chatId, {
                  title,
                  body,
                  buttons: options.map((o) => ({
                      value: `ask:${nonce}:${o.value}`,
                      label: o.label ?? o.value,
                      ...(o.type ? { type: o.type } : {}),
                  })),
              })
            : await hub.sendText(
                  channel,
                  chatId,
                  [title, body, ...options.map((o, i) => `${i + 1}) ${o.label ?? o.value}`)].filter(Boolean).join('\n')
              )
        if (!sent.ok) return fail('send-failed', sent.error || 'question could not be delivered')

        const deadline = Date.now() + clampTimeout(request.timeoutMs)
        for (;;) {
            const remaining = deadline - Date.now()
            if (remaining <= 0) break
            let reply: Awaited<ReturnType<InteractionHub['waitReply']>>
            try {
                reply = await hub.waitReply(channel, chatId, remaining, request.signal)
            } catch (e) {
                if ((e as Error).message === 'aborted') return fail('aborted', 'the ask was aborted')
                return fail('internal', (e as Error).message)
            }
            if (reply.timedOut) break
            if (request.from?.length && (!reply.senderId || !request.from.includes(reply.senderId))) {
                recordIgnored({
                    channel,
                    chatId,
                    ...(reply.senderId === undefined ? {} : { by: reply.senderId }),
                    text: reply.text,
                    messageId: reply.messageId,
                    reason: 'sender-not-allowed',
                    at: Date.now(),
                })
                continue // keep waiting: a rejected sender must not consume the question
            }
            if (options.length > 0) {
                const hit = matchOption(reply.text, options, nonce)
                if (!hit) {
                    recordIgnored({
                        channel,
                        chatId,
                        ...(reply.senderId === undefined ? {} : { by: reply.senderId }),
                        text: reply.text,
                        messageId: reply.messageId,
                        reason: 'option-mismatch',
                        at: Date.now(),
                    })
                    continue // unrelated message: keep waiting for the real answer
                }
                const kind = kindOf(channel, chatId, reply)
                return ok({
                    value: hit.value,
                    text: reply.text,
                    ...(hit.label ? { label: hit.label } : {}),
                    ...(reply.senderId ? { by: reply.senderId } : {}),
                    chatId,
                    ...(kind === undefined ? {} : { chatKind: kind }),
                    messageId: reply.messageId,
                    via: hit.via,
                    at: Date.now(),
                })
            }
            const kind = kindOf(channel, chatId, reply)
            return ok({
                value: reply.text,
                text: reply.text,
                ...(reply.senderId ? { by: reply.senderId } : {}),
                chatId,
                ...(kind === undefined ? {} : { chatKind: kind }),
                messageId: reply.messageId,
                via: reply.isCardAction ? 'click' : 'text',
                at: Date.now(),
            })
        }
        if (request.defaultOption !== undefined) {
            return ok({
                value: request.defaultOption,
                text: '',
                chatId,
                messageId: '',
                via: 'text',
                at: Date.now(),
            })
        }
        return fail('timeout', `no answer within ${clampTimeout(request.timeoutMs)}ms`)
    }

    const confirm = async (
        target: ChatTarget,
        question: { title?: string; body?: string },
        opts: { timeoutMs?: number } = {}
    ): Promise<ApiResult<ConfirmResult>> => {
        const answer = await ask({
            ...target,
            ...(question.title ? { title: question.title } : {}),
            ...(question.body ? { body: question.body } : {}),
            options: [
                { value: 'yes', label: '同意', type: 'primary' },
                { value: 'no', label: '拒绝', type: 'danger' },
            ],
            defaultOption: 'no', // fail closed: silence is not consent
            ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
        })
        if (!answer.ok) return answer
        const timedOut = answer.value.text === '' && answer.value.messageId === ''
        return ok({
            confirmed: answer.value.value === 'yes' && !timedOut,
            timedOut,
            ...(answer.value.by ? { by: answer.value.by } : {}),
            ...(answer.value.messageId ? { messageId: answer.value.messageId } : {}),
        })
    }

    // ---- notify / waitForAction -------------------------------------------
    const notify = async (request: NoticeRequest): Promise<ApiResult<NoticeResult>> => {
        if (disposed) return fail('internal', 'api disposed')
        const t = resolve(request)
        if (!t.ok) return t
        const { channel, chatId } = t.value
        const adapter = adapterOf(channel)
        if (!adapter) return fail('channel-not-found', `unknown channel "${channel}"`)
        const levelPrefix: Record<NoticeLevel, string> = { info: '', warn: '⚠️ ', error: '❌ ', success: '✅ ' }
        const prefix = levelPrefix[request.level ?? 'info']
        const title = request.title ? `${prefix}${request.title}` : prefix.trim()
        const body = request.body ?? ''

        if (request.actions?.length) {
            const token = randomUUID().replace(/-/g, '').slice(0, 16)
            const sent = adapter.capabilities.cards
                ? await hub.sendCard(channel, chatId, {
                      title: title || '请选择',
                      body,
                      buttons: request.actions.map((a) => ({
                          value: `act:${token}:${a.value}`,
                          label: a.label ?? a.value,
                          ...(a.type ? { type: a.type } : {}),
                      })),
                  })
                : await hub.sendText(
                      channel,
                      chatId,
                      [title, body, ...request.actions.map((a, i) => `${i + 1}) ${a.label ?? a.value}`)].filter(Boolean).join('\n')
                  )
            if (!sent.ok) return fail('send-failed', sent.error || 'notice could not be delivered')
            return ok({ channel, chatId, messageId: sent.messageId, actionToken: token })
        }

        const sent = await hub.sendText(channel, chatId, [title, body].filter(Boolean).join('\n'))
        return sendOk(channel, chatId, sent)
    }

    const waitForAction = async (request: ActionRequest): Promise<ApiResult<ActionAnswer>> => {
        if (disposed) return fail('internal', 'api disposed')
        const t = resolve(request)
        if (!t.ok) return t
        const { channel, chatId } = t.value
        const token = request.token
        const values = new Set(request.values ?? [])
        if (!token && values.size === 0) {
            return fail('invalid-argument', 'waitForAction needs a token (from notify) or explicit values')
        }
        const accept = (msg: InboundMessage): boolean => {
            if (!msg.isCardAction) return false
            const parsed = parseTokenValue(msg.text)
            if (token) return parsed?.kind === 'act' && parsed.token === token
            return values.has(msg.text) || (parsed ? values.has(parsed.value) : false)
        }
        let reply: Awaited<ReturnType<InteractionHub['waitReply']>>
        try {
            reply = await hub.waitFor(channel, chatId, accept, request.timeoutMs, request.signal)
        } catch (e) {
            if ((e as Error).message === 'aborted') return fail('aborted', 'the wait was aborted')
            return fail('internal', (e as Error).message)
        }
        if (reply.timedOut) return fail('timeout', `no action within ${clampTimeout(request.timeoutMs)}ms`)
        const parsed = parseTokenValue(reply.text)
        const kind = kindOf(channel, chatId, reply)
        return ok({
            value: parsed ? parsed.value : reply.text,
            text: reply.text,
            ...(reply.senderId ? { by: reply.senderId } : {}),
            chatId,
            ...(kind === undefined ? {} : { chatKind: kind }),
            messageId: reply.messageId,
            at: Date.now(),
        })
    }

    // ---- commands ----------------------------------------------------------
    const sendCommandReply = async (
        channel: string,
        chatId: string,
        reply: CommandReply | void
    ): Promise<void> => {
        if (!reply) return
        if (reply.card) {
            await hub.sendCard(channel, chatId, reply.card)
            return
        }
        if (reply.richText) {
            await hub.sendRichText(channel, chatId, reply.richText.title, reply.richText.body)
            return
        }
        if (reply.text) await hub.sendText(channel, chatId, reply.text)
    }

    const registry: CommandRegistry = {
        match(text: string) {
            const raw = String(text || '').trim()
            if (!raw.startsWith('/')) return null
            const [head, ...rest] = raw.split(/\s+/)
            const name = (head ?? '').slice(1).toLowerCase()
            const spec = commands.get(name)
            return spec ? { spec, args: rest } : null
        },
        async run(match, msg) {
            const { spec, args } = match
            try {
                const result = await spec.handler({
                    channel: msg.channel,
                    chatId: msg.chatId,
                    args,
                    text: String(msg.text ?? ''),
                    message: msg,
                    log,
                    reply: {
                        text: (text: string) => hub.sendText(msg.channel, msg.chatId, text),
                        richText: (title: string, body: string) => hub.sendRichText(msg.channel, msg.chatId, title, body),
                        card: (card: CardSpec) => hub.sendCard(msg.channel, msg.chatId, card),
                    },
                })
                await sendCommandReply(msg.channel, msg.chatId, result)
                return true
            } catch (e) {
                log('error', `command "/${spec.name}" failed:`, (e as Error).message)
                await hub.sendText(msg.channel, msg.chatId, `命令 /${spec.name} 执行失败: ${(e as Error).message}`)
                return true // it WAS this command's message; do not let the agent also answer it
            }
        },
    }

    const api: ChatInteractionApi = {
        apiVersion: CHAT_INTERACTION_API_VERSION,

        info() {
            return {
                apiVersion: CHAT_INTERACTION_API_VERSION,
                pluginVersion: deps.pluginVersion,
                channels: api.channels(),
            }
        },

        channels() {
            const out: ChannelInfo[] = []
            for (const [name, adapter] of adapters) {
                out.push({
                    name,
                    label: adapter.label,
                    connected: adapter.status().connected,
                    capabilities: adapter.capabilities,
                })
            }
            return out
        },

        capabilities(channel: string) {
            const adapter = adapterOf(channel)
            return adapter ? ok(adapter.capabilities) : fail('channel-not-found', `unknown channel "${channel}"`)
        },

        status: (channel) => deps.status(channel),
        connect: (channel) => deps.connect(channel),
        disconnect: (channel) => deps.disconnect(channel),
        authState: (channel) => deps.authState(channel),

        sendText,
        sendRichText,
        sendCard,
        sendFile,
        ask,
        onAnswerIgnored(handler: (event: IgnoredAnswer) => void) {
            ignoredHandlers.add(handler)
            const dispose = () => { ignoredHandlers.delete(handler) }
            disposers.add(dispose)
            return {
                dispose() {
                    disposers.delete(dispose)
                    dispose()
                },
            }
        },
        stats(): ApiStats {
            return { ...counters }
        },
        chatKind(target: ChatTarget) {
            const t = resolve(target)
            if (!t.ok) return t
            const kind = deps.resolveChatKind?.(t.value.channel, t.value.chatId)
            return kind === undefined
                ? fail('unknown-chat', `chat ${t.value.channel}/${t.value.chatId} has not been observed and has no p2p marker`)
                : ok(kind)
        },
        resolveChat(target: ChatTarget) {
            const t = resolve(target)
            if (!t.ok) return t
            const kind = deps.resolveChatKind?.(t.value.channel, t.value.chatId)
            return ok({
                channel: t.value.channel,
                chatId: t.value.chatId,
                ...(kind === undefined ? {} : { kind }),
            })
        },
        confirm,
        notify,
        waitForAction,

        registerCommand(spec: CommandSpec) {
            const name = String(spec.name || '').replace(/^\//, '').toLowerCase()
            if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(name)) {
                throw new Error(`invalid command name "${spec.name}" (expected /^[a-z0-9][a-z0-9_-]{0,31}$/)`)
            }
            if (commands.has(name)) throw new Error(`command "${name}" is already registered`)
            commands.set(name, { ...spec, name })
            const dispose = () => { commands.delete(name) }
            disposers.add(dispose)
            return {
                dispose() {
                    disposers.delete(dispose)
                    dispose()
                },
            }
        },

        commands() {
            return [...commands.values()].map((c) => ({
                name: c.name,
                ...(c.description ? { description: c.description } : {}),
                ...(c.usage ? { usage: c.usage } : {}),
            }))
        },

        onInbound(handler: (msg: InboundMessage) => void) {
            const off = hub.onInbound(handler)
            const dispose = () => { off() }
            disposers.add(dispose)
            return {
                dispose() {
                    disposers.delete(dispose)
                    dispose()
                },
            }
        },

        dispose() {
            if (disposed) return
            disposed = true
            for (const d of [...disposers]) {
                try { d() } catch { /* best effort */ }
            }
            disposers.clear()
            commands.clear()
        },
    }

    // The router uses this registry; expose it without widening the public API.
    Object.defineProperty(api, 'commandRegistry', { value: registry, enumerable: false })
    return api
}

/** Internal accessor for the plugin wiring (not part of the public contract). */
export function commandRegistryOf(api: ChatInteractionApi): CommandRegistry {
    return (api as unknown as { commandRegistry: CommandRegistry }).commandRegistry
}

/** Re-exported for adapters/tests that need the token format. */
export function makeActionValue(token: string, value: string): string {
    return `act:${token}:${value}`
}

export function makeAskValue(nonce: string, value: string): string {
    return `ask:${nonce}:${value}`
}

export type { ButtonSpec }
