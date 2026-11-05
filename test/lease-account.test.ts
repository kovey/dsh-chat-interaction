/**
 * 租约身份 = 机器人（账号），不是渠道名。
 *
 * 背景（真实缺陷）：凭据与状态都是**项目级**（`<project>/.dsh/feishu-app.json`、
 * active chat / 审批人 / 账本），但旧租约只按 `channel` 命名 → 两个项目用**不同机器人**
 * 时会被误判成同一个监听器而互相拒绝。修复后：
 *   - 不同机器人（不同 accountKey）→ 互不阻塞
 *   - 同一机器人（同 accountKey）→ 仍然互斥（双 WS 会分流丢消息）
 *   - 无凭据（无 accountKey）→ 保持旧文件名（向后兼容）
 *   - 旧版遗留的渠道级租约仍在活跃时 → 新键拒绝（迁移保护，避免双监听）
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ChannelLease } from '../src/lease.js'

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-lease-acct-'))

function lease(dir: string, over: Partial<ConstructorParameters<typeof ChannelLease>[0]> = {}) {
    return new ChannelLease({
        channel: 'feishu',
        role: 'interactive',
        dir,
        ttlMs: 90_000,
        heartbeatMs: 30_000,
        log: () => undefined,
        ...over,
    })
}

test('不同机器人（不同 accountKey）各持一份租约，互不阻塞', () => {
    const dir = tmp()
    const a = lease(dir, { accountKey: 'aaaaaaaaaaaa', instanceId: 'A' })
    const b = lease(dir, { accountKey: 'bbbbbbbbbbbb', instanceId: 'B' })
    const ra = a.acquire()
    const rb = b.acquire()
    assert.equal(ra.ok, true)
    assert.equal(rb.ok, true, '两个项目用不同机器人时必须都能连')
    assert.notEqual(a.file, b.file)
    assert.ok(fs.existsSync(a.file) && fs.existsSync(b.file))
    a.release(); b.release(); a.dispose(); b.dispose()
})

test('跨项目（不同租约目录）同一机器人互不阻塞 —— 租约是项目级的', () => {
    const a = lease(tmp(), { accountKey: 'sameaccount1', instanceId: 'A' })
    const b = lease(tmp(), { accountKey: 'sameaccount1', instanceId: 'B' })
    assert.equal(a.acquire().ok, true)
    const rb = b.acquire()
    assert.equal(rb.ok, true, '两个项目各持自己的租约（项目级），不应互相阻塞')
    a.release(); a.dispose(); b.release(); b.dispose()
})

test('同一个项目内的两个实例（同目录 + 同机器人）仍然互斥', () => {
    const dir = tmp()
    const a = lease(dir, { accountKey: 'sameaccount1', instanceId: 'A' })
    const b = lease(dir, { accountKey: 'sameaccount1', instanceId: 'B' })
    assert.equal(a.acquire().ok, true)
    const rb = b.acquire()
    assert.equal(rb.ok, false, '同一个机器人只能有一个监听器')
    if (!rb.ok) assert.match(rb.reason!, /account sameaccount1/)
    a.release(); a.dispose(); b.dispose()
})

test('无 accountKey 时沿用旧文件名（向后兼容）', () => {
    const dir = tmp()
    const l = lease(dir)
    assert.equal(path.basename(l.file), 'chat-interaction-lease-feishu.json')
    assert.equal(l.acquire().ok, true)
    l.release(); l.dispose()
})

test('迁移保护：旧版渠道级租约仍活跃时，新键拒绝接管', () => {
    const dir = tmp()
    // 模拟旧版本写入的渠道级租约（无 accountKey），心跳新鲜
    const legacy = lease(dir, { instanceId: 'OLD' })
    assert.equal(legacy.acquire().ok, true)

    const fresh = lease(dir, { accountKey: 'newaccount12', instanceId: 'NEW' })
    const r = fresh.acquire()
    assert.equal(r.ok, false, '旧实例可能连着同一个机器人，不能贸然双连')
    if (!r.ok) assert.match(r.reason!, /legacy channel-scoped lease/)

    legacy.release(); legacy.dispose(); fresh.dispose()
})

test('旧版租约过期后，新键可以正常接管', () => {
    const dir = tmp()
    // 直接写一份"崩溃残留"的旧版渠道级租约（心跳已过期）
    fs.writeFileSync(
        path.join(dir, 'chat-interaction-lease-feishu.json'),
        JSON.stringify({
            owner: 'OLD-crashed',
            role: 'interactive',
            pid: 99999,
            host: 'somehost',
            heartbeatAt: Date.now() - 10 * 60_000,
            acquiredAt: Date.now() - 20 * 60_000,
        })
    )

    const fresh = lease(dir, { accountKey: 'newaccount12', instanceId: 'NEW' })
    const r = fresh.acquire()
    assert.equal(r.ok, true)
    fresh.release(); fresh.dispose()
})

test('遗留租约属于本实例时不阻塞（升级后同进程重连）', () => {
    const dir = tmp()
    const legacy = lease(dir, { instanceId: 'SELF' })
    assert.equal(legacy.acquire().ok, true)
    legacy.release()

    const same = lease(dir, { accountKey: 'selfaccount1', instanceId: 'SELF' })
    const r = same.acquire()
    assert.equal(r.ok, true)
    same.release(); same.dispose(); legacy.dispose()
})
