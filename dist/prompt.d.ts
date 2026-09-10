/**
 * Agent-facing text: system-prompt sections and inbound turn formatting,
 * parameterized per channel so every platform teaches the agent the same
 * interaction contract (verbatim chat_id, cards for confirmations,
 * wait_reply sequencing, opt-in connection control, task-active markers,
 * closing-time commit cards).
 * @module dsh-chat-interaction/prompt
 */
import type { ChannelDescriptor, InboundMessage, ScoreResult } from './types.js';
/** Task-session policy lines (task-active markers + closing commit cards). */
export declare const TASK_POLICY_LINES: (d: ChannelDescriptor) => string[];
/** Scoring guidance, appended when the scoring step is enabled. */
export declare const SCORING_PROMPT_LINES: (d: ChannelDescriptor) => string[];
export interface PromptSectionOptions {
    /** Extra guidance lines appended after the core block. */
    extraLines?: string[];
    /** Include the task-active / closing-card policy lines (default true). */
    taskPolicy?: boolean;
    /** Include the scoring/model-routing guidance lines (default false). */
    scoring?: boolean;
}
/** Build the system-prompt section text for one channel. */
export declare function buildPromptSection(desc: ChannelDescriptor, opts?: PromptSectionOptions): string;
/**
 * Format one inbound message into the user-turn text handed to
 * `agent.followup` — the exact pattern dsh-feishu uses, parameterized,
 * plus the optional scoring annotation.
 */
export declare function formatInbound(desc: ChannelDescriptor, msg: InboundMessage, note?: string, score?: ScoreResult): string;
