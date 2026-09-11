/**
 * Model catalog guard — never route a turn to a model that does not exist.
 *
 * The harness resolves model ids against the provider's catalog (the shipped
 * `DEFAULT_MODELS` of e.g. `dsh-llm-deepseek`, possibly REPLACED wholesale by
 * `~/.dsh/settings.yaml`). A typo in `scoring.models` / `router.model` would
 * otherwise select a non-existent model for the scored turn and every request
 * of that turn would fail (`UNSUPPORTED_*` / unknown-model), which the retry
 * guard would then redeliver — burning the whole retry budget on a config
 * mistake.
 *
 * This module reads the effective catalog (settings.yaml, best effort) and
 * sanitizes overrides:
 *   - unknown model id  → dropped (turn keeps the host default model)
 *   - illegal effort    → dropped (the adapter accepts off|low|high|max only)
 *   - catalog unknown   → nothing is dropped (behave exactly as before)
 *
 * Parsing is deliberately defensive: settings.yaml is a host-owned file whose
 * shape may evolve, so any surprise degrades to "no opinion" instead of
 * blocking model routing.
 * @module dsh-chat-interaction/model-catalog
 */
import fs from 'node:fs'
import path from 'node:path'
import { dshHome, expandHome } from './state.js'
import type { LogFn } from './log.js'
import { log as defaultLog } from './log.js'

export interface ModelCatalog {
    /** Provider from the host's agent-default-model (when declared). */
    provider?: string
    /** Declared model ids (across every `llm-*` section). */
    models: string[]
    /** Host default model id. */
    defaultModel?: string
    /** Host default reasoning effort. */
    defaultEffort?: string
    /** Where the catalog came from (diagnostics). */
    source: string
}

/** Reasoning efforts the DeepSeek adapter accepts (see dsh-llm-deepseek). */
export const ALLOWED_REASONING_EFFORTS = ['off', 'low', 'high', 'max'] as const

export interface ReadCatalogOptions {
    settingsFile?: string
    /** Cache TTL for the process-wide read (default 60s). */
    ttlMs?: number
    now?: () => number
}

let cache: { at: number; value: ModelCatalog | null; file: string } | null = null

/**
 * Read the effective model catalog from the DSH settings file (best effort).
 * Returns null when the file is missing/unparsable — callers must treat that
 * as "no opinion" and keep the configured values.
 */
export function readModelCatalog(opts: ReadCatalogOptions = {}): ModelCatalog | null {
    const file = opts.settingsFile
        ? expandHome(opts.settingsFile)
        : path.join(dshHome(), 'settings.yaml')
    const ttl = opts.ttlMs ?? 60_000
    const now = (opts.now || Date.now)()
    if (cache && cache.file === file && now - cache.at < ttl) return cache.value

    let value: ModelCatalog | null = null
    try {
        const raw = fs.readFileSync(file, 'utf8')
        value = parseSettingsCatalog(raw, file)
    } catch {
        value = null // missing/unreadable → no opinion
    }
    cache = { at: now, value, file }
    return value
}

/** Test hook: drop the cached catalog. */
export function clearModelCatalogCache(): void {
    cache = null
}

/**
 * Minimal, defensive parser for the settings shape the host writes:
 *
 *   agent-default-model:
 *     provider: deepseek-official
 *     model: deepseek-v4-flash
 *     reasoningEffort: max
 *   llm-deepseek:
 *     models:
 *       - id: deepseek-v4-flash
 *       ...
 *
 * Extraction is regex-based on purpose: we only need model ids and the host
 * default, and we would rather return null than mis-parse a future format.
 */
export function parseSettingsCatalog(raw: string, source = 'settings.yaml'): ModelCatalog | null {
    const lines = String(raw).split(/\r?\n/)
    const models: string[] = []
    let provider: string | undefined
    let defaultModel: string | undefined
    let defaultEffort: string | undefined
    let section = ''

    for (const line of lines) {
        if (/^\S/.test(line)) {
            const m = /^([A-Za-z0-9_-]+):\s*$/.exec(line)
            section = m ? m[1] : ''
            continue
        }
        if (section === 'agent-default-model') {
            const p = /^\s+provider:\s*(\S+)\s*$/.exec(line)
            if (p) { provider = p[1]; continue }
            const m = /^\s+model:\s*(\S+)\s*$/.exec(line)
            if (m) { defaultModel = m[1]; continue }
            const e = /^\s+reasoningEffort:\s*(\S+)\s*$/.exec(line)
            if (e) { defaultEffort = e[1]; continue }
            continue
        }
        if (section.startsWith('llm-')) {
            const id = /^\s*-\s*id:\s*(\S+)\s*$/.exec(line)
            if (id) models.push(id[1])
        }
    }
    if (models.length === 0 && !defaultModel) return null // nothing usable
    return {
        provider,
        models: Array.from(new Set(models)),
        defaultModel,
        defaultEffort,
        source,
    }
}

export interface SanitizeInput {
    model?: string
    provider?: string
    reasoningEffort?: string
}

export interface SanitizeResult {
    /** Values that are safe to apply (unknown ones removed). */
    applied: SanitizeInput
    /** Human-readable reasons for everything that was dropped. */
    dropped: string[]
}

/**
 * Drop model ids / efforts that the catalog does not know. With no catalog
 * (null) everything is passed through unchanged.
 */
export function sanitizeModelOverride(
    catalog: ModelCatalog | null,
    input: SanitizeInput,
    opts: { allowedEfforts?: readonly string[] } = {}
): SanitizeResult {
    const applied: SanitizeInput = { ...input }
    const dropped: string[] = []
    if (!catalog) return { applied, dropped }

    if (applied.model && catalog.models.length > 0 && !catalog.models.includes(applied.model)) {
        dropped.push(
            `model "${applied.model}" is not in ${catalog.source} (available: ${catalog.models.join(', ')})`
        )
        // Keep provider/effort out of the override too: a provider paired with
        // a dropped model would be meaningless.
        applied.model = undefined
        applied.provider = undefined
        applied.reasoningEffort = undefined
        return { applied, dropped }
    }
    const allowed = opts.allowedEfforts || ALLOWED_REASONING_EFFORTS
    if (applied.reasoningEffort && !allowed.includes(applied.reasoningEffort)) {
        dropped.push(
            `reasoningEffort "${applied.reasoningEffort}" is not supported (allowed: ${allowed.join(', ')})`
        )
        applied.reasoningEffort = undefined
    }
    return { applied, dropped }
}

/** Log a message once per distinct text (keeps the log readable). */
export function warnOnce(message: string, log: LogFn = defaultLog): void {
    if (warned.has(message)) return
    warned.add(message)
    log('warn', message)
}

/** Log dropped overrides once per distinct reason. */
export function reportDropped(dropped: string[], log: LogFn = defaultLog): void {
    for (const reason of dropped) {
        warnOnce(`model routing: ignoring override — ${reason}`, log)
    }
}

/**
 * Whether a model id is usable. With no catalog (or an empty one) we have no
 * opinion and let the host decide — that keeps behaviour unchanged on hosts
 * whose settings we cannot read.
 */
export function isModelAvailable(catalog: ModelCatalog | null, model: string): boolean {
    if (!catalog || catalog.models.length === 0) return true
    return catalog.models.includes(model)
}

const warned = new Set<string>()

/** Test hook: reset the warn-once set. */
export function clearModelWarnings(): void {
    warned.clear()
}
