/**
 * Inbound attachments: non-image files must be downloaded to local paths and
 * exposed on the SAME InboundMessage that the agent and `api.onInbound`
 * observers receive. Before this existed a `file` message only produced raw
 * JSON text (Feishu) or `[文件消息]` (WeCom) and no consumer ever saw a path.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { FeishuChannel, extractFileRefs } from '../src/adapters/feishu.js'
import { WeComChannel } from '../src/adapters/wecom.js'
import { formatInbound } from '../src/prompt.js'
import { InteractionHub } from '../src/hub.js'
import type { InboundMessage } from '../src/types.js'

const CHANNEL = { name: 'probe', label: '探测', toolPrefix: 'probe', statePrefix: 'probe' } as never

test('extractFileRefs: file and non-image media are attachments, images are not', () => {
    const file = JSON.stringify({ file_key: 'fk_1', file_name: '报价单.pdf' })
    assert.deepEqual(extractFileRefs('file', file), [{ key: 'fk_1', name: '报价单.pdf' }])

    const pdfMedia = JSON.stringify({ file_key: 'fk_2', file_name: 'a.pdf', mime_type: 'application/pdf' })
    assert.deepEqual(extractFileRefs('media', pdfMedia), [{ key: 'fk_2', name: 'a.pdf', mime: 'application/pdf' }])

    const imageMedia = JSON.stringify({ file_key: 'fk_3', file_name: 'a.png', mime_type: 'image/png' })
    assert.deepEqual(extractFileRefs('media', imageMedia), [], 'images stay on extractImageRefs')

    assert.deepEqual(extractFileRefs('text', '{}'), [])
})

test('feishu: a file message is downloaded and exposed as files[0].path', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-file-'))
    const ch = new FeishuChannel({ mediaDir: dir, mediaRetentionDays: 7, timeoutMs: 1000 } as never)
    const body = Buffer.from('%PDF-1.4 fake pdf bytes')
    // The adapter is driven directly: only the HTTP client is faked.
    ;(ch as unknown as { apiClient: unknown }).apiClient = { request: async () => body }

    const msg = await (ch as unknown as { normalizeReceive: (d: unknown) => Promise<InboundMessage> }).normalizeReceive({
        message: {
            message_id: 'om_file_1',
            chat_id: 'oc_1',
            chat_type: 'p2p',
            message_type: 'file',
            content: JSON.stringify({ file_key: 'fk_1', file_name: '报价单.pdf' }),
        },
        sender: { sender_id: { open_id: 'ou_a' } },
    })

    assert.equal(msg.files?.length, 1)
    const file = msg.files![0]
    assert.ok(fs.existsSync(file.path), `file should exist at ${file.path}`)
    assert.deepEqual(fs.readFileSync(file.path), body)
    assert.equal(file.name, '报价单.pdf')
    assert.equal(file.size, body.length)
    assert.match(msg.text, /报价单\.pdf/)
    // images stay separate and empty
    assert.deepEqual(msg.imagePaths, [])
})

test('feishu: a failed file download keeps the message usable and reports fileErrors', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-file-'))
    const ch = new FeishuChannel({ mediaDir: dir, mediaRetentionDays: 7, timeoutMs: 1000 } as never)
    ;(ch as unknown as { apiClient: unknown }).apiClient = {
        request: async () => Buffer.from(JSON.stringify({ code: 400, msg: 'no permission' })),
    }
    const msg = await (ch as unknown as { normalizeReceive: (d: unknown) => Promise<InboundMessage> }).normalizeReceive({
        message: {
            message_id: 'om_file_2',
            chat_id: 'oc_1',
            chat_type: 'p2p',
            message_type: 'file',
            content: JSON.stringify({ file_key: 'fk_2', file_name: 'x.pdf' }),
        },
        sender: { sender_id: { open_id: 'ou_a' } },
    })
    assert.equal(msg.files, undefined)
    assert.ok(msg.fileErrors && msg.fileErrors.length === 1, 'failure is reported, not thrown')
})

test('wecom: a file message is downloaded through the media API', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-wecom-file-'))
    const fetchImpl = (async (url: string) => {
        if (url.includes('gettoken')) {
            return new Response(JSON.stringify({ errcode: 0, access_token: 'tok', expires_in: 7200 }))
        }
        return new Response(Buffer.from('wecom-file-bytes'))
    }) as unknown as typeof fetch
    const ch = new WeComChannel({
        corpId: 'corp',
        corpSecret: 'secret',
        agentId: '1',
        mediaDir: dir,
        mediaRetentionDays: 7,
        timeoutMs: 1000,
        fetchImpl,
    } as never)

    const msg = await ch.feed({
        MsgType: 'file',
        MediaId: 'media_1',
        FileName: '报告.pdf',
        FromUserName: 'u1',
        ChatId: 'c1',
        ChatType: 'single',
        MsgId: 'id_1',
    } as never)

    assert.ok(msg)
    assert.equal(msg!.files?.length, 1)
    assert.ok(fs.existsSync(msg!.files![0].path))
    assert.deepEqual(fs.readFileSync(msg!.files![0].path), Buffer.from('wecom-file-bytes'))
    assert.match(msg!.text, /报告\.pdf/)
})

test('onInbound observers receive the same attachment fields (images + files)', async () => {
    const hub = new InteractionHub({ ack: false })
    const seen: InboundMessage[] = []
    const off = hub.onInbound((m) => void seen.push(m))
    // dispatch requires a channel; use a minimal mock
    const ch = {
        name: 'probe',
        label: '探测',
        capabilities: { cards: false, richText: false, images: true, files: true, inbound: true },
        status: () => ({ connected: true }),
        sendText: async () => ({ ok: true }),
        sendRichText: async () => ({ ok: true }),
        sendCard: async () => ({ ok: true }),
        sendFile: async () => ({ ok: true }),
        connect: async () => ({ ok: true, connected: true }),
        disconnect: async () => ({ ok: true, connected: false }),
        setInboundHandler: () => undefined,
    } as never
    hub.addChannel(ch)
    const message: InboundMessage = {
        channel: 'probe',
        chatId: 'c1',
        chatType: 'p2p',
        messageId: 'm1',
        messageType: 'file',
        text: '[文件] a.pdf',
        imagePaths: ['/tmp/one.png'],
        files: [{ path: '/tmp/a.pdf', name: 'a.pdf', size: 3, kind: 'file' }],
    }
    await hub.dispatch(message)
    off()
    assert.equal(seen.length, 1)
    assert.equal(seen[0], message, 'observers receive the same object, not a stripped copy')
    assert.deepEqual(seen[0].imagePaths, ['/tmp/one.png'])
    assert.equal(seen[0].files?.[0].path, '/tmp/a.pdf')
})

test('formatInbound prints file paths for the agent', () => {
    const text = formatInbound(CHANNEL, {
        channel: 'feishu',
        chatId: 'oc_1',
        chatType: 'p2p',
        messageId: 'm2',
        messageType: 'file',
        text: '[文件] 报价单.pdf',
        files: [{ path: '/tmp/x/报价单.pdf', name: '报价单.pdf', size: 10, kind: 'file' }],
    })
    assert.match(text, /文件: \/tmp\/x\/报价单\.pdf/)
    assert.match(text, /文件名: 报价单\.pdf/)
    assert.doesNotMatch(text, /图片文件:/)
})
