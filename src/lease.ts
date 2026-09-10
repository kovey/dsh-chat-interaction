/**
 * Channel lease — heartbeat takeover between a 24×7 headless service and an
 * interactive (TUI) session.
 *
 * Only ONE process may own a channel's connection at a time (two WS listeners
 * on the same bot would double-deliver every message). The lease is a small
 * JSON file in the DSH home:
 *
 *   ~/.dsh/chat-interaction-lease-<channel>.json
 *   { owner, role, pid, host, heartbeatAt, acquiredAt }
 *
 * Rules:
 *   - free  = file missing / unparsable / heartbeat older than `ttlMs`
 *   - an `interactive` instance MAY preempt a `service` holder (the human is
 *     at the keyboard — the TUI takes over from the launchd service)
 *   - a `service` instance only takes a free lease; it keeps retrying while it
 *     wants ownership, so it takes back over once the TUI releases or its
 *     heartbeat expires
 *   - the holder renews `heartbeatAt` every `heartbeatMs`
 *   - a holder that finds a fresh foreign owner fires `onLost` — the plugin
 *     disconnects the channel and waits to be able to take over again
 *
 * Everything is injectable (`now`, dir, instanceId) so the takeover logic is
 * unit-testable without wall-clock waits.
 * @module dsh-chat-interaction/lease
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { dshHome, expandHome } from './state.js'
import { log as defaultLog } from './log.js'
import type { LogFn } from './log.js'

export type InstanceRole = 'interactive' | 'service'

export interface LeaseState {
    owner: string
    role: InstanceRole
    pid: number
    host: string
    heartbeatAt: number
    acquiredAt: number
}

export interface LeaseOptions {
    /** Channel name the lease protects (feishu / wecom / ...). */
    channel: string
    /** This process's role. */
    role: InstanceRole
    /** Lease directory; default the DSH home. */
    dir?: string
    /** Unique id for this instance (default: random). */
    instanceId?: string
    /** A heartbeat older than this counts as a dead owner (default 90s). */
    ttlMs?: number
    /** Renewal interval (default 30s). */
    heartbeatMs?: number
    /** Injectable clock (tests). */
    now?: () => number
    log?: LogFn
}

export interface AcquireResult {
    ok: boolean
    /** Why the acquire failed (held by a fresh foreign owner). */
    reason?: string
    /** Current holder as seen by this attempt. */
    holder?: LeaseState
    /** True when this attempt preempted another instance. */
    preempted?: boolean
}

const DEFAULTS = {
    ttlMs: 90_000,
    heartbeatMs: 30_000,
    /**
     * How often a holder CHECKS whether it still owns the lease. Renewal still
     * happens at most every `heartbeatMs`; the shorter check interval means a
     * preempted instance yields within ~2s instead of a full heartbeat period
     * (otherwise both instances would double-deliver for 30s).
     */
    checkMs: 2_000,
}

export class ChannelLease {
    readonly channel: string
    readonly role: InstanceRole
    readonly instanceId: string
    readonly ttlMs: number
    readonly heartbeatMs: number
    private readonly dir: string
    private readonly now: () => number
    private readonly log: LogFn

    private timer: NodeJS.Timeout | null = null
    private lostHandler: (() => void) | null = null
    private acquiredHandler: (() => void) | null = null
    private want = false
    private held: LeaseState | null = null
    private lastRenewAt = 0

    constructor(opts: LeaseOptions) {
        this.channel = opts.channel
        this.role = opts.role
        this.instanceId = opts.instanceId || `${os.hostname()}-${process.pid}-${randomUUID().slice(0, 8)}`
        this.ttlMs = opts.ttlMs ?? DEFAULTS.ttlMs
        this.heartbeatMs = opts.heartbeatMs ?? DEFAULTS.heartbeatMs
        this.dir = opts.dir ? expandHome(opts.dir) : dshHome()
        this.now = opts.now || (() => Date.now())
        this.log = opts.log || defaultLog
    }

    get file(): string {
        return path.join(this.dir, `chat-interaction-lease-${this.channel}.json`)
    }

    /** The lease currently on disk (null when free/unreadable). */
    read(): LeaseState | null {
        try {
            const raw = fs.readFileSync(this.file, 'utf8')
            const j = JSON.parse(raw) as Partial<LeaseState>
            if (!j || typeof j.owner !== 'string' || typeof j.heartbeatAt !== 'number') return null
            return {
                owner: j.owner,
                role: (j.role === 'service' ? 'service' : 'interactive') as InstanceRole,
                pid: typeof j.pid === 'number' ? j.pid : -1,
                host: typeof j.host === 'string' ? j.host : '',
                heartbeatAt: j.heartbeatAt,
                acquiredAt: typeof j.acquiredAt === 'number' ? j.acquiredAt : j.heartbeatAt,
            }
        } catch {
            return null
        }
    }

    /** True when the on-disk lease is absent or its heartbeat is stale. */
    isFree(state: LeaseState | null = this.read()): boolean {
        if (!state) return true
        return this.now() - state.heartbeatAt > this.ttlMs
    }

    private write(state: LeaseState): void {
        try {
            fs.mkdirSync(this.dir, { recursive: true })
            const tmp = this.file + '.tmp'
            fs.writeFileSync(tmp, JSON.stringify(state, null, 2))
            fs.renameSync(tmp, this.file) // atomic: readers never see a partial lease
        } catch (e) {
            this.log('error', 'lease write failed:', (e as Error).message)
        }
    }

    /**
     * Try to take the lease. Interactive instances preempt a service holder;
     * services only take a free lease.
     */
    acquire(): AcquireResult {
        const holder = this.read()
        if (holder && holder.owner === this.instanceId) {
            this.held = holder
            this.renew()
            return { ok: true, holder }
        }
        const free = this.isFree(holder)
        const preempt = !!holder && !free && this.role === 'interactive' && holder.role === 'service'
        if (holder && !free && !preempt) {
            this.held = null
            return {
                ok: false,
                holder,
                reason: `channel ${this.channel} is owned by ${holder.role} ${holder.owner} ` +
                    `(heartbeat ${Math.round((this.now() - holder.heartbeatAt) / 1000)}s ago)`,
            }
        }
        const state: LeaseState = {
            owner: this.instanceId,
            role: this.role,
            pid: process.pid,
            host: os.hostname(),
            heartbeatAt: this.now(),
            acquiredAt: this.now(),
        }
        this.write(state)
        this.held = state
        this.want = true
        this.lastRenewAt = state.heartbeatAt
        if (preempt) {
            this.log('info', `lease: preempted ${holder!.role} ${holder!.owner} on channel ${this.channel} (interactive priority)`)
        } else if (holder) {
            this.log('info', `lease: took over stale lease of ${holder.owner} on channel ${this.channel}`)
        } else {
            this.log('info', `lease: acquired channel ${this.channel} as ${this.role}`)
        }
        return { ok: true, holder: state, preempted: preempt }
    }

    /** Refresh the heartbeat while we still own the lease. */
    renew(): boolean {
        const current = this.read()
        if (current && current.owner !== this.instanceId) return false
        this.lastRenewAt = this.now()
        const state: LeaseState = {
            owner: this.instanceId,
            role: this.role,
            pid: process.pid,
            host: os.hostname(),
            heartbeatAt: this.now(),
            acquiredAt: current && current.owner === this.instanceId ? current.acquiredAt : this.now(),
        }
        this.write(state)
        this.held = state
        return true
    }

    /** Start renewing + watching for preemption. */
    start(): void {
        this.want = true
        if (this.timer) return
        // check more often than we renew, so preemption is noticed quickly
        this.timer = setInterval(() => this.tick(), Math.min(this.heartbeatMs, DEFAULTS.checkMs))
        if (typeof this.timer.unref === 'function') this.timer.unref()
    }

    /**
     * One heartbeat round. Returns the action taken — the whole takeover
     * policy lives here, so tests can drive it deterministically.
     */
    tick(): 'renewed' | 'acquired' | 'lost' | 'waiting' | 'idle' {
        if (!this.want) return 'idle'
        const current = this.read()
        if (current && current.owner === this.instanceId) {
            // still ours: renew at the heartbeat cadence, no-op in between
            if (this.now() - this.lastRenewAt < this.heartbeatMs) return 'idle'
            this.renew()
            return 'renewed'
        }
        if (current && !this.isFree(current)) {
            // someone else holds a fresh lease
            if (this.held) {
                this.held = null
                this.log('warn', `lease lost on channel ${this.channel}: taken by ${current.role} ${current.owner}`)
                try { this.lostHandler?.() } catch (e) {
                    this.log('error', 'lease lost handler failed:', (e as Error).message)
                }
                return 'lost'
            }
            return 'waiting'
        }
        // free (or stale, or preemptable): try again
        const res = this.acquire()
        if (!res.ok) return 'waiting'
        // only reached via tick(): a RE-acquire while we already wanted the
        // channel — the owner can now reconnect its listener
        try { this.acquiredHandler?.() } catch (e) {
            this.log('error', 'lease acquired handler failed:', (e as Error).message)
        }
        return 'acquired'
    }

    /** Register the callback fired when another instance takes the lease. */
    onLost(handler: () => void): void {
        this.lostHandler = handler
    }

    /** Register the callback fired when the lease is (re)acquired via tick(). */
    onAcquired(handler: () => void): void {
        this.acquiredHandler = handler
    }

    /** True while this instance owns the lease. */
    get owns(): boolean {
        const current = this.read()
        return !!current && current.owner === this.instanceId
    }

    /** Give the lease up (no-op when someone else owns it). */
    release(): void {
        this.want = false
        const current = this.read()
        if (current && current.owner !== this.instanceId) {
            this.held = null
            return
        }
        try {
            fs.unlinkSync(this.file)
        } catch { /* already gone */ }
        this.held = null
        this.log('info', `lease released on channel ${this.channel}`)
    }

    stop(): void {
        if (this.timer) {
            clearInterval(this.timer)
            this.timer = null
        }
    }

    /** Stop renewing and give the lease up. */
    dispose(): void {
        this.stop()
        this.release()
    }
}
