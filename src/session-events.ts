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

/** The envelope both API generations share. */
export interface SessionEventLike {
    seq?: number
    type?: string
    data?: unknown
    time?: number
}

/** Structural slice of the Session object that carries events. */
export interface SessionEventsSource {
    /** Legacy (≤0.1.2) direct array access. */
    events?: SessionEventLike[]
    /** Official 0.1.5+ snapshot accessor. */
    snapshotEvents?(fromSeq?: number, toSeqExclusive?: number): readonly SessionEventLike[]
    eventAt?(seq: number): SessionEventLike | undefined
    /** Session identity / project context (header.cwd). */
    id?: string
    header?: { cwd?: string }
}

/**
 * Materialize the current event log of a session. Prefers the official
 * `snapshotEvents()`; falls back to the legacy `events` array; returns []
 * when neither is available. Never throws.
 */
export function readSessionEvents(session: SessionEventsSource | null | undefined): SessionEventLike[] {
    if (!session) return []
    if (typeof session.snapshotEvents === 'function') {
        try {
            return Array.from(session.snapshotEvents() || [])
        } catch {
            return []
        }
    }
    return Array.isArray(session.events) ? session.events : []
}

/** Whether the session exposes an event log at all (either API generation). */
export function hasSessionEvents(session: SessionEventsSource | null | undefined): boolean {
    return !!(session && (typeof session.snapshotEvents === 'function' || Array.isArray(session.events)))
}
