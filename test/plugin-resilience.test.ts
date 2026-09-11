/**
 * Resilience tests — the hard rule: a plugin bug must NEVER take the host
 * session down. These cover the shapes that a real host ctx can have
 * (cordis proxies, scope/trace interceptors that throw on unknown property
 * access) and outright hostile inputs.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { apply } from '../src/plugin.js'
import { setLogFile } from '../src/log.js'
import { harnessFromCordis, isHarnessContext } from '../src/harness.js'
import type { DshChatLayer } from '../src/plugin.js'
import { BaseChannel } from '../src/channel.js'
import type { SendResult } from '../src/types.js'

class ProbeChannel extends BaseChannel {
    readonly name = 'probe'
    readonly label = '探针'
    override readonly capabilities = { cards: false, richText: false, images: false, inbound: true }
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
}

/** A context whose unknown-property access THROWS (like a strict interceptor). */
function hostileCtx(known: Record<string, unknown> = {}) {
    return new Proxy(known, {
        get(target, prop: string) {
            if (prop in target) return target[prop as keyof typeof target]
            throw new Error(`host interceptor: unknown property "${String(prop)}"`)
        },
        has() {
            throw new Error('host interceptor: has()')
        },
    })
}

function tmpDir(): string {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-resilience-'))
    fs.mkdirSync(path.join(d, '.dsh'), { recursive: true })
    return d
}

test('isHarnessContext never throws on hostile contexts', () => {
    assert.equal(isHarnessContext(hostileCtx()), false, 'throwing proxy → not a flat context')
    assert.equal(isHarnessContext(null), false)
    assert.equal(isHarnessContext(undefined), false)
    assert.equal(isHarnessContext(42), false)
    const ctx = new Context()
    assert.equal(isHarnessContext(ctx), false, 'real cordis context is branded, not probed')
})

test('harnessFromCordis degrades to no-ops on hostile contexts', () => {
    const h = harnessFromCordis(hostileCtx() as never)
    assert.deepEqual(h.roots(), [])
    assert.doesNotThrow(() => h.registerTool({}))
    assert.doesNotThrow(() => h.promptSection({ name: 'x', text: 'y' }))
    assert.doesNotThrow(() => h.onDispose(() => undefined))
    assert.doesNotThrow(() => h.on?.('x', () => undefined))
    assert.doesNotThrow(() => h.provide?.('k', 1))
})

test('apply() survives a hostile ctx (no throw, layer disabled or adapted)', () => {
    const dir = tmpDir()
    let layer: DshChatLayer | null = null
    assert.doesNotThrow(() => {
        layer = apply(hostileCtx({}) as never, {
            logFile: path.join(dir, 'layer.log'),
            channelFactories: { probe: () => new ProbeChannel() },
        } as never)
    }, 'apply must not throw')
    // hostile ctx exposes no host services → the plugin reports "no channels"? 
    // it actually builds the adapter but cannot reach the host; either way it
    // must not throw, and teardown must be safe:
    assert.doesNotThrow(() => layer?.teardown())
})

test('apply() never throws when the config object itself is hostile', () => {
    const dir = tmpDir()
    const badConfig = new Proxy({ logFile: path.join(dir, 'layer.log') }, {
        get(target, prop: string) {
            if (prop === 'logFile') return target.logFile
            throw new Error(`config getter "${String(prop)}" exploded`)
        },
    })
    // the layer log is module-global: pin it so the crash record has a home
    const logPath = path.join(dir, 'layer.log')
    setLogFile(logPath)
    let out: DshChatLayer | null = null
    const stderr: string[] = []
    const originalError = console.error
    console.error = (...args: unknown[]) => { stderr.push(args.map(String).join(' ')) }
    try {
        assert.doesNotThrow(() => {
            out = apply({ roots: () => [], registerTool: () => undefined, promptSection: () => undefined, onDispose: () => undefined } as never, badConfig as never)
        })
    } finally {
        console.error = originalError
    }
    assert.equal(out, null, 'crashed startup disables the layer')
    // the host terminal must show the stack (that is how the user sees it)…
    const shown = stderr.join('\n')
    assert.match(shown, /startup CRASHED/, 'crash reported to stderr')
    assert.match(shown, /config getter .* exploded/, 'the real cause is visible')
    // …and it must also land in the layer log file
    const logged = fs.readFileSync(logPath, 'utf8')
    assert.match(logged, /startup CRASHED/, 'crash persisted to the log file')
    assert.match(logged, /config getter .* exploded/, 'stack carries the real cause')
})

test('apply() works with a real cordis context carrying host services', () => {
    const dir = tmpDir()
    const ctx = new Context()
    const tools: unknown[] = []
    const prompts: string[] = []
    const effects: Array<() => unknown> = []
    ctx.provide('agents', { roots: () => [] })
    ctx.provide('tools', { register: (t: unknown) => { tools.push(t) } })
    ctx.provide('systemPrompt', { section: (s: { name: string }) => { prompts.push(s.name) } })
    // effect/on/provide already exist on a real Context

    const layer = apply(ctx, {
        logFile: path.join(dir, 'layer.log'),
        scoring: { enabled: false },
        router: { enabled: false },
        lease: { enabled: false },
        channels: { probe: {} },
        channelFactories: { probe: () => new ProbeChannel() },
    } as never) as DshChatLayer
    assert.ok(layer, 'layer assembled on a real cordis ctx')
    assert.ok(tools.length >= 4, `tool family registered (got ${tools.length})`)
    assert.deepEqual(prompts, ['probe-channel'])
    void effects
    layer.teardown()
    const logged = fs.readFileSync(path.join(dir, 'layer.log'), 'utf8')
    assert.match(logged, /cordis context detected/)
    assert.doesNotMatch(logged, /startup CRASHED/)
})

test('a throwing channel factory disables that channel, not the layer', () => {
    const dir = tmpDir()
    const layer = apply({ roots: () => [], registerTool: () => undefined, promptSection: () => undefined, onDispose: () => undefined } as never, {
        logFile: path.join(dir, 'layer.log'),
        scoring: { enabled: false },
        lease: { enabled: false },
        channels: { probe: {} },
        channelFactories: { probe: () => { throw new Error('factory boom') } },
    } as never)
    assert.equal(layer, null, 'no channel survived → layer disabled, host fine')
    const logged = fs.readFileSync(path.join(dir, 'layer.log'), 'utf8')
    assert.match(logged, /channel probe setup failed: factory boom/)
    assert.doesNotMatch(logged, /startup CRASHED/, 'handled locally, not escalated')
})
