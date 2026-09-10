/**
 * dsh-chat-interaction — an abstract interaction layer between DeepSeek
 * Harness (DSH) and IM platforms (Feishu, WeCom, ...).
 *
 *   ┌──────────────────────────┐        ┌────────────────────────────────┐
 *   │  harness (DSH)           │        │  IM platforms                  │
 *   │  agent.followup / tools  │        │  Feishu (WS)  WeCom (callback) │
 *   └───────────┬──────────────┘        └───────────────┬────────────────┘
 *               │                                       │
 *        harness.ts (DshBridge)              adapters/  (ChannelAdapter)
 *               │                                       │
 *               └──────────►  hub.ts  ◄─────────────────┘
 *                     dedupe · waiters · ack · followup · retry
 *                     tools.ts (per-channel tools) · approval.ts · prompt.ts
 *
 * Usage as a cordis plugin (see plugin.ts):
 *   import { apply } from 'dsh-chat-interaction/plugin'
 *   export { apply, name }
 *
 * Standalone usage:
 *   const hub = new InteractionHub({ onFollowup: ... })
 *   hub.addChannel(createFeishuChannel({ appId, appSecret }))
 *   hub.addChannel(createWeComChannel({ corpId, corpSecret, ... }))
 * @module dsh-chat-interaction
 */
export type { AuthState, ButtonSpec, CardSpec, ChannelCapabilities, ChannelDescriptor, ChatType, DocLink, FollowupContext, InboundMessage, ListenerStatus, Mention, ScoreLevel, ScoreResult, SendResult, WaitResult, } from './types.js';
export { BaseChannel, descriptorOf } from './channel.js';
export type { ChannelAdapter, InboundHandler } from './channel.js';
export { InteractionHub } from './hub.js';
export type { AckTextFn, HubOptions, MessageRouter, RouterDecision } from './hub.js';
export { RetryGuard } from './retry.js';
export type { OutcomeProbe, RetryDeps, RetryOptions } from './retry.js';
export { askViaChannel, buildApprovalCard, evaluateGate, parseAnswer, setupAuthorization, CMD_MAX_CHARS, } from './approval.js';
export type { AnswerDecision, ApprovalDeps, ApprovalHarness, GateInput, GateOutput, PreExecutePayload } from './approval.js';
export { ChannelLease } from './lease.js';
export type { AcquireResult, InstanceRole, LeaseOptions, LeaseState } from './lease.js';
export { PendingStore } from './pending.js';
export type { PendingEntry, PendingStoreOptions } from './pending.js';
export { hasSessionEvents, readSessionEvents } from './session-events.js';
export type { SessionEventLike, SessionEventsSource } from './session-events.js';
export { CompositeScorer, ModelScorer, RuleScorer, applyScoreConfig, createScorer, levelOf, normalizeScore, resolveScoringConfig, } from './scoring.js';
export type { ModelScorerOptions, ResolvedScoringConfig, Scorer, ScoringConfig } from './scoring.js';
export { classifyByRules, createRouter, disambiguationCard, permissionModeCard, resolvePending, resolveRouterConfig, runCommand, securityCheck, } from './router.js';
export type { Classification, CommandResult, PendingResolution, ResolvedRouterConfig, RouterConfig, RouterDeps, SecurityVerdict, } from './router.js';
export { buildChannelTools } from './tools.js';
export type { ChannelToolDeps, ParamSpec, ToolSpec } from './tools.js';
export { buildPromptSection, formatInbound, SCORING_PROMPT_LINES, TASK_POLICY_LINES } from './prompt.js';
export type { PromptSectionOptions } from './prompt.js';
export { dshHome, expandHome, inGitRepo, projStateDir, pruneOldFiles, readFileSafe, statePaths, writeActiveChat, writeFileSafe, } from './state.js';
export { getLogFile, log, sdkLogger, setLogFile } from './log.js';
export type { LogFn, LogLevel } from './log.js';
export { FeishuChannel, buildCardContent, buildUpdatedCard, createFeishuChannel, extractDocIds, extractImageRefs, extractMentions, normalizeButtons, parseContent, resolveFeishuCreds, } from './adapters/feishu.js';
export type { FeishuChannelConfig, LarkClientLike, LarkSdkLike, LarkWsClientLike } from './adapters/feishu.js';
export { WeComChannel, createWeComChannel, parseWeComXml, resolveWeComCreds, wecomDecrypt, wecomSignature, } from './adapters/wecom.js';
export type { WeComChannelConfig, WeComCreds, WeComCryptoLike } from './adapters/wecom.js';
export { WeComBotChannel, createWeComBotChannel, resolveWeComBotCreds, } from './adapters/wecom-bot.js';
export type { AiBotClientLike, AiBotFrameLike, AiBotSdkLike, WeComBotChannelConfig, WeComBotCreds } from './adapters/wecom-bot.js';
