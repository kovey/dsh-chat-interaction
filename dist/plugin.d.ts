import { InteractionHub } from './hub.js';
import type { AckTextFn } from './hub.js';
import { DshBridge } from './harness.js';
import type { CordisContextLike, HarnessContext } from './harness.js';
import type { ChannelAdapter } from './channel.js';
import type { ResolvedScoringConfig, ScoringConfig } from './scoring.js';
import type { RouterConfig } from './router.js';
import type { FeishuChannelConfig } from './adapters/feishu.js';
import type { WeComChannelConfig } from './adapters/wecom.js';
import type { WeComBotChannelConfig } from './adapters/wecom-bot.js';
import { ChannelLease } from './lease.js';
import type { InstanceRole } from './lease.js';
import type { LogFn } from './log.js';
import type { RetryOptions } from './retry.js';
import type { AuthState, ListenerStatus } from './types.js';
export declare const name = "dsh-chat-interaction";
export declare const inject: string[];
/** Per-channel entry config shared by every adapter. */
export interface ChannelEntryConfig {
    /** Master switch for this channel (default true when listed). */
    enabled?: boolean;
    /** `listener` = connect on startup (deployment decision); `off` = opt-in via the listener tool (default). */
    role?: 'listener' | 'off';
    /** Extra guidance lines for this channel's system-prompt section. */
    promptExtraLines?: string[];
    /** Include task-active / closing-card policy lines (default true). */
    promptTaskPolicy?: boolean;
}
export type ChannelFactory = (cfg: Record<string, unknown>) => ChannelAdapter;
export interface PluginConfig {
    /** Master switch; false = the layer does nothing at all. */
    enabled?: boolean;
    logFile?: string;
    /** JSONL tee of every inbound message. */
    spoolFile?: string;
    /** Plugin pending Q&A store root (per-channel subdirs). */
    pendingDir?: string;
    /** Instant receipt before agent wakeup (default on). */
    ack?: boolean | AckTextFn;
    /** Model-failure redelivery guard (default on). */
    retry?: RetryOptions | false;
    /** Message scoring → model routing (see scoring.ts). */
    scoring?: ScoringConfig;
    /**
     * Built-in plugin autonomy: command execution / confirmation handling /
     * casual-chat replies / task continuity (see router.ts).
     * Default ON; every part degrades gracefully (no API key → rules only).
     */
    router?: RouterConfig;
    permission?: {
        /** Default permission mode when no mode file exists. */
        mode?: 'auto' | 'manual';
        /** A bash call counts as channel-originated within this window after a followup. */
        activeWindowMs?: number;
        /** Approval card answer timeout (fail closed). */
        answerTimeoutMs?: number;
        /** L3: route ALL harness approval asks to channel cards (headless 24×7); default off. */
        bridgeHarnessApproval?: boolean;
    };
    channels?: {
        feishu?: FeishuChannelConfig & ChannelEntryConfig;
        /** 自建应用：HTTP 回调（加密 XML）或 feed() 推送。 */
        wecom?: WeComChannelConfig & ChannelEntryConfig;
        /**
         * 智能机器人：WebSocket 长连接（wss://openws.work.weixin.qq.com），
         * 免公网回调；凭证是 botId + secret（不是 corpId/corpSecret）。
         */
        wecom_bot?: WeComBotChannelConfig & ChannelEntryConfig;
    };
    /** Adapters for platforms beyond the built-ins, e.g. { dingtalk: (cfg) => ... }. */
    channelFactories?: Record<string, ChannelFactory>;
    /**
     * Channel lease: only one instance owns a channel's connection at a time.
     * An `interactive` (TUI) instance preempts a `service` (24×7 headless)
     * holder; the service takes the channel back once the TUI releases or its
     * heartbeat expires — the launchd-service ⇄ TUI heartbeat takeover.
     */
    lease?: {
        enabled?: boolean;
        /** Lease directory; default the DSH home (~/.dsh). */
        dir?: string;
        /** A heartbeat older than this counts as a dead owner (default 90s). */
        ttlMs?: number;
        /** Renewal interval (default 30s). */
        heartbeatMs?: number;
        /**
         * This process's role. Default: `service` when any channel is
         * configured with `role: 'listener'` (a 24×7 deployment), else
         * `interactive`.
         */
        role?: InstanceRole;
    };
    /** Custom logger override. */
    log?: LogFn;
}
export interface ResolvedPluginConfig {
    enabled: boolean;
    logFile: string;
    spoolFile: string;
    pendingDir: string;
    permission: {
        mode: 'auto' | 'manual';
        activeWindowMs: number;
        answerTimeoutMs: number;
        bridgeHarnessApproval: boolean;
    };
}
export declare function resolvePluginConfig(raw?: PluginConfig): ResolvedPluginConfig;
/** The assembled layer, returned by apply() and exported as a service. */
export interface DshChatLayer {
    name: string;
    hub: InteractionHub;
    bridge: DshBridge;
    adapters: Map<string, ChannelAdapter>;
    /** Per-channel leases (heartbeat takeover); empty when disabled. */
    leases: Map<string, ChannelLease>;
    config: ResolvedPluginConfig;
    scoring: ResolvedScoringConfig;
    connect(channel: string): Promise<ListenerStatus>;
    disconnect(channel: string): Promise<ListenerStatus>;
    status(channel: string): ListenerStatus;
    authState(channel: string): AuthState;
    teardown(): void;
}
/**
 * Apply the layer to a harness context (cordis plugin entry point).
 *
 * HARD RULE: this function NEVER throws. A plugin bug must not take the host
 * session down — any startup failure is logged with its stack (our own log
 * file) and the layer is disabled for that session.
 */
export declare function apply(ctx: HarnessContext | CordisContextLike, config?: PluginConfig): DshChatLayer | null;
