/**
 * Convenience base class: stores the inbound handler, guards emissions while
 * disconnected, and provides default status plumbing. Adapters typically
 * extend it and call `this.emit(msg)` from their transport callbacks.
 */
export class BaseChannel {
    capabilities = {
        cards: false,
        richText: false,
        images: false,
        inbound: true,
    };
    handler = null;
    connected = false;
    setInboundHandler(handler) {
        this.handler = handler;
    }
    /** Deliver one normalized message to the layer. Never throws. */
    emit(msg) {
        if (!this.handler)
            return;
        try {
            const r = this.handler(msg);
            if (r && typeof r.catch === 'function') {
                ;
                r.catch(() => { });
            }
        }
        catch { /* an inbound handler failure must not kill the adapter */ }
    }
    /** Mark the transport as up/down (used by status()). */
    setConnected(v) {
        this.connected = v;
    }
    get isConnected() {
        return this.connected;
    }
    status() {
        return {
            ok: true,
            connected: this.connected,
            message: this.connected ? 'connected' : 'not connected',
        };
    }
    dispose() {
        this.handler = null;
        this.connected = false;
    }
}
/** Derive the standard descriptor from an adapter. */
export function descriptorOf(adapter) {
    return { name: adapter.name, label: adapter.label, capabilities: adapter.capabilities };
}
