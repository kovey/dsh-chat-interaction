/**
 * Public interaction API for OTHER DSH plugins.
 *
 * A plugin that wants to talk to IM (ask a question, post a card with actions,
 * notify a human, register a `/command`) should depend on this package and use
 * this API instead of re-implementing channels, dedupe, waiters, cards and
 * token hygiene. The contract is intentionally small, typed and versioned:
 *
 * ```ts
 * const chat = ctx.get('chatInteraction')?.api          // service lookup
 * if (chat?.apiVersion >= 1) {
 *     const ans = await chat.ask({ chatId, body: '继续吗？', options: [
 *         { value: 'yes', label: '继续', type: 'primary' },
 *         { value: 'no', label: '停止', type: 'danger' },
 *     ], timeoutMs: 60_000 })
 *     if (ans.ok && ans.value.value === 'yes') { … }
 * }
 * ```
 *
 * Design rules:
 *  - **Never throw for expected failures** — return `ApiResult` with a stable
 *    `code` (`no-target`, `channel-unsupported`, `timeout`, …).
 *  - **One-shot tokens** — every button this API sends carries
 *    `ask:<nonce>:<value>` / `act:<nonce>:<value>`, so a stale card from an
 *    earlier request (or a forwarded message) can never resolve a newer wait.
 *  - **Capability negotiation** — a channel without cards gets a numbered text
 *    menu; without files the call returns `channel-unsupported` instead of
 *    silently dropping the payload.
 *  - **Disposables** — every registration returns a disposer, and `dispose()`
 *    releases all of them (HMR-safe).
 * @module dsh-chat-interaction/api
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
/** Bump when a breaking change lands in this contract. */
export const CHAT_INTERACTION_API_VERSION = 1;
const ok = (value) => ({ ok: true, value });
const fail = (code, message) => ({ ok: false, code, message });
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;
/** Normalise a timeout, clamped to [1s, 10min]. */
function clampTimeout(ms) {
    return Math.min(Math.max(Number(ms) || DEFAULT_TIMEOUT_MS, 1000), MAX_TIMEOUT_MS);
}
/** `ask:<nonce>:<value>` / `act:<nonce>:<value>` → parts, or null. */
function parseTokenValue(text) {
    const m = /^(ask|act):([A-Za-z0-9_-]{4,64}):([\s\S]+)$/i.exec(String(text || '').trim());
    if (!m)
        return null;
    return { kind: m[1].toLowerCase(), token: m[2], value: m[3] };
}
/**
 * Match an inbound message against the offered options.
 * Accepts: token-bound click, exact value, label, or a 1-based index.
 */
function matchOption(text, options, nonce) {
    const raw = String(text || '').trim();
    const tokenised = parseTokenValue(raw);
    if (tokenised) {
        if (tokenised.kind !== 'ask' || tokenised.token !== nonce)
            return null; // stale / foreign card
        const hit = options.find((o) => o.value === tokenised.value);
        return hit ? { value: hit.value, label: hit.label, via: 'click' } : { value: tokenised.value, via: 'click' };
    }
    const lower = raw.toLowerCase();
    const byValue = options.find((o) => o.value.toLowerCase() === lower);
    if (byValue)
        return { value: byValue.value, label: byValue.label, via: 'text' };
    const byLabel = options.find((o) => (o.label ?? '').toLowerCase() === lower);
    if (byLabel)
        return { value: byLabel.value, label: byLabel.label, via: 'text' };
    const index = Number(raw);
    if (Number.isInteger(index) && index >= 1 && index <= options.length) {
        const hit = options[index - 1];
        return { value: hit.value, label: hit.label, via: 'text' };
    }
    return null;
}
/**
 * Contain a file path inside `root` (same rule as the approval artifacts):
 * absolute paths and `../` escapes outside the root are rejected, symlinks are
 * resolved first.
 */
export function containFilePath(root, requested) {
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
/** Create the API object exposed as `layer.api` (see {@link ChatInteractionApi}). */
export function createChatApi(deps) {
    const { hub, log, adapters } = deps;
    const disposers = new Set();
    const commands = new Map();
    let disposed = false;
    // ---- target resolution -------------------------------------------------
    const resolve = (target) => {
        if (target?.channel && target.chatId)
            return ok({ channel: target.channel, chatId: target.chatId });
        if (target?.agent) {
            const hit = deps.resolveForAgent(target.agent);
            if (!hit)
                return fail('no-target', `no chat bound to agent "${target.agent.id}"`);
            return ok(hit);
        }
        if (target?.channel && !target.chatId) {
            const hit = deps.resolveActive(target.channel);
            if (!hit)
                return fail('no-target', `no active chat recorded for channel "${target.channel}"`);
            return ok(hit);
        }
        const hit = deps.resolveActive();
        if (!hit)
            return fail('no-target', 'no channel/chatId given and no active chat is recorded');
        return ok(hit);
    };
    const adapterOf = (channel) => adapters.get(channel);
    const sendOk = (channel, chatId, r) => r.ok ? ok({ channel, chatId, messageId: r.messageId }) : fail('send-failed', r.error || 'send failed');
    // ---- sending -----------------------------------------------------------
    const sendText = async (target, text) => {
        if (disposed)
            return fail('internal', 'api disposed');
        const t = resolve(target);
        if (!t.ok)
            return t;
        const { channel, chatId } = t.value;
        const r = await hub.sendText(channel, chatId, String(text ?? ''));
        return sendOk(channel, chatId, r);
    };
    const sendRichText = async (target, title, body) => {
        if (disposed)
            return fail('internal', 'api disposed');
        const t = resolve(target);
        if (!t.ok)
            return t;
        const { channel, chatId } = t.value;
        const adapter = adapterOf(channel);
        const text = title ? `${title}\n\n${body ?? ''}` : String(body ?? '');
        const r = adapter?.capabilities.richText
            ? await hub.sendRichText(channel, chatId, title, body)
            : await hub.sendText(channel, chatId, text);
        return sendOk(channel, chatId, r);
    };
    const sendCard = async (target, card) => {
        if (disposed)
            return fail('internal', 'api disposed');
        const t = resolve(target);
        if (!t.ok)
            return t;
        const { channel, chatId } = t.value;
        const adapter = adapterOf(channel);
        if (!adapter)
            return fail('channel-not-found', `unknown channel "${channel}"`);
        if (!adapter.capabilities.cards) {
            // Graceful degradation: render the card as text instead of dropping it.
            const lines = [card.title, card.body].filter(Boolean);
            const buttons = (card.buttons || []).map((b, i) => `${i + 1}) ${typeof b === 'string' ? b : (b.label || b.value)}`);
            const r = await hub.sendText(channel, chatId, [...lines, ...buttons].join('\n'));
            return sendOk(channel, chatId, r);
        }
        const r = await hub.sendCard(channel, chatId, card);
        return sendOk(channel, chatId, r);
    };
    const sendFile = async (request) => {
        if (disposed)
            return fail('internal', 'api disposed');
        const t = resolve(request);
        if (!t.ok)
            return t;
        const { channel, chatId } = t.value;
        const adapter = adapterOf(channel);
        if (!adapter)
            return fail('channel-not-found', `unknown channel "${channel}"`);
        if (!adapter.sendFile || adapter.capabilities.files === false) {
            return fail('channel-unsupported', `channel "${channel}" does not support file delivery`);
        }
        const root = request.root || process.cwd();
        const contained = containFilePath(root, request.path);
        if (!contained)
            return fail('invalid-argument', `file "${request.path}" is missing or outside "${root}"`);
        const r = await hub.sendFile(channel, chatId, { path: contained, ...(request.name ? { name: request.name } : {}) });
        return sendOk(channel, chatId, r);
    };
    // ---- ask / confirm -----------------------------------------------------
    const ask = async (request) => {
        if (disposed)
            return fail('internal', 'api disposed');
        const t = resolve(request);
        if (!t.ok)
            return t;
        const { channel, chatId } = t.value;
        const adapter = adapterOf(channel);
        if (!adapter)
            return fail('channel-not-found', `unknown channel "${channel}"`);
        const options = request.options ?? [];
        const nonce = randomUUID().replace(/-/g, '').slice(0, 16);
        const title = request.title ?? '需要确认';
        const body = request.body ?? '';
        const sent = options.length > 0 && adapter.capabilities.cards
            ? await hub.sendCard(channel, chatId, {
                title,
                body,
                buttons: options.map((o) => ({
                    value: `ask:${nonce}:${o.value}`,
                    label: o.label ?? o.value,
                    ...(o.type ? { type: o.type } : {}),
                })),
            })
            : await hub.sendText(channel, chatId, [title, body, ...options.map((o, i) => `${i + 1}) ${o.label ?? o.value}`)].filter(Boolean).join('\n'));
        if (!sent.ok)
            return fail('send-failed', sent.error || 'question could not be delivered');
        const deadline = Date.now() + clampTimeout(request.timeoutMs);
        for (;;) {
            const remaining = deadline - Date.now();
            if (remaining <= 0)
                break;
            let reply;
            try {
                reply = await hub.waitReply(channel, chatId, remaining, request.signal);
            }
            catch (e) {
                if (e.message === 'aborted')
                    return fail('aborted', 'the ask was aborted');
                return fail('internal', e.message);
            }
            if (reply.timedOut)
                break;
            if (request.from?.length && (!reply.senderId || !request.from.includes(reply.senderId)))
                continue;
            if (options.length > 0) {
                const hit = matchOption(reply.text, options, nonce);
                if (!hit)
                    continue; // unrelated message: keep waiting for the real answer
                return ok({
                    value: hit.value,
                    text: reply.text,
                    ...(hit.label ? { label: hit.label } : {}),
                    ...(reply.senderId ? { by: reply.senderId } : {}),
                    messageId: reply.messageId,
                    via: hit.via,
                    at: Date.now(),
                });
            }
            return ok({
                value: reply.text,
                text: reply.text,
                ...(reply.senderId ? { by: reply.senderId } : {}),
                messageId: reply.messageId,
                via: reply.isCardAction ? 'click' : 'text',
                at: Date.now(),
            });
        }
        if (request.defaultOption !== undefined) {
            return ok({
                value: request.defaultOption,
                text: '',
                messageId: '',
                via: 'text',
                at: Date.now(),
            });
        }
        return fail('timeout', `no answer within ${clampTimeout(request.timeoutMs)}ms`);
    };
    const confirm = async (target, question, opts = {}) => {
        const answer = await ask({
            ...target,
            ...(question.title ? { title: question.title } : {}),
            ...(question.body ? { body: question.body } : {}),
            options: [
                { value: 'yes', label: '同意', type: 'primary' },
                { value: 'no', label: '拒绝', type: 'danger' },
            ],
            defaultOption: 'no', // fail closed: silence is not consent
            ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
        });
        if (!answer.ok)
            return answer;
        const timedOut = answer.value.text === '' && answer.value.messageId === '';
        return ok({
            confirmed: answer.value.value === 'yes' && !timedOut,
            timedOut,
            ...(answer.value.by ? { by: answer.value.by } : {}),
            ...(answer.value.messageId ? { messageId: answer.value.messageId } : {}),
        });
    };
    // ---- notify / waitForAction -------------------------------------------
    const notify = async (request) => {
        if (disposed)
            return fail('internal', 'api disposed');
        const t = resolve(request);
        if (!t.ok)
            return t;
        const { channel, chatId } = t.value;
        const adapter = adapterOf(channel);
        if (!adapter)
            return fail('channel-not-found', `unknown channel "${channel}"`);
        const levelPrefix = { info: '', warn: '⚠️ ', error: '❌ ', success: '✅ ' };
        const prefix = levelPrefix[request.level ?? 'info'];
        const title = request.title ? `${prefix}${request.title}` : prefix.trim();
        const body = request.body ?? '';
        if (request.actions?.length) {
            const token = randomUUID().replace(/-/g, '').slice(0, 16);
            const sent = adapter.capabilities.cards
                ? await hub.sendCard(channel, chatId, {
                    title: title || '请选择',
                    body,
                    buttons: request.actions.map((a) => ({
                        value: `act:${token}:${a.value}`,
                        label: a.label ?? a.value,
                        ...(a.type ? { type: a.type } : {}),
                    })),
                })
                : await hub.sendText(channel, chatId, [title, body, ...request.actions.map((a, i) => `${i + 1}) ${a.label ?? a.value}`)].filter(Boolean).join('\n'));
            if (!sent.ok)
                return fail('send-failed', sent.error || 'notice could not be delivered');
            return ok({ channel, chatId, messageId: sent.messageId, actionToken: token });
        }
        const sent = await hub.sendText(channel, chatId, [title, body].filter(Boolean).join('\n'));
        return sendOk(channel, chatId, sent);
    };
    const waitForAction = async (request) => {
        if (disposed)
            return fail('internal', 'api disposed');
        const t = resolve(request);
        if (!t.ok)
            return t;
        const { channel, chatId } = t.value;
        const token = request.token;
        const values = new Set(request.values ?? []);
        if (!token && values.size === 0) {
            return fail('invalid-argument', 'waitForAction needs a token (from notify) or explicit values');
        }
        const accept = (msg) => {
            if (!msg.isCardAction)
                return false;
            const parsed = parseTokenValue(msg.text);
            if (token)
                return parsed?.kind === 'act' && parsed.token === token;
            return values.has(msg.text) || (parsed ? values.has(parsed.value) : false);
        };
        let reply;
        try {
            reply = await hub.waitFor(channel, chatId, accept, request.timeoutMs, request.signal);
        }
        catch (e) {
            if (e.message === 'aborted')
                return fail('aborted', 'the wait was aborted');
            return fail('internal', e.message);
        }
        if (reply.timedOut)
            return fail('timeout', `no action within ${clampTimeout(request.timeoutMs)}ms`);
        const parsed = parseTokenValue(reply.text);
        return ok({
            value: parsed ? parsed.value : reply.text,
            text: reply.text,
            ...(reply.senderId ? { by: reply.senderId } : {}),
            messageId: reply.messageId,
            at: Date.now(),
        });
    };
    // ---- commands ----------------------------------------------------------
    const sendCommandReply = async (channel, chatId, reply) => {
        if (!reply)
            return;
        if (reply.card) {
            await hub.sendCard(channel, chatId, reply.card);
            return;
        }
        if (reply.richText) {
            await hub.sendRichText(channel, chatId, reply.richText.title, reply.richText.body);
            return;
        }
        if (reply.text)
            await hub.sendText(channel, chatId, reply.text);
    };
    const registry = {
        match(text) {
            const raw = String(text || '').trim();
            if (!raw.startsWith('/'))
                return null;
            const [head, ...rest] = raw.split(/\s+/);
            const name = (head ?? '').slice(1).toLowerCase();
            const spec = commands.get(name);
            return spec ? { spec, args: rest } : null;
        },
        async run(match, msg) {
            const { spec, args } = match;
            try {
                const result = await spec.handler({
                    channel: msg.channel,
                    chatId: msg.chatId,
                    args,
                    text: String(msg.text ?? ''),
                    message: msg,
                    log,
                    reply: {
                        text: (text) => hub.sendText(msg.channel, msg.chatId, text),
                        richText: (title, body) => hub.sendRichText(msg.channel, msg.chatId, title, body),
                        card: (card) => hub.sendCard(msg.channel, msg.chatId, card),
                    },
                });
                await sendCommandReply(msg.channel, msg.chatId, result);
                return true;
            }
            catch (e) {
                log('error', `command "/${spec.name}" failed:`, e.message);
                await hub.sendText(msg.channel, msg.chatId, `命令 /${spec.name} 执行失败: ${e.message}`);
                return true; // it WAS this command's message; do not let the agent also answer it
            }
        },
    };
    const api = {
        apiVersion: CHAT_INTERACTION_API_VERSION,
        info() {
            return {
                apiVersion: CHAT_INTERACTION_API_VERSION,
                pluginVersion: deps.pluginVersion,
                channels: api.channels(),
            };
        },
        channels() {
            const out = [];
            for (const [name, adapter] of adapters) {
                out.push({
                    name,
                    label: adapter.label,
                    connected: adapter.status().connected,
                    capabilities: adapter.capabilities,
                });
            }
            return out;
        },
        capabilities(channel) {
            const adapter = adapterOf(channel);
            return adapter ? ok(adapter.capabilities) : fail('channel-not-found', `unknown channel "${channel}"`);
        },
        status: (channel) => deps.status(channel),
        connect: (channel) => deps.connect(channel),
        disconnect: (channel) => deps.disconnect(channel),
        authState: (channel) => deps.authState(channel),
        sendText,
        sendRichText,
        sendCard,
        sendFile,
        ask,
        confirm,
        notify,
        waitForAction,
        registerCommand(spec) {
            const name = String(spec.name || '').replace(/^\//, '').toLowerCase();
            if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(name)) {
                throw new Error(`invalid command name "${spec.name}" (expected /^[a-z0-9][a-z0-9_-]{0,31}$/)`);
            }
            if (commands.has(name))
                throw new Error(`command "${name}" is already registered`);
            commands.set(name, { ...spec, name });
            const dispose = () => { commands.delete(name); };
            disposers.add(dispose);
            return {
                dispose() {
                    disposers.delete(dispose);
                    dispose();
                },
            };
        },
        commands() {
            return [...commands.values()].map((c) => ({
                name: c.name,
                ...(c.description ? { description: c.description } : {}),
                ...(c.usage ? { usage: c.usage } : {}),
            }));
        },
        onInbound(handler) {
            const off = hub.onInbound(handler);
            const dispose = () => { off(); };
            disposers.add(dispose);
            return {
                dispose() {
                    disposers.delete(dispose);
                    dispose();
                },
            };
        },
        dispose() {
            if (disposed)
                return;
            disposed = true;
            for (const d of [...disposers]) {
                try {
                    d();
                }
                catch { /* best effort */ }
            }
            disposers.clear();
            commands.clear();
        },
    };
    // The router uses this registry; expose it without widening the public API.
    Object.defineProperty(api, 'commandRegistry', { value: registry, enumerable: false });
    return api;
}
/** Internal accessor for the plugin wiring (not part of the public contract). */
export function commandRegistryOf(api) {
    return api.commandRegistry;
}
/** Re-exported for adapters/tests that need the token format. */
export function makeActionValue(token, value) {
    return `act:${token}:${value}`;
}
export function makeAskValue(nonce, value) {
    return `ask:${nonce}:${value}`;
}
