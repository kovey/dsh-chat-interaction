/**
 * Model-catalog guard tests: the layer must never route a turn (or spend a
 * model call) on a model id the provider does not declare.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
    ALLOWED_REASONING_EFFORTS,
    clearModelCatalogCache,
    clearModelWarnings,
    isModelAvailable,
    parseSettingsCatalog,
    readModelCatalog,
    sanitizeModelOverride,
    warnOnce,
} from '../src/model-catalog.js'
import { ModelScorer, resolveScoringConfig } from '../src/scoring.js'
import { resolveRouterConfig } from '../src/router.js'

/** The real settings.yaml shape this host writes. */
const REAL_SETTINGS = `agent-default-model:
  provider: deepseek-official
  model: deepseek-v4-flash
  reasoningEffort: max

llm-deepseek:
  # comment about retries
  models:
    - id: deepseek-v4-flash
      name: DeepSeek-V4-Flash
      inputModalities: [ text, image ]
    - id: deepseek-v4-pro
      name: DeepSeek-V4-Pro
      inputModalities: [ text ]
    - id: deepseek-v4-flash-vision-exp
      name: DeepSeek-V4-Flash-Vision-Exp
`

test('parseSettingsCatalog extracts provider, default model and every declared id', () => {
    const c = parseSettingsCatalog(REAL_SETTINGS, 'settings.yaml')
    assert.ok(c)
    assert.equal(c.provider, 'deepseek-official')
    assert.equal(c.defaultModel, 'deepseek-v4-flash')
    assert.equal(c.defaultEffort, 'max')
    assert.deepEqual(c.models, ['deepseek-v4-flash', 'deepseek-v4-pro', 'deepseek-v4-flash-vision-exp'])
    assert.ok(!c.models.includes('deepseek-chat'), 'a model that this host does not have')
    assert.ok(!c.models.includes('deepseek-reasoner'))
})

test('parseSettingsCatalog returns null for unusable input (no opinion)', () => {
    assert.equal(parseSettingsCatalog('', 'x'), null)
    assert.equal(parseSettingsCatalog('unrelated: true\n', 'x'), null)
})

test('readModelCatalog reads a file and degrades to null when missing', () => {
    clearModelCatalogCache()
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-catalog-'))
    const file = path.join(dir, 'settings.yaml')
    fs.writeFileSync(file, REAL_SETTINGS)
    const c = readModelCatalog({ settingsFile: file, ttlMs: 0 })
    assert.ok(c)
    assert.equal(c.defaultModel, 'deepseek-v4-flash')
    clearModelCatalogCache()
    assert.equal(readModelCatalog({ settingsFile: path.join(dir, 'nope.yaml'), ttlMs: 0 }), null)
})

test('sanitizeModelOverride drops an unknown model (and its provider/effort)', () => {
    const catalog = parseSettingsCatalog(REAL_SETTINGS)!
    // the exact bug this guard exists for: README used deepseek-reasoner
    const bad = sanitizeModelOverride(catalog, { model: 'deepseek-reasoner', provider: 'deepseek', reasoningEffort: 'high' })
    assert.equal(bad.applied.model, undefined)
    assert.equal(bad.applied.provider, undefined)
    assert.equal(bad.applied.reasoningEffort, undefined)
    assert.match(bad.dropped[0], /deepseek-reasoner/)
    assert.match(bad.dropped[0], /deepseek-v4-flash, deepseek-v4-pro/)

    const good = sanitizeModelOverride(catalog, { model: 'deepseek-v4-pro', reasoningEffort: 'high' })
    assert.equal(good.applied.model, 'deepseek-v4-pro')
    assert.equal(good.applied.reasoningEffort, 'high')
    assert.deepEqual(good.dropped, [])
})

test('sanitizeModelOverride rejects unsupported reasoning efforts', () => {
    const catalog = parseSettingsCatalog(REAL_SETTINGS)!
    const r = sanitizeModelOverride(catalog, { model: 'deepseek-v4-pro', reasoningEffort: 'medium' })
    assert.equal(r.applied.model, 'deepseek-v4-pro', 'model survives')
    assert.equal(r.applied.reasoningEffort, undefined, 'illegal effort dropped')
    assert.match(r.dropped[0], /medium.*allowed: off, low, high, max/)
    assert.deepEqual([...ALLOWED_REASONING_EFFORTS], ['off', 'low', 'high', 'max'])
})

test('no catalog → no opinion: overrides pass through untouched', () => {
    const r = sanitizeModelOverride(null, { model: 'anything', reasoningEffort: 'whatever' })
    assert.equal(r.applied.model, 'anything')
    assert.equal(r.applied.reasoningEffort, 'whatever')
    assert.deepEqual(r.dropped, [])
    assert.equal(isModelAvailable(null, 'anything'), true)
})

test('isModelAvailable: declared ids pass, unknown ids fail', () => {
    const catalog = parseSettingsCatalog(REAL_SETTINGS)!
    assert.equal(isModelAvailable(catalog, 'deepseek-v4-flash'), true)
    assert.equal(isModelAvailable(catalog, 'deepseek-chat'), false)
})

test('ModelScorer refuses to call an undeclared model (falls back to rules)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-catalog-'))
    const file = path.join(dir, 'settings.yaml')
    fs.writeFileSync(file, REAL_SETTINGS)
    process.env.DSH_HOME = dir
    process.env.DEEPSEEK_BASE_URL = 'https://api.test'
    process.env.DEEPSEEK_API_KEY = 'k'
    clearModelCatalogCache()
    clearModelWarnings()
    try {
        let calls = 0
        const cfg = resolveScoringConfig({
            model: 'deepseek-reasoner', // does not exist on this host
            fetchImpl: (async () => {
                calls += 1
                return new Response('{}', { status: 200 })
            }) as unknown as typeof fetch,
        })
        const result = await new ModelScorer({ cfg }).score({
            channel: 'feishu', chatId: 'c', chatType: 'p2p', messageType: 'text', text: 'hi',
        })
        assert.equal(result, null, 'no verdict from a non-existent model')
        assert.equal(calls, 0, 'the HTTP call was skipped entirely')
    } finally {
        delete process.env.DSH_HOME
        delete process.env.DEEPSEEK_BASE_URL
        delete process.env.DEEPSEEK_API_KEY
        clearModelCatalogCache()
        clearModelWarnings()
    }
})

test('router model guard: declared model is used, undeclared one is refused', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-catalog-'))
    fs.writeFileSync(path.join(dir, 'settings.yaml'), REAL_SETTINGS)
    process.env.DSH_HOME = dir
    process.env.DEEPSEEK_BASE_URL = 'https://api.test'
    process.env.DEEPSEEK_API_KEY = 'k'
    clearModelCatalogCache()
    try {
        // resolveRouterConfig itself is pure; the guard lives inside createRouter,
        // so we assert the shared predicate the guard uses.
        const catalog = readModelCatalog()
        assert.equal(isModelAvailable(catalog, resolveRouterConfig({}).model), true, 'default matches the host default')
        assert.equal(isModelAvailable(catalog, resolveRouterConfig({ model: 'deepseek-reasoner' }).model), false)
    } finally {
        delete process.env.DSH_HOME
        delete process.env.DEEPSEEK_BASE_URL
        delete process.env.DEEPSEEK_API_KEY
        clearModelCatalogCache()
    }
})

test('warnOnce logs a repeated reason only once', () => {
    clearModelWarnings()
    const lines: string[] = []
    const sink = (_lvl: string, ...msg: unknown[]) => { lines.push(msg.join(' ')) }
    warnOnce('same reason', sink as never)
    warnOnce('same reason', sink as never)
    warnOnce('other reason', sink as never)
    assert.equal(lines.length, 2)
    clearModelWarnings()
})
