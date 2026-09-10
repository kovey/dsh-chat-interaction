/**
 * Session-event access adapter for dsh 0.1.5+.
 *
 * Breaking change in @deepseek-ai/dsh-session 0.1.5-rc.1: the Session object
 * no longer exposes a plain `events` array (which dsh-feishu and earlier
 * versions of this layer read directly). The official accessors are now
 *  - `snapshotEvents(fromSeq?, toSeqExclusive?)` — frozen immutable snapshot
 *  - `eventAt(seq)` — single event by sequence number
 *  - `ownEvents()` — events appended after the fork-inherited prefix
 *
 * `readSessionEvents()` prefers the official snapshot API and falls back to
 * the legacy `events` array, so the layer stays compatible with both 0.1.5+
 * hosts and older ones. Consumers only need a monotonically-sequenced event
 * list: `{ seq, type, data }`.
 * @module dsh-chat-interaction/session-events
 */
/**
 * Materialize the current event log of a session. Prefers the official
 * `snapshotEvents()`; falls back to the legacy `events` array; returns []
 * when neither is available. Never throws.
 */
export function readSessionEvents(session) {
    if (!session)
        return [];
    if (typeof session.snapshotEvents === 'function') {
        try {
            return Array.from(session.snapshotEvents() || []);
        }
        catch {
            return [];
        }
    }
    return Array.isArray(session.events) ? session.events : [];
}
/** Whether the session exposes an event log at all (either API generation). */
export function hasSessionEvents(session) {
    return !!(session && (typeof session.snapshotEvents === 'function' || Array.isArray(session.events)));
}
