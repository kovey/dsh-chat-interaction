/**
 * Per-channel tool factory — the agent-facing half of the interaction layer.
 *
 * For every registered channel this builds the same proven tool family that
 * dsh-feishu exposes, namespaced by channel name:
 *
 *   <name>_send_message   text / rich-text reply
 *   <name>_send_card      interactive card with buttons (capability-gated)
 *   <name>_wait_reply     block for the user's next message (consumed)
 *   <name>_listener       start/stop/status — opt-in connection control
 *   <name>_auth_state     permission mode / allowlist / pending questions
 *
 * Tool specs are emitted in the `defineTool` input form (schema-spec), and
 * the harness bridge compiles them — via the real `defineTool` when present,
 * or the built-in mini compiler otherwise. The agent experiences identical
 * semantics on every channel, which is what "easy to integrate Feishu,
 * WeCom, ..." means in practice.
 * @module dsh-chat-interaction/tools
 */
import type { AuthState, ButtonSpec, ChannelDescriptor, ListenerStatus, SendResult, WaitResult } from './types.js';
/** Parameter spec, in the `defineTool` schema-spec dialect. */
export interface ParamSpec {
    type?: string;
    required?: boolean;
    description?: string;
    items?: unknown;
    properties?: Record<string, ParamSpec>;
    additionalProperties?: boolean;
    enum?: unknown[];
}
/** One tool in the `defineTool` input form. */
export interface ToolSpec {
    name: string;
    description: string;
    parameters: Record<string, ParamSpec>;
    output: {
        schema: unknown;
        render?: (args: Record<string, unknown>, value: any) => Array<{
            type: 'text';
            text: string;
        }>;
    };
    timeoutMs?: number;
    isConcurrencySafe?: () => boolean;
    execute: (args: Record<string, unknown>, exec: {
        signal?: AbortSignal;
    }) => unknown | Promise<unknown>;
}
/** What the hub + bridge provide per channel. */
export interface ChannelToolDeps {
    sendText(chatId: string, text: string): Promise<SendResult>;
    sendRichText(chatId: string, title: string, body: string): Promise<SendResult>;
    sendCard(chatId: string, title: string, body: string, buttons: ButtonSpec[]): Promise<SendResult>;
    waitReply(chatId: string, timeoutMs: number, signal?: AbortSignal): Promise<WaitResult>;
    listenerControl(action: string): Promise<ListenerStatus & {
        ok: boolean;
    }>;
    authState(): AuthState;
}
/**
 * Build the full tool family for one channel. `capabilities` decides which
 * tools exist (e.g. no `send_card` when the platform has no cards).
 */
export declare function buildChannelTools(desc: ChannelDescriptor, deps: ChannelToolDeps): ToolSpec[];
