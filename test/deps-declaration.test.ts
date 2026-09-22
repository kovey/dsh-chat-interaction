/**
 * 依赖声明约定：飞书 / 企微的平台 SDK 必须是 **optionalDependencies**，
 * 这样 `dsh plugin --profile <p> add github:kovey/dsh-chat-interaction#<tag>`
 * 会连平台 SDK 一起装上（"装完即用"）。
 *
 * 反例（真实踩过）：SDK 声明为 optional peerDependency 时 pnpm 不会安装，
 * 用户装完插件必须再手动 `add @larksuiteoapi/node-sdk`，否则
 * `feishu_listener start` 报 `Cannot find package ...`，而宿主/市场的入口自检
 * 又会报 `<pkg>/index.js` 找不到，看起来像"插件缺 exports/main 字段"。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { FeishuChannel } from '../src/adapters/feishu.js'

/** 向上找到本包的 package.json（源码 test/ 与编译产物 dist-test/test/ 深度不同）。 */
function findPackageJson(start: string): string {
    let dir = start
    for (let i = 0; i < 5; i++) {
        const file = path.join(dir, 'package.json')
        if (fs.existsSync(file)) {
            try {
                const j = JSON.parse(fs.readFileSync(file, 'utf8')) as { name?: string }
                if (j.name === 'dsh-chat-interaction') return file
            } catch { /* keep walking */ }
        }
        dir = path.dirname(dir)
    }
    throw new Error('未找到 dsh-chat-interaction 的 package.json')
}

const pkgPath = findPackageJson(path.dirname(fileURLToPath(import.meta.url)))
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as {
    main?: string
    exports?: Record<string, unknown>
    peerDependencies?: Record<string, string>
    optionalDependencies?: Record<string, string>
}

test('平台 SDK 声明为 optionalDependencies（装插件时自动安装）', () => {
    assert.equal(pkg.optionalDependencies?.['@larksuiteoapi/node-sdk'], '^1.60.0')
    assert.equal(pkg.optionalDependencies?.['@wecom/crypto'], '^1.0.0')
    assert.equal(pkg.peerDependencies?.['@larksuiteoapi/node-sdk'], undefined, '不得退回 optional peer（那样不会被安装）')
    assert.equal(pkg.peerDependencies?.['@wecom/crypto'], undefined)
})

test('dsh 运行时依赖仍然是 peer（由宿主提供，避免重复安装）', () => {
    for (const name of ['@deepseek-ai/cordis', '@deepseek-ai/dsh-agent', '@deepseek-ai/dsh-llm', '@deepseek-ai/dsh-tools']) {
        assert.ok(pkg.peerDependencies?.[name], `${name} 必须是 peerDependency`)
    }
})

test('入口字段完整：main + exports 子路径（宿主/市场按 main 做入口自检）', () => {
    assert.equal(pkg.main, './dist/index.js')
    for (const sub of ['.', './plugin', './adapters/feishu', './adapters/wecom']) {
        assert.ok(pkg.exports?.[sub], `exports 必须声明 ${sub}`)
    }
})

test('飞书 SDK 已随依赖安装，且导出适配器需要的成员', async () => {
    let sdk: { WSClient?: unknown; Client?: unknown; EventDispatcher?: unknown }
    try {
        sdk = (await import('@larksuiteoapi/node-sdk')) as never
    } catch {
        return // 离线/裁剪安装下跳过（optionalDependencies 允许缺失）
    }
    assert.ok(sdk.WSClient || (sdk as { default?: { WSClient?: unknown } }).default?.WSClient, 'WSClient')
    assert.ok(sdk.Client || (sdk as { default?: { Client?: unknown } }).default?.Client, 'Client')
    assert.ok(sdk.EventDispatcher || (sdk as { default?: { EventDispatcher?: unknown } }).default?.EventDispatcher, 'EventDispatcher')
})

test('适配器 loadSdk() 能从真实安装的 SDK 组装出客户端工厂', async () => {
    const ch = new FeishuChannel({ appId: 'cli_x', appSecret: 'y' })
    const loadSdk = (ch as unknown as { loadSdk: () => Promise<{ WSClient?: unknown; Client?: unknown; EventDispatcher?: unknown }> }).loadSdk.bind(ch)
    let resolved: { WSClient?: unknown; Client?: unknown; EventDispatcher?: unknown }
    try {
        resolved = await loadSdk()
    } catch (e) {
        // 未安装时必须是可执行的提示，而不是裸的 module-not-found
        assert.match((e as Error).message, /缺少可选依赖|>= 1\.60\.0/)
        return
    }
    assert.equal(typeof resolved.WSClient, 'function')
    assert.equal(typeof resolved.Client, 'function')
    assert.equal(typeof resolved.EventDispatcher, 'function')
})
