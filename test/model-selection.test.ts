/**
 * ModelSelectionManager tests — dsh 0.2.2 moved the selection to the agent:
 * `agent.model.select({provider, model, reasoningEffort})` (official `Model`).
 * These tests drive a fake `Model` and a session log, so they exercise the
 * manager's POLICY (what to select, when to restore) without depending on the
 * harness's projection machinery.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import type { ModelSelection } from '@deepseek-ai/dsh-agent'
import { ModelSelectionManager } from '../src/model-selection.js'
import type { HarnessAgent } from '../src/harness.js'

/** Records every selection the manager asks for. */
class FakeModel {
    readonly selects: ModelSelection[] = []
    private currentSel: ModelSelection | null = null
    constructor(private readonly fallback: ModelSelection) {}
    current(): Readonly<ModelSelection> | undefined {
        return this.currentSel ?? { ...this.fallback }
    }
    select(selection: Readonly<ModelSelection>): void {
        this.selects.push({ ...selection })
        this.currentSel = { ...selection }
    }
    get last(): ModelSelection | undefined {
        return this.selects[this.selects.length - 1]
    }
}

const DEFAULT: ModelSelection = { provider: 'deepseek', model: 'deepseek-v4-pro', reasoningEffort: 'off' as ModelSelection['reasoningEffort'] }

function makeAgent(id: string, events?: Array<{ seq?: number; type?: string }>) {
    const ctx = new Context()
    const model = new FakeModel(DEFAULT)
    const agent: HarnessAgent = {
        id,
        followup: () => undefined,
        ctx,
        model: model as never,
        options: { provider: DEFAULT.provider, model: DEFAULT.model, reasoningEffort: DEFAULT.reasoningEffort },
        session: { id: 's-' + id, header: { cwd: '/tmp' }, events: events ?? [] },
    }
    return { agent, model, ctx }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

test('override selects a COMPLETE route through the agent-owned model seam', () => {
    const { agent, model } = makeAgent('a1')
    const m = new ModelSelectionManager({ restoreOnTurnEnd: false })
    m.override(agent, { model: 'deepseek-v4-flash', reasoningEffort: 'low' })
    assert.equal(m.hasOverride('a1'), true)
    assert.deepEqual(model.selects[0], { provider: 'deepseek', model: 'deepseek-v4-flash', reasoningEffort: 'low' })
    m.dispose()
})

test('override keeps an explicit provider and omits an unknown effort', () => {
    const { agent, model } = makeAgent('a2')
    const m = new ModelSelectionManager({ restoreOnTurnEnd: false })
    m.override(agent, { provider: 'other', model: 'm2', reasoningEffort: 'medium' })
    assert.deepEqual(model.selects[0], { provider: 'other', model: 'm2' })
    m.dispose()
})

test('null override restores the agent default and disarms', () => {
    const { agent, model } = makeAgent('a3')
    const m = new ModelSelectionManager({ restoreOnTurnEnd: false })
    m.override(agent, { model: 'deepseek-v4-flash' })
    m.override(agent, null)
    assert.equal(m.hasOverride('a3'), false)
    assert.deepEqual(model.last, DEFAULT)
    m.dispose()
})

test('override is restored when the scored turn ends (turn/start then turn/end)', async () => {
    const events: Array<{ seq?: number; type?: string }> = [{ seq: 1, type: 'turn/start' }]
    const { agent, model } = makeAgent('a4', events)
    const m = new ModelSelectionManager({ restorePollMs: 10 })
    m.override(agent, { model: 'deepseek-v4-flash' })
    assert.equal(m.hasOverride('a4'), true)
    events.push({ seq: 2, type: 'turn/end' }) // previous turn closes: must NOT restore yet
    await sleep(30)
    assert.equal(m.hasOverride('a4'), true, 'override survives the PREVIOUS turn end')
    events.push({ seq: 3, type: 'turn/start' })
    events.push({ seq: 4, type: 'turn/end' })
    await sleep(60)
    assert.equal(m.hasOverride('a4'), false, 'override restored after the scored turn ends')
    assert.deepEqual(model.last, DEFAULT)
    m.dispose()
})

test('queued scored turn: an interleaved earlier turn/end does not clear the override', async () => {
    const events: Array<{ seq?: number; type?: string }> = [{ seq: 1, type: 'turn/start' }]
    const { agent } = makeAgent('a5', events)
    const m = new ModelSelectionManager({ restorePollMs: 10 })
    m.override(agent, { model: 'deepseek-v4-flash' })
    events.push({ seq: 2, type: 'turn/end' })
    await sleep(30)
    assert.equal(m.hasOverride('a5'), true)
    events.push({ seq: 3, type: 'turn/start' })
    events.push({ seq: 4, type: 'turn/end' })
    await sleep(60)
    assert.equal(m.hasOverride('a5'), false)
    m.dispose()
})

test('safety restore when no turn/end is ever observed', async () => {
    const { agent } = makeAgent('a6', [])
    const m = new ModelSelectionManager({ restorePollMs: 5, maxIdlePolls: 3 })
    m.override(agent, { model: 'deepseek-v4-flash' })
    await sleep(80)
    assert.equal(m.hasOverride('a6'), false)
    m.dispose()
})

test('restoreAll and dispose restore every armed agent', () => {
    const { agent, model } = makeAgent('a7', [])
    const m = new ModelSelectionManager({ restoreOnTurnEnd: false })
    m.override(agent, { model: 'deepseek-v4-flash' })
    m.restoreAll()
    assert.equal(m.hasOverride('a7'), false)
    assert.deepEqual(model.last, DEFAULT)
    m.override(agent, { model: 'deepseek-v4-flash' })
    m.dispose()
    assert.equal(m.hasOverride('a7'), false)
})

test('agents without the model seam warn once and stay policy-only (no crash)', () => {
    const logs: string[] = []
    const agent: HarnessAgent = { id: 'a8', followup: () => undefined, session: { events: [] } }
    const m = new ModelSelectionManager({ restoreOnTurnEnd: false, log: (level: string, ...args: unknown[]) => void logs.push(`${level}:${args.join(' ')}`) as never })
    m.override(agent, { model: 'x' })
    assert.equal(m.hasOverride('a8'), false)
    assert.ok(logs.some((l) => l.startsWith('warn:') && l.includes('no model seam')), logs.join(' | '))
    m.override(agent, null)
    m.dispose()
})

test('dsh 0.2 sessions: restore watches the official snapshotEvents() accessor', async () => {
    const backing: Array<{ seq: number; type: string }> = [{ seq: 1, type: 'turn/start' }]
    const model = new FakeModel(DEFAULT)
    const agent: HarnessAgent = {
        id: 'a9',
        followup: () => undefined,
        ctx: new Context(),
        model: model as never,
        options: { provider: DEFAULT.provider, model: DEFAULT.model },
        session: { id: 's-a9', header: { cwd: '/tmp' }, snapshotEvents: () => backing },
    }
    const m = new ModelSelectionManager({ restorePollMs: 10 })
    m.override(agent, { model: 'deepseek-v4-flash' })
    assert.equal(m.hasOverride('a9'), true)
    backing.push({ seq: 2, type: 'turn/start' })
    backing.push({ seq: 3, type: 'turn/end' })
    await sleep(60)
    assert.equal(m.hasOverride('a9'), false, 'override restored after turn/end via snapshotEvents')
    m.dispose()
})
