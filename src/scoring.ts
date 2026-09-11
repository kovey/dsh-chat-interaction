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
import type { InboundMessage, ScoreLevel, ScoreResult } from './types.js'
import type { LogFn } from './log.js'
import { log as defaultLog } from './log.js'
import { isModelAvailable, readModelCatalog, warnOnce } from './model-catalog.js'

// ---------------------------------------------------------------------------
// config
// ---------------------------------------------------------------------------

export interface ScoringConfig {
    /** Master switch (default true). */
    enabled?: boolean
    /** rule | model | auto (model with rule fallback). Default auto. */
    evaluator?: 'rule' | 'model' | 'auto'
    /** Evaluation model for the ModelScorer. */
    model?: string
    baseURL?: string
    apiKey?: string
    /** Evaluation call timeout. */
    timeoutMs?: number
    /**
     * Level thresholds: score < medium → low; score < high → medium;
     * else high. Defaults 0.4 / 0.75.
     */
    thresholds?: { medium?: number; high?: number }
    /** Execution model per level; unset level = host default model. */
    models?: Partial<Record<ScoreLevel, string>>
    providers?: Partial<Record<ScoreLevel, string>>
    reasoningEfforts?: Partial<Record<ScoreLevel, string>>
    /** Annotate the agent turn with 消息评分 + 执行模型 (default true). */
    annotateTurn?: boolean
    /** Restore the host default model when the scored turn ends (default true). */
    restoreOnTurnEnd?: boolean
    /** Injectable fetch (tests). */
    fetchImpl?: typeof fetch
}

export interface ResolvedScoringConfig {
    enabled: boolean
    evaluator: 'rule' | 'model' | 'auto'
    model: string
    baseURL: string
    apiKey: string
    timeoutMs: number
    thresholds: { medium: number; high: number }
    models: Partial<Record<ScoreLevel, string>>
    providers: Partial<Record<ScoreLevel, string>>
    reasoningEfforts: Partial<Record<ScoreLevel, string>>
    annotateTurn: boolean
    restoreOnTurnEnd: boolean
    fetchImpl?: typeof fetch
}

const SCORING_DEFAULTS: Omit<ResolvedScoringConfig, 'fetchImpl'> = {
    enabled: true,
    evaluator: 'auto',
    model: 'deepseek-v4-flash',
    baseURL: '',
    apiKey: '',
    timeoutMs: 15_000,
    thresholds: { medium: 0.4, high: 0.75 },
    models: {},
    providers: {},
    reasoningEfforts: {},
    annotateTurn: true,
    restoreOnTurnEnd: true,
}

export function resolveScoringConfig(raw: ScoringConfig | undefined): ResolvedScoringConfig {
    return {
        ...SCORING_DEFAULTS,
        ...(raw || {}),
        thresholds: { ...SCORING_DEFAULTS.thresholds, ...((raw && raw.thresholds) || {}) },
        models: { ...((raw && raw.models) || {}) },
        providers: { ...((raw && raw.providers) || {}) },
        reasoningEfforts: { ...((raw && raw.reasoningEfforts) || {}) },
        fetchImpl: raw?.fetchImpl,
    }
}

// ---------------------------------------------------------------------------
// pure helpers
// ---------------------------------------------------------------------------

/** Score → level via thresholds. */
export function levelOf(score: number, thresholds: { medium: number; high: number }): ScoreLevel {
    if (score < thresholds.medium) return 'low'
    if (score < thresholds.high) return 'medium'
    return 'high'
}

/** Clamp + normalize a scorer's output into a canonical ScoreResult. */
export function normalizeScore(result: {
    score: number
    level?: string
    reasoning?: string
    source: ScoreResult['source']
}, thresholds: { medium: number; high: number }): ScoreResult {
    const score = Math.max(0, Math.min(1, Number(result.score) || 0))
    return {
        score,
        level: levelOf(score, thresholds),
        reasoning: String(result.reasoning || '').slice(0, 300) || undefined,
        source: result.source,
    }
}

/**
 * Apply the level → model mapping to a score result (fills model / provider /
 * reasoningEffort). Levels without a configured model keep the host default.
 */
export function applyScoreConfig(cfg: ResolvedScoringConfig, result: ScoreResult): ScoreResult {
    const model = cfg.models[result.level]
    return {
        ...result,
        ...(model ? { model } : {}),
        ...(model && cfg.providers[result.level] ? { provider: cfg.providers[result.level] } : {}),
        ...(model && cfg.reasoningEfforts[result.level] ? { reasoningEffort: cfg.reasoningEfforts[result.level] } : {}),
    }
}

// ---------------------------------------------------------------------------
// rule scorer
// ---------------------------------------------------------------------------

/** Heuristic scoring: additive contributions with human-readable reasons. */
export class RuleScorer {
    readonly name = 'rule'

    score(msg: InboundMessage, thresholds: { medium: number; high: number }): ScoreResult {
        const text = String(msg.text || '')
        const trimmed = text.trim()
        let score = 0.3 // neutral base
        const reasons: string[] = []
        const add = (pts: number, reason: string, cond: boolean) => {
            if (!cond) return
            score += pts
            reasons.push(reason)
        }

        add(-0.15, '卡片点击/确认类', !!msg.isCardAction)
        add(-0.25, '极短消息', trimmed.length <= 8)
        add(-0.15, '只读查询命令', /^(git\s+(status|log|diff|branch|show)|ls\b|pwd\b|df\b|date\b|文件列表|目录结构|最近提交|现在几点)/i.test(trimmed))
        add(+0.15, '代码/堆栈片段', /(stack\s*trace|traceback|exception|panic|fatal|```|at\s+[\w.]+\(|Error:)/i.test(text))
        add(+0.2, '报错/故障描述', /(报错|报\s*bug|异常|崩溃|闪退|error|\b500\b|\b502\b|timeout|超时)/i.test(text))
        add(+0.25, '需求/开发任务', /(需求|新增|添加|功能|实现|开发|feature|requirement|写一个|加一个|做一个|上线)/i.test(text))
        add(+0.2, '携带文档链接', !!(msg.docLinks && msg.docLinks.length))
        add(+0.15, '携带图片', !!(msg.imagePaths && msg.imagePaths.length))
        add(+0.1, '长消息', text.length > 200)
        add(+0.2, '紧急/线上', /(紧急|线上|生产环境|事故|马上|立刻|尽快|严重)/i.test(text))
        add(+0.05, '多个问题', (text.match(/[?？]/g) || []).length >= 2)
        add(+0.05, '群聊 @机器人', !!msg.isBotMentioned)

        return normalizeScore({
            score,
            reasoning: reasons.length ? reasons.join('; ') : '普通消息',
            source: 'rule',
        }, thresholds)
    }
}

// ---------------------------------------------------------------------------
// model scorer (evaluateWithModel pattern, ported from the feishu router)
// ---------------------------------------------------------------------------

const SCORING_SYSTEM_PROMPT = [
    '你是消息复杂度评估器。根据消息内容给出 0-1 的复杂度评分, 并给一句话理由。',
    '评分参考:',
    '- 0.0-0.4 (low): 卡片点击/确认回答、简短闲聊、只读查询命令 (git status、文件列表、现在几点)。',
    '- 0.4-0.75 (medium): 一般问题、普通查询、简单任务。',
    '- 0.75-1.0 (high): 报错排查、需求/开发任务、长消息、含代码堆栈或文档链接、多步骤任务。',
    '只输出 JSON, 不要输出其它内容。格式:',
    '{"score":0.0-1.0,"reasoning":"一句话理由"}',
].join('\n')

export interface ModelScorerOptions {
    cfg: ResolvedScoringConfig
    log?: LogFn
}

/**
 * LLM-based scoring. Returns null on any failure (bad response / timeout /
 * unparsable JSON) — callers fall back to rules. Never throws.
 */
export class ModelScorer {
    readonly name = 'model'
    private readonly cfg: ResolvedScoringConfig
    private readonly log: LogFn

    constructor(opts: ModelScorerOptions) {
        this.cfg = opts.cfg
        this.log = opts.log || defaultLog
    }

    private get ready(): boolean {
        const baseURL = this.cfg.baseURL || process.env.DEEPSEEK_BASE_URL || process.env.OPENAI_BASE_URL || ''
        const apiKey = this.cfg.apiKey || process.env.DEEPSEEK_API_KEY || process.env.OPENAI_API_KEY || ''
        if (!baseURL || !apiKey) return false
        // Never call a model the provider does not declare: the call would fail
        // on every message; rule scoring is the correct fallback instead.
        const catalog = readModelCatalog()
        if (!isModelAvailable(catalog, this.cfg.model)) {
            warnOnce(
                `scoring: evaluation model "${this.cfg.model}" is not declared in ${catalog!.source} ` +
                `(available: ${catalog!.models.join(', ')}) — using rule scoring instead`,
                this.log
            )
            return false
        }
        return true
    }

    async score(msg: InboundMessage): Promise<ScoreResult | null> {
        if (!this.ready) return null
        const baseURL = (this.cfg.baseURL || process.env.DEEPSEEK_BASE_URL || process.env.OPENAI_BASE_URL || '').replace(/\/$/, '')
        const apiKey = this.cfg.apiKey || process.env.DEEPSEEK_API_KEY || process.env.OPENAI_API_KEY || ''
        const payload = {
            model: this.cfg.model,
            temperature: 0,
            response_format: { type: 'json_object' },
            messages: [
                { role: 'system', content: SCORING_SYSTEM_PROMPT },
                {
                    role: 'user',
                    content: JSON.stringify({
                        message: {
                            text: msg.text || '',
                            chat_type: msg.chatType || '',
                            is_bot_mentioned: !!msg.isBotMentioned,
                            is_card_action: !!msg.isCardAction,
                            has_images: !!(msg.imagePaths && msg.imagePaths.length),
                            has_doc_links: !!(msg.docLinks && msg.docLinks.length),
                            doc_links: (msg.docLinks || []).map((d) => d.url).slice(0, 3),
                        },
                    }),
                },
            ],
        }
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), this.cfg.timeoutMs)
        try {
            const f = this.cfg.fetchImpl || fetch
            const res = await f(baseURL + '/chat/completions', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey },
                body: JSON.stringify(payload),
                signal: controller.signal,
            })
            if (!res.ok) return null
            const data = (await res.json()) as {
                choices?: Array<{ message?: { content?: string } }>
            }
            const content = data && data.choices && data.choices[0] && data.choices[0].message ? data.choices[0].message.content : ''
            if (!content) return null
            const parsed = JSON.parse(content) as { score?: number; reasoning?: string }
            if (typeof parsed.score !== 'number') return null
            return normalizeScore({ score: parsed.score, reasoning: parsed.reasoning, source: 'model' }, this.cfg.thresholds)
        } catch (e) {
            this.log('warn', 'scoring model call failed:', (e as Error).message)
            return null
        } finally {
            clearTimeout(timer)
        }
    }
}

// ---------------------------------------------------------------------------
// composite (the production chain)
// ---------------------------------------------------------------------------

export interface Scorer {
    name: string
    score(msg: InboundMessage): Promise<ScoreResult | null>
}

/**
 * evaluator='auto':  model first, rule fallback (source becomes 'fallback');
 * evaluator='model': model only (null → unscored followup);
 * evaluator='rule':  rules only.
 */
export class CompositeScorer implements Scorer {
    readonly name = 'composite'
    private readonly cfg: ResolvedScoringConfig
    private readonly rule: RuleScorer
    private readonly model: ModelScorer

    constructor(cfg: ResolvedScoringConfig, log?: LogFn) {
        this.cfg = cfg
        this.rule = new RuleScorer()
        this.model = new ModelScorer({ cfg, log })
    }

    async score(msg: InboundMessage): Promise<ScoreResult | null> {
        if (this.cfg.evaluator === 'rule') {
            return this.rule.score(msg, this.cfg.thresholds)
        }
        const fromModel = await this.model.score(msg)
        if (fromModel) return fromModel
        if (this.cfg.evaluator === 'model') return null
        const fromRule = this.rule.score(msg, this.cfg.thresholds)
        return { ...fromRule, source: 'fallback' }
    }
}

/** Convenience factory. */
export function createScorer(cfg: ResolvedScoringConfig, log?: LogFn): Scorer {
    return new CompositeScorer(cfg, log)
}
