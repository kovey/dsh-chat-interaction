/**
 * 宿主审批契约的**运行期**回归（不是读源码得出的结论）。
 *
 * `approval/request` 是一个 cordis waterfall：应答者**必须返回一个
 * `ApprovalOutcome` 字符串**（`'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'`）。
 * `dsh-user-approval` 的 `decide()` 会把任何非 outcome 的返回值归一化：
 *
 *     OUTCOMES.includes(outcome) ? outcome : 'unavailable'
 *
 * 实测（0.1.5-rc.1 与 0.1.7-rc.1 行为相同）：返回 `{decision:'allowed-once', by,…}`
 * 这样的富对象会被判成 `'unavailable'` —— 即"用户点了通过却等于没人应答"，
 * 而且 `approval/decided` 审计事件也记成 unavailable（审计失真）。
 * 决策溯源（by/messageId/via）因此必须走插件自己的账本与日志。
 *
 * 本文件用**真实的** `ApprovalService` + 真实 cordis Context 跑这条契约，避免有人
 * 再把"返回对象"当成能用的做法（测试与实现自洽、却与宿主契约不符）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { setupAuthorization } from '../src/approval.js'
import type { ApprovalDeps, ApprovalHarness } from '../src/approval.js'

const HOST_OUTCOMES = ['allowed-once', 'rejected', 'cancelled', 'unavailable']

/** 载入官方服务；包缺失（离线裁剪安装）时跳过整个文件。 */
const approvalMod = await import('@deepseek-ai/dsh-user-approval').catch(() => null)
const ApprovalService = (approvalMod as { ApprovalService?: new (ctx: unknown, cfg: unknown) => { request(req: unknown): Promise<string> } } | null)?.ApprovalService

/** 真实服务要求会话有"打开的回合"（审计对必须 turn-enclosed）。 */
function fakeSession(events: Record<number, unknown>, appended: Array<{ type: string; data: Record<string, unknown> }>) {
    let seq = 1
    const session = {
        seq: 1,
        eventAt: (s: number) => events[Number(s)],
        append: (type: string, data: Record<string, unknown>) => {
            appended.push({ type, data })
            events[seq] = { type, data, seq }
            seq += 1
            session.seq = seq
            return seq
        },
    }
    return session
}

async function runRequest(opts: {
    listener?: (req: unknown, next: () => unknown) => unknown
    askCard?: unknown
}): Promise<{ outcome: string; decided?: string; logs: string[] }> {
    const ctx = new Context()
    const appended: Array<{ type: string; data: Record<string, unknown> }> = []
    const events: Record<number, unknown> = { 0: { type: 'turn/start', seq: 0 } }
    const session = fakeSession(events, appended)
    const logs: string[] = []
    // cordis 的 Events 是靠 declaration merging 扩充的（键类型为 never），
    // 测试里直接 cast —— 运行时按名字派发，与宿主一致。
    if (opts.listener) ctx.on('approval/request' as never, opts.listener as never)

    const deps = {
        log: (_lvl: string, ...msg: unknown[]) => void logs.push(msg.join(' ')),
        readMode: () => 'manual',
        readAllowlist: () => [],
        addAllowlist: () => true,
        isOriginated: () => true,
        askCard: async () => opts.askCard ?? null,
    } as unknown as ApprovalDeps
    // 把插件的 L3 桥挂到同一个真实 ctx（等价于宿主里的 harness.on）
    setupAuthorization({ on: (event, listener) => ctx.on(event as never, listener as never) } as ApprovalHarness, deps, {
        bridgeHarnessApproval: true,
    })

    const svc = new ApprovalService!(ctx, { policy: 'ask' })
    const agent = { id: 'a1', session, ctx }
    const outcome = (await svc.request({ agent, toolName: 'spec_approve', reason: '规格审批' })) as string
    return { outcome, decided: appended.find((a) => a.type === 'approval/decided')?.data?.outcome as string, logs }
}

test('契约：应答者返回对象会被宿主判成 unavailable（这条断言就是修复的依据）', { skip: !ApprovalService }, async () => {
    const { outcome, decided } = await runRequest({
        listener: async () => ({ decision: 'allowed-once', by: 'ou_boss', messageId: 'om_9' }),
    })
    assert.equal(outcome, 'unavailable', '富对象不是 outcome —— 宿主会归一化成 unavailable')
    assert.equal(decided, 'unavailable', '审计事件也记成 unavailable（这就是"点通过不放行"的现场）')
    assert.ok(HOST_OUTCOMES.includes(outcome))
})

test('契约：合法 outcome 字符串原样通过', { skip: !ApprovalService }, async () => {
    for (const want of ['allowed-once', 'rejected', 'cancelled'] as const) {
        const { outcome, decided } = await runRequest({ listener: async () => want })
        assert.equal(outcome, want)
        assert.equal(decided, want, '审计与裁决一致')
    }
})

test('端到端：修复后的桥 + 真实服务 —— 用户点通过/拒绝/超时分别得到 allowed-once / rejected / cancelled', { skip: !ApprovalService }, async () => {
    const allowed = await runRequest({ askCard: { decision: 'allow', always: false, by: 'ou_boss', messageId: 'om_9', via: 'click' } })
    assert.equal(allowed.outcome, 'allowed-once', '点通过必须真的放行')
    assert.equal(allowed.decided, 'allowed-once')
    assert.match(allowed.logs.join('\n'), /by=ou_boss/, '溯源落在插件日志里（宿主通道不携带元数据）')
    assert.match(allowed.logs.join('\n'), /via=click/)

    const rejected = await runRequest({ askCard: { decision: 'deny', always: false, by: 'ou_boss', messageId: 'om_10', via: 'click' } })
    assert.equal(rejected.outcome, 'rejected')

    const cancelled = await runRequest({ askCard: null })
    assert.equal(cancelled.outcome, 'cancelled', '通道发起的任务沉默 → cancelled（沉默不是同意）')
})

test('端到端：桥的每种返回都是宿主 outcome 集合内的字符串', { skip: !ApprovalService }, async () => {
    for (const askCard of [
        { decision: 'allow', always: true, by: 'u', via: 'click' },
        { decision: 'deny', always: false, by: 'u', via: 'text' },
        null,
    ]) {
        const { outcome } = await runRequest({ askCard })
        assert.equal(typeof outcome, 'string', '绝不能返回对象')
        assert.ok(HOST_OUTCOMES.includes(outcome), `outcome 必须是宿主认可的取值，得到 ${outcome}`)
    }
})
