import type { LogFn } from './log.js';
export interface ModelCatalog {
    /** Provider from the host's agent-default-model (when declared). */
    provider?: string;
    /** Declared model ids (across every `llm-*` section). */
    models: string[];
    /** Host default model id. */
    defaultModel?: string;
    /** Host default reasoning effort. */
    defaultEffort?: string;
    /** Where the catalog came from (diagnostics). */
    source: string;
}
/** Reasoning efforts the DeepSeek adapter accepts (see dsh-llm-deepseek). */
export declare const ALLOWED_REASONING_EFFORTS: readonly ["off", "low", "high", "max"];
export interface ReadCatalogOptions {
    settingsFile?: string;
    /** Cache TTL for the process-wide read (default 60s). */
    ttlMs?: number;
    now?: () => number;
}
/**
 * Read the effective model catalog from the DSH settings file (best effort).
 * Returns null when the file is missing/unparsable — callers must treat that
 * as "no opinion" and keep the configured values.
 */
export declare function readModelCatalog(opts?: ReadCatalogOptions): ModelCatalog | null;
/** Test hook: drop the cached catalog. */
export declare function clearModelCatalogCache(): void;
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
export declare function parseSettingsCatalog(raw: string, source?: string): ModelCatalog | null;
export interface SanitizeInput {
    model?: string;
    provider?: string;
    reasoningEffort?: string;
}
export interface SanitizeResult {
    /** Values that are safe to apply (unknown ones removed). */
    applied: SanitizeInput;
    /** Human-readable reasons for everything that was dropped. */
    dropped: string[];
}
/**
 * Drop model ids / efforts that the catalog does not know. With no catalog
 * (null) everything is passed through unchanged.
 */
export declare function sanitizeModelOverride(catalog: ModelCatalog | null, input: SanitizeInput, opts?: {
    allowedEfforts?: readonly string[];
}): SanitizeResult;
/** Log a message once per distinct text (keeps the log readable). */
export declare function warnOnce(message: string, log?: LogFn): void;
/** Log dropped overrides once per distinct reason. */
export declare function reportDropped(dropped: string[], log?: LogFn): void;
/**
 * Whether a model id is usable. With no catalog (or an empty one) we have no
 * opinion and let the host decide — that keeps behaviour unchanged on hosts
 * whose settings we cannot read.
 */
export declare function isModelAvailable(catalog: ModelCatalog | null, model: string): boolean;
/** Test hook: reset the warn-once set. */
export declare function clearModelWarnings(): void;
