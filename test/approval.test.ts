/**
 * Authorization tests: pure decision helpers + the manual-mode gate flow
 * through a fake waterfall harness.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { evaluateGate, parseAnswer, setupAuthorization } from '../src/approval.js'
import type { ApprovalDeps, ApprovalHarness, PreExecutePayload } from '../src/approval.js'

test('evaluateGate: manual + originated + unknown cmd → ask', () => {
    assert.deepEqual(evaluateGate({ mode: 'manual', allowlist: [], cmd: 'git status', originated: true }), { ask: true })
    assert.deepEqual(evaluateGate({ mode: 'auto', allowlist: [], cmd: 'git status', originated: true }), { ask: false })
    assert.deepEqual(evaluateGate({ mode: 'manual', allowlist: [], cmd: 'git status', originated: false }), { ask: false })
    assert.deepEqual(evaluateGate({ mode: 'manual', allowlist: ['git status'], cmd: 'git status', originated: true }), { ask: false, allowed: true })
})

test('parseAnswer: yes / always / no / garbage', () => {
    assert.deepEqual(parseAnswer('yes'), { decision: 'allow', always: false })
    assert.deepEqual(parseAnswer('始终同意'), { decision: 'allow', always: true })
    assert.deepEqual(parseAnswer('no'), { decision: 'deny', always: false })
    assert.equal(parseAnswer('随便聊聊'), null)
})

function makeDeps(over: Partial<ApprovalDeps> = {}): ApprovalDeps & { asked: string[] } {
    const asked: string[] = []
    return {
        log: () => { /* quiet */ },
        readMode: () => 'manual',
        readAllowlist: () => [],
        addAllowlist: () => true,
        isOriginated: () => true,
        askCard: async (_agent, cmd) => {
            asked.push(cmd)
            return { decision: 'allow', always: false }
        },
        asked,
        ...over,
    }
}

/** Minimal waterfall harness capturing listeners. */
class FakeWaterfall implements ApprovalHarness {
    listeners = new Map<string, (payload: any, next: () => any) => any>()
    on(event: string, listener: (payload: any, next: () => any) => any): void {
        this.listeners.set(event, listener)
    }
}

test('manual gate asks for unlisted commands and allows on approval', async () => {
    const harness = new FakeWaterfall()
    const deps = makeDeps()
    setupAuthorization(harness, deps)

    const gate = harness.listeners.get('tools/pre-execute')!
    const next = () => 'next-result'
    const exec: PreExecutePayload = { name: 'bash', agent: { id: 'a1' }, arguments: { command: 'git push' } }
    const out = await gate(exec, next)
    assert.deepEqual(out, { kind: 'allow' })
    assert.deepEqual(deps.asked, ['git push'])
})

test('manual gate denies when the card answer is no', async () => {
    const harness = new FakeWaterfall()
    const deps = makeDeps({ askCard: async () => ({ decision: 'deny', always: false }) })
    setupAuthorization(harness, deps)
    const gate = harness.listeners.get('tools/pre-execute')!
    const out = await gate({ name: 'bash', agent: { id: 'a1' }, arguments: { command: 'rm -rf /' } }, () => 'next')
    assert.equal((out as { kind: string }).kind, 'deny')
})

test('manual gate fails closed on card timeout (null answer)', async () => {
    const harness = new FakeWaterfall()
    const deps = makeDeps({ askCard: async () => null })
    setupAuthorization(harness, deps)
    const gate = harness.listeners.get('tools/pre-execute')!
    const out = await gate({ name: 'bash', agent: { id: 'a1' }, arguments: { command: 'git push' } }, () => 'next')
    assert.equal((out as { kind: string }).kind, 'deny')
})

test('auto mode and non-bash tools pass through untouched', async () => {
    const harness = new FakeWaterfall()
    const deps = makeDeps({ readMode: () => 'auto' })
    setupAuthorization(harness, deps)
    const gate = harness.listeners.get('tools/pre-execute')!
    assert.equal(await gate({ name: 'bash', agent: { id: 'a1' }, arguments: { command: 'git push' } }, () => 'next'), 'next')
    assert.equal(await gate({ name: 'read', agent: { id: 'a1' }, arguments: {} }, () => 'next'), 'next')
    assert.equal(deps.asked.length, 0)
})

test('always-answer appends the command to the allowlist', async () => {
    const harness = new FakeWaterfall()
    const added: string[] = []
    const deps = makeDeps({
        askCard: async () => ({ decision: 'allow', always: true }),
        addAllowlist: (_agent, cmd) => {
            added.push(cmd)
            return true
        },
    })
    setupAuthorization(harness, deps)
    const gate = harness.listeners.get('tools/pre-execute')!
    const out = await gate({ name: 'bash', agent: { id: 'a1' }, arguments: { command: 'git status' } }, () => 'next')
    assert.deepEqual(out, { kind: 'allow' })
    assert.deepEqual(added, ['git status'])
})
