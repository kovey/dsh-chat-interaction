/**
 * Message scoring → model routing.
 *
 * Every inbound message that reaches the agent is scored first (0..1), the
 * score maps to a level (low / medium / high) via configurable thresholds,
 * and the level maps to an execution model. The selected model is applied to
 * the followup turn through the harness's model-selection seam (see
 * `model-selection.ts`), and the score is annotated on the agent turn so the
 * whole chain stays transparent.
 *
 * Scorers are pluggable:
 *  - RuleScorer    deterministic heuristics, zero dependencies, always works
 *  - ModelScorer   LLM evaluation (the dsh-feishu router's evaluateWithModel
 *                  pattern), falls back to rules on any failure
 *  - CompositeScorer  the production chain: model → rule fallback (auto)
 *
 * A broken scorer must never block message delivery: the hub catches scorer
 * errors and follows up unscored.
 * @module dsh-chat-interaction/scoring
 */
import type { InboundMessage, ScoreLevel, ScoreResult } from './types.js';
import type { LogFn } from './log.js';
export interface ScoringConfig {
    /** Master switch (default true). */
    enabled?: boolean;
    /** rule | model | auto (model with rule fallback). Default auto. */
    evaluator?: 'rule' | 'model' | 'auto';
    /** Evaluation model for the ModelScorer. */
    model?: string;
    baseURL?: string;
    apiKey?: string;
    /** Evaluation call timeout. */
    timeoutMs?: number;
    /**
     * Level thresholds: score < medium → low; score < high → medium;
     * else high. Defaults 0.4 / 0.75.
     */
    thresholds?: {
        medium?: number;
        high?: number;
    };
    /** Execution model per level; unset level = host default model. */
    models?: Partial<Record<ScoreLevel, string>>;
    providers?: Partial<Record<ScoreLevel, string>>;
    reasoningEfforts?: Partial<Record<ScoreLevel, string>>;
    /** Annotate the agent turn with 消息评分 + 执行模型 (default true). */
    annotateTurn?: boolean;
    /** Restore the host default model when the scored turn ends (default true). */
    restoreOnTurnEnd?: boolean;
    /** Injectable fetch (tests). */
    fetchImpl?: typeof fetch;
}
export interface ResolvedScoringConfig {
    enabled: boolean;
    evaluator: 'rule' | 'model' | 'auto';
    model: string;
    baseURL: string;
    apiKey: string;
    timeoutMs: number;
    thresholds: {
        medium: number;
        high: number;
    };
    models: Partial<Record<ScoreLevel, string>>;
    providers: Partial<Record<ScoreLevel, string>>;
    reasoningEfforts: Partial<Record<ScoreLevel, string>>;
    annotateTurn: boolean;
    restoreOnTurnEnd: boolean;
    fetchImpl?: typeof fetch;
}
export declare function resolveScoringConfig(raw: ScoringConfig | undefined): ResolvedScoringConfig;
/** Score → level via thresholds. */
export declare function levelOf(score: number, thresholds: {
    medium: number;
    high: number;
}): ScoreLevel;
/** Clamp + normalize a scorer's output into a canonical ScoreResult. */
export declare function normalizeScore(result: {
    score: number;
    level?: string;
    reasoning?: string;
    source: ScoreResult['source'];
}, thresholds: {
    medium: number;
    high: number;
}): ScoreResult;
/**
 * Apply the level → model mapping to a score result (fills model / provider /
 * reasoningEffort). Levels without a configured model keep the host default.
 */
export declare function applyScoreConfig(cfg: ResolvedScoringConfig, result: ScoreResult): ScoreResult;
/** Heuristic scoring: additive contributions with human-readable reasons. */
export declare class RuleScorer {
    readonly name = "rule";
    score(msg: InboundMessage, thresholds: {
        medium: number;
        high: number;
    }): ScoreResult;
}
export interface ModelScorerOptions {
    cfg: ResolvedScoringConfig;
    log?: LogFn;
}
/**
 * LLM-based scoring. Returns null on any failure (bad response / timeout /
 * unparsable JSON) — callers fall back to rules. Never throws.
 */
export declare class ModelScorer {
    readonly name = "model";
    private readonly cfg;
    private readonly log;
    constructor(opts: ModelScorerOptions);
    private get ready();
    score(msg: InboundMessage): Promise<ScoreResult | null>;
}
export interface Scorer {
    name: string;
    score(msg: InboundMessage): Promise<ScoreResult | null>;
}
/**
 * evaluator='auto':  model first, rule fallback (source becomes 'fallback');
 * evaluator='model': model only (null → unscored followup);
 * evaluator='rule':  rules only.
 */
export declare class CompositeScorer implements Scorer {
    readonly name = "composite";
    private readonly cfg;
    private readonly rule;
    private readonly model;
    constructor(cfg: ResolvedScoringConfig, log?: LogFn);
    score(msg: InboundMessage): Promise<ScoreResult | null>;
}
/** Convenience factory. */
export declare function createScorer(cfg: ResolvedScoringConfig, log?: LogFn): Scorer;
