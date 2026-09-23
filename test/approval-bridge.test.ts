/**
 * P0–P3: IM approval semantics — nonce-bound buttons, the project approver list,
 * the cancelled-on-silence policy and decision provenance.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
    askViaChannel,
    buildContextCard,
    parseAnswer,
    parseApprovalContext,
    proseOf,
    resolveContainedPath,
    setupAuthorization,
} from '../src/approval.js'
import { InteractionHub } from '../src/hub.js'
import { BaseChannel } from '../src/channel.js'
import type { SendResult } from '../src/types.js'
import type { ApprovalDeps, ApprovalHarness } from '../src/approval.js'

const CONTEXT_REASON = [
    '规格审批（第 2 次送审）：Add health endpoint',
    '',
    '```approval-context',
    JSON.stringify({ kind: 'spec', missionId: 'M-1', revision: 3, artifacts: ['.dsh/specs/M-1.md'], facts: { 验收标准: 2 } }, null, 2),
    '```',
    '',
].join('\n')

test('parseAnswer: nonce-bound button values are one-shot', () => {
    assert.deepEqual(parseAnswer('approve:abc12345'), { decision: 'allow', always: false, nonce: 'abc12345' })
    assert.deepEqual(parseAnswer('reject:abc12345'), { decision: 'deny', always: false, nonce: 'abc12345' })
    assert.deepEqual(parseAnswer('always:abc12345'), { decision: 'allow', always: true, nonce: 'abc12345' })
    // Legacy text answers keep working (terminal-style replies, older cards).
    assert.deepEqual(parseAnswer('yes'), { decision: 'allow', always: false })
})

test('parseApprovalContext: the suite block round-trips, prose stays readable', () => {
    const context = parseApprovalContext(CONTEXT_REASON)
    assert.equal(context?.kind, 'spec')
    assert.equal(context?.missionId, 'M-1')
    assert.equal(context?.revision, 3)
    assert.deepEqual(context?.artifacts, ['.dsh/specs/M-1.md'])
    assert.match(proseOf(CONTEXT_REASON), /规格审批（第 2 次送审）/)
    assert.doesNotMatch(proseOf(CONTEXT_REASON), /approval-context/)
    assert.equal(parseApprovalContext('plain reason'), undefined)
})

test('buildContextCard: fields instead of an essay, buttons bound to the nonce', () => {
    const card = buildContextCard(parseApprovalContext(CONTEXT_REASON)!, CONTEXT_REASON, 'n1')
    assert.match(card.body, /需求规格审核/)
    assert.match(card.body, /M-1/)
    assert.match(card.body, /验收标准：2/)
    assert.deepEqual(card.buttons.map((b) => b.value), ['approve:n1', 'reject:n1'])
})

/** A hub stand-in: scripted replies, recorded sends. */
function harness(replies: { text?: string; senderId?: string; messageId?: string }[]) {
    const sent: { title: string; body: string; buttons: { value: string }[] }[] = []
    const repliesLeft = [...replies]
    return {
        sent,
        opts: {
            chatId: 'oc_1',
            log: () => undefined,
            label: '飞书',
            answerTimeoutMs: 5_000,
            sendCard: async (_id: string, title: string, body: string, buttons: { value: string }[]) => {
                sent.push({ title, body, buttons })
                return { ok: true }
            },
            waitReply: async () => {
                const next = repliesLeft.shift()
                if (!next) return null
                return { channel: 'feishu', chatId: 'oc_1', chatType: 'p2p' as const, ...next }
            },
        },
    }
}

test('a click from outside the approver list does not decide anything', async () => {
    // The second answer is a REAL click: it echoes the button value of the card
    // the flow actually sent (a stranger clicking first must not consume it).
    const { opts, sent } = harness([])
    let click = 0
    opts.waitReply = async () => {
        click += 1
        // Both click the SAME real button value — only the identity differs, which
        // is the case this test is about (a bogus nonce is a stale card instead).
        if (click > 2) return null
        return {
            channel: 'feishu',
            chatId: 'oc_1',
            chatType: 'p2p' as const,
            text: String(sent[0]?.buttons[0]?.value ?? ''),
            senderId: click === 1 ? 'ou_stranger' : 'ou_boss',
            messageId: click === 1 ? 'om_1' : 'om_2',
        }
    }
    const replies: string[] = []
    const decision = await askViaChannel(
        { ...opts, approvers: ['ou_boss'], respond: async (t: string) => void replies.push(t) } as never,
        CONTEXT_REASON,
    )
    assert.equal(decision?.decision, 'allow', 'the authorised click decides')
    assert.equal(decision?.by, 'ou_boss')
    assert.equal(decision?.messageId, 'om_2')
    assert.match(replies.join('\n'), /没有该项目的审批权/)
})

test('a stale card from an earlier round is refused, not counted', async () => {
    const { opts, sent } = harness([{ text: 'approve:stale000', senderId: 'ou_boss', messageId: 'om_1' }, { text: 'x' }])
    void sent
    const replies: string[] = []
    const decision = await askViaChannel({ ...opts, respond: async (t: string) => void replies.push(t) } as never, CONTEXT_REASON)
    assert.equal(decision, null, 'no valid decision arrived')
    assert.match(replies.join('\n'), /已过期/)
})

test('every decision and refusal is written to the ledger', async () => {
    const { opts, sent } = harness([{ text: 'stale000', senderId: 'ou_boss' }, { text: 'reject:stale000', senderId: 'ou_boss' }])
    void sent
    const entries: { decision: string; userId?: string }[] = []
    const decision = await askViaChannel({ ...opts, onDecision: (e: never) => void entries.push(e) } as never, CONTEXT_REASON)
    assert.equal(decision, null)
    assert.ok(entries.length >= 2, `expected ledger rows, got ${JSON.stringify(entries)}`)
})

test('the artifacts named by the card are delivered before waiting', async () => {
    const { opts } = harness([{ text: 'approve:any', senderId: 'ou_boss' }])
    const files: string[] = []
    await askViaChannel(
        {
            ...opts,
            sendFile: async (f: { path: string }) => {
                files.push(f.path)
                return { ok: true }
            },
        } as never,
        CONTEXT_REASON,
    )
    assert.deepEqual(files, ['.dsh/specs/M-1.md'])
})

test('L3: silence on a channel-originated task is "cancelled", never a pass', async () => {
    const seen: unknown[] = []
    let nextCalls = 0
    const deps = {
        log: () => undefined,
        readMode: () => 'auto',
        readAllowlist: () => [],
        addAllowlist: () => true,
        isOriginated: () => true,
        askCard: async () => null,
    } as unknown as ApprovalDeps
    const harnessApi: ApprovalHarness = { on: (_event, listener) => void seen.push(listener) }
    setupAuthorization(harnessApi, deps, { bridgeHarnessApproval: true })
    const listener = seen.at(-1) as (payload: unknown, next: () => unknown) => Promise<unknown>
    const reply = await listener({ toolName: 'spec_approve', agent: { id: 'a1' } }, () => {
        nextCalls += 1
        return 'allowed-once'
    })
    assert.deepEqual(reply, { decision: 'cancelled', source: 'im', at: (reply as { at: number }).at })
    assert.equal(nextCalls, 0, 'a channel-originated task must not fall through to another answerer')
})

test('L3: a pass from elsewhere is left to that surface', async () => {
    const seen: unknown[] = []
    const deps = {
        log: () => undefined,
        readMode: () => 'auto',
        readAllowlist: () => [],
        addAllowlist: () => true,
        isOriginated: () => false,
        askCard: async () => null,
    } as unknown as ApprovalDeps
    setupAuthorization({ on: (_event, listener) => void seen.push(listener) } as ApprovalHarness, deps, { bridgeHarnessApproval: true })
    const listener = seen.at(-1) as (payload: unknown, next: () => unknown) => Promise<unknown>
    assert.equal(await listener({ toolName: 'x', agent: { id: 'a1' } }, () => 'allowed-once'), 'allowed-once')
})

test('L3: an IM decision carries who and which card', async () => {
    const seen: unknown[] = []
    const deps = {
        log: () => undefined,
        readMode: () => 'auto',
        readAllowlist: () => [],
        addAllowlist: () => true,
        isOriginated: () => true,
        askCard: async () => ({ decision: 'allow', always: false, by: 'ou_boss', messageId: 'om_9', at: 42 }),
    } as unknown as ApprovalDeps
    setupAuthorization({ on: (_event, listener) => void seen.push(listener) } as ApprovalHarness, deps, { bridgeHarnessApproval: true })
    const listener = seen.at(-1) as (payload: unknown, next: () => unknown) => Promise<unknown>
    assert.deepEqual(await listener({ toolName: 'mission_complete', agent: { id: 'a1' } }, () => 'x'), {
        decision: 'allowed-once',
        by: 'ou_boss',
        messageId: 'om_9',
        at: 42,
        source: 'im',
    })
})

// ---------------------------------------------------------------------------
// 材料路径包含校验（安全）：清单来自审批载荷，不能让模型诱导读取任意本地文件
// ---------------------------------------------------------------------------

test('resolveContainedPath: artifacts cannot escape the project workspace', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-artifacts-'))
    const inside = path.join(root, 'spec.md')
    fs.writeFileSync(inside, 'x')
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-outside-'))
    const outside = path.join(outsideDir, 'feishu-app.json')
    fs.writeFileSync(outside, '{"app_secret":"secret"}')

    assert.equal(resolveContainedPath(root, 'spec.md'), fs.realpathSync(inside), '项目内相对路径 → 允许')
    assert.equal(resolveContainedPath(root, inside), fs.realpathSync(inside), '项目内绝对路径 → 允许')
    assert.equal(resolveContainedPath(root, outside), null, '项目外绝对路径 → 拒绝')
    assert.equal(resolveContainedPath(root, path.relative(root, outside)), null, '`../` 逃逸 → 拒绝')
    assert.equal(resolveContainedPath(root, 'missing.md'), null, '不存在的文件 → 拒绝')
    assert.equal(resolveContainedPath(root, '.'), null, '目录 → 拒绝')

    const link = path.join(root, 'link.json')
    try {
        fs.symlinkSync(outside, link)
        assert.equal(resolveContainedPath(root, 'link.json'), null, '指向项目外的符号链接 → 拒绝')
    } catch { /* 平台不支持符号链接时跳过 */ }
})

test('所有 artifacts 都必须通过包含校验（否则不投递）', async () => {
    // 一个真实存在的项目内文件 + 一个项目外文件
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-artifacts-ok-'))
    const okFile = path.join(root, 'ok.md')
    fs.writeFileSync(okFile, 'spec')
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-artifacts-out-'))
    const outside = path.join(outsideDir, 'feishu-app.json')
    fs.writeFileSync(outside, '{"app_secret":"secret"}')

    const { opts } = harness([{ text: 'approve:any', senderId: 'ou_boss' }])
    const delivered: string[] = []
    const rejected: string[] = []
    const reason = [
        '规格审批',
        '',
        '```approval-context',
        JSON.stringify({ kind: 'spec', artifacts: [outside, path.relative(root, outside), 'ok.md'] }),
        '```',
        '',
    ].join('\n')
    await askViaChannel(
        {
            ...opts,
            sendFile: async (f: { path: string }) => {
                // 与 plugin 接线一致：投递前必须过包含校验
                const contained = resolveContainedPath(root, f.path)
                if (!contained) {
                    rejected.push(f.path)
                    return { ok: false, error: 'outside' }
                }
                delivered.push(contained)
                return { ok: true }
            },
        } as never,
        reason
    )
    assert.deepEqual(delivered, [fs.realpathSync(okFile)], '只有项目内材料被投递')
    assert.equal(rejected.length, 2, `两份越界材料被拒绝（实际: ${JSON.stringify(rejected)}）`)
})

test('plugin 接线确实使用包含校验（静态防回归）', () => {
    const here = path.dirname(fileURLToPath(import.meta.url))
    let root = here
    for (let i = 0; i < 4; i++) {
        if (fs.existsSync(path.join(root, 'src', 'plugin.ts'))) break
        root = path.dirname(root)
    }
    const src = fs.readFileSync(path.join(root, 'src', 'plugin.ts'), 'utf8')
    assert.match(src, /resolveContainedPath\(cwdOfAgent\(agent\), file\.path\)/, 'sendFile 闭包必须调用 resolveContainedPath')
    assert.doesNotMatch(src, /path\.isAbsolute\(file\.path\) \? file\.path/, '不得再直接放行绝对路径')
})

// ---------------------------------------------------------------------------
// requireTokenClick：只认按钮点击
// ---------------------------------------------------------------------------

test('requireTokenClick: a typed yes is answered but never decides; a click does', async () => {
    const { opts, sent } = harness([])
    const entries: { decision: string; via?: string }[] = []
    const replies: string[] = []
    let calls = 0
    opts.waitReply = async () => {
        calls += 1
        if (calls === 1) {
            return { channel: 'feishu', chatId: 'oc_1', chatType: 'p2p' as const, text: 'yes', senderId: 'ou_boss', messageId: 'om_text' }
        }
        if (calls === 2) {
            return {
                channel: 'feishu',
                chatId: 'oc_1',
                chatType: 'p2p' as const,
                text: String(sent[0]?.buttons[0]?.value ?? ''),
                senderId: 'ou_boss',
                messageId: 'om_click',
            }
        }
        return null
    }
    const decision = await askViaChannel(
        {
            ...opts,
            requireTokenClick: true,
            onDecision: (e: never) => void entries.push(e),
            respond: async (t: string) => void replies.push(t),
        } as never,
        CONTEXT_REASON
    )
    assert.equal(decision?.decision, 'allow', '点击决定了结果')
    assert.equal(decision?.messageId, 'om_click', '文本回答没有生效')
    assert.ok(
        entries.some((e) => e.decision === 'text-rejected' && e.via === 'text'),
        `文本回答必须记 text-rejected（实际: ${JSON.stringify(entries)}）`
    )
    assert.ok(entries.some((e) => e.decision === 'allow' && e.via === 'click'), '放行记 via=click')
    assert.match(replies.join('\n'), /只接受卡片按钮/)
})

test('默认模式：文本回答仍生效，但记账标明来源是 text', async () => {
    const { opts } = harness([{ text: 'yes', senderId: 'ou_ops', messageId: 'om_t' }])
    const entries: { decision: string; via?: string; userId?: string; messageId?: string }[] = []
    const decision = await askViaChannel(
        { ...opts, onDecision: (e: never) => void entries.push(e) } as never,
        CONTEXT_REASON
    )
    assert.equal(decision?.decision, 'allow', '默认兼容：文本回答可用')
    assert.equal(decision?.by, 'ou_ops')
    assert.equal(entries.length, 1, '恰好一行账')
    assert.deepEqual(
        { ...entries[0], at: undefined, chatId: undefined, nonce: undefined },
        { decision: 'allow', userId: 'ou_ops', messageId: 'om_t', via: 'text', at: undefined, chatId: undefined, nonce: undefined },
        '记账标明来源是 text'
    )
})

// ---------------------------------------------------------------------------
// hub.sendFile 守卫
// ---------------------------------------------------------------------------

test('hub.sendFile: 未记录会话时拒绝，且不调用适配器', async () => {
    const hub = new InteractionHub({ log: () => undefined })
    let called = 0
    class Probe extends BaseChannel {
        readonly name = 'probe'
        readonly label = '探针'
        override readonly capabilities = { cards: false, richText: false, images: false, inbound: true, files: true }
        override async connect() {
            this.setConnected(true)
            return { ok: true, connected: true }
        }
        override async disconnect() {
            this.setConnected(false)
            return { ok: true, connected: false }
        }
        override async sendText(_c: string, _t: string): Promise<SendResult> {
            return { ok: true }
        }
        async sendFile(_c: string, _f: { path: string }): Promise<SendResult> {
            called += 1
            return { ok: true }
        }
    }
    hub.addChannel(new Probe())
    const r = await hub.sendFile('probe', '', { path: '/tmp/whatever' })
    assert.equal(r.ok, false)
    assert.match(r.error || '', /no chat recorded/)
    assert.equal(called, 0, '空会话不得调用适配器')
    hub.teardown()
})
