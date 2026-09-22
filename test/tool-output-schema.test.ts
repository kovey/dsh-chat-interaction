/**
 * 工具输出 schema 一致性回归测试
 *
 * 宿主要求每个工具的输出必须匹配它自己声明的 `output.schema`
 * （`additionalProperties: false`，见 dsh-tools 的 `ToolOutputError`：
 * `tool "x" returned invalid output: "value.y" is not a declared property`）。
 * 这里用**宿主内部同一个校验器** `validateJsonSchemaValue`（dsh-tools 导出）
 * 检查每个渠道工具的每条返回路径，防止 snake_case/camelCase 之类的错位再次发生。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { defineTool, validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'

/** 官方校验器的 schema 入参类型（避免在测试里到处 as any）。 */
type JsonSchemaArg = Parameters<typeof validateJsonSchemaValue>[0]
const validate = (schema: unknown, value: unknown) =>
    validateJsonSchemaValue(schema as JsonSchemaArg, value, 'value') as string[]
import { buildChannelTools } from '../src/tools.js'
import type { ChannelToolDeps, ToolSpec } from '../src/tools.js'
import { InteractionHub } from '../src/hub.js'
import { BaseChannel } from '../src/channel.js'
import { descriptorOf } from '../src/channel.js'
import { apply } from '../src/plugin.js'
import type { DshChatLayer } from '../src/plugin.js'
import type { AuthState, ButtonSpec, CardSpec, ListenerStatus, SendResult, WaitResult } from '../src/types.js'

// 测试隔离：把 DSH_HOME 指向临时目录 —— 渠道租约、凭证链、模型目录读取都不再
// 触碰真实的 ~/.dsh（否则测试会与用户正在运行的会话互抢租约，结果随机器状态波动）。
process.env.DSH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-home-'))


class ProbeChannel extends BaseChannel {
    readonly name = 'probe'
    readonly label = '探针'
    override readonly capabilities = { cards: true, richText: true, images: false, inbound: true }
    override async connect(): Promise<ListenerStatus> {
        this.setConnected(true)
        return { ok: true, connected: true }
    }
    override async disconnect(): Promise<ListenerStatus> {
        this.setConnected(false)
        return { ok: true, connected: false }
    }
    override async sendText(_c: string, _t: string): Promise<SendResult> {
        return { ok: true }
    }
}

/** Compile a tool spec exactly like the harness does, then validate its output. */
async function checkTool(
    spec: ToolSpec,
    args: Record<string, unknown>,
    deps: Partial<ChannelToolDeps>
): Promise<{ tool: string; value: unknown }> {
    // deps are injected by rebuilding the tool set with our stubs
    const tools = buildChannelTools(desc, { ...stubDeps, ...deps })
    const fresh = tools.find((t) => t.name === spec.name)!
    const compiled = defineTool(fresh as never) as unknown as {
        name: string
        output: { schema: unknown }
        execute: (a: Record<string, unknown>, e: { signal?: AbortSignal }) => Promise<unknown>
    }
    const value = await compiled.execute(args, {})
    const violations = validate(compiled.output.schema, value)
    assert.deepEqual(violations, [], `${compiled.name} 的输出必须匹配自己的 schema（宿主会以 additionalProperties:false 校验）`)
    return { tool: compiled.name, value }
}

const desc = { name: 'feishu', label: '飞书', capabilities: { cards: true, richText: true, images: true, inbound: true } }

const stubDeps: ChannelToolDeps = {
    sendText: async (): Promise<SendResult> => ({ ok: true, messageId: 'om_1' }),
    sendRichText: async (): Promise<SendResult> => ({ ok: true, messageId: 'om_2' }),
    sendCard: async (): Promise<SendResult> => ({ ok: true, messageId: 'om_3' }),
    waitReply: async (): Promise<WaitResult> => ({ ok: true, timedOut: false, text: 'A', messageId: 'm1', isCardAction: true }),
    listenerControl: async (): Promise<ListenerStatus & { ok: boolean }> => ({ ok: true, connected: true, message: 'ok' }),
    authState: (): AuthState => ({
        ok: true,
        mode: 'auto',
        allowlist: ['git status'],
        activeChat: 'oc_1',
        p2pChat: 'ou_1',
        listenerRole: 'off',
        listenerConnected: false,
        pendingQuestions: ['feishu:permission-mode:选择权限模式'],
    }),
}

const tools = buildChannelTools(desc, stubDeps)
const byName = (n: string) => tools.find((t) => t.name === n)!

// ---------------------------------------------------------------------------
// 成功路径
// ---------------------------------------------------------------------------

test('feishu_send_message: 成功（有/无 messageId）与失败输出都匹配 schema', async () => {
    const spec = byName('feishu_send_message')
    await checkTool(spec, { chat_id: 'oc_1', text: 'hi' }, {})
    await checkTool(spec, { chat_id: 'oc_1', title: '标题', text: '正文' }, {})
    await checkTool(spec, { chat_id: 'oc_1', text: 'hi' }, {
        sendText: async (): Promise<SendResult> => ({ ok: true }), // 平台没回 message_id
    })
    const failed = await checkTool(spec, { chat_id: 'oc_1', text: 'hi' }, {
        sendText: async (): Promise<SendResult> => ({ ok: false, error: 'boom' }),
    })
    assert.equal((failed.value as SendResult).ok, false)
})

test('feishu_send_card: 输出匹配 schema', async () => {
    await checkTool(byName('feishu_send_card'), { chat_id: 'oc_1', title: 'T', body: 'B', buttons: [{ value: 'A', label: '同意' }] }, {})
})

test('feishu_wait_reply: 收到回复与超时两种输出都匹配 schema', async () => {
    const got = await checkTool(byName('feishu_wait_reply'), { chat_id: 'oc_1', timeoutMs: 1000 }, {})
    assert.equal((got.value as WaitResult).timedOut, false)

    const timedOut = await checkTool(byName('feishu_wait_reply'), { chat_id: 'oc_1', timeoutMs: 1000 }, {
        waitReply: async (): Promise<WaitResult> => ({ ok: true, timedOut: true, text: '', messageId: '', isCardAction: false }),
    })
    assert.equal((timedOut.value as WaitResult).timedOut, true)
})

test('feishu_listener: 成功/失败/未连接输出都匹配 schema', async () => {
    await checkTool(byName('feishu_listener'), { action: 'status' }, {})
    await checkTool(byName('feishu_listener'), { action: 'start' }, {
        listenerControl: async (): Promise<ListenerStatus & { ok: boolean }> => ({ ok: false, connected: false, error: 'no creds' }),
    })
    await checkTool(byName('feishu_listener'), { action: 'stop' }, {
        listenerControl: async (): Promise<ListenerStatus & { ok: boolean }> => ({ ok: true, connected: false, message: '本来就没有连接' }),
    })
})

test('feishu_auth_state: 正常与错误输出都匹配 schema（用户报告的那条）', async () => {
    const ok = await checkTool(byName('feishu_auth_state'), {}, {})
    const value = ok.value as AuthState
    assert.equal(value.activeChat, 'oc_1', 'camelCase 字段确实返回了')
    assert.equal(value.listenerConnected, false)

    await checkTool(byName('feishu_auth_state'), {}, {
        authState: (): AuthState => ({
            ok: false,
            mode: 'auto',
            allowlist: [],
            activeChat: '',
            p2pChat: '',
            listenerRole: 'off',
            listenerConnected: false,
            pendingQuestions: [],
            error: '读取失败',
        }),
    })
})

// ---------------------------------------------------------------------------
// 真实链路（不是 stub）
// ---------------------------------------------------------------------------

test('真实 hub 的 wait_reply 超时结果同样通过 schema 校验', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-toolout-'))
    const hub = new InteractionHub({ log: () => { /* quiet */ } })
    hub.addChannel(new ProbeChannel())
    const realDeps: ChannelToolDeps = {
        ...stubDeps,
        waitReply: (chatId: string, timeoutMs: number, signal?: AbortSignal) => hub.waitReply('probe', chatId, timeoutMs, signal),
    }
    const tool = buildChannelTools(descriptorOf(new ProbeChannel()), realDeps).find((t) => t.name === 'probe_wait_reply')!
    const compiled = defineTool(tool as never) as unknown as {
        output: { schema: unknown }
        execute: (a: Record<string, unknown>, e: { signal?: AbortSignal }) => Promise<unknown>
    }
    const value = await compiled.execute({ chat_id: 'chat-1', timeoutMs: 1000 }, {})
    assert.deepEqual(validate(compiled.output.schema, value), [])
    assert.equal((value as WaitResult).timedOut, true)
    hub.teardown()
    void tmp
})

test('plugin 层真实 authState 结果通过 schema 校验（端到端）', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-toolout-'))
    fs.mkdirSync(path.join(tmp, '.dsh'), { recursive: true })
    const ctx = {
        roots: () => [],
        registerTool: () => undefined,
        promptSection: () => undefined,
        onDispose: () => undefined,
    }
    const layer = apply(ctx as never, {
        logFile: path.join(tmp, 'layer.log'),
        scoring: { enabled: false },
        router: { enabled: false },
        lease: { enabled: false },
        channels: {},
        channelFactories: { probe: () => new ProbeChannel() },
    } as never) as DshChatLayer
    const state = layer.authState('probe')
    const schema = defineTool(byName('feishu_auth_state') as never) as unknown as { output: { schema: unknown } }
    assert.deepEqual(validate(schema.output.schema, state), [], 'plugin 返回的 AuthState 也必须匹配 schema')
    layer.teardown()
})

// ---------------------------------------------------------------------------
// 全部工具都不得声明「返回值里不存在」的字段
// ---------------------------------------------------------------------------

test('每个工具的 schema 属性都能在实际返回值中找到（并集校验）', async () => {
    for (const spec of buildChannelTools(desc, stubDeps)) {
        const compiled = defineTool(spec as never) as unknown as {
            name: string
            output: { schema: { properties?: Record<string, unknown> } }
            execute: (a: Record<string, unknown>, e: { signal?: AbortSignal }) => Promise<unknown>
        }
        const props = Object.keys(compiled.output.schema.properties || {})
        const values: unknown[] = []
        try {
            if (compiled.name.endsWith('_send_message')) values.push(await compiled.execute({ chat_id: 'c', text: 'x' }, {}))
            else if (compiled.name.endsWith('_send_card')) values.push(await compiled.execute({ chat_id: 'c', title: 't', body: 'b' }, {}))
            else if (compiled.name.endsWith('_wait_reply')) values.push(await compiled.execute({ chat_id: 'c', timeoutMs: 1000 }, {}))
            else if (compiled.name.endsWith('_listener')) values.push(await compiled.execute({ action: 'status' }, {}))
            else values.push(await compiled.execute({}, {}))
        } catch { /* 参数校验失败也不影响本断言 */ }
        for (const v of values) {
            const returned = new Set(Object.keys(v as Record<string, unknown>))
            for (const p of props) {
                if (p === 'error') continue // 仅错误路径出现
                assert.ok(returned.has(p), `${compiled.name}: schema 声明了 "${p}"，但返回值里没有（返回值字段: ${[...returned].join(', ')}）`)
            }
        }
    }
})
