/**
 * Session-event adapter + retry probe tests against the 0.1.5-rc.1 session
 * API (snapshotEvents) and the legacy events-array fallback.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { hasSessionEvents, readSessionEvents } from '../src/session-events.js'
import { DshBridge } from '../src/harness.js'
import type { HarnessAgent, HarnessContext } from '../src/harness.js'

test('readSessionEvents: legacy events array', () => {
    const s = { events: [{ seq: 1, type: 'turn/start' }] }
    assert.equal(readSessionEvents(s).length, 1)
    assert.equal(hasSessionEvents(s), true)
})

test('readSessionEvents: official snapshotEvents (0.1.5+)', () => {
    const backing = [{ seq: 1, type: 'turn/start' }]
    const s = { snapshotEvents: () => backing }
    assert.deepEqual(readSessionEvents(s), backing)
    assert.equal(hasSessionEvents(s), true)
})

test('readSessionEvents: missing / broken sources degrade to []', () => {
    assert.deepEqual(readSessionEvents(undefined), [])
    assert.deepEqual(readSessionEvents({}), [])
    assert.deepEqual(readSessionEvents({ snapshotEvents: () => { throw new Error('boom') } }), [])
    assert.equal(hasSessionEvents({}), false)
})

function makeCtx(events: Array<{ seq: number; type: string; data?: unknown }>, opts: { useSnapshot?: boolean } = {}) {
    const agent: HarnessAgent = {
        id: 'a1',
        followup: () => undefined,
        session: opts.useSnapshot
            ? { id: 's1', snapshotEvents: () => events }
            : { id: 's1', events },
    }
    const ctx: HarnessContext = {
        roots: () => [agent],
        registerTool: () => undefined,
        promptSection: () => undefined,
        onDispose: () => undefined,
    }
    return ctx
}

const RETRYABLE = ['SERVER', 'TIMEOUT', 'TRANSPORT', 'RATE_LIMIT', 'EMPTY_RESPONSE']

test('retry probe classifies 0.1.5 snapshotEvents turn/end as retryable or settled', () => {
    const events: Array<{ seq: number; type: string; data?: unknown }> = [
        { seq: 1, type: 'turn/start' },
    ]
    const bridge = new DshBridge(makeCtx(events, { useSnapshot: true }))
    const { probe, baseline } = bridge.createOutcomeProbe(RETRYABLE)
    baseline() // arm-time baseline: pre-existing events are never classified

    events.push(
        { seq: 2, type: 'turn/end', data: { reason: { kind: 'error', error: { code: 'SERVER', message: 'x' } } } }
    )
    assert.equal(probe(), 'retryable-error')

    events.push({ seq: 3, type: 'turn/start' })
    events.push({ seq: 4, type: 'turn/end', data: { reason: { kind: 'completed' } } })
    assert.equal(probe(), 'settled')
})

test('retry probe works with legacy events arrays too', () => {
    const events: Array<{ seq: number; type: string; data?: unknown }> = []
    const bridge = new DshBridge(makeCtx(events))
    const { probe, baseline } = bridge.createOutcomeProbe(RETRYABLE)
    baseline() // empty baseline: the very first appended event IS scanned
    events.push({ seq: 1, type: 'turn/end', data: { reason: { kind: 'error', error: { code: 'TIMEOUT' } } } })
    assert.equal(probe(), 'retryable-error')
})

test('retry probe: baseline is idempotent (concurrent arms cannot steal outcomes)', () => {
    const events: Array<{ seq: number; type: string; data?: unknown }> = [
        { seq: 1, type: 'turn/start' },
    ]
    const bridge = new DshBridge(makeCtx(events, { useSnapshot: true }))
    const { probe, baseline } = bridge.createOutcomeProbe(RETRYABLE)
    baseline()
    events.push({ seq: 2, type: 'turn/end', data: { reason: { kind: 'error', error: { code: 'SERVER' } } } })
    baseline() // second arm: MUST NOT consume the pending outcome
    assert.equal(probe(), 'retryable-error', 'outcome survives a second baseline call')
})

test('retry probe: no events yet → null (keep waiting)', () => {
    const bridge = new DshBridge(makeCtx([]))
    const { probe } = bridge.createOutcomeProbe(RETRYABLE)
    assert.equal(probe(), null)
})
