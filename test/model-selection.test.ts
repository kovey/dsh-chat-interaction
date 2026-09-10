/**
 * ModelSelectionManager tests — the manager now delegates to the OFFICIAL
 * installModelSelection from @deepseek-ai/dsh-agent, so these tests exercise
 * the real machinery: a real cordis Context, the real installer, and the
 * real waterfall dispatch (ctx.waterfall with the innermost next).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { ModelSelectionManager } from '../src/model-selection.js'
import type { HarnessAgent } from '../src/harness.js'

function makeAgent(id: string, events?: Array<{ seq?: number; type?: string; data?: unknown }>) {
    const ctx = new Context()
    const agent: HarnessAgent = {
        id,
        followup: () => undefined,
        ctx,
        session: { id: 's-' + id, header: { cwd: '/tmp' }, events: events ?? [] },
    }
    return { agent, ctx }
}

/** Dispatch a custom event through the real cordis waterfall (innermost next last). */
const waterfall = (ctx: Context, name: string, ...args: unknown[]) =>
    (ctx as unknown as { waterfall: (n: string, ...a: unknown[]) => unknown }).waterfall(name, ...args)

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

test('official seam: override injects provider/model into prompt assembly and request config', async () => {
    const { agent, ctx } = makeAgent('a1')
    const m = new ModelSelectionManager()
    m.override(agent, { provider: 'deepseek', model: 'deepseek-reasoner', reasoningEffort: 'high' })
    assert.equal(m.hasOverride('a1'), true)

    // prompt assembly snapshots the selection and injects the variables
    const assembled = await waterfall(ctx, 'system-prompt/assemble', {}, {}, async () => ({ variables: { system: 'x' } }))
    assert.deepEqual((assembled as { variables: Record<string, unknown> }).variables, {
        system: 'x',
        provider: 'deepseek',
        model: 'deepseek-reasoner',
    })

    // request routing applies the snapshot, clearing inherited effort
    const resolved = await waterfall(ctx, 'agent/request', {}, async () => ({
        provider: 'default',
        model: 'default-model',
        reasoningEffort: 'low',
        foo: 1,
    }))
    assert.deepEqual(resolved, { foo: 1, provider: 'deepseek', model: 'deepseek-reasoner', reasoningEffort: 'high' })
})

test('no selection → the official waterfall passes results through untouched', async () => {
    const { agent, ctx } = makeAgent('a2')
    const m = new ModelSelectionManager()
    m.override(agent, null)
    const out = await waterfall(ctx, 'system-prompt/assemble', {}, {}, async () => ({ variables: { a: 1 } }))
    assert.deepEqual(out, { variables: { a: 1 } })
    const req = await waterfall(ctx, 'agent/request', {}, async () => ({ model: 'default' }))
    assert.deepEqual(req, { model: 'default' })
})

test('override is restored when the scored turn ends (turn/start then turn/end)', async () => {
    const events: Array<{ seq?: number; type?: string }> = [{ seq: 1, type: 'turn/start' }]
    const { agent } = makeAgent('a3', events)
    const m = new ModelSelectionManager({ restorePollMs: 10 })
    m.override(agent, { model: 'deepseek-reasoner' })
    assert.equal(m.hasOverride('a3'), true)
    events.push({ seq: 2, type: 'turn/end' }) // previous turn closes: must NOT restore yet
    await sleep(30)
    assert.equal(m.hasOverride('a3'), true, 'override survives the PREVIOUS turn end')
    events.push({ seq: 3, type: 'turn/start' }) // scored turn starts
    events.push({ seq: 4, type: 'turn/end' }) // scored turn ends
    await sleep(60)
    assert.equal(m.hasOverride('a3'), false, 'override restored after the scored turn ends')
})

test('queued scored turn: an interleaved earlier turn/end does not clear the override', async () => {
    // The scored followup is queued while another turn is running: the other
    // turn's start/end arrive first and must be ignored.
    const events: Array<{ seq?: number; type?: string }> = [{ seq: 1, type: 'turn/start' }]
    const { agent } = makeAgent('a3b', events)
    const m = new ModelSelectionManager({ restorePollMs: 10 })
    m.override(agent, { model: 'deepseek-reasoner' })
    events.push({ seq: 2, type: 'turn/end' }) // running turn closes
    await sleep(30)
    assert.equal(m.hasOverride('a3b'), true)
    events.push({ seq: 3, type: 'turn/start' })
    events.push({ seq: 4, type: 'turn/end' }) // the scored turn
    await sleep(60)
    assert.equal(m.hasOverride('a3b'), false)
})

test('safety restore when no turn/end is ever observed', async () => {
    const { agent } = makeAgent('a4', [])
    const m = new ModelSelectionManager({ restorePollMs: 5, maxIdlePolls: 3 })
    m.override(agent, { model: 'deepseek-reasoner' })
    await sleep(60)
    assert.equal(m.hasOverride('a4'), false)
})

test('restoreAll and dispose clear every override', () => {
    const { agent } = makeAgent('a5', [])
    const m = new ModelSelectionManager({ restoreOnTurnEnd: false })
    m.override(agent, { model: 'x' })
    assert.equal(m.hasOverride('a5'), true)
    m.restoreAll()
    assert.equal(m.hasOverride('a5'), false)
    m.override(agent, { model: 'y' })
    m.dispose()
    assert.equal(m.hasOverride('a5'), false)
})

test('agents without a context still track overrides (no install, no crash)', () => {
    const agent: HarnessAgent = { id: 'a6', followup: () => undefined, session: { events: [] } }
    const m = new ModelSelectionManager({ restoreOnTurnEnd: false })
    m.override(agent, { model: 'x' })
    assert.equal(m.hasOverride('a6'), true)
    m.override(agent, null)
    assert.equal(m.hasOverride('a6'), false)
})

test('dsh 0.1.5 sessions: restore watches the official snapshotEvents() accessor', async () => {
    // dsh-session 0.1.5-rc.1 removed the `events` array; the log is exposed
    // through snapshotEvents(). The restore poller must use it.
    const backing: Array<{ seq: number; type: string }> = [{ seq: 1, type: 'turn/start' }]
    const ctx = new Context()
    const agent: HarnessAgent = {
        id: 'a7',
        followup: () => undefined,
        ctx,
        session: {
            id: 's-a7',
            header: { cwd: '/tmp' },
            snapshotEvents: () => backing,
        },
    }
    const m = new ModelSelectionManager({ restorePollMs: 10 })
    m.override(agent, { model: 'deepseek-reasoner' })
    assert.equal(m.hasOverride('a7'), true)
    backing.push({ seq: 2, type: 'turn/start' })
    backing.push({ seq: 3, type: 'turn/end' })
    await sleep(60)
    assert.equal(m.hasOverride('a7'), false, 'override restored after turn/end via snapshotEvents')
})
