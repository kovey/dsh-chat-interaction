/**
 * Canonical, platform-neutral contracts shared by the whole layer.
 *
 * Everything that touches an IM platform speaks these types; everything that
 * touches the harness speaks the structurally-typed interfaces in
 * `harness.ts`. Adapters translate their native payloads into
 * `InboundMessage`; the hub and the harness bridge never see vendor types.
 * @module dsh-chat-interaction/types
 */

/** Peer kind of a chat. `unknown` = the adapter could not tell. */
export type ChatType = 'p2p' | 'group' | 'unknown'

/** One @-mention inside a message. */
export interface Mention {
    id?: string
    name?: string
}

/** A link to a shared document found in message text (Feishu docs etc.). */
export interface DocLink {
    url: string
    docId?: string
}

/**
 * Kind of one inline span in a rich-text message.
 * `strike` is the platform's strikethrough style; `text` is unstyled text.
 */
export type RichSpanType =
    | 'text'
    | 'bold'
    | 'italic'
    | 'strike'
    | 'underline'
    | 'link'
    | 'mention'
    | 'image'
    | 'code_block'
    | 'emotion'
    | 'hr'

/**
 * One inline span of a rich-text message, normalized across platforms.
 *
 * Which fields are populated depends on `type`: `text` for text-like spans,
 * `href` for links, `mentionId`/`mentionName` for @-mentions, `imageKey` (+ a
 * local `path` when the image was downloaded) for images, `language` for code
 * blocks.
 */
export interface RichSpan {
    type: RichSpanType
    /** Visible text (also the code-block body and the emotion label). */
    text?: string
    /** Target URL of a `link` span. */
    href?: string
    /** Platform mention id (Feishu `user_id`) of a `mention` span. */
    mentionId?: string
    /** Display name of the mentioned user. */
    mentionName?: string
    /** Platform image key (Feishu `image_key`) of an `image` span. */
    imageKey?: string
    /** Language label of a `code_block` span, when the platform reported one. */
    language?: string
    /**
     * Local absolute path of a downloaded image. Absent when the image was not
     * downloaded — a missing path is never invented.
     */
    path?: string
    /**
     * The platform's original segment this span was derived from; adapters that
     * can supply it (Feishu `post`) set a shallow copy, so fields we do not
     * normalise stay available here.
     */
    raw?: unknown
}

/**
 * Normalized rich-text body: an optional title plus spans grouped by the
 * original paragraphs. Only platforms/message types that carry structure
 * (`post` on Feishu) populate this; `text` stays the flattened form.
 */
export interface RichContent {
    title?: string
    /** Paragraphs in their original order; each entry is one line of spans. */
    blocks: RichSpan[][]
}

/**
 * One inbound message normalized by a channel adapter.
 * This is the single currency of the inbound pipeline.
 */
export interface InboundMessage {
    /** Channel name, e.g. `feishu` / `wecom`. Always set by the adapter. */
    channel: string
    /** The exact opaque chat id; the agent must reply with it verbatim. */
    chatId: string
    chatType: ChatType
    /** Platform message id — used for dedupe only, never for replies. */
    messageId?: string
    /** Platform message type (`text`, `image`, `post`, ...). */
    messageType?: string
    /** Best sender identifier on the platform (open_id preferred, then user_id). */
    senderId?: string
    /** Feishu `open_id` — always present on inbound events; the stable id for allowlists. */
    senderOpenId?: string
    /** Feishu `user_id` — permission/per-org dependent; may be absent. */
    senderUserId?: string
    /** Human-readable text (post/rich messages flattened). */
    text: string
    /**
     * Normalized rich-text structure (title + paragraph-grouped spans) for
     * message types that carry one (`post`). `text` remains the flattened form,
     * so consumers that only want plain text keep working unchanged.
     */
    rich?: RichContent
    /** True when this message was synthesized from an interactive-card click. */
    isCardAction?: boolean
    /** True when the bot itself was @-mentioned in a group. */
    isBotMentioned?: boolean
    mentions?: Mention[]
    docLinks?: DocLink[]
    /** Local absolute paths of downloaded images (read with read_image). */
    imagePaths?: string[]
    /** Download failures, one entry per failed image. */
    imageErrors?: string[]
    /**
     * Non-image attachments downloaded to local files (PDF, doc, zip, voice…).
     * Every consumer (the agent AND `api.onInbound` observers) gets the same
     * absolute paths — a file that never landed cannot be handed to anyone.
     */
    files?: InboundFile[]
    /** Download failures, one entry per failed file. */
    fileErrors?: string[]
    /** Original create timestamp as reported by the platform. */
    timestamp?: string
    /** Raw normalized platform payload, for routers that need more. */
    raw?: unknown
}

/** One inbound attachment already written to disk. */
export interface InboundFile {
    /** Local absolute path (same shape as `imagePaths` entries). */
    path: string
    /** Original file name reported by the platform, when available. */
    name?: string
    /** MIME type, when the platform reported one. */
    mime?: string
    /** Size in bytes. */
    size?: number
    /** Platform message kind that carried it (`file`, `voice`, `video`, …). */
    kind?: string
}

/** One button of an interactive card. */
export interface ButtonSpec {
    /** Short value delivered back to the agent when clicked (A / yes / ...). */
    value: string
    /** Visible label; defaults to value. */
    label?: string
    /** Visual style; adapters map this onto platform styles. */
    type?: 'primary' | 'default' | 'danger'
}

/** Interactive card: title + markdown-ish body + one button row. */
export interface CardSpec {
    title: string
    body?: string
    /**
     * Buttons as objects, or compact `"value|label|type"` strings
     * (the dsh-feishu dialect, e.g. `"A|提交+推送+部署|primary"`).
     */
    buttons?: Array<ButtonSpec | string>
}

/** Result of any outbound send. Never throws. */
export interface SendResult {
    ok: boolean
    /** Platform message id when the platform returned one. */
    messageId?: string
    error?: string
}

/** Connection lifecycle result (connect/disconnect/status). */
export interface ListenerStatus {
    ok: boolean
    connected: boolean
    message?: string
    error?: string
}

/** Resolution of `wait_reply`: either the user's message or a timeout. */
export interface WaitResult {
    ok: boolean
    timedOut: boolean
    text: string
    messageId: string
    isCardAction: boolean
    /**
     * The consumed message's chat kind (`p2p` / `group`) when the platform
     * reported one. Answer provenance needs both "which chat" and "what kind":
     * an approval decision must be attributable to a chat, not just a sender.
     */
    chatType?: 'p2p' | 'group'
    /**
     * Who sent it. Required for approval cards: a decision that cannot name the
     * person who clicked is not an audit trail (the suite records `by` in the
     * specification approval and in the delivery receipt).
     */
    senderId?: string
    /** Feishu open_id of the sender (when the platform reported it). */
    senderOpenId?: string
    /** Feishu user_id of the sender (when the platform reported it). */
    senderUserId?: string
}

/** What a channel adapter is able to do. The tools layer reads this. */
export interface ChannelCapabilities {
    /** Interactive cards (buttons → card-click events). */
    cards: boolean
    /** Rich-text messages (title + body). */
    richText: boolean
    /** Inbound images are downloaded to local files (`imagePaths`). */
    images: boolean
    /**
     * Outbound FILE delivery (`sendFile`), used to hand an approval reviewer the
     * artifacts (specification, test design) a card only summarises. Optional so
     * third-party adapters keep compiling; absent means "not supported".
     */
    files?: boolean
    /** The platform delivers inbound events while `connected`. */
    inbound: boolean
}

/** What the channel adapter reports about itself. */
export interface ChannelDescriptor {
    /** Short machine name; doubles as the tool-name prefix. */
    name: string
    /** Human label used in prompts and user turns, e.g. `飞书`. */
    label: string
    capabilities: ChannelCapabilities
}

/** Chunk of prompt guidance attached to one channel's system-prompt section. */
export interface PromptExtraLine {
    /** When true, the line appears only for the given channel name. */
    channels?: string[]
    text: string
}

/** Auth / permission introspection surface (per channel + project). */
export interface AuthState {
    ok: boolean
    /** Permission mode in effect: `auto` | `manual`. */
    mode: string
    allowlist: string[]
    activeChat: string
    p2pChat: string
    listenerRole: string
    listenerConnected: boolean
    pendingQuestions: string[]
    error?: string
}

// ---------------------------------------------------------------------------
// message scoring → model routing
// ---------------------------------------------------------------------------

/** Complexity tier a message falls into, derived from its score. */
export type ScoreLevel = 'low' | 'medium' | 'high'

/** One scoring verdict for an inbound message. */
export interface ScoreResult {
    /** 0..1 complexity score. */
    score: number
    /** Tier derived from the configured thresholds. */
    level: ScoreLevel
    /** Execution model chosen for this tier (absent = host default). */
    model?: string
    provider?: string
    reasoningEffort?: string
    /** Short human-readable justification. */
    reasoning?: string
    /** Which scorer produced this verdict. */
    source: 'rule' | 'model' | 'fallback'
}

/** Context handed to the followup hook / harness bridge for one wakeup. */
export interface FollowupContext {
    /** Extra plugin context appended to the agent turn. */
    note?: string
    /** Scoring verdict (drives the model override + turn annotation). */
    score?: ScoreResult
}
