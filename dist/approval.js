import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
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
/** The fence the engineering suite uses to embed machine-readable fields. */
export const APPROVAL_CONTEXT_FENCE = 'approval-context';
/**
 * Read the suite's `approval-context` block out of a reason.
 *
 * A standalone copy of the same convention (this plugin does not depend on
 * `dsh-eng-core`): prose for a text answerer, fenced JSON for a card.
 */
export function parseApprovalContext(reason) {
    const match = /```approval-context\s*\n([\s\S]*?)\n```/.exec(String(reason ?? ''));
    if (!match)
        return undefined;
    try {
        const parsed = JSON.parse(match[1]);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
            return undefined;
        return parsed;
    }
    catch {
        return undefined;
    }
}
/** The reason without its machine block: what a text answerer should show. */
export function proseOf(reason) {
    return String(reason ?? '').replace(/\n*```approval-context\s*\n[\s\S]*?\n```\n*/, '\n').trim();
}
/**
 * Resolve an approval artifact to an ABSOLUTE path that is provably inside
 * `root`, or return null.
 *
 * The artifact list comes from the approval payload (`approval-context` block),
 * which the suite writes but a model can also influence — so an absolute path or
 * a `../` traversal must not be able to hand the chat an arbitrary local file
 * (e.g. `~/.dsh/feishu-app.json`, which holds app credentials).
 *
 * Symlinks are resolved first, so a link inside the project pointing outside is
 * rejected as well. Directories and missing files are not artifacts.
 */
export function resolveContainedPath(root, requested) {
    try {
        const realRoot = fs.realpathSync(root);
        const candidate = path.isAbsolute(requested) ? requested : path.join(realRoot, requested);
        if (!fs.existsSync(candidate))
            return null;
        const real = fs.realpathSync(candidate);
        const prefix = realRoot.endsWith(path.sep) ? realRoot : realRoot + path.sep;
        if (real === realRoot || !real.startsWith(prefix))
            return null;
        if (!fs.statSync(real).isFile())
            return null;
        return real;
    }
    catch {
        return null;
    }
}
/** Parse the card answer into a decision + always flag. */
export function parseAnswer(text) {
    const t = String(text || '').trim();
    // Button values carry a ONE-SHOT token (`approve:<nonce>`): a forwarded card,
    // a stale card from an earlier round, or a guessed `yes` cannot be replayed.
    const token = /^(approve|reject|always):([A-Za-z0-9_-]{4,64})$/i.exec(t);
    if (token) {
        const nonce = token[2];
        const verb = token[1].toLowerCase();
        if (verb === 'approve')
            return { decision: 'allow', always: false, nonce };
        if (verb === 'always')
            return { decision: 'allow', always: true, nonce };
        return { decision: 'deny', always: false, nonce };
    }
    if (/^(yes|同意|y|ok|好的|允许)$/i.test(t))
        return { decision: 'allow', always: false };
    if (/^(always|始终|始终同意|永久同意)$/i.test(t))
        return { decision: 'allow', always: true };
    if (/^(no|拒绝|n|不|算了|deny)$/i.test(t))
        return { decision: 'deny', always: false };
    return null;
}
/** The standard approval card (buttons: yes / no / always). */
export function buildApprovalCard(cmd, nonce, allowAlways = true) {
    const value = (verb) => (nonce ? `${verb}:${nonce}` : verb === 'approve' ? 'yes' : verb === 'reject' ? 'no' : 'always');
    return {
        body: [
            '手动审批模式：以下命令需要你的确认',
            '```\n' + String(cmd).slice(0, CMD_MAX_CHARS) + '\n```',
            `同意=仅本次放行 | 拒绝=本次拦截${allowAlways ? ' | 始终同意=加入允许列表并放行' : ''}`,
        ].join('\n'),
        buttons: [
            { value: value('approve'), label: '同意', type: 'primary' },
            { value: value('reject'), label: '拒绝', type: 'danger' },
            ...(allowAlways ? [{ value: value('always'), label: '始终同意' }] : []),
        ],
    };
}
/**
 * The card for a suite approval (spec / delivery / standards / dependency).
 *
 * The fields come from the `approval-context` block, so a card says WHAT is being
 * decided instead of pasting an essay — and the buttons stay nonce-bound.
 */
export function buildContextCard(context, prose, nonce, allowAlways = false) {
    const kindLabel = {
        spec: '需求规格审核',
        delivery: '交付审核',
        standards: '代码规范放宽',
        dependency: '新增依赖审批',
        command: '命令审批',
    };
    const lines = [`**${kindLabel[context.kind ?? ''] ?? '审批'}**`, ''];
    if (context.title)
        lines.push(`- 任务：${context.title}`);
    if (context.missionId)
        lines.push(`- mission：\`${context.missionId}\``);
    if (context.revision !== undefined)
        lines.push(`- 版本：${context.revision}`);
    if (context.risk)
        lines.push(`- 风险：${context.risk}`);
    for (const [key, value] of Object.entries(context.facts ?? {}))
        lines.push(`- ${key}：${value}`);
    if (context.artifacts?.length)
        lines.push(`- 材料：${context.artifacts.length} 份（随后单独发送）`);
    lines.push('', '---', '', String(proseOf(prose)).slice(0, CMD_MAX_CHARS));
    return {
        body: lines.join('\n'),
        buttons: [
            { value: `approve:${nonce}`, label: '通过', type: 'primary' },
            { value: `reject:${nonce}`, label: '打回', type: 'danger' },
            ...(allowAlways ? [{ value: `always:${nonce}`, label: '始终允许' }] : []),
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
                const originated = req.agent ? deps.isOriginated(req.agent) : false;
                const r = await deps.askCard(req.agent, String(req.reason || cmd).slice(0, CMD_MAX_CHARS * 4), req.signal, req.toolName);
                if (!r) {
                    // Nobody decided. For a task that ARRIVED over this channel the
                    // answer is "cancelled" — silence is not consent, and falling
                    // through would let another answerer approve by default. A task
                    // started elsewhere is left to that surface.
                    if (originated) {
                        deps.log('info', `approval bridge: no decision for a channel-originated task → cancelled${req.callId ? ` (call ${String(req.callId).slice(0, 12)})` : ''}`);
                        return 'cancelled';
                    }
                    return next();
                }
                // Only an outcome may cross this seam (see HarnessApprovalReply):
                // provenance goes to our ledger + this log line instead.
                const outcome = r.decision === 'deny' ? 'rejected' : 'allowed-once';
                deps.log('info', `approval bridge: ${outcome} by=${r.by ?? 'unknown'} message=${r.messageId ?? '-'} via=${r.via ?? '-'}`);
                return outcome;
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
/** How many unauthorised clicks are answered before giving up (bounded noise). */
const MAX_REFUSALS = 3;
export async function askViaChannel(opts, cmd, signal) {
    const { chatId } = opts;
    const nonce = randomUUID().replace(/-/g, '').slice(0, 12);
    const ledger = (entry) => {
        try {
            opts.onDecision?.({ at: Date.now(), chatId: chatId ?? '', nonce, ...entry });
        }
        catch (e) {
            opts.log('error', 'approval ledger write failed:', e.message);
        }
    };
    if (!chatId) {
        opts.log('warn', 'no chat recorded for approval; denying (fail closed)');
        ledger({ decision: 'send-failed' });
        return null;
    }
    const context = parseApprovalContext(cmd);
    const card = context
        ? buildContextCard(context, cmd, nonce, opts.allowAlways === true)
        : buildApprovalCard(cmd, nonce, opts.allowAlways !== false);
    const heading = context?.kind ? `[审批] ${opts.subject ?? context.kind}` : `[审批] ${opts.label}远程任务执行命令`;
    const sent = await opts.sendCard(chatId, heading, card.body, card.buttons);
    if (!sent || !sent.ok) {
        opts.log('error', 'approval card send failed; denying:', sent && sent.error);
        ledger({ decision: 'send-failed' });
        return null;
    }
    if (context?.artifacts?.length && opts.sendFile && opts.sendArtifacts !== false) {
        for (const artifact of context.artifacts.slice(0, 5)) {
            try {
                const result = await opts.sendFile({ path: artifact });
                if (!result.ok)
                    opts.log('warn', `artifact not delivered (${artifact}):`, result.error);
            }
            catch (e) {
                opts.log('warn', `artifact delivery threw (${artifact}):`, e.message);
            }
        }
    }
    const deadline = Date.now() + opts.answerTimeoutMs;
    let refusals = 0;
    for (;;) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
            ledger({ decision: 'timeout' });
            return null;
        }
        const ans = await opts.waitReply(chatId, remaining, signal);
        if (!ans || !ans.text) {
            ledger({ decision: 'timeout' });
            return null; // timeout / aborted → deny (fail closed)
        }
        const parsed = parseAnswer(ans.text);
        if (!parsed)
            continue; // unrelated chatter: keep waiting for the decision
        if (parsed.nonce !== undefined && parsed.nonce !== nonce) {
            ledger({ decision: 'stale-click', userId: ans.senderId, messageId: ans.messageId, via: 'click' });
            await opts.respond?.('这张审批卡已过期（或来自别的请求），请使用最新一张卡片。');
            continue;
        }
        if (opts.requireTokenClick === true && parsed.nonce === undefined) {
            // Strict mode: only the nonce-bound button counts. A typed `yes` is
            // answered and recorded, but never decides — otherwise "cannot be
            // replayed" would be untrue.
            ledger({ decision: 'text-rejected', userId: ans.senderId, messageId: ans.messageId, via: 'text' });
            opts.log('warn', 'approval text answer refused (requireTokenClick):', ans.text);
            await opts.respond?.('本次审批只接受卡片按钮，请点击卡片上的按钮完成。');
            continue;
        }
        const approvers = opts.approvers ?? [];
        if (approvers.length > 0 && (!ans.senderId || !approvers.includes(ans.senderId))) {
            refusals += 1;
            ledger({ decision: 'unauthorized', userId: ans.senderId, messageId: ans.messageId, via: parsed.nonce !== undefined ? 'click' : 'text' });
            opts.log('warn', 'approval click from a user who is not on the approver list:', ans.senderId);
            await opts.respond?.('你没有该项目的审批权，本次点击未生效。');
            if (refusals >= MAX_REFUSALS)
                return null;
            continue;
        }
        ledger({
            decision: parsed.decision,
            userId: ans.senderId,
            messageId: ans.messageId,
            via: parsed.nonce !== undefined ? 'click' : 'text',
        });
        return {
            ...parsed,
            by: ans.senderId,
            messageId: ans.messageId,
            at: Date.now(),
            via: parsed.nonce !== undefined ? 'click' : 'text',
        };
    }
}
