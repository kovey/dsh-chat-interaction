/**
 * Plugin-level takeover test: a 24×7 "service" instance (channel role
 * listener) and an interactive TUI instance share one channel. The TUI
 * preempts the service; when the TUI goes away the service takes the channel
 * back and reconnects its listener — the heartbeat takeover loop.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { apply } from '../src/plugin.js'
import type { DshChatLayer } from '../src/plugin.js'
import { BaseChannel } from '../src/channel.js'
import type { HarnessAgent } from '../src/harness.js'
import type { SendResult } from '../src/types.js'

class ProbeChannel extends BaseChannel {
    readonly name = 'probe'
    readonly label = '探针'
    override readonly capabilities = { cards: false, richText: false, images: false, inbound: true }
    override async connect() {
        this.setConnected(true)
        return { ok: true, connected: true, message: 'probe connected' }
    }
    override async disconnect() {
        this.setConnected(false)
        return { ok: true, connected: false }
    }
    override async sendText(_c: string, _t: string): Promise<SendResult> {
        return { ok: true }
    }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

function makeCtx(cwd: string) {
    const agent: HarnessAgent = { id: 'a1', followup: () => undefined, session: { id: 's1', header: { cwd }, events: [] } }
    return {
        roots: () => [agent],
        registerTool: () => undefined,
        promptSection: () => undefined,
        onDispose: () => undefined,
    }
}

function boot(cwd: string, leaseDir: string, opts: { service: boolean }) {
    const ctx = makeCtx(cwd)
    return apply(ctx as never, {
        logFile: path.join(cwd, 'layer.log'),
        scoring: { enabled: false },
        router: { enabled: false },
        lease: { dir: leaseDir, ttlMs: 60_000, heartbeatMs: 40 },
        channels: { probe: opts.service ? { role: 'listener' } : {} },
        channelFactories: { probe: () => new ProbeChannel() },
    } as never) as DshChatLayer
}

test('interactive session preempts the service; service reconnects after the session leaves', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-takeover-'))
    fs.mkdirSync(path.join(tmp, '.dsh'), { recursive: true })
    const leaseDir = path.join(tmp, 'leases')

    // 1) the 24×7 service: role=listener → connects at startup as `service`
    const service = boot(tmp, leaseDir, { service: true })
    await sleep(30)
    assert.equal(service.status('probe').connected, true, 'service connected at startup')
    const leaseFile = path.join(leaseDir, 'chat-interaction-lease-probe.json')
    assert.equal(JSON.parse(fs.readFileSync(leaseFile, 'utf8')).role, 'service')

    // 2) the interactive session takes the channel over
    const tui = boot(tmp, leaseDir, { service: false })
    const tuiConn = await tui.connect('probe')
    assert.equal(tuiConn.ok, true, 'interactive preempts the service')
    await sleep(120) // the service notices the preemption on its next check
    assert.equal(tui.status('probe').connected, true, 'tui serving')
    assert.equal(service.status('probe').connected, false, 'service listener was disconnected on lease loss')
    assert.equal(JSON.parse(fs.readFileSync(leaseFile, 'utf8')).role, 'interactive')

    // 3) the session ends → the service notices the free lease and reconnects
    tui.teardown()
    assert.equal(fs.existsSync(leaseFile), false, 'tui released the lease on teardown')
    const svcLease = service.leases.get('probe')!
    assert.equal(svcLease.tick(), 'acquired', 'service takes the free lease back')
    await sleep(30)
    assert.equal(service.status('probe').connected, true, 'service reconnected automatically')

    service.teardown()
})

test('a second service instance is refused while the first holds the channel', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-takeover-'))
    fs.mkdirSync(path.join(tmp, '.dsh'), { recursive: true })
    const leaseDir = path.join(tmp, 'leases')

    const a = boot(tmp, leaseDir, { service: true })
    await sleep(30)
    const b = boot(tmp, leaseDir, { service: true })
    const refused = await b.connect('probe')
    assert.equal(refused.ok, false, 'second service is refused')
    assert.match(refused.error || '', /owned by service/)

    a.teardown()
    b.teardown()
})

test('lease.enabled:false restores the old behaviour (no takeover, both connect)', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-takeover-'))
    fs.mkdirSync(path.join(tmp, '.dsh'), { recursive: true })
    const ctx = makeCtx(tmp)
    const layer = apply(ctx as never, {
        logFile: path.join(tmp, 'layer.log'),
        scoring: { enabled: false },
        router: { enabled: false },
        lease: { enabled: false },
        channels: {},
        channelFactories: { probe: () => new ProbeChannel() },
    } as never) as DshChatLayer
    assert.equal(layer.leases.size, 0, 'no leases created')
    const st = await layer.connect('probe')
    assert.equal(st.ok, true)
    layer.teardown()
})
