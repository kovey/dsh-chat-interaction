/**
 * Built-in message router — the dsh-feishu "plugin autonomy" behaviours,
 * generalized across channels and wired into `hub.router`.
 *
 * Classification (model evaluation first when an API key is configured, rule
 * fallback always available):
 *
 *   task     an active task marker covers this chat → hand to the agent
 *            (task continuity: no command/chat interception mid-task)
 *   confirmation  an open pending question is answered here (option letter,
 *            yes/no/always, permission-mode words) → resolved in-plugin
 *   command  explicit or safe-prefixed commands → executed in-plugin with a
 *            safety layer; forbidden commands are NOT run — they become an
 *            agent turn so the approval gate owns them
 *   requirement / bugfix  hand to the agent with a routing note
 *   chat     casual talk → answered in-plugin by the LLM (per-chat memory);
 *            without a model key it falls through to the agent
 *
 * Everything is optional: without an API key you get rule classification +
 * command autonomy; without commands the router just forwards to the agent.
 * @module dsh-chat-interaction/router
 */
import fs from 'node:fs'
import path from 'node:path'
import { exec } from 'node:child_process'
import type { MessageRouter, RouterDecision, InteractionHub } from './hub.js'
import type { PendingStore } from './pending.js'
import { log as defaultLog } from './log.js'
import type { LogFn } from './log.js'
import { expandHome, projStateDir, readFileSafe, writeFileSafe } from './state.js'
import type { InboundMessage } from './types.js'

// ---------------------------------------------------------------------------
// config
// ---------------------------------------------------------------------------

export interface RouterConfig {
    enabled?: boolean
    /**
     * Classification evaluator: 'auto' (model when a key is configured, rules
     * otherwise), 'model' (never fall back to rules for classification), or
     * 'rule' (never spend a model call on classification).
     */
    evaluator?: 'auto' | 'model' | 'rule'
    /** Evaluation + casual-chat model. */
    model?: string
    baseURL?: string
    apiKey?: string
    evaluationTimeoutMs?: number
    commandTimeoutMs?: number
    commandMaxOutputChars?: number
    /** Answer casual messages in-plugin (default true when a key is present). */
    autoReply?: boolean
    chatTimeoutMs?: number
    /** Per-chat conversation memory size (turns). */
    chatHistoryTurns?: number
    /** Where per-chat memory lives; default ~/.dsh/chat-history. */
    chatDir?: string
    /** Task-active marker TTL (default 8h). */
    taskActiveTtlMs?: number
    /** Command execution directory; default = hub/bridge project cwd. */
    cwdOf?: () => string
    /** Injectable fetch (tests). */
    fetchImpl?: typeof fetch
}

export interface ResolvedRouterConfig {
    enabled: boolean
    evaluator: 'auto' | 'model' | 'rule'
    model: string
    baseURL: string
    apiKey: string
    evaluationTimeoutMs: number
    commandTimeoutMs: number
    commandMaxOutputChars: number
    autoReply: boolean
    chatTimeoutMs: number
    chatHistoryTurns: number
    chatDir: string
    taskActiveTtlMs: number
    cwdOf?: () => string
    fetchImpl?: typeof fetch
}

const ROUTER_DEFAULTS: Omit<ResolvedRouterConfig, 'cwdOf' | 'fetchImpl'> = {
    enabled: true,
    evaluator: 'auto',
    model: 'deepseek-v4-flash',
    baseURL: '',
    apiKey: '',
    evaluationTimeoutMs: 15_000,
    commandTimeoutMs: 30_000,
    commandMaxOutputChars: 2000,
    autoReply: true,
    chatTimeoutMs: 30_000,
    chatHistoryTurns: 10,
    chatDir: '~/.dsh/chat-history',
    taskActiveTtlMs: 8 * 60 * 60 * 1000,
}

export function resolveRouterConfig(raw: RouterConfig | undefined): ResolvedRouterConfig {
    return {
        ...ROUTER_DEFAULTS,
        ...(raw || {}),
        cwdOf: raw?.cwdOf,
        fetchImpl: raw?.fetchImpl,
    }
}

// ---------------------------------------------------------------------------
// rule classification
// ---------------------------------------------------------------------------

const OPTION_LETTER_RE = /^[a-dA-D]$/
const CONFIRM_WORDS_RE = /^(全自动|auto|需审批|manual|审批|同意|确认|yes|no|不|取消|cancel|撤回|算了|全部采纳推荐方案|all|全采纳|always|始终同意)$/i
const EXPLICIT_CMD_RE = /^(git|npm|npx|node|pnpm|yarn|php|composer|python[0-9.]*|ls|pwd|cat|head|tail|grep|find|wc|df|du|ps|date|echo|which|whoami)\s/
const SAFE_PREFIX_RE = /^(git\s+(status|log|diff|branch|show|stash|pull|remote)(\s|$)|ls(\s|$)|find\s|cat\s|head\s|tail\s|wc\s|grep\s|pwd\s*$|whoami\s*$|df\s|du\s|uptime\s*$|free\s|ps\s|date\s*$|date\s|node\s--version|npm\s--version|pnpm\s--version|echo\s)/i
const FORBIDDEN_RE: RegExp[] = [
    /git\s+push/, /git\s+reset\s+--hard/, /git\s+checkout\s+\./, /git\s+clean/,
    /rm\s+-[rf]/, /(^|[^A-Za-z])kill(\s|$)/, /pkill/, /shutdown|reboot|poweroff/,
    /cat\s+[^|;]*\.env/, /sudo\s/, /chmod\s+777/, />\s*\/etc\//,
    /curl\s+[^|;]*\|\s*(ba)?sh/, /wget\s+[^|;]*\|\s*(ba)?sh/, /eval\s/,
    /deploy/i, /npm\s+publish/, /pnpm\s+publish/,
]
const REQUIREMENT_KEYWORD_RE = /(需求|新增|添加|功能|实现|开发|requirement|feature|写一个|加一个|做一个|上线)/i
const BUG_REPORT_KEYWORD_RE = /(报错|报\s*bug|出\s*bug|bug|异常|崩溃|闪退|错误信息|错误提示|error|exception|stack\s*trace|\b500\b)/i

const INTENT_COMMAND_MAP: Array<{ re: RegExp; cmd: string }> = [
    { re: /(最近的?git\s*提交|最近提交|最新改动|提交记录|commits?)/i, cmd: 'git log --oneline -10' },
    { re: /(代码状态|git\s*状态|git\s*status)/i, cmd: 'git status' },
    { re: /(拉取最新代码|拉取代码|git\s*pull|更新代码)/i, cmd: 'git pull' },
    { re: /(有哪些分支|分支列表|列出分支)/i, cmd: 'git branch -a' },
    { re: /(现在几点|当前时间|几点了)/i, cmd: 'date' },
    { re: /(文件列表|目录结构|有哪些文件)/i, cmd: 'ls -la' },
    { re: /(当前目录|在哪个目录)/i, cmd: 'pwd' },
    { re: /(磁盘)/i, cmd: 'df -h' },
    { re: /(服务状态|进程)/i, cmd: 'ps aux | head -20' },
]

export interface Classification {
    mode: 'task' | 'confirmation' | 'command' | 'requirement' | 'bugfix' | 'chat'
    confidence: number
    reasoning: string
    commands?: string[]
    summary?: string
}

/** Deterministic classification (always available, no API key needed). */
export function classifyByRules(msg: InboundMessage, hasPending: boolean): Classification {
    const text = String(msg.text || '').trim()

    if (hasPending) {
        return { mode: 'confirmation', confidence: 0.95, reasoning: '存在待确认问题, 消息视为回答' }
    }
    if (msg.chatType === 'group' && msg.isBotMentioned && BUG_REPORT_KEYWORD_RE.test(text)) {
        return { mode: 'bugfix', confidence: 0.9, reasoning: '群聊@机器人报错' }
    }
    if (OPTION_LETTER_RE.test(text) || (text.length <= 12 && CONFIRM_WORDS_RE.test(text))) {
        return { mode: 'confirmation', confidence: 0.7, reasoning: '短回复, 疑似回答确认问题' }
    }
    const explicit = text.split(/[\n;]+/).map((s) => s.trim()).filter((s) => EXPLICIT_CMD_RE.test(s))
    if (explicit.length > 0) {
        return { mode: 'command', confidence: 0.9, reasoning: '显式命令行', commands: explicit.slice(0, 5) }
    }
    if (/^(帮我|请)?\s*(push|推送)(代码)?(到远程)?|推送到远程/.test(text)) {
        return { mode: 'command', confidence: 0.9, reasoning: '推送意图 → 进入安全层', commands: ['git push'] }
    }
    const safe = text.split(/[\n;]+/).map((s) => s.trim()).filter((s) => s && SAFE_PREFIX_RE.test(s))
    if (safe.length > 0) {
        return { mode: 'command', confidence: 0.8, reasoning: '安全前缀命令', commands: [...new Set(safe)].slice(0, 5) }
    }
    const mapped: string[] = []
    for (const { re, cmd } of INTENT_COMMAND_MAP) {
        if (re.test(text)) mapped.push(cmd)
    }
    if (mapped.length > 0) {
        return { mode: 'command', confidence: 0.75, reasoning: '查询意图映射', commands: [...new Set(mapped)].slice(0, 5) }
    }
    if ((msg.docLinks && msg.docLinks.length > 0) || REQUIREMENT_KEYWORD_RE.test(text)) {
        return {
            mode: 'requirement',
            confidence: 0.85,
            reasoning: msg.docLinks && msg.docLinks.length ? '包含文档链接' : '命中需求关键词',
            summary: text.slice(0, 80),
        }
    }
    if (BUG_REPORT_KEYWORD_RE.test(text)) {
        return { mode: 'bugfix', confidence: 0.8, reasoning: '报错上报', summary: text.slice(0, 80) }
    }
    return { mode: 'chat', confidence: 0.5, reasoning: '无明确意图', summary: text.slice(0, 80) }
}

// ---------------------------------------------------------------------------
// command safety + execution
// ---------------------------------------------------------------------------

export interface SecurityVerdict {
    ok: boolean
    reason?: string
}

/** Whitelist-prefix + blacklist-pattern safety gate for in-plugin commands. */
export function securityCheck(cmd: string): SecurityVerdict {
    const c = String(cmd || '').trim()
    if (!c) return { ok: false, reason: '空命令' }
    if (/[;&|`$]/.test(c) && !/^ps\s+aux\s*\|\s*head\s+-?\d*$/.test(c) && !/^git\s+log\b/.test(c)) {
        // shell metacharacters are only tolerated for the exact pipeline forms we generate
        if (!/^\s*(git\s+log|git\s+status|ls|cat|head|tail|grep|wc|find|df|du|ps)\b[^;&`$]*$/.test(c)) {
            return { ok: false, reason: '包含不允许的 shell 元字符' }
        }
    }
    for (const re of FORBIDDEN_RE) {
        if (re.test(c)) return { ok: false, reason: '命中禁止规则: ' + String(re) }
    }
    if (!SAFE_PREFIX_RE.test(c)) return { ok: false, reason: '不在安全命令白名单内' }
    return { ok: true }
}

export interface CommandResult {
    cmd: string
    ok: boolean
    output: string
    error?: string
}

/** Run one whitelisted command; output is truncated. Never throws. */
export function runCommand(
    cmd: string,
    cwd: string,
    timeoutMs: number,
    maxChars: number
): Promise<CommandResult> {
    return new Promise<CommandResult>((resolve) => {
        try {
            exec(cmd, { cwd, timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
                const raw = String(stdout || '') + (stderr ? (stdout ? '\n' : '') + String(stderr) : '')
                const output = raw.length > maxChars ? raw.slice(0, maxChars) + '\n... (truncated)' : raw
                if (err) {
                    resolve({ cmd, ok: false, output, error: (err as Error).message })
                } else {
                    resolve({ cmd, ok: true, output })
                }
            })
        } catch (e) {
            resolve({ cmd, ok: false, output: '', error: (e as Error).message })
        }
    })
}

// ---------------------------------------------------------------------------
// model evaluation (optional; rules remain the fallback)
// ---------------------------------------------------------------------------

const CLASSIFY_SYSTEM_PROMPT = [
    '你是 IM 消息路由评估器。判断消息属于哪一类, 只输出 JSON。',
    '类别:',
    '- confirmation: 在回答一个待确认的问题 (选项字母 A/B/C/D、是/否、同意/取消等)。',
    '- command: 要求执行命令并返回结果 (git 状态/日志、文件列表、磁盘/内存、日期等只读操作)。params.commands 给出命令数组。',
    '- requirement: 需求/开发任务 (含文档链接或 需求/新增/实现/开发 等字眼)。',
    '- bugfix: 报错、异常、堆栈、线上故障描述。',
    '- chat: 其他闲聊或无法归类。',
    '格式: {"mode":"...","confidence":0.0-1.0,"reasoning":"一句话","params":{"commands":[],"summary":""}}',
].join('\n')

function normalizeClassification(raw: unknown): Classification | null {
    const modes = ['confirmation', 'command', 'requirement', 'bugfix', 'chat', 'task'] as const
    if (!raw || typeof raw !== 'object') return null
    const e = raw as { mode?: string; confidence?: number; reasoning?: string; params?: { commands?: unknown; summary?: unknown } }
    if (!e.mode || !(modes as readonly string[]).includes(e.mode)) return null
    const commands = Array.isArray(e.params?.commands)
        ? (e.params!.commands as unknown[]).map((c) => String(c)).filter(Boolean).slice(0, 5)
        : undefined
    return {
        mode: e.mode as Classification['mode'],
        confidence: typeof e.confidence === 'number' ? Math.max(0, Math.min(1, e.confidence)) : 0.5,
        reasoning: String(e.reasoning || '').slice(0, 200),
        commands,
        summary: typeof e.params?.summary === 'string' ? String(e.params.summary).slice(0, 120) : undefined,
    }
}

// ---------------------------------------------------------------------------
// casual chat (per-chat memory)
// ---------------------------------------------------------------------------

const CHAT_SYSTEM_PROMPT = [
    '你是 IM 群/私聊里的助手 (通过 DSH 承载)。简短、礼貌地回答闲聊类问题; 不要编造事实,',
    '不确定就说明需要转交主 agent 处理。需要执行命令或开发任务时提示用户已转交处理。',
].join('\n')

interface ChatTurn {
    role: 'user' | 'assistant'
    content: string
}

// ---------------------------------------------------------------------------
// the router
// ---------------------------------------------------------------------------

export interface RouterDeps {
    hub: InteractionHub
    pendingStore: PendingStore
    config: ResolvedRouterConfig
    log?: LogFn
}

export function createRouter(deps: RouterDeps): MessageRouter {
    const cfg = deps.config
    const log = deps.log || defaultLog
    const cwdOf = () => {
        try {
            return cfg.cwdOf ? cfg.cwdOf() : process.cwd()
        } catch {
            return process.cwd()
        }
    }
    const modelReady = () => {
        const base = cfg.baseURL || process.env.DEEPSEEK_BASE_URL || process.env.OPENAI_BASE_URL || ''
        const key = cfg.apiKey || process.env.DEEPSEEK_API_KEY || process.env.OPENAI_API_KEY || ''
        return !!(base && key)
    }

    const chatHistoryPath = (channel: string, chatId: string) =>
        path.join(expandHome(cfg.chatDir), channel, `${chatId.replace(/[^A-Za-z0-9_-]/g, '_')}.json`)

    const loadHistory = (channel: string, chatId: string): ChatTurn[] => {
        try {
            const j = JSON.parse(fs.readFileSync(chatHistoryPath(channel, chatId), 'utf8'))
            return Array.isArray(j) ? (j as ChatTurn[]) : []
        } catch {
            return []
        }
    }

    const saveHistory = (channel: string, chatId: string, history: ChatTurn[]): void => {
        const keep = Math.max(1, cfg.chatHistoryTurns) * 2
        writeFileSafe(chatHistoryPath(channel, chatId), JSON.stringify(history.slice(-keep)))
    }

    const taskActive = (msg: InboundMessage): boolean => {
        try {
            const f = path.join(projStateDir(cwdOf()), `${msg.channel}-task-active`, `${msg.chatId.replace(/[^A-Za-z0-9_-]/g, '_')}.json`)
            const raw = readFileSafe(f)
            if (!raw) return false
            const j = JSON.parse(raw) as { chat_id?: string; updated_at?: string }
            if (!j || !j.chat_id) return false
            const at = j.updated_at ? Date.parse(j.updated_at) : NaN
            if (Number.isFinite(at) && Date.now() - at > cfg.taskActiveTtlMs) return false
            return true
        } catch {
            return false
        }
    }

    const complete = async (system: string, messages: ChatTurn[], timeoutMs: number): Promise<string | null> => {
        const base = (cfg.baseURL || process.env.DEEPSEEK_BASE_URL || process.env.OPENAI_BASE_URL || '').replace(/\/$/, '')
        const key = cfg.apiKey || process.env.DEEPSEEK_API_KEY || process.env.OPENAI_API_KEY || ''
        if (!base || !key) return null
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), timeoutMs)
        try {
            const f = cfg.fetchImpl || fetch
            const res = await f(base + '/chat/completions', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
                body: JSON.stringify({
                    model: cfg.model,
                    temperature: 0,
                    messages: [{ role: 'system', content: system }, ...messages],
                }),
                signal: controller.signal,
            })
            if (!res.ok) return null
            const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> }
            const content = data?.choices?.[0]?.message?.content
            return content ? String(content) : null
        } catch (e) {
            log('warn', 'router model call failed:', (e as Error).message)
            return null
        } finally {
            clearTimeout(timer)
        }
    }

    const evaluate = async (msg: InboundMessage, hasPending: boolean): Promise<{ c: Classification; evaluator: 'model' | 'rules' }> => {
        const useModel = cfg.evaluator === 'model' || (cfg.evaluator === 'auto' && modelReady())
        if (useModel && modelReady()) {
            const prompt = JSON.stringify({
                message: {
                    text: msg.text || '',
                    chat_type: msg.chatType,
                    is_bot_mentioned: !!msg.isBotMentioned,
                    is_card_action: !!msg.isCardAction,
                    has_doc_links: !!(msg.docLinks && msg.docLinks.length),
                },
                plugin_pending_question: hasPending ? { kind: 'pending', question: '待确认' } : null,
            })
            const content = await complete(CLASSIFY_SYSTEM_PROMPT, [{ role: 'user', content: prompt }], cfg.evaluationTimeoutMs)
            if (content) {
                try {
                    const parsed = normalizeClassification(JSON.parse(content))
                    if (parsed) return { c: parsed, evaluator: 'model' }
                } catch { /* fall through to rules */ }
            }
        }
        return { c: classifyByRules(msg, hasPending), evaluator: 'rules' }
    }

    const replyReceipt = async (msg: InboundMessage, text: string): Promise<void> => {
        try {
            await deps.hub.sendText(msg.channel, msg.chatId, text)
        } catch (e) {
            log('error', 'router receipt failed:', (e as Error).message)
        }
    }

    const handleCommand = async (msg: InboundMessage, commands: string[]): Promise<RouterDecision> => {
        const verdicts = commands.map((c) => ({ cmd: c, verdict: securityCheck(c) }))
        const allowed = verdicts.filter((v) => v.verdict.ok)
        const blocked = verdicts.filter((v) => !v.verdict.ok)

        const results: CommandResult[] = []
        for (const { cmd } of allowed) {
            results.push(await runCommand(cmd, cwdOf(), cfg.commandTimeoutMs, cfg.commandMaxOutputChars))
        }

        if (results.length > 0) {
            const body = results
                .map((r) => `$ ${r.cmd}\n${r.output || (r.ok ? '(无输出)' : r.error || '执行失败')}`)
                .join('\n\n')
            await replyReceipt(msg, body.length > 3500 ? body.slice(0, 3500) + '\n... (truncated)' : body)
        }
        if (blocked.length > 0) {
            const names = blocked.map((b) => b.cmd).join('; ')
            if (results.length === 0) {
                // nothing ran: escalate to the agent (approval gate owns risky commands)
                return {
                    handled: false,
                    followup: true,
                    mode: 'command',
                    followupNote: `插件安全层未直接执行: ${names} (原因: ${blocked.map((b) => b.verdict.reason).join('; ')}) — 如需执行请走审批/确认流程。`,
                }
            }
            await replyReceipt(msg, `⚠️ 未执行受限命令: ${names}`)
        }
        return { handled: true, followup: false, mode: 'command' }
    }

    const handleConfirmation = async (msg: InboundMessage): Promise<RouterDecision> => {
        const pending = deps.pendingStore.get(msg.channel, msg.chatId)
        if (!pending) {
            // short confirmation with no open question → let the agent interpret it
            return { handled: false, followup: true, mode: 'confirmation' }
        }
        const text = String(msg.text || '').trim()
        const isModeCard = pending.kind === 'permission-mode'
        const letterOrWord = OPTION_LETTER_RE.test(text) || CONFIRM_WORDS_RE.test(text)
        if (!letterOrWord) {
            // not an answer: keep the question open, hand the message to the agent
            return { handled: false, followup: true, mode: 'confirmation' }
        }
        deps.pendingStore.clear(msg.channel, msg.chatId)
        if (isModeCard) {
            const mode = /^(全自动|auto|all|全采纳)/i.test(text) ? 'auto' : 'manual'
            const modeFile = path.join(projStateDir(cwdOf()), `${msg.channel}-permission-mode.txt`)
            writeFileSafe(modeFile, mode + '\n')
            await replyReceipt(msg, `已切换权限模式: ${mode === 'auto' ? '全自动' : '需审批'}（后续敏感操作按该模式处理）`)
            return { handled: true, followup: false, mode: 'confirmation' }
        }
        await replyReceipt(msg, `已记录你的选择: ${text}`)
        return { handled: true, followup: false, mode: 'confirmation' }
    }

    const handleChat = async (msg: InboundMessage): Promise<RouterDecision> => {
        if (!cfg.autoReply || !modelReady()) {
            // no model: the main agent answers (it still owns the conversation)
            return { handled: false, followup: true, mode: 'chat' }
        }
        const history = loadHistory(msg.channel, msg.chatId)
        const messages: ChatTurn[] = [...history, { role: 'user', content: String(msg.text || '') }]
        const answer = await complete(CHAT_SYSTEM_PROMPT, messages, cfg.chatTimeoutMs)
        if (!answer) return { handled: false, followup: true, mode: 'chat' }
        await replyReceipt(msg, answer)
        saveHistory(msg.channel, msg.chatId, [...messages, { role: 'assistant', content: answer }])
        return { handled: true, followup: false, mode: 'chat' }
    }

    /** The hub router: returns what the plugin handled vs what wakes the agent. */
    const router: MessageRouter = async (msg: InboundMessage): Promise<RouterDecision> => {
        if (!cfg.enabled) return { handled: false, followup: true, mode: 'followup' }
        try {
            // 1) an active task owns this chat — never intercept mid-task
            if (taskActive(msg)) {
                return {
                    handled: false,
                    followup: true,
                    mode: 'task',
                    followupNote: '该会话存在进行中的任务（task-active 标记），本条消息直接转交主 agent 处理。',
                }
            }

            const hasPending = deps.pendingStore.has(msg.channel, msg.chatId)
            const { c, evaluator } = await evaluate(msg, hasPending)
            log('info', `router: ${c.mode} (${evaluator}, conf=${c.confidence}) ${c.reasoning}`)

            switch (c.mode) {
                case 'confirmation':
                    return await handleConfirmation(msg)
                case 'command':
                    return await handleCommand(msg, c.commands && c.commands.length ? c.commands : [])
                case 'requirement':
                    return {
                        handled: false,
                        followup: true,
                        mode: 'requirement',
                        followupNote: c.summary ? `需求摘要: ${c.summary}` : undefined,
                    }
                case 'bugfix':
                    return {
                        handled: false,
                        followup: true,
                        mode: 'bugfix',
                        followupNote: c.summary ? `问题摘要: ${c.summary}` : undefined,
                    }
                case 'task':
                    return { handled: false, followup: true, mode: 'task' }
                default:
                    return await handleChat(msg)
            }
        } catch (e) {
            log('error', 'router failed; forwarding to agent:', (e as Error).message)
            return { handled: false, followup: true, mode: 'fallback' }
        }
    }

    return router
}
