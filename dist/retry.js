const DEFAULTS = {
    maxAttempts: 10,
    baseDelayMs: 30_000,
    capDelayMs: 10 * 60_000,
    pollMs: 5_000,
    retryableCodes: ['SERVER', 'TIMEOUT', 'TRANSPORT', 'RATE_LIMIT', 'EMPTY_RESPONSE'],
};
export class RetryGuard {
    opts;
    probe;
    establishBaseline;
    deps;
    cycles = new Map();
    poller = null;
    armSeq = 0;
    constructor(opts, deps) {
        const { probe, establishBaseline, ...rest } = opts || {};
        this.opts = { ...DEFAULTS, ...rest };
        this.probe = probe;
        this.establishBaseline = establishBaseline;
        this.deps = deps;
    }
    keyOf(msg) {
        const id = String(msg.messageId || '');
        // Messages without a platform id still get a cycle (key fallback is
        // unique per arm — they only collide if redelivered, which never
        // happens for id-less messages).
        if (id)
            return `${String(msg.channel || '')}:${id}`;
        this.armSeq += 1;
        return `${String(msg.channel || '')}:${String(msg.chatId || '')}:nomid-${this.armSeq}`;
    }
    delayMs(failures) {
        return Math.min(this.opts.baseDelayMs * Math.pow(2, failures - 1), this.opts.capDelayMs);
    }
    /**
     * Arm a retry cycle for one delivered message. The outcome baseline is
     * fixed HERE (not at the first poll), so events that already exist at
     * arm time are never classified — the exact timing of the original
     * plugin, and it keeps concurrent cycles from stealing each other's
     * outcomes.
     */
    arm(msg, note) {
        try {
            if (this.establishBaseline)
                this.establishBaseline();
            else
                this.probe?.(); // direct-probe users: first call self-establishes
        }
        catch { /* best effort */ }
        this.cycles.set(this.keyOf(msg), { msg, note, failures: 0, timer: null });
        this.ensurePoller();
    }
    /** Any success evidence — clear every cycle. */
    markSuccess() {
        if (this.cycles.size === 0)
            return;
        for (const e of this.cycles.values()) {
            if (e.timer)
                clearTimeout(e.timer);
        }
        this.cycles.clear();
        this.stopPoller();
        this.deps.log('info', 'retry: cycles reset (success evidence)');
    }
    resetAll(reason) {
        if (this.cycles.size === 0)
            return;
        for (const e of this.cycles.values()) {
            if (e.timer)
                clearTimeout(e.timer);
        }
        this.cycles.clear();
        this.stopPoller();
        this.deps.log('info', 'retry: cycles reset (' + reason + ')');
    }
    stopPoller() {
        if (this.poller) {
            clearInterval(this.poller);
            this.poller = null;
        }
    }
    ensurePoller() {
        if (this.poller || this.cycles.size === 0)
            return;
        this.poller = setInterval(() => {
            if (this.cycles.size === 0) {
                this.stopPoller();
                return;
            }
            const outcome = this.probe ? this.probe() : null;
            if (outcome === 'settled') {
                this.resetAll('turn settled');
                return;
            }
            if (outcome !== 'retryable-error')
                return;
            for (const [key, e] of Array.from(this.cycles.entries())) {
                if (e.timer)
                    continue; // a redelivery is already scheduled
                e.failures += 1;
                if (e.failures >= this.opts.maxAttempts) {
                    this.cycles.delete(key);
                    this.deps.log('error', `retry: exhausted after ${this.opts.maxAttempts} failures:`, e.msg.messageId || '');
                    try {
                        this.deps.notifyExhausted(e.msg, e.failures);
                    }
                    catch { /* best effort */ }
                    continue;
                }
                const delay = this.delayMs(e.failures);
                this.deps.log('warn', 'retry: scheduling redelivery', e.msg.messageId || '', `failure=${e.failures}/${this.opts.maxAttempts}`, `delayMs=${delay}`);
                e.timer = setTimeout(() => {
                    e.timer = null;
                    this.cycles.delete(key);
                    const retryNote = (e.note ? e.note + ' ' : '') +
                        `⚠️ 模型调用失败，自动重试（第 ${e.failures}/${this.opts.maxAttempts} 次）`;
                    e.msg.__retryRedelivery = true;
                    if (this.deps.redeliver(e.msg, retryNote)) {
                        this.cycles.set(key, e); // turn restarted; keep counting
                        this.ensurePoller();
                    }
                    else {
                        this.resetAll('redelivery failed');
                    }
                }, delay);
                if (typeof e.timer.unref === 'function')
                    e.timer.unref();
            }
            if (this.cycles.size === 0)
                this.stopPoller();
        }, this.opts.pollMs);
        if (typeof this.poller.unref === 'function')
            this.poller.unref();
    }
    /** True when at least one cycle is armed. */
    get active() {
        return this.cycles.size > 0;
    }
    dispose() {
        this.resetAll('dispose');
    }
}
