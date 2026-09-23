/**
 * Authorization, generalized from dsh-feishu's P3 approval module.
 *
 * L2 manual-mode gate: a `tools/pre-execute` waterfall listener. For bash
 * calls made during channel-originated task turns while the project's
 * permission mode is `manual`, the command is put to an inline yes/no/always
 * card on the originating channel. `always` appends the exact command to the
 * project allowlist. Timeout / no recorded chat → deny (fail closed).
 *
 * L3 harness-approval bridge (default OFF): an `approval/request` answerer
 * that routes ANY harness approval ask to a channel card — for headless 24×7
 * deployments without a local answerer.
 *
 * Everything is channel-agnostic: decisions are pure functions, side effects
 * arrive through injected deps, so this module is trivially unit-testable
 * and reusable for Feishu, WeCom, or any future adapter.
 * @module dsh-chat-interaction/approval
 */
import type { InboundMessage, ButtonSpec } from './types.js'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { LogFn } from './log.js'

export const CMD_MAX_CHARS = 800

// ---- pure decision helpers (unit-tested) ----

export interface GateInput {
    /** `auto` | `manual` */
    mode: string
    allowlist: string[]
    cmd: string
    /** True while the executing agent handles a channel-originated turn. */
    originated: boolean
}

export interface GateOutput {
    ask: boolean
    allowed?: boolean
}

/** Decide whether one command needs the manual-mode card. */
export function evaluateGate({ mode, allowlist, cmd, originated }: GateInput): GateOutput {
    if (mode !== 'manual') return { ask: false }
    if (!originated) return { ask: false }
    if (!cmd) return { ask: false }
    if (allowlist.includes(cmd)) return { ask: false, allowed: true }
    return { ask: true }
}

export interface AnswerDecision {
    decision: 'allow' | 'deny'
    always: boolean
    /** Who decided (platform user id). Absent for text answers. */
    by?: string
    /** Platform message id of the card/message carrying the decision. */
    messageId?: string
    /** Decision time (epoch ms). */
    at?: number
    /** The one-shot token the card carried, when it was a button click. */
    nonce?: string
}

/** The fence the engineering suite uses to embed machine-readable fields. */
export const APPROVAL_CONTEXT_FENCE = 'approval-context'

/** Fields a card renders; mirrors `dsh-eng-core`'s `ApprovalContext`. */
export interface ApprovalContext {
    kind?: string
    missionId?: string
    title?: string
    revision?: number | string
    risk?: string
    artifacts?: string[]
    facts?: Record<string, string | number>
    channelHints?: { buttons?: string[]; requiresReason?: boolean }
}

/**
 * Read the suite's `approval-context` block out of a reason.
 *
 * A standalone copy of the same convention (this plugin does not depend on
 * `dsh-eng-core`): prose for a text answerer, fenced JSON for a card.
 */
export function parseApprovalContext(reason: string): ApprovalContext | undefined {
    const match = /```approval-context\s*\n([\s\S]*?)\n```/.exec(String(reason ?? ''))
    if (!match) return undefined
    try {
        const parsed = JSON.parse(match[1] as string) as unknown
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
        return parsed as ApprovalContext
    } catch {
        return undefined
    }
}

/** The reason without its machine block: what a text answerer should show. */
export function proseOf(reason: string): string {
    return String(reason ?? '').replace(/\n*```approval-context\s*\n[\s\S]*?\n```\n*/, '\n').trim()
}

/**
 * Resolve an approval artifact to an ABSOLUTE path that is provably inside
 * `root`, or return null.
 *
 * The artifact list comes from the approval payload (`approval-context` block),
 * which the suite writes but a model can also influence — so an absolute path or
 * a `../` traversal must not be able to hand the chat an arbitrary local file
 * (e.g. `~/.dsh/feishu-app.json`, which holds app credentials).
 *
 * Symlinks are resolved first, so a link inside the project pointing outside is
 * rejected as well. Directories and missing files are not artifacts.
 */
export function resolveContainedPath(root: string, requested: string): string | null {
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

/** One ledger row per decision (or refusal) — the IM half of the audit trail. */
export interface ApprovalLedgerEntry {
    at: number
    chatId: string
    userId?: string
    decision:
        | 'allow'
        | 'deny'
        | 'timeout'
        | 'send-failed'
        | 'unauthorized'
        | 'stale-click'
        /** A text answer refused because the flow demands a button click. */
        | 'text-rejected'
    /** How the decision arrived: a nonce-bound click, or a typed answer. */
    via?: 'click' | 'text'
    /** The tool that asked, when the payload carried one. */
    toolName?: string
    nonce: string
    messageId?: string
    missionId?: string
}

/** Parse the card answer into a decision + always flag. */
export function parseAnswer(text: string): AnswerDecision | null {
    const t = String(text || '').trim()
    // Button values carry a ONE-SHOT token (`approve:<nonce>`): a forwarded card,
    // a stale card from an earlier round, or a guessed `yes` cannot be replayed.
    const token = /^(approve|reject|always):([A-Za-z0-9_-]{4,64})$/i.exec(t)
    if (token) {
        const nonce = token[2] as string
        const verb = (token[1] as string).toLowerCase()
        if (verb === 'approve') return { decision: 'allow', always: false, nonce }
        if (verb === 'always') return { decision: 'allow', always: true, nonce }
        return { decision: 'deny', always: false, nonce }
    }
    if (/^(yes|同意|y|ok|好的|允许)$/i.test(t)) return { decision: 'allow', always: false }
    if (/^(always|始终|始终同意|永久同意)$/i.test(t)) return { decision: 'allow', always: true }
    if (/^(no|拒绝|n|不|算了|deny)$/i.test(t)) return { decision: 'deny', always: false }
    return null
}

/** The standard approval card (buttons: yes / no / always). */
export function buildApprovalCard(cmd: string, nonce?: string, allowAlways = true): { body: string; buttons: ButtonSpec[] } {
    const value = (verb: 'approve' | 'reject' | 'always'): string => (nonce ? `${verb}:${nonce}` : verb === 'approve' ? 'yes' : verb === 'reject' ? 'no' : 'always')
    return {
        body: [
            '手动审批模式：以下命令需要你的确认',
            '```\n' + String(cmd).slice(0, CMD_MAX_CHARS) + '\n```',
            `同意=仅本次放行 | 拒绝=本次拦截${allowAlways ? ' | 始终同意=加入允许列表并放行' : ''}`,
        ].join('\n'),
        buttons: [
            { value: value('approve'), label: '同意', type: 'primary' },
            { value: value('reject'), label: '拒绝', type: 'danger' },
            ...(allowAlways ? [{ value: value('always'), label: '始终同意' }] : []),
        ],
    }
}

/**
 * The card for a suite approval (spec / delivery / standards / dependency).
 *
 * The fields come from the `approval-context` block, so a card says WHAT is being
 * decided instead of pasting an essay — and the buttons stay nonce-bound.
 */
export function buildContextCard(
    context: ApprovalContext,
    prose: string,
    nonce: string,
    allowAlways = false,
): { body: string; buttons: ButtonSpec[] } {
    const kindLabel: Record<string, string> = {
        spec: '需求规格审核',
        delivery: '交付审核',
        standards: '代码规范放宽',
        dependency: '新增依赖审批',
        command: '命令审批',
    }
    const lines = [`**${kindLabel[context.kind ?? ''] ?? '审批'}**`, '']
    if (context.title) lines.push(`- 任务：${context.title}`)
    if (context.missionId) lines.push(`- mission：\`${context.missionId}\``)
    if (context.revision !== undefined) lines.push(`- 版本：${context.revision}`)
    if (context.risk) lines.push(`- 风险：${context.risk}`)
    for (const [key, value] of Object.entries(context.facts ?? {})) lines.push(`- ${key}：${value}`)
    if (context.artifacts?.length) lines.push(`- 材料：${context.artifacts.length} 份（随后单独发送）`)
    lines.push('', '---', '', String(proseOf(prose)).slice(0, CMD_MAX_CHARS))
    return {
        body: lines.join('\n'),
        buttons: [
            { value: `approve:${nonce}`, label: '通过', type: 'primary' },
            { value: `reject:${nonce}`, label: '打回', type: 'danger' },
            ...(allowAlways ? [{ value: `always:${nonce}`, label: '始终允许' }] : []),
        ],
    }
}

// ---- side-effect dependencies (injected) ----

/** What a `tools/pre-execute` payload looks like (structural, dsh-compatible). */
export interface PreExecutePayload {
    name: string
    agent?: { id?: string } | null
    arguments?: { command?: string } | Record<string, unknown>
    signal?: AbortSignal
}

/** What an `approval/request` payload looks like (structural). */
export interface ApprovalRequestPayload {
    toolName?: string
    callId?: string
    reason?: string
    agent?: { id?: string } | null
    signal?: AbortSignal
}

/** Decisions this plugin returns to the harness approval seam (see the suite's contract). */
export type HarnessApprovalReply =
    | 'allowed-once'
    | 'rejected'
    | { decision: 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'; by?: string; messageId?: string; at?: number; source?: string }

export interface ApprovalDeps {
    log: LogFn
    /** Current permission mode for the agent's project. */
    readMode(agent: PreExecutePayload['agent']): string
    readAllowlist(agent: PreExecutePayload['agent']): string[]
    addAllowlist(agent: PreExecutePayload['agent'], cmd: string): boolean
    /** True while the agent is inside a channel-originated task window. */
    isOriginated(agent: PreExecutePayload['agent']): boolean
    /**
     * Put the command to an inline card on the originating channel and wait
     * for the answer. Resolve null on timeout / send failure (fail closed).
     */
    askCard(
        agent: PreExecutePayload['agent'],
        cmd: string,
        signal?: AbortSignal,
        /** The asking tool, for the card heading (suite approvals). */
        subject?: string,
    ): Promise<AnswerDecision | null>
}

/** Minimal structural slice of the harness context that approval needs. */
export interface ApprovalHarness {
    on?(event: string, listener: (payload: any, next: () => any) => any): void
}

/**
 * Register the L2 manual-mode pre-execute gate and (optionally) the L3
 * approval bridge. Returns the registered listeners' unregister function
 * (via harness.on when it supports it; otherwise a no-op teardown).
 */
export function setupAuthorization(
    harness: ApprovalHarness,
    deps: ApprovalDeps,
    cfg: { bridgeHarnessApproval?: boolean } = {}
): () => void {
    const on = (event: string, listener: (payload: any, next: () => any) => any) => {
        if (typeof harness.on === 'function') harness.on(event, listener)
    }

    // ---- L2: manual-mode pre-execute gate (bash only, inline card Q&A) ----
    on('tools/pre-execute', async (exec: PreExecutePayload, next: () => any) => {
        try {
            if (exec.name !== 'bash' || !exec.agent) return next()
            if (deps.readMode(exec.agent) !== 'manual') return next()
            if (!deps.isOriginated(exec.agent)) return next()
            const cmd = exec.arguments && typeof exec.arguments.command === 'string' ? exec.arguments.command : ''
            const gate = evaluateGate({
                mode: 'manual',
                allowlist: deps.readAllowlist(exec.agent),
                cmd,
                originated: true,
            })
            if (!gate.ask) return gate.allowed ? { kind: 'allow' } : next()
            deps.log('info', 'manual gate: asking approval for', cmd.slice(0, 120))
            const r = await deps.askCard(exec.agent, cmd, exec.signal)
            if (!r) return { kind: 'deny', reason: '审批未通过/超时（fail closed）' }
            if (r.decision === 'deny') return { kind: 'deny', reason: '用户拒绝了该命令' }
            if (r.always) deps.addAllowlist(exec.agent, cmd)
            return { kind: 'allow' }
        } catch (e) {
            deps.log('error', 'pre-execute gate error:', (e as Error).message)
            return next()
        }
    })
    deps.log('info', 'manual-mode pre-execute gate registered')

    // ---- L3: harness approval bridge (default OFF; for headless 24x7) ----
    if (cfg.bridgeHarnessApproval) {
        on('approval/request', async (req: ApprovalRequestPayload, next: () => any): Promise<HarnessApprovalReply | unknown> => {
            try {
                const cmd = `${req.toolName || '?'}${req.callId ? ' (call ' + String(req.callId).slice(0, 12) + ')' : ''}`
                deps.log('info', 'harness approval bridge: asking for', cmd)
                const originated = req.agent ? deps.isOriginated(req.agent) : false
                const r = await deps.askCard(
                    req.agent,
                    String(req.reason || cmd).slice(0, CMD_MAX_CHARS * 4),
                    req.signal,
                    req.toolName,
                )
                if (!r) {
                    // Nobody decided. For a task that ARRIVED over this channel the
                    // answer is "cancelled" — silence is not consent, and falling
                    // through would let another answerer approve by default. A task
                    // started elsewhere is left to that surface.
                    if (originated) return { decision: 'cancelled', source: 'im', at: Date.now() }
                    return next()
                }
                if (r.decision === 'deny') {
                    return { decision: 'rejected', ...(r.by ? { by: r.by } : {}), ...(r.messageId ? { messageId: r.messageId } : {}), at: r.at ?? Date.now(), source: 'im' }
                }
                return {
                    decision: 'allowed-once',
                    ...(r.by ? { by: r.by } : {}),
                    ...(r.messageId ? { messageId: r.messageId } : {}),
                    at: r.at ?? Date.now(),
                    source: 'im',
                }
            } catch (e) {
                deps.log('error', 'approval bridge error:', (e as Error).message)
                return next()
            }
        })
        deps.log('info', 'harness approval bridge (L3) registered')
    }

    return () => { /* cordis waterfalls have no unregister; teardown is a no-op */ }
}

// ---- helpers for wiring into a hub (used by plugin.ts) ----

/** Ask via one channel, wait for the card click, parse the answer. */
export interface AskViaChannelOptions {
    chatId: string | null
    sendCard: (chatId: string, title: string, body: string, buttons: ButtonSpec[]) => Promise<{ ok: boolean; error?: string }>
    waitReply: (chatId: string, timeoutMs: number, signal?: AbortSignal) => Promise<InboundMessage | null>
    log: LogFn
    label: string
    answerTimeoutMs: number
    /** Card heading detail, e.g. the asking tool. */
    subject?: string
    /**
     * Ids allowed to decide. EMPTY means "anyone in the bound chat", which keeps
     * the historical behaviour; a filled list is the strict mode a project opts
     * into (`.dsh`-side file, one id per line).
     */
    approvers?: string[]
    /** Every decision/refusal is reported here (JSONL ledger in the plugin). */
    onDecision?: (entry: ApprovalLedgerEntry) => void
    /** Reply into the chat (answering an unauthorised or stale click). */
    respond?: (text: string) => Promise<unknown>
    /** Deliver one approval artifact. */
    sendFile?: (file: { path: string; name?: string }) => Promise<{ ok: boolean; error?: string }>
    /** Send the artifacts named in the context block (default true when sendFile exists). */
    sendArtifacts?: boolean
    /** Offer "始终允许" (command approvals only). */
    allowAlways?: boolean
    /**
     * Accept ONLY nonce-bound card clicks. A typed `yes`/`同意` then no longer
     * decides anything (it is answered and recorded as `text-rejected`), which is
     * what the replay-protection story promises. Default false keeps the
     * historical behaviour where a typed answer still works.
     */
    requireTokenClick?: boolean
}

/** How many unauthorised clicks are answered before giving up (bounded noise). */
const MAX_REFUSALS = 3

export async function askViaChannel(opts: AskViaChannelOptions, cmd: string, signal?: AbortSignal): Promise<AnswerDecision | null> {
    const { chatId } = opts
    const nonce = randomUUID().replace(/-/g, '').slice(0, 12)
    const ledger = (entry: Omit<ApprovalLedgerEntry, 'at' | 'chatId' | 'nonce'>): void => {
        try {
            opts.onDecision?.({ at: Date.now(), chatId: chatId ?? '', nonce, ...entry })
        } catch (e) {
            opts.log('error', 'approval ledger write failed:', (e as Error).message)
        }
    }
    if (!chatId) {
        opts.log('warn', 'no chat recorded for approval; denying (fail closed)')
        ledger({ decision: 'send-failed' })
        return null
    }
    const context = parseApprovalContext(cmd)
    const card = context
        ? buildContextCard(context, cmd, nonce, opts.allowAlways === true)
        : buildApprovalCard(cmd, nonce, opts.allowAlways !== false)
    const heading = context?.kind ? `[审批] ${opts.subject ?? context.kind}` : `[审批] ${opts.label}远程任务执行命令`
    const sent = await opts.sendCard(chatId, heading, card.body, card.buttons)
    if (!sent || !sent.ok) {
        opts.log('error', 'approval card send failed; denying:', sent && sent.error)
        ledger({ decision: 'send-failed' })
        return null
    }
    if (context?.artifacts?.length && opts.sendFile && opts.sendArtifacts !== false) {
        for (const artifact of context.artifacts.slice(0, 5)) {
            try {
                const result = await opts.sendFile({ path: artifact })
                if (!result.ok) opts.log('warn', `artifact not delivered (${artifact}):`, result.error)
            } catch (e) {
                opts.log('warn', `artifact delivery threw (${artifact}):`, (e as Error).message)
            }
        }
    }

    const deadline = Date.now() + opts.answerTimeoutMs
    let refusals = 0
    for (;;) {
        const remaining = deadline - Date.now()
        if (remaining <= 0) {
            ledger({ decision: 'timeout' })
            return null
        }
        const ans = await opts.waitReply(chatId, remaining, signal)
        if (!ans || !ans.text) {
            ledger({ decision: 'timeout' })
            return null // timeout / aborted → deny (fail closed)
        }
        const parsed = parseAnswer(ans.text)
        if (!parsed) continue // unrelated chatter: keep waiting for the decision
        if (parsed.nonce !== undefined && parsed.nonce !== nonce) {
            ledger({ decision: 'stale-click', userId: ans.senderId, messageId: ans.messageId, via: 'click' })
            await opts.respond?.('这张审批卡已过期（或来自别的请求），请使用最新一张卡片。')
            continue
        }
        if (opts.requireTokenClick === true && parsed.nonce === undefined) {
            // Strict mode: only the nonce-bound button counts. A typed `yes` is
            // answered and recorded, but never decides — otherwise "cannot be
            // replayed" would be untrue.
            ledger({ decision: 'text-rejected', userId: ans.senderId, messageId: ans.messageId, via: 'text' })
            opts.log('warn', 'approval text answer refused (requireTokenClick):', ans.text)
            await opts.respond?.('本次审批只接受卡片按钮，请点击卡片上的按钮完成。')
            continue
        }
        const approvers = opts.approvers ?? []
        if (approvers.length > 0 && (!ans.senderId || !approvers.includes(ans.senderId))) {
            refusals += 1
            ledger({ decision: 'unauthorized', userId: ans.senderId, messageId: ans.messageId, via: parsed.nonce !== undefined ? 'click' : 'text' })
            opts.log('warn', 'approval click from a user who is not on the approver list:', ans.senderId)
            await opts.respond?.('你没有该项目的审批权，本次点击未生效。')
            if (refusals >= MAX_REFUSALS) return null
            continue
        }
        ledger({
            decision: parsed.decision,
            userId: ans.senderId,
            messageId: ans.messageId,
            via: parsed.nonce !== undefined ? 'click' : 'text',
        })
        return { ...parsed, by: ans.senderId, messageId: ans.messageId, at: Date.now() }
    }
}
