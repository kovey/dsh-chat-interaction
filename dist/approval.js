export const CMD_MAX_CHARS = 800;
/** Decide whether one command needs the manual-mode card. */
export function evaluateGate({ mode, allowlist, cmd, originated }) {
    if (mode !== 'manual')
        return { ask: false };
    if (!originated)
        return { ask: false };
    if (!cmd)
        return { ask: false };
    if (allowlist.includes(cmd))
        return { ask: false, allowed: true };
    return { ask: true };
}
/** Parse the card answer into a decision + always flag. */
export function parseAnswer(text) {
    const t = String(text || '').trim();
    if (/^(yes|同意|y|ok|好的|允许)$/i.test(t))
        return { decision: 'allow', always: false };
    if (/^(always|始终|始终同意|永久同意)$/i.test(t))
        return { decision: 'allow', always: true };
    if (/^(no|拒绝|n|不|算了|deny)$/i.test(t))
        return { decision: 'deny', always: false };
    return null;
}
/** The standard approval card (buttons: yes / no / always). */
export function buildApprovalCard(cmd) {
    return {
        body: [
            '手动审批模式：以下命令需要你的确认',
            '```\n' + String(cmd).slice(0, CMD_MAX_CHARS) + '\n```',
            '同意=仅本次放行 | 拒绝=本次拦截 | 始终同意=加入允许列表并放行',
        ].join('\n'),
        buttons: [
            { value: 'yes', label: '同意', type: 'primary' },
            { value: 'no', label: '拒绝', type: 'danger' },
            { value: 'always', label: '始终同意' },
        ],
    };
}
/**
 * Register the L2 manual-mode pre-execute gate and (optionally) the L3
 * approval bridge. Returns the registered listeners' unregister function
 * (via harness.on when it supports it; otherwise a no-op teardown).
 */
export function setupAuthorization(harness, deps, cfg = {}) {
    const on = (event, listener) => {
        if (typeof harness.on === 'function')
            harness.on(event, listener);
    };
    // ---- L2: manual-mode pre-execute gate (bash only, inline card Q&A) ----
    on('tools/pre-execute', async (exec, next) => {
        try {
            if (exec.name !== 'bash' || !exec.agent)
                return next();
            if (deps.readMode(exec.agent) !== 'manual')
                return next();
            if (!deps.isOriginated(exec.agent))
                return next();
            const cmd = exec.arguments && typeof exec.arguments.command === 'string' ? exec.arguments.command : '';
            const gate = evaluateGate({
                mode: 'manual',
                allowlist: deps.readAllowlist(exec.agent),
                cmd,
                originated: true,
            });
            if (!gate.ask)
                return gate.allowed ? { kind: 'allow' } : next();
            deps.log('info', 'manual gate: asking approval for', cmd.slice(0, 120));
            const r = await deps.askCard(exec.agent, cmd, exec.signal);
            if (!r)
                return { kind: 'deny', reason: '审批未通过/超时（fail closed）' };
            if (r.decision === 'deny')
                return { kind: 'deny', reason: '用户拒绝了该命令' };
            if (r.always)
                deps.addAllowlist(exec.agent, cmd);
            return { kind: 'allow' };
        }
        catch (e) {
            deps.log('error', 'pre-execute gate error:', e.message);
            return next();
        }
    });
    deps.log('info', 'manual-mode pre-execute gate registered');
    // ---- L3: harness approval bridge (default OFF; for headless 24x7) ----
    if (cfg.bridgeHarnessApproval) {
        on('approval/request', async (req, next) => {
            try {
                const cmd = `${req.toolName || '?'}${req.callId ? ' (call ' + String(req.callId).slice(0, 12) + ')' : ''}`;
                deps.log('info', 'harness approval bridge: asking for', cmd);
                const r = await deps.askCard(req.agent, String(req.reason || cmd).slice(0, CMD_MAX_CHARS), req.signal);
                if (!r)
                    return next();
                if (r.decision === 'deny')
                    return 'rejected';
                return 'allowed-once';
            }
            catch (e) {
                deps.log('error', 'approval bridge error:', e.message);
                return next();
            }
        });
        deps.log('info', 'harness approval bridge (L3) registered');
    }
    return () => { };
}
// ---- helpers for wiring into a hub (used by plugin.ts) ----
/** Ask via one channel, wait for the card click, parse the answer. */
export async function askViaChannel(opts, cmd, signal) {
    const { chatId } = opts;
    if (!chatId) {
        opts.log('warn', 'no chat recorded for approval; denying (fail closed)');
        return null;
    }
    const card = buildApprovalCard(cmd);
    const sent = await opts.sendCard(chatId, `[审批] ${opts.label}远程任务执行命令`, card.body, card.buttons);
    if (!sent || !sent.ok) {
        opts.log('error', 'approval card send failed; denying:', sent && sent.error);
        return null;
    }
    const ans = await opts.waitReply(chatId, opts.answerTimeoutMs, signal);
    if (!ans || !ans.text)
        return null; // timeout / aborted → deny (fail closed)
    return parseAnswer(ans.text);
}
