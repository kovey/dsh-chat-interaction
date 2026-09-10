/**
 * Channel lease tests — the heartbeat takeover between a 24×7 headless
 * service and an interactive TUI session. Deterministic: injected clock.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ChannelLease } from '../src/lease.js'

function setup(role: 'interactive' | 'service', opts: { dir?: string; ttlMs?: number; now?: () => number; id?: string } = {}) {
    const dir = opts.dir || fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-lease-'))
    const clock = { t: 1_000_000 }
    const lease = new ChannelLease({
        channel: 'probe',
        role,
        dir,
        instanceId: opts.id,
        ttlMs: opts.ttlMs ?? 1000,
        heartbeatMs: 500,
        now: opts.now || (() => clock.t),
        log: () => { /* quiet */ },
    })
    return { dir, clock, lease }
}

test('acquire on a free lease succeeds and writes the state file', () => {
    const { dir, lease } = setup('service')
    const r = lease.acquire()
    assert.equal(r.ok, true)
    assert.equal(lease.owns, true)
    const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'chat-interaction-lease-probe.json'), 'utf8'))
    assert.equal(onDisk.owner, lease.instanceId)
    assert.equal(onDisk.role, 'service')
})

test('two services: the second is refused while the heartbeat is fresh', () => {
    const { dir, clock } = setup('service')
    const a = setup('service', { dir, now: () => clock.t, id: 'svc-a' }).lease
    const b = setup('service', { dir, now: () => clock.t, id: 'svc-b' }).lease
    assert.equal(a.acquire().ok, true)
    const refused = b.acquire()
    assert.equal(refused.ok, false)
    assert.match(refused.reason || '', /owned by service svc-a/)
    // after the heartbeat goes stale the second service takes over
    clock.t += 2000
    const taken = b.acquire()
    assert.equal(taken.ok, true)
    assert.equal(b.owns, true)
})

test('interactive preempts a service holder; services never preempt', () => {
    const { dir, clock } = setup('service')
    const svc = setup('service', { dir, now: () => clock.t, id: 'svc' }).lease
    const tui = setup('interactive', { dir, now: () => clock.t, id: 'tui' }).lease
    assert.equal(svc.acquire().ok, true)

    const preempt = tui.acquire()
    assert.equal(preempt.ok, true)
    assert.equal(preempt.preempted, true)
    assert.equal(tui.owns, true)
    assert.equal(svc.owns, false)

    // and an interactive holder is never preempted by a service
    const svc2 = setup('service', { dir, now: () => clock.t, id: 'svc2' }).lease
    assert.equal(svc2.acquire().ok, false)
})

test('lost callback fires when the lease is taken over', () => {
    const { dir, clock } = setup('service')
    const svc = setup('service', { dir, now: () => clock.t, id: 'svc' }).lease
    const tui = setup('interactive', { dir, now: () => clock.t, id: 'tui' }).lease
    svc.acquire()
    svc.start()
    let lost = 0
    svc.onLost(() => { lost += 1 })

    tui.acquire() // preempt
    assert.equal(svc.tick(), 'lost')
    assert.equal(lost, 1)
    assert.equal(svc.owns, false)
    svc.stop()
})

test('service keeps waiting, then auto-acquires and fires onAcquired after the TUI releases', () => {
    const { dir, clock } = setup('service')
    const svc = setup('service', { dir, now: () => clock.t, id: 'svc' }).lease
    const tui = setup('interactive', { dir, now: () => clock.t, id: 'tui' }).lease

    tui.acquire()
    svc.start()
    let reacquired = 0
    svc.onAcquired(() => { reacquired += 1 })

    assert.equal(svc.tick(), 'waiting', 'service is polite while the TUI holds it')
    tui.release()
    assert.equal(svc.tick(), 'acquired')
    assert.equal(reacquired, 1)
    assert.equal(svc.owns, true)
    svc.stop()
})

test('renew keeps ownership; release frees the channel for others', () => {
    const { dir, clock } = setup('service')
    const a = setup('service', { dir, now: () => clock.t, id: 'a' }).lease
    const b = setup('service', { dir, now: () => clock.t, id: 'b' }).lease
    a.acquire()
    clock.t += 500
    assert.equal(a.tick(), 'renewed')
    assert.equal(a.owns, true)
    // the other service still cannot take it (heartbeat was just renewed)
    clock.t += 800
    assert.equal(b.acquire().ok, false)

    a.release()
    assert.equal(a.owns, false)
    assert.equal(b.acquire().ok, true)
})

test('release by a non-owner is a no-op (never steals the file)', () => {
    const { dir, clock } = setup('service')
    const a = setup('service', { dir, now: () => clock.t, id: 'a' }).lease
    const b = setup('service', { dir, now: () => clock.t, id: 'b' }).lease
    a.acquire()
    b.release()
    assert.equal(a.owns, true, 'owner keeps the lease')
})

test('corrupt or missing lease file counts as free', () => {
    const { dir, lease } = setup('service')
    fs.writeFileSync(path.join(dir, 'chat-interaction-lease-probe.json'), '{ not json')
    assert.equal(lease.isFree(), true)
    assert.equal(lease.acquire().ok, true)
})

test('dispose stops the timer and releases', () => {
    const { dir, clock } = setup('service')
    const a = setup('service', { dir, now: () => clock.t, id: 'a' }).lease
    a.acquire()
    a.start()
    a.dispose()
    assert.equal(a.owns, false)
})
