/**
 * 本地自检：验证插件可加载、且 apply() 在「真实 cordis ctx + 宿主服务」形状下
 * 不抛异常。用于排查「挂载后宿主启动崩溃」这类问题，不需要启动 dsh 会话。
 *
 * 用法（插件目录内）:
 *   node scripts/selfcheck.mjs
 * 或在已安装的 profile 插件副本里:
 *   cd ~/.dsh/profiles/<profile>/node_modules/dsh-chat-interaction && node scripts/selfcheck.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const logFile = path.join(os.tmpdir(), `dsh-chat-selfcheck-${process.pid}.log`)
const fail = (msg) => { console.error('✗ ' + msg); process.exitCode = 1 }

let apply
try {
    ;({ apply } = await import('../dist/plugin.js'))
    console.log('✓ 模块加载: dist/plugin.js')
} catch (e) {
    fail(`模块加载失败: ${e.message}`)
    process.exit(1)
}

const { Context } = await import('@deepseek-ai/cordis')

// 1) 真实 cordis ctx + 宿主服务（最接近宿主装载的形状）
{
    const ctx = new Context()
    ctx.provide('agents', { roots: () => [] })
    ctx.provide('tools', { register: () => undefined })
    ctx.provide('systemPrompt', { section: () => undefined })
    try {
        const layer = apply(ctx, { logFile, scoring: { enabled: false }, router: { enabled: false }, lease: { enabled: false } })
        console.log(`✓ 真实 cordis ctx: apply 未抛异常 (${layer ? '装配成功' : '已禁用/无渠道'})`)
        layer?.teardown()
    } catch (e) {
        fail(`真实 cordis ctx 上 apply 抛出: ${e.stack || e}`)
    }
}

// 2) 敌意 ctx（未知属性访问抛错）——插件必须不崩
{
    const hostile = new Proxy({}, { get(_t, p) { throw new Error(`unknown property ${String(p)}`) } })
    try {
        const layer = apply(hostile, { logFile, channelFactories: {} })
        console.log(`✓ 敌意 ctx: apply 未抛异常 (${layer ? '装配成功' : '已禁用'})`)
        layer?.teardown()
    } catch (e) {
        fail(`敌意 ctx 上 apply 抛出: ${e.stack || e}`)
    }
}

console.log('\n--- 自检日志 ---')
try { console.log(fs.readFileSync(logFile, 'utf8')) } catch { console.log('(无日志)') }
console.log(process.exitCode ? '自检失败' : '自检通过 ✓')
