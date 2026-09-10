/**
 * Scoring tests: thresholds, rule heuristics, model evaluator (injected
 * fetch), composite fallback chain, and level → model mapping.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
    CompositeScorer,
    ModelScorer,
    RuleScorer,
    applyScoreConfig,
    levelOf,
    resolveScoringConfig,
} from '../src/scoring.js'
import type { InboundMessage } from '../src/types.js'

const TH = { medium: 0.4, high: 0.75 }

function msg(over: Partial<InboundMessage> = {}): InboundMessage {
    return { channel: 'feishu', chatId: 'c1', chatType: 'p2p', text: 'hello', ...over }
}

test('levelOf maps scores through the thresholds', () => {
    assert.equal(levelOf(0.1, TH), 'low')
    assert.equal(levelOf(0.4, TH), 'medium')
    assert.equal(levelOf(0.74, TH), 'medium')
    assert.equal(levelOf(0.75, TH), 'high')
})

test('RuleScorer: casual / card clicks score low', () => {
    const r = new RuleScorer()
    assert.equal(r.score(msg({ text: '好的' }), TH).level, 'low')
    assert.equal(r.score(msg({ text: 'A', isCardAction: true }), TH).level, 'low')
    assert.equal(r.score(msg({ text: 'git status' }), TH).level, 'low')
})

test('RuleScorer: errors, requirements and docs score high', () => {
    const r = new RuleScorer()
    const bug = r.score(msg({ text: '线上服务报错 500 了, 有 stack trace: Error: foo\n    at bar()' }), TH)
    assert.equal(bug.level, 'high')
    const req = r.score(msg({ text: '新增一个活动功能, 需求文档见链接', docLinks: [{ url: 'https://x.feishu.cn/docx/abc' }] }), TH)
    assert.equal(req.level, 'high')
})

test('RuleScorer: score is clamped and reasons are human-readable', () => {
    const r = new RuleScorer()
    const s = r.score(msg({ text: '紧急! 生产环境事故, 马上排查这个报错 Error: boom', isBotMentioned: true }), TH)
    assert.ok(s.score <= 1 && s.score >= 0)
    assert.ok((s.reasoning || '').length > 0)
})

test('ModelScorer parses a good API response and normalizes the level', async () => {
    const cfg = resolveScoringConfig({
        baseURL: 'https://api.test',
        apiKey: 'k',
        fetchImpl: async () =>
            new Response(JSON.stringify({ choices: [{ message: { content: '{"score":0.9,"reasoning":"复杂需求"}' } }] }), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            }) as unknown as Response,
    })
    const scorer = new ModelScorer({ cfg })
    const r = await scorer.score(msg({ text: '实现一个复杂的推荐系统' }))
    assert.ok(r)
    assert.equal(r.source, 'model')
    assert.equal(r.level, 'high')
    assert.equal(r.reasoning, '复杂需求')
})

test('ModelScorer returns null on bad JSON / non-200 / missing key', async () => {
    const badCfg = resolveScoringConfig({
        baseURL: 'https://api.test',
        apiKey: 'k',
        evaluator: 'model',
        fetchImpl: async () => new Response('not json', { status: 200 }) as unknown as Response,
    })
    assert.equal(await new ModelScorer({ cfg: badCfg }).score(msg()), null)

    const noKey = resolveScoringConfig({ baseURL: '', apiKey: '', evaluator: 'model' })
    assert.equal(await new ModelScorer({ cfg: noKey }).score(msg()), null)
})

test('CompositeScorer: auto falls back to rules when the model fails', async () => {
    const cfg = resolveScoringConfig({
        evaluator: 'auto',
        baseURL: 'https://api.test',
        apiKey: 'k',
        fetchImpl: async () => {
            throw new Error('network down')
        },
    })
    const s = new CompositeScorer(cfg)
    const r = await s.score(msg({ text: 'git status' }))
    assert.ok(r)
    assert.equal(r.source, 'fallback')
    assert.equal(r.level, 'low')
})

test('CompositeScorer: model mode yields null on failure, rule mode never calls the API', async () => {
    const modelCfg = resolveScoringConfig({ evaluator: 'model', baseURL: 'https://api.test', apiKey: 'k', fetchImpl: async () => { throw new Error('x') } })
    assert.equal(await new CompositeScorer(modelCfg).score(msg()), null)

    const ruleCfg = resolveScoringConfig({ evaluator: 'rule', baseURL: 'https://api.test', apiKey: 'k' })
    const r = await new CompositeScorer(ruleCfg).score(msg({ text: 'git log' }))
    assert.ok(r)
    assert.equal(r.source, 'rule')
})

test('applyScoreConfig maps level → model/provider/effort; unset levels keep defaults', () => {
    const cfg = resolveScoringConfig({
        models: { low: 'deepseek-chat', high: 'deepseek-reasoner' },
        providers: { high: 'deepseek' },
        reasoningEfforts: { high: 'high' },
    })
    const high = applyScoreConfig(cfg, { score: 0.9, level: 'high', source: 'rule' })
    assert.equal(high.model, 'deepseek-reasoner')
    assert.equal(high.provider, 'deepseek')
    assert.equal(high.reasoningEffort, 'high')

    const medium = applyScoreConfig(cfg, { score: 0.5, level: 'medium', source: 'rule' })
    assert.equal(medium.model, undefined) // no medium mapping → host default
    assert.equal(medium.provider, undefined)
})
