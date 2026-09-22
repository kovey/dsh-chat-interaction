/**
 * Per-channel tool factory — the agent-facing half of the interaction layer.
 *
 * For every registered channel this builds the same proven tool family that
 * dsh-feishu exposes, namespaced by channel name:
 *
 *   <name>_send_message   text / rich-text reply
 *   <name>_send_card      interactive card with buttons (capability-gated)
 *   <name>_wait_reply     block for the user's next message (consumed)
 *   <name>_listener       start/stop/status — opt-in connection control
 *   <name>_auth_state     permission mode / allowlist / pending questions
 *
 * Tool specs are emitted in the `defineTool` input form (schema-spec), and
 * the harness bridge compiles them — via the real `defineTool` when present,
 * or the built-in mini compiler otherwise. The agent experiences identical
 * semantics on every channel, which is what "easy to integrate Feishu,
 * WeCom, ..." means in practice.
 * @module dsh-chat-interaction/tools
 */
import type {
    AuthState,
    ButtonSpec,
    ChannelDescriptor,
    ListenerStatus,
    SendResult,
    WaitResult,
} from './types.js'

/** Parameter spec, in the `defineTool` schema-spec dialect. */
export interface ParamSpec {
    type?: string
    required?: boolean
    description?: string
    items?: unknown
    properties?: Record<string, ParamSpec>
    additionalProperties?: boolean
    enum?: unknown[]
}

/** One tool in the `defineTool` input form. */
export interface ToolSpec {
    name: string
    description: string
    parameters: Record<string, ParamSpec>
    output: {
        schema: unknown
        render?: (args: Record<string, unknown>, value: any) => Array<{ type: 'text'; text: string }>
    }
    timeoutMs?: number
    isConcurrencySafe?: () => boolean
    execute: (args: Record<string, unknown>, exec: { signal?: AbortSignal }) => unknown | Promise<unknown>
}

/** What the hub + bridge provide per channel. */
export interface ChannelToolDeps {
    sendText(chatId: string, text: string): Promise<SendResult>
    sendRichText(chatId: string, title: string, body: string): Promise<SendResult>
    sendCard(chatId: string, title: string, body: string, buttons: ButtonSpec[]): Promise<SendResult>
    waitReply(chatId: string, timeoutMs: number, signal?: AbortSignal): Promise<WaitResult>
    listenerControl(action: string): Promise<ListenerStatus & { ok: boolean }>
    authState(): AuthState
}

// NOTE: output schemas must mirror the EXACT shape of the values the tools
// return (`SendResult` / `WaitResult` / `AuthState` are camelCase). The host
// validates every tool result against this schema with
// `additionalProperties: false`, so a snake_case/camelCase mismatch makes the
// call fail with `returned invalid output` — see test/tool-output-schema.test.ts.
const OUTPUT_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    properties: {
        ok: { type: 'boolean', required: true },
        messageId: { type: 'string' },
        error: { type: 'string' },
    },
}

/** Cooperative race: reject when the caller aborts (tool observes exec.signal). */
function withAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
    if (!signal) return promise
    return new Promise<T>((resolve, reject) => {
        let done = false
        const onAbort = () => {
            if (!done) {
                done = true
                reject(new Error('aborted'))
            }
        }
        if (signal.aborted) return onAbort()
        signal.addEventListener('abort', onAbort, { once: true })
        promise.then(
            (v) => {
                if (!done) {
                    done = true
                    resolve(v)
                }
            },
            (e) => {
                if (!done) {
                    done = true
                    reject(e)
                }
            }
        )
    })
}

function renderSendResult(args: Record<string, unknown>, value: SendResult): Array<{ type: 'text'; text: string }> {
    if (value.ok) {
        const kind = args.title ? '富文本' : args.buttons ? '卡片' : '文本'
        return [{
            type: 'text',
            text: `已发送${kind}消息到 ${args.chat_id}${value.messageId ? ` (message_id=${value.messageId})` : ''}`,
        }]
    }
    return [{ type: 'text', text: `发送失败: ${value.error || 'unknown'}` }]
}

function tag(desc: ChannelDescriptor, suffix: string): string {
    return `[${desc.label}${suffix}]`
}

/**
 * Build the full tool family for one channel. `capabilities` decides which
 * tools exist (e.g. no `send_card` when the platform has no cards).
 */
export function buildChannelTools(desc: ChannelDescriptor, deps: ChannelToolDeps): ToolSpec[] {
    const p = desc.name
    const t = (suffix: string) => tag(desc, suffix)
    const tools: ToolSpec[] = []

    tools.push({
        name: `${p}_send_message`,
        description:
            `Send a ${desc.label} message to a chat. Use it to reply to inbound ${desc.label} messages: always use the exact chat_id from the ${t('消息')}/${t('卡片点击')} user message. Plain text by default; pass title to send a rich-text post. For questions that need the user to choose between options, prefer ${p}_send_card.`,
        parameters: {
            chat_id: { type: 'string', required: true, description: 'Target chat id, taken verbatim from the inbound message.' },
            text: { type: 'string', required: true, description: 'Message body text.' },
            title: { type: 'string', description: 'Optional rich-text title; when present the message is sent as a post with this title.' },
        },
        output: { schema: OUTPUT_SCHEMA, render: renderSendResult },
        timeoutMs: 30000,
        execute: async (args, exec) => {
            const p2 = args.title ? deps.sendRichText(args.chat_id as string, args.title as string, args.text as string) : deps.sendText(args.chat_id as string, args.text as string)
            return withAbort(p2, exec.signal)
        },
    })

    if (desc.capabilities.cards) {
        tools.push({
            name: `${p}_send_card`,
            description:
                `Send an interactive ${desc.label} card with buttons. The click arrives later as a ${t('卡片点击')} user message whose text is the clicked button value. Use for confirmations and multiple-choice questions (e.g. permission mode, merge/not-merge, A/B/C/D options). Keep button values short (A/B/C/D/yes/no/always). Follow with ${p}_wait_reply(chat_id) when the flow must block for the answer.`,
            parameters: {
                chat_id: { type: 'string', required: true, description: 'Target chat id, taken verbatim from the inbound message.' },
                title: { type: 'string', required: true, description: 'Card header title (plain text).' },
                body: { type: 'string', description: 'Card body in markdown.' },
                buttons: {
                    type: 'array',
                    items: {
                        type: 'object',
                        additionalProperties: false,
                        properties: {
                            value: { type: 'string', required: true, description: 'Short value returned when clicked (e.g. A, yes).' },
                            label: { type: 'string', description: 'Button label shown to the user.' },
                            type: { type: 'string', description: 'primary | default | danger (default: default)' },
                        },
                    },
                    description: 'One button object per option.',
                },
            },
            output: { schema: OUTPUT_SCHEMA, render: renderSendResult },
            timeoutMs: 30000,
            execute: async (args, exec) => {
                const buttons = (args.buttons as ButtonSpec[] | undefined) || []
                const p2 = deps.sendCard(args.chat_id as string, args.title as string, (args.body as string) || '', buttons)
                return withAbort(p2, exec.signal)
            },
        })
    }

    tools.push({
        name: `${p}_wait_reply`,
        description:
            `Wait for the user's NEXT ${desc.label} message (or card click) in a chat, up to timeoutMs (default 120000, max 600000). Use for strict Q&A sequencing after sending a question via ${p}_send_card / ${p}_send_message. The matched message is consumed by this call — it does NOT create another agent turn. Messages in other chats flow normally while waiting.`,
        parameters: {
            chat_id: { type: 'string', required: true, description: 'Chat to wait on, taken verbatim from the inbound message.' },
            timeoutMs: { type: 'number', description: 'Max wait in milliseconds (default 120000, capped at 600000).' },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    ok: { type: 'boolean', required: true },
                    timedOut: { type: 'boolean', required: true },
                    text: { type: 'string' },
                    messageId: { type: 'string' },
                    isCardAction: { type: 'boolean' },
                },
            },
            render: (_args, value: WaitResult) => [{
                type: 'text',
                text: value.timedOut
                    ? `等待超时（无新消息）`
                    : `收到回复: ${value.text}${value.isCardAction ? ' (卡片点击)' : ''}`,
            }],
        },
        timeoutMs: 600000,
        execute: async (args, exec) => {
            const t = Math.min(Math.max(Number(args.timeoutMs) || 120000, 1000), 600000)
            return deps.waitReply(args.chat_id as string, t, exec.signal)
        },
    })

    tools.push({
        name: `${p}_listener`,
        description:
            `Control the ${desc.label} connection (start/stop/status). The layer NEVER connects on its own: call action=start ONLY when the user explicitly asks to connect ${desc.label}; call action=stop when the user asks to disconnect; action=status reports the current state without changing it. Do NOT start the listener without an explicit user instruction.`,
        parameters: {
            action: { type: 'string', required: true, description: 'start | stop | status' },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    ok: { type: 'boolean', required: true },
                    connected: { type: 'boolean' },
                    message: { type: 'string' },
                    error: { type: 'string' },
                },
            },
            render: (_args, value: ListenerStatus & { ok: boolean }) => [{
                type: 'text',
                text: value.ok
                    ? `${desc.label}连接: ${value.connected ? '已连接' : '未连接'} — ${value.message || ''}`
                    : `${desc.label}连接操作失败: ${value.error || 'unknown'}`,
            }],
        },
        timeoutMs: 30000,
        execute: async (args) => deps.listenerControl(args.action as string),
    })

    tools.push({
        name: `${p}_auth_state`,
        description:
            `Read the ${desc.label} authorization/state files: current permission mode (auto/manual), allowlist, active chats, listener role, and pending questions. Use to check whether manual approval mode is on before executing sensitive work in a ${desc.label}-originated task.`,
        parameters: {},
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    ok: { type: 'boolean', required: true },
                    mode: { type: 'string' },
                    allowlist: { type: 'array', items: { type: 'string' } },
                    activeChat: { type: 'string' },
                    p2pChat: { type: 'string' },
                    listenerRole: { type: 'string' },
                    listenerConnected: { type: 'boolean' },
                    pendingQuestions: { type: 'array', items: { type: 'string' } },
                    error: { type: 'string' },
                },
            },
            render: (_args, value: AuthState) => [{
                type: 'text',
                text: value.ok
                    ? `权限模式: ${value.mode} | ${desc.label}连接: ${value.listenerConnected ? '已连接' : '未连接(默认)'} | allowlist: ${(value.allowlist || []).length} 条 | active_chat: ${value.activeChat || '-'} | pending: ${(value.pendingQuestions || []).length}`
                    : `读取授权状态失败: ${value.error}`,
            }],
        },
        isConcurrencySafe: () => true,
        execute: async () => deps.authState(),
    })

    return tools
}
