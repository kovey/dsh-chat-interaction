import { log as defaultLog } from './log.js';
const SCORING_DEFAULTS = {
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
};
export function resolveScoringConfig(raw) {
    return {
        ...SCORING_DEFAULTS,
        ...(raw || {}),
        thresholds: { ...SCORING_DEFAULTS.thresholds, ...((raw && raw.thresholds) || {}) },
        models: { ...((raw && raw.models) || {}) },
        providers: { ...((raw && raw.providers) || {}) },
        reasoningEfforts: { ...((raw && raw.reasoningEfforts) || {}) },
        fetchImpl: raw?.fetchImpl,
    };
}
// ---------------------------------------------------------------------------
// pure helpers
// ---------------------------------------------------------------------------
/** Score → level via thresholds. */
export function levelOf(score, thresholds) {
    if (score < thresholds.medium)
        return 'low';
    if (score < thresholds.high)
        return 'medium';
    return 'high';
}
/** Clamp + normalize a scorer's output into a canonical ScoreResult. */
export function normalizeScore(result, thresholds) {
    const score = Math.max(0, Math.min(1, Number(result.score) || 0));
    return {
        score,
        level: levelOf(score, thresholds),
        reasoning: String(result.reasoning || '').slice(0, 300) || undefined,
        source: result.source,
    };
}
/**
 * Apply the level → model mapping to a score result (fills model / provider /
 * reasoningEffort). Levels without a configured model keep the host default.
 */
export function applyScoreConfig(cfg, result) {
    const model = cfg.models[result.level];
    return {
        ...result,
        ...(model ? { model } : {}),
        ...(model && cfg.providers[result.level] ? { provider: cfg.providers[result.level] } : {}),
        ...(model && cfg.reasoningEfforts[result.level] ? { reasoningEffort: cfg.reasoningEfforts[result.level] } : {}),
    };
}
// ---------------------------------------------------------------------------
// rule scorer
// ---------------------------------------------------------------------------
/** Heuristic scoring: additive contributions with human-readable reasons. */
export class RuleScorer {
    name = 'rule';
    score(msg, thresholds) {
        const text = String(msg.text || '');
        const trimmed = text.trim();
        let score = 0.3; // neutral base
        const reasons = [];
        const add = (pts, reason, cond) => {
            if (!cond)
                return;
            score += pts;
            reasons.push(reason);
        };
        add(-0.15, '卡片点击/确认类', !!msg.isCardAction);
        add(-0.25, '极短消息', trimmed.length <= 8);
        add(-0.15, '只读查询命令', /^(git\s+(status|log|diff|branch|show)|ls\b|pwd\b|df\b|date\b|文件列表|目录结构|最近提交|现在几点)/i.test(trimmed));
        add(+0.15, '代码/堆栈片段', /(stack\s*trace|traceback|exception|panic|fatal|```|at\s+[\w.]+\(|Error:)/i.test(text));
        add(+0.2, '报错/故障描述', /(报错|报\s*bug|异常|崩溃|闪退|error|\b500\b|\b502\b|timeout|超时)/i.test(text));
        add(+0.25, '需求/开发任务', /(需求|新增|添加|功能|实现|开发|feature|requirement|写一个|加一个|做一个|上线)/i.test(text));
        add(+0.2, '携带文档链接', !!(msg.docLinks && msg.docLinks.length));
        add(+0.15, '携带图片', !!(msg.imagePaths && msg.imagePaths.length));
        add(+0.1, '长消息', text.length > 200);
        add(+0.2, '紧急/线上', /(紧急|线上|生产环境|事故|马上|立刻|尽快|严重)/i.test(text));
        add(+0.05, '多个问题', (text.match(/[?？]/g) || []).length >= 2);
        add(+0.05, '群聊 @机器人', !!msg.isBotMentioned);
        return normalizeScore({
            score,
            reasoning: reasons.length ? reasons.join('; ') : '普通消息',
            source: 'rule',
        }, thresholds);
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
].join('\n');
/**
 * LLM-based scoring. Returns null on any failure (bad response / timeout /
 * unparsable JSON) — callers fall back to rules. Never throws.
 */
export class ModelScorer {
    name = 'model';
    cfg;
    log;
    constructor(opts) {
        this.cfg = opts.cfg;
        this.log = opts.log || defaultLog;
    }
    get ready() {
        const baseURL = this.cfg.baseURL || process.env.DEEPSEEK_BASE_URL || process.env.OPENAI_BASE_URL || '';
        const apiKey = this.cfg.apiKey || process.env.DEEPSEEK_API_KEY || process.env.OPENAI_API_KEY || '';
        return !!(baseURL && apiKey);
    }
    async score(msg) {
        if (!this.ready)
            return null;
        const baseURL = (this.cfg.baseURL || process.env.DEEPSEEK_BASE_URL || process.env.OPENAI_BASE_URL || '').replace(/\/$/, '');
        const apiKey = this.cfg.apiKey || process.env.DEEPSEEK_API_KEY || process.env.OPENAI_API_KEY || '';
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
        };
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.cfg.timeoutMs);
        try {
            const f = this.cfg.fetchImpl || fetch;
            const res = await f(baseURL + '/chat/completions', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey },
                body: JSON.stringify(payload),
                signal: controller.signal,
            });
            if (!res.ok)
                return null;
            const data = (await res.json());
            const content = data && data.choices && data.choices[0] && data.choices[0].message ? data.choices[0].message.content : '';
            if (!content)
                return null;
            const parsed = JSON.parse(content);
            if (typeof parsed.score !== 'number')
                return null;
            return normalizeScore({ score: parsed.score, reasoning: parsed.reasoning, source: 'model' }, this.cfg.thresholds);
        }
        catch (e) {
            this.log('warn', 'scoring model call failed:', e.message);
            return null;
        }
        finally {
            clearTimeout(timer);
        }
    }
}
/**
 * evaluator='auto':  model first, rule fallback (source becomes 'fallback');
 * evaluator='model': model only (null → unscored followup);
 * evaluator='rule':  rules only.
 */
export class CompositeScorer {
    name = 'composite';
    cfg;
    rule;
    model;
    constructor(cfg, log) {
        this.cfg = cfg;
        this.rule = new RuleScorer();
        this.model = new ModelScorer({ cfg, log });
    }
    async score(msg) {
        if (this.cfg.evaluator === 'rule') {
            return this.rule.score(msg, this.cfg.thresholds);
        }
        const fromModel = await this.model.score(msg);
        if (fromModel)
            return fromModel;
        if (this.cfg.evaluator === 'model')
            return null;
        const fromRule = this.rule.score(msg, this.cfg.thresholds);
        return { ...fromRule, source: 'fallback' };
    }
}
/** Convenience factory. */
export function createScorer(cfg, log) {
    return new CompositeScorer(cfg, log);
}
