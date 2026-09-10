/**
 * Plugin pending Q&A store, generalized from dsh-feishu's router.
 *
 * Routers (permission-mode cards, disambiguation cards, ...) record open
 * questions per chat. While a question is open, inbound messages from that
 * chat are answers — the hub must NOT let an agent-side `wait_reply` consume
 * them (the router's own flow needs them) — and the router itself resolves
 * them. The hub only needs `has(channel, chatId)`; the store is a tiny
 * JSON-per-chat directory with TTL.
 * @module dsh-chat-interaction/pending
 */
import fs from 'node:fs';
import path from 'node:path';
export class PendingStore {
    dir;
    ttlMs;
    constructor(opts) {
        this.dir = opts.dir;
        this.ttlMs = opts.ttlMs ?? 30 * 60 * 1000;
    }
    file(channel, chatId) {
        return path.join(this.dir, channel, `${chatId.replace(/[^A-Za-z0-9_-]/g, '_')}.json`);
    }
    has(channel, chatId) {
        return this.get(channel, chatId) !== null;
    }
    get(channel, chatId) {
        try {
            const raw = JSON.parse(fs.readFileSync(this.file(channel, chatId), 'utf8'));
            if (Date.now() - raw.createdAt > this.ttlMs) {
                this.clear(channel, chatId);
                return null;
            }
            return raw;
        }
        catch {
            return null;
        }
    }
    set(channel, chatId, entry) {
        try {
            const f = this.file(channel, chatId);
            fs.mkdirSync(path.dirname(f), { recursive: true });
            fs.writeFileSync(f, JSON.stringify({ ...entry, createdAt: Date.now() }));
        }
        catch { /* best effort */ }
    }
    clear(channel, chatId) {
        try {
            fs.unlinkSync(this.file(channel, chatId));
        }
        catch { /* best effort */ }
    }
    /** List `kind:question` strings for the auth-state tool. */
    listAll() {
        try {
            const out = [];
            for (const ch of fs.readdirSync(this.dir)) {
                const chDir = path.join(this.dir, ch);
                if (!fs.statSync(chDir).isDirectory())
                    continue;
                for (const f of fs.readdirSync(chDir)) {
                    if (!f.endsWith('.json'))
                        continue;
                    try {
                        const p = JSON.parse(fs.readFileSync(path.join(chDir, f), 'utf8'));
                        out.push(`${ch}:${p.kind || '?'}:${p.question || ''}`);
                    }
                    catch {
                        out.push(`${ch}:${f}`);
                    }
                }
            }
            return out;
        }
        catch {
            return [];
        }
    }
}
