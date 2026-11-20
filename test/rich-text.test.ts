/**
 * Inbound rich text: a Feishu `post` payload must reach consumers as a
 * normalized structure (`InboundMessage.rich`) instead of forcing every plugin
 * to parse the platform's private JSON. The flattened `text` is untouched, so
 * this file also pins backward compatibility with `parseContent`.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { FeishuChannel, parseContent, parseRichContent } from '../src/adapters/feishu.js'
import type { InboundMessage } from '../src/types.js'
import type { RichContent, RichSpan, RichSpanType } from '../src/index.js'

const POST = {
    title: '周报',
    content: [
        [{ tag: 'text', text: '本周完成：' }, { tag: 'text', text: '登录改造', style: ['bold'] }],
        [{ tag: 'a', text: '设计稿', href: 'https://x.cn/doc/1' }, { tag: 'at', user_id: 'ou_boss', user_name: '老板' }],
        [{ tag: 'img', image_key: 'img_1' }],
        [{ tag: 'code_block', language: 'TS', text: 'const a = 1' }],
        [
            { tag: 'text', text: '斜体', style: ['italic'] },
            { tag: 'text', text: '删除线', style: ['strikethrough'] },
            { tag: 'text', text: '下划线', style: ['underline'] },
            { tag: 'emotion', emoji_type: 'SMILE' },
            { tag: 'hr' },
        ],
    ],
}

/** One `im.message.receive_v1` event body (only the fields normalizeReceive reads). */
function receiveEvent(messageType: string, content: string): Record<string, unknown> {
    return {
        message: {
            message_id: 'om_rich_1',
            chat_id: 'oc_1',
            chat_type: 'p2p',
            message_type: messageType,
            content,
            create_time: '1',
        },
        sender: { sender_id: { open_id: 'ou_sender' } },
    }
}

/** The adapter is driven directly (same approach as attachments.test.ts). */
function normalize(ch: FeishuChannel, data: Record<string, unknown>): Promise<InboundMessage> {
    return (ch as unknown as { normalizeReceive: (d: Record<string, unknown>) => Promise<InboundMessage> })
        .normalizeReceive(data)
}

test('parseRichContent: title, paragraph grouping and inline span semantics', () => {
    const rich = parseRichContent(JSON.stringify(POST))
    assert.ok(rich)
    assert.equal(rich.title, '周报')
    assert.equal(rich.blocks.length, 5, 'one block per original paragraph')

    assert.deepEqual(rich.blocks[0], [
        { type: 'text', text: '本周完成：', raw: POST.content[0][0] },
        { type: 'bold', text: '登录改造', raw: POST.content[0][1] },
    ])
    assert.deepEqual(rich.blocks[1], [
        { type: 'link', text: '设计稿', href: 'https://x.cn/doc/1', raw: POST.content[1][0] },
        {
            type: 'mention',
            mentionId: 'ou_boss',
            mentionName: '老板',
            text: '老板',
            raw: POST.content[1][1],
        },
    ])
    assert.deepEqual(rich.blocks[2], [{ type: 'image', imageKey: 'img_1', raw: POST.content[2][0] }])
    assert.deepEqual(rich.blocks[3], [{
        type: 'code_block',
        language: 'TS',
        text: 'const a = 1',
        raw: POST.content[3][0],
    }])
    assert.deepEqual(rich.blocks[4], [
        { type: 'italic', text: '斜体', raw: POST.content[4][0] },
        { type: 'strike', text: '删除线', raw: POST.content[4][1] },
        { type: 'underline', text: '下划线', raw: POST.content[4][2] },
        { type: 'emotion', text: 'SMILE', raw: POST.content[4][3] },
        { type: 'hr', raw: POST.content[4][4] },
    ])

    // Unknown segments degrade to text instead of disappearing; their seg is kept on raw.
    const unknown = parseRichContent(JSON.stringify({ content: [[{ tag: 'button', text: 'x' }]] }))
    assert.deepEqual(unknown!.blocks[0], [{ type: 'text', text: 'button', raw: { tag: 'button', text: 'x' } }])

    // Backward compatibility: the flattened output is byte-identical to before.
    assert.equal(
        parseContent('post', JSON.stringify(POST)),
        '周报 本周完成： 登录改造 https://x.cn/doc/1 斜体 删除线 下划线'
    )
})

test('parseRichContent: image spans use img order for local paths and never invent one', () => {
    const raw = JSON.stringify({
        content: [
            [{ tag: 'img', image_key: 'img_a' }, { tag: 'text', text: '中间' }],
            [{ tag: 'img', image_key: 'img_b' }, { tag: 'img', image_key: 'img_c' }],
        ],
    })
    // '' is the adapter's placeholder for a failed download.
    const rich = parseRichContent(raw, ['/media/0.png', '', '/media/2.png'])
    // raw is the original seg: the local `path` is derived, never written into it.
    assert.deepEqual(rich!.blocks[0][0], {
        type: 'image',
        imageKey: 'img_a',
        path: '/media/0.png',
        raw: { tag: 'img', image_key: 'img_a' },
    })
    assert.deepEqual(rich!.blocks[1][0], {
        type: 'image',
        imageKey: 'img_b',
        raw: { tag: 'img', image_key: 'img_b' },
    }, 'failed download: key only')
    assert.deepEqual(rich!.blocks[1][1], {
        type: 'image',
        imageKey: 'img_c',
        path: '/media/2.png',
        raw: { tag: 'img', image_key: 'img_c' },
    })

    // No image mapping at all → no local path anywhere.
    const noPaths = parseRichContent(raw)
    assert.equal(noPaths!.blocks[0][0].path, undefined)
    assert.equal(noPaths!.blocks[1][1].path, undefined)
})

test('parseRichContent: malformed or non-array content never throws', () => {
    assert.equal(parseRichContent('not json'), undefined)
    assert.equal(parseRichContent('"just a string"'), undefined)
    assert.equal(parseRichContent('null'), undefined)
    assert.equal(parseRichContent(JSON.stringify({ content: 'oops' })), undefined)
    assert.deepEqual(parseRichContent(JSON.stringify({ title: '只有标题', content: 42 })), { title: '只有标题', blocks: [] })
    assert.equal(parseRichContent(JSON.stringify({ content: [] })), undefined)

    // Malformed segments are skipped; their well-formed siblings survive.
    const mixed = parseRichContent(JSON.stringify({ content: [[null, 'x', { tag: 'text', text: 'ok' }]] }))
    assert.deepEqual(mixed!.blocks, [[{ type: 'text', text: 'ok', raw: { tag: 'text', text: 'ok' } }]])

    // The localized wrapper used by the send side is understood too.
    const localized = parseRichContent(JSON.stringify({
        zh_cn: { title: '本地化', content: [[{ tag: 'text', text: '内容' }]] },
    }))
    assert.equal(localized!.title, '本地化')
    assert.deepEqual(localized!.blocks[0], [{ type: 'text', text: '内容', raw: { tag: 'text', text: '内容' } }])
})

test('feishu post: rich image paths point at the downloaded local files', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-rich-'))
    const ch = new FeishuChannel({ mediaDir: dir, mediaRetentionDays: 7, timeoutMs: 1000 } as never)
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])
    ;(ch as unknown as { apiClient: unknown }).apiClient = { request: async () => png }

    const msg = await normalize(ch, receiveEvent('post', JSON.stringify({
        title: '图',
        content: [[{ tag: 'img', image_key: 'img_1' }], [{ tag: 'img', image_key: 'img_2' }]],
    })))

    assert.equal(msg.rich?.title, '图')
    assert.equal(msg.imagePaths?.length, 2)
    const images = msg.rich!.blocks.flat() as RichSpan[]
    assert.equal(images.length, 2)
    assert.equal(images[0].imageKey, 'img_1')
    assert.equal(images[0].path, msg.imagePaths![0])
    assert.deepEqual(images[0].raw, { tag: 'img', image_key: 'img_1' }, 'raw keeps the platform seg')
    assert.equal(images[1].imageKey, 'img_2')
    assert.equal(images[1].path, msg.imagePaths![1])
    assert.deepEqual(images[1].raw, { tag: 'img', image_key: 'img_2' })
    assert.ok(fs.existsSync(images[0].path!), 'downloaded image exists on disk')
})

test('parseRichContent: every span carries the original seg on raw', () => {
    const rich = parseRichContent(JSON.stringify(POST))!
    const spans = rich.blocks.flat()
    const segs = POST.content.flat()
    assert.equal(spans.length, segs.length, 'one span per original seg')
    for (let i = 0; i < segs.length; i += 1) {
        assert.deepEqual(spans[i].raw, segs[i], `span ${i} (${spans[i].type}) keeps its seg on raw`)
    }

    // Platform fields the normalized mapping does not model stay readable via raw.
    assert.deepEqual((rich.blocks[0][1].raw as { style?: string[] }).style, ['bold'])
    assert.deepEqual((rich.blocks[4][0].raw as { style?: string[] }).style, ['italic'])
    assert.deepEqual((rich.blocks[4][1].raw as { style?: string[] }).style, ['strikethrough'])
    assert.deepEqual((rich.blocks[4][2].raw as { style?: string[] }).style, ['underline'])
    assert.equal((rich.blocks[1][0].raw as { href?: string }).href, 'https://x.cn/doc/1')
    assert.equal((rich.blocks[1][1].raw as { user_id?: string }).user_id, 'ou_boss')
    assert.equal((rich.blocks[1][1].raw as { user_name?: string }).user_name, '老板')
    assert.equal((rich.blocks[2][0].raw as { image_key?: string }).image_key, 'img_1')
    assert.equal((rich.blocks[3][0].raw as { language?: string }).language, 'TS')
    assert.equal((rich.blocks[4][3].raw as { emoji_type?: string }).emoji_type, 'SMILE')
    assert.deepEqual(rich.blocks[4][4].raw, { tag: 'hr' })

    // raw is a snapshot: mutating it must not rewrite the normalized span.
    ;(rich.blocks[0][0].raw as Record<string, unknown>).text = '被改'
    assert.equal(rich.blocks[0][0].text, '本周完成：')
})

test('parseRichContent: unknown tag degrades to text and keeps custom fields on raw', () => {
    const seg = { tag: 'unknown_x', text: '自定义', foo: 'bar', nested: { a: 1 } }
    const rich = parseRichContent(JSON.stringify({ content: [[seg]] }))!
    const span = rich.blocks[0][0]
    assert.equal(span.type, 'text')
    assert.equal(span.text, 'unknown_x', 'an unknown span keeps its tag as visible text')
    assert.deepEqual(span.raw, seg)
    assert.equal((span.raw as Record<string, unknown>).foo, 'bar', 'custom fields survive on raw')
    assert.deepEqual((span.raw as { nested?: unknown }).nested, { a: 1 })
})

test('normalizeReceive: rich is post-only; text/image messages keep their old shape', async () => {
    const ch = new FeishuChannel()

    const post = await normalize(ch, receiveEvent('post', JSON.stringify(POST)))
    assert.ok(post.rich, 'post carries the structure')
    assert.equal(
        post.text,
        '周报 本周完成： 登录改造 https://x.cn/doc/1 斜体 删除线 下划线',
        'flattened text is unchanged'
    )

    const text = await normalize(ch, receiveEvent('text', JSON.stringify({ text: '你好' })))
    assert.equal(text.text, '你好')
    assert.equal(text.rich, undefined)
    assert.equal('rich' in text, false, 'the optional field is absent, not undefined-valued')

    const image = await normalize(ch, receiveEvent('image', JSON.stringify({ image_key: 'img_1' })))
    assert.equal(image.rich, undefined)
    assert.equal('rich' in image, false)

    // A post whose image never downloaded keeps imageKey only.
    const offline = await normalize(ch, receiveEvent('post', JSON.stringify({
        content: [[{ tag: 'img', image_key: 'img_x' }]],
    })))
    assert.deepEqual(offline.rich!.blocks[0][0], {
        type: 'image',
        imageKey: 'img_x',
        raw: { tag: 'img', image_key: 'img_x' },
    })
    assert.deepEqual(offline.imagePaths, [])
})

test('rich contracts are importable from the package root (type-only)', () => {
    // `RichContent` / `RichSpan` / `RichSpanType` come from `../src/index.js`
    // (the package root), not from the internal `types.js` path — consumers must
    // be able to write `import type { RichContent } from 'dsh-chat-interaction'`.
    // `import type` is erased at compile time, so this adds no runtime export:
    // the assertions below only inspect a plain object.
    const bold: RichSpan = { type: 'bold', text: '登录改造' }
    const spanType: RichSpanType = bold.type
    const content: RichContent = {
        title: '周报',
        blocks: [
            [bold, { type: 'link', text: '设计稿', href: 'https://x.cn/doc/1' }],
            [{ type: 'image', imageKey: 'img_1', path: '/tmp/img_1.png' }],
        ],
    }

    assert.equal(spanType, 'bold', 'RichSpanType is the span discriminator')
    assert.equal(content.title, '周报')
    assert.equal(content.blocks.length, 2)
    assert.deepEqual(content.blocks[0]!.map((s) => s.type), ['bold', 'link'])
    assert.equal(content.blocks[1]![0]!.imageKey, 'img_1')
})
