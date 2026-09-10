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
// channel abstraction
export { BaseChannel, descriptorOf } from './channel.js';
// hub (inbound pipeline + agent tool surface)
export { InteractionHub } from './hub.js';
// retry guard
export { RetryGuard } from './retry.js';
// authorization
export { askViaChannel, buildApprovalCard, evaluateGate, parseAnswer, setupAuthorization, CMD_MAX_CHARS, } from './approval.js';
// channel lease (heartbeat takeover between service and TUI)
export { ChannelLease } from './lease.js';
// pending Q&A store
export { PendingStore } from './pending.js';
// session-event access adapter (dsh 0.1.5+ snapshotEvents / legacy events)
export { hasSessionEvents, readSessionEvents } from './session-events.js';
// message scoring → model routing
export { CompositeScorer, ModelScorer, RuleScorer, applyScoreConfig, createScorer, levelOf, normalizeScore, resolveScoringConfig, } from './scoring.js';
// plugin autonomy router (commands / confirmations / casual chat)
export { classifyByRules, createRouter, disambiguationCard, permissionModeCard, resolvePending, resolveRouterConfig, runCommand, securityCheck, } from './router.js';
// per-channel tools + prompt
export { buildChannelTools } from './tools.js';
export { buildPromptSection, formatInbound, SCORING_PROMPT_LINES, TASK_POLICY_LINES } from './prompt.js';
// NOTE: the harness bridge (DshBridge), the model-selection manager and the
// cordis plugin entry (apply) are dsh-runtime-bound — they import the
// official @deepseek-ai packages. Import them from 'dsh-chat-interaction/plugin'.
// project state helpers
export { dshHome, expandHome, inGitRepo, projStateDir, pruneOldFiles, readFileSafe, statePaths, writeActiveChat, writeFileSafe, } from './state.js';
// logging
export { getLogFile, log, sdkLogger, setLogFile } from './log.js';
// adapters
export { FeishuChannel, buildCardContent, buildUpdatedCard, createFeishuChannel, extractDocIds, extractImageRefs, extractMentions, normalizeButtons, parseContent, resolveFeishuCreds, } from './adapters/feishu.js';
export { WeComChannel, createWeComChannel, parseWeComXml, resolveWeComCreds, wecomDecrypt, wecomSignature, } from './adapters/wecom.js';
// 企业微信智能机器人（WS 长连接，免公网回调）
export { WeComBotChannel, createWeComBotChannel, resolveWeComBotCreds, } from './adapters/wecom-bot.js';
