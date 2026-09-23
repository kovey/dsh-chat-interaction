/**
 * The channel abstraction — the IM-facing half of the interaction layer.
 *
 * A `ChannelAdapter` is everything the layer needs to know about one IM
 * platform. Concretely: how to connect, how to send text / rich text /
 * interactive cards, and how inbound platform events become canonical
 * `InboundMessage`s. Everything platform-specific lives inside the adapter;
 * the hub, tools and harness bridge only ever see these methods.
 *
 * Adding a platform = implementing this interface + one config object.
 * See `adapters/feishu.ts` and `adapters/wecom.ts`.
 * @module dsh-chat-interaction/channel
 */
import type {
    ButtonSpec,
    CardSpec,
    ChannelCapabilities,
    ChannelDescriptor,
    InboundMessage,
    ListenerStatus,
    SendResult,
} from './types.js'

export type InboundHandler = (msg: InboundMessage) => void | Promise<void>

/**
 * The contract every IM adapter implements.
 *
 * Contract rules (mirroring the proven dsh-feishu behavior):
 *  - Never throw out of `send*`: report failures through `SendResult.error`.
 *  - Never throw out of `connect/disconnect/status`: report via `ListenerStatus`.
 *  - `connect()` is the ONLY way inbound delivery starts; adapters must not
 *    connect on their own (opt-in connection policy).
 *  - `setInboundHandler` must be called before `connect()`.
 */
export interface ChannelAdapter {
    /** Machine name — also the tool-name prefix (`feishu_send_message`...). */
    readonly name: string
    /** Human label used in prompts and user turns (`飞书`, `企业微信`...). */
    readonly label: string
    readonly capabilities: ChannelCapabilities

    /** Start inbound delivery (WS listener / callback server / poll loop). */
    connect(): Promise<ListenerStatus>
    /** Stop inbound delivery and free the event loop. */
    disconnect(): Promise<ListenerStatus>
    /** Report current state without changing anything. */
    status(): ListenerStatus

    /** Plain-text message. Always supported. */
    sendText(chatId: string, text: string): Promise<SendResult>
    /** Rich-text (title + body) message; optional capability. */
    sendRichText?(chatId: string, title: string, body: string): Promise<SendResult>
    /** Interactive card with buttons; optional capability. */
    sendCard?(chatId: string, card: CardSpec): Promise<SendResult>
    /**
     * Deliver a file from the local disk (approval artifacts: the specification a
     * human is asked to approve, the test design, a measurement detail).
     * Optional capability — a channel without it falls back to text.
     */
    sendFile?(chatId: string, file: { path: string; name?: string }): Promise<SendResult>

    /** Register the single inbound sink. */
    setInboundHandler(handler: InboundHandler): void

    /** Release every resource (sockets, servers, timers). */
    dispose(): void | Promise<void>
}

export type { ButtonSpec, CardSpec, ChannelDescriptor, InboundMessage, ListenerStatus, SendResult }

/**
 * Convenience base class: stores the inbound handler, guards emissions while
 * disconnected, and provides default status plumbing. Adapters typically
 * extend it and call `this.emit(msg)` from their transport callbacks.
 */
export abstract class BaseChannel implements ChannelAdapter {
    abstract readonly name: string
    abstract readonly label: string
    readonly capabilities: ChannelCapabilities = {
        cards: false,
        richText: false,
        images: false,
        inbound: true,
    }

    private handler: InboundHandler | null = null
    private connected = false

    setInboundHandler(handler: InboundHandler): void {
        this.handler = handler
    }

    /** Deliver one normalized message to the layer. Never throws. */
    protected emit(msg: InboundMessage): void {
        if (!this.handler) return
        try {
            const r = this.handler(msg)
            if (r && typeof (r as Promise<void>).catch === 'function') {
                ;(r as Promise<void>).catch(() => { /* handler errors are its own business */ })
            }
        } catch { /* an inbound handler failure must not kill the adapter */ }
    }

    /** Mark the transport as up/down (used by status()). */
    protected setConnected(v: boolean): void {
        this.connected = v
    }

    protected get isConnected(): boolean {
        return this.connected
    }

    status(): ListenerStatus {
        return {
            ok: true,
            connected: this.connected,
            message: this.connected ? 'connected' : 'not connected',
        }
    }

    abstract connect(): Promise<ListenerStatus>
    abstract disconnect(): Promise<ListenerStatus>
    abstract sendText(chatId: string, text: string): Promise<SendResult>
    sendRichText?(chatId: string, title: string, body: string): Promise<SendResult>
    sendCard?(chatId: string, card: CardSpec): Promise<SendResult>

    dispose(): void {
        this.handler = null
        this.connected = false
    }
}

/** Derive the standard descriptor from an adapter. */
export function descriptorOf(adapter: ChannelAdapter): ChannelDescriptor {
    return { name: adapter.name, label: adapter.label, capabilities: adapter.capabilities }
}
