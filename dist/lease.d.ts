import type { LogFn } from './log.js';
export type InstanceRole = 'interactive' | 'service';
export interface LeaseState {
    owner: string;
    role: InstanceRole;
    pid: number;
    host: string;
    heartbeatAt: number;
    acquiredAt: number;
}
export interface LeaseOptions {
    /** Channel name the lease protects (feishu / wecom / ...). */
    channel: string;
    /** This process's role. */
    role: InstanceRole;
    /** Lease directory; default the DSH home. */
    dir?: string;
    /** Unique id for this instance (default: random). */
    instanceId?: string;
    /** A heartbeat older than this counts as a dead owner (default 90s). */
    ttlMs?: number;
    /** Renewal interval (default 30s). */
    heartbeatMs?: number;
    /** Injectable clock (tests). */
    now?: () => number;
    log?: LogFn;
}
export interface AcquireResult {
    ok: boolean;
    /** Why the acquire failed (held by a fresh foreign owner). */
    reason?: string;
    /** Current holder as seen by this attempt. */
    holder?: LeaseState;
    /** True when this attempt preempted another instance. */
    preempted?: boolean;
}
export declare class ChannelLease {
    readonly channel: string;
    readonly role: InstanceRole;
    readonly instanceId: string;
    readonly ttlMs: number;
    readonly heartbeatMs: number;
    private readonly dir;
    private readonly now;
    private readonly log;
    private timer;
    private lostHandler;
    private acquiredHandler;
    private want;
    private held;
    private lastRenewAt;
    constructor(opts: LeaseOptions);
    get file(): string;
    /** The lease currently on disk (null when free/unreadable). */
    read(): LeaseState | null;
    /** True when the on-disk lease is absent or its heartbeat is stale. */
    isFree(state?: LeaseState | null): boolean;
    private write;
    /**
     * Try to take the lease. Interactive instances preempt a service holder;
     * services only take a free lease.
     */
    acquire(): AcquireResult;
    /** Refresh the heartbeat while we still own the lease. */
    renew(): boolean;
    /** Start renewing + watching for preemption. */
    start(): void;
    /**
     * One heartbeat round. Returns the action taken — the whole takeover
     * policy lives here, so tests can drive it deterministically.
     */
    tick(): 'renewed' | 'acquired' | 'lost' | 'waiting' | 'idle';
    /** Register the callback fired when another instance takes the lease. */
    onLost(handler: () => void): void;
    /** Register the callback fired when the lease is (re)acquired via tick(). */
    onAcquired(handler: () => void): void;
    /** True while this instance owns the lease. */
    get owns(): boolean;
    /** Give the lease up (no-op when someone else owns it). */
    release(): void;
    stop(): void;
    /** Stop renewing and give the lease up. */
    dispose(): void;
}
