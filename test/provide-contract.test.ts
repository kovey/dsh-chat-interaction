/**
 * cordis `provide` 契约的**真实 Context** 回归测试。
 *
 * 背景（用户实测报告 + 本次复现）：cordis 4.0.5 的签名是
 *
 *     ctx.provide(name, value, check?)
 *
 * 第三个参数是**可用性谓词**（check），不是 override 开关。传 `true` 会让
 * `_checkImpl` 执行 `impl.check.call(...)` → TypeError → 被 catch → 把该依赖从
 * 消费者的 store 里删掉 ⇒ `ctx.inject([name], cb)` **永不触发**；而 `ctx.get(name)`
 * 仍能取到值，所以"一次性 get 探测"看不出问题。
 *
 * 这类错误只有用真实 cordis Context 才测得出来：`test/cordis-integration.test.ts`
 * 里的桩 `provide: (key, value) => …` 会静默忽略第三参。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { apply } from '../src/plugin.js'
import { BaseChannel } from '../src/channel.js'
import { harnessFromCordis } from '../src/harness.js'
import { setLogFile } from '../src/log.js'

const tick = (ms = 50) => new Promise((r) => setTimeout(r, ms))

/** 最小探针渠道：让插件走正常装配路径（而不是“无渠道提前退出”）。 */
class ProbeChannel extends BaseChannel {
    readonly name = 'probe'
    readonly label = '探针'
    override readonly capabilities = { cards: true, richText: true, images: false, inbound: true, files: false }
    override async connect() { this.setConnected(true); return { ok: true, connected: true } }
    override async disconnect() { this.setConnected(false); return { ok: true, connected: false } }
    override async sendText() { return { ok: true, messageId: 'om_1' } }
    override async sendRichText() { return { ok: true, messageId: 'om_2' } }
    override async sendCard() { return { ok: true, messageId: 'om_3' } }
}

/** 真实 cordis Context + apply() 所需的最小宿主服务。 */
function realContext() {
    const ctx = new Context()
    ctx.provide('agents', { roots: () => [] })
    ctx.provide('tools', { register: () => undefined })
    ctx.provide('systemPrompt', { section: () => undefined })
    return ctx
}

test('真实 cordis：apply() 后 ctx.inject([chatInteraction]) 必须触发', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-provide-'))
    const ctx = realContext()
    const layer = apply(ctx as never, {
        logFile: path.join(tmp, 'layer.log'),
        scoring: { enabled: false },
        channelFactories: { probe: () => new ProbeChannel() },
    } as never)

    let fired = 0
    let seen: unknown = null
    ctx.inject(['chatInteraction'], (c: unknown) => {
        fired += 1
        seen = c
    })
    await tick()

    assert.equal(fired, 1, 'ctx.inject 的回调必须触发 —— provide 第三参传 true 时会永不触发')
    assert.equal(typeof seen, 'object')
    assert.equal(ctx.get('chatInteraction'), layer, 'ctx.get 也必须能取到（两种探测方式都成立）')
    ;(layer as { teardown?: () => void }).teardown?.()
})

test('真实 cordis：harnessFromCordis.provide 不额外传第三参', async () => {
    const ctx = new Context()
    const harness = harnessFromCordis(ctx)
    harness.provide!('someService', { ok: 1 })

    let fired = 0
    ctx.inject(['someService'], () => { fired += 1 })
    await tick()

    assert.equal(fired, 1, 'harness.provide 必须只透传 (key, value)')
    assert.deepEqual(ctx.get('someService'), { ok: 1 })
})

test('provide 失败不得静默：记录 error 日志并保持降级（不抛出）', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-provide-log-'))
    const file = path.join(tmp, 'log.txt')
    setLogFile(file)
    try {
        const stub = {
            provide: () => {
                throw new Error('boom')
            },
        }
        const harness = harnessFromCordis(stub as never)
        assert.doesNotThrow(() => harness.provide!('svc', 1), 'provide 失败不得拖垮 apply')
        const content = fs.readFileSync(file, 'utf8')
        assert.match(content, /error.*provide\("svc"\) failed: boom/)
    } finally {
        setLogFile(null)
    }
})

test('宿主没有 provide 方法时安静跳过（旧宿主兼容）', () => {
    const harness = harnessFromCordis({} as never)
    assert.doesNotThrow(() => harness.provide!('k', 1))
})
