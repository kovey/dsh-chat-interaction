/**
 * Canonical, platform-neutral contracts shared by the whole layer.
 *
 * Everything that touches an IM platform speaks these types; everything that
 * touches the harness speaks the structurally-typed interfaces in
 * `harness.ts`. Adapters translate their native payloads into
 * `InboundMessage`; the hub and the harness bridge never see vendor types.
 * @module dsh-chat-interaction/types
 */
export {};
