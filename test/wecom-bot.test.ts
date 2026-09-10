/**
 * WeCom smart-bot (智能机器人 WS long-connection) adapter tests.
 * Uses an injected fake SDK — no network, no real credentials.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { WeComBotChannel, resolveWeComBotCreds } from '../src/adapters/wecom-bot.js'
import type { AiBotFrameLike, AiBotSdkLike } from '../src/adapters/wecom-bot.js'
import type { InboundMessage } from '../src/types.js'

/** Fake official SDK: records sends, lets tests push frames. */
function makeFakeSdk() {
    const handlers = new Map<string, Array<(frame: AiBotFrameLike) => unknown>>()
    const sent: Array<{ chatId: string; body: Record<string, unknown> }> = []
    let connected = 0
    let disconnected = 0
    const client = {
        on(event: string, listener: (frame: AiBotFrameLike) => unknown) {
            const list = handlers.get(event) || []
            list.push(listener)
            handlers.set(event, list)
            return undefined
        },
        connect() {
            connected += 1
            return undefined
        },
        disconnect() {
            disconnected += 1
            return undefined
        },
        async sendMessage(chatid: string, body: Record<string, unknown>) {
            sent.push({ chatId: chatid, body })
            return { headers: { req_id: 'req-' + sent.length } }
        },
        async downloadFile(_url: string, _aesKey?: string) {
            return { buffer: Buffer.from('fake-image-bytes'), filename: 'pic.png' }
        },
    }
    const sdk: AiBotSdkLike = {
        WSClient: function WSClient() {
            return client
        } as unknown as AiBotSdkLike['WSClient'],
    }
    const emit = (event: string, frame: AiBotFrameLike) => {
        for (const h of handlers.get(event) || []) h(frame)
    }
    return { sdk, emit, sent, stats: () => ({ connected, disconnected }) }
}

function setup(cfgOver: Record<string, unknown> = {}) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-aibot-'))
    const fake = makeFakeSdk()
    const ch = new WeComBotChannel({
        botId: 'bot-123456',
        secret: 'sec-abcdef',
        mediaDir: path.join(tmp, 'media'),
        sdk: fake.sdk,
        ...cfgOver,
    })
    const received: InboundMessage[] = []
    ch.setInboundHandler((m) => { received.push(m) })
    return { tmp, fake, ch, received }
}

const flush = () => new Promise((r) => setTimeout(r, 5))

test('connect() builds the official WSClient with bot credentials and connects', async () => {
    const { fake, ch } = setup()
    const st = await ch.connect()
    assert.equal(st.ok, true)
    assert.equal(st.connected, true)
    assert.equal(fake.stats().connected, 1)
    assert.equal(ch.status().connected, true)
    const st2 = await ch.disconnect()
    assert.equal(st2.connected, false)
    assert.equal(fake.stats().disconnected, 1)
})

test('connect() without credentials fails with the full resolution hint', async () => {
    const ch = new WeComBotChannel({ sdk: makeFakeSdk().sdk })
    const st = await ch.connect()
    assert.equal(st.ok, false)
    assert.match(st.error || '', /WECOM_BOT_ID/)
})

test('inbound text from a group chat → InboundMessage with the group chatid', async () => {
    const { fake, ch, received } = setup()
    await ch.connect()
    fake.emit('message', {
        headers: { req_id: 'r1' },
        body: {
            msgid: 'msg-1',
            aibotid: 'bot-123456',
            chatid: 'wr-group-1',
            chattype: 'group',
            from: { userid: 'zhangsan' },
            msgtype: 'text',
            text: { content: '帮我看看最近的提交' },
            create_time: 1700000000,
        },
    })
    await flush()
    assert.equal(received.length, 1)
    const m = received[0]
    assert.equal(m.channel, 'wecom_bot')
    assert.equal(m.chatId, 'wr-group-1')
    assert.equal(m.chatType, 'group')
    assert.equal(m.messageId, 'msg-1')
    assert.equal(m.text, '帮我看看最近的提交')
    assert.equal(m.senderId, 'zhangsan')
})

test('single chat has no chatid → addressed by the sender userid', async () => {
    const { fake, ch, received } = setup()
    await ch.connect()
    fake.emit('message', {
        body: { msgid: 'msg-2', chattype: 'single', from: { userid: 'lisi' }, msgtype: 'text', text: { content: '你好' } },
    })
    await flush()
    assert.equal(received[0].chatId, 'lisi')
    assert.equal(received[0].chatType, 'p2p')
})

test('template_card_event → card-action message carrying event_key', async () => {
    const { fake, ch, received } = setup()
    await ch.connect()
    fake.emit('event.template_card_event', {
        body: {
            msgid: 'evt-1',
            chattype: 'group',
            chatid: 'wr-group-1',
            from: { userid: 'zhangsan' },
            msgtype: 'event',
            event: { event_key: 'A', task_id: 'task_1' },
        },
    })
    await flush()
    assert.equal(received.length, 1)
    assert.equal(received[0].isCardAction, true)
    assert.equal(received[0].text, 'A')
    assert.equal(received[0].chatId, 'wr-group-1')
})

test('enter_chat / feedback_event are not agent turns', async () => {
    const { fake, ch, received } = setup()
    await ch.connect()
    fake.emit('event.enter_chat', { body: { msgid: 'e1', chattype: 'single', from: { userid: 'u1' }, msgtype: 'event' } })
    fake.emit('event.feedback_event', { body: { msgid: 'e2', chattype: 'single', from: { userid: 'u1' }, msgtype: 'event' } })
    await flush()
    assert.equal(received.length, 0)
})

test('inbound image is downloaded+decrypted to a local file', async () => {
    const { fake, ch, received } = setup()
    await ch.connect()
    fake.emit('message', {
        body: {
            msgid: 'msg-img',
            chattype: 'single',
            from: { userid: 'u1' },
            msgtype: 'image',
            image: { url: 'https://x/enc', aeskey: 'k' },
        },
    })
    await flush()
    const m = received[0]
    assert.equal(m.text, '[图片]')
    assert.equal(m.imagePaths!.length, 1)
    assert.ok(fs.existsSync(m.imagePaths![0]), 'image written to disk')
})

test('sendText uses the text frame; sendRichText/sendCard use markdown/template_card', async () => {
    const { fake, ch } = setup()
    await ch.connect()
    assert.equal((await ch.sendText('wr-g', 'hi')).ok, true)
    assert.deepEqual(fake.sent[0].body, { msgtype: 'text', text: { content: 'hi' } })

    await ch.sendRichText('wr-g', '标题', '正文')
    assert.equal((fake.sent[1].body as { msgtype: string }).msgtype, 'markdown')

    const card = await ch.sendCard('wr-g', {
        title: '收尾提交方式',
        body: '有未推送改动',
        buttons: ['A|提交+推送+部署|primary', 'D|暂不提交'],
    })
    assert.equal(card.ok, true)
    const tc = fake.sent[2].body as { msgtype: string; template_card: { card_type: string; task_id: string; button_list: Array<{ key: string }> } }
    assert.equal(tc.msgtype, 'template_card')
    assert.equal(tc.template_card.card_type, 'button_interaction')
    assert.equal(tc.template_card.button_list[0].key, 'A')
    assert.ok(tc.template_card.task_id)
})

test('sending without an explicit connect() lazily builds and connects the client', async () => {
    const { fake, ch } = setup()
    const r = await ch.sendText('wr-g', 'lazy')
    assert.equal(r.ok, true)
    assert.equal(fake.stats().connected, 1, 'client connected on demand')
})

test('resolveWeComBotCreds: config → wecom-bot.json → env', () => {
    const saved = { id: process.env.WECOM_BOT_ID, sec: process.env.WECOM_BOT_SECRET, home: process.env.DSH_HOME }
    delete process.env.WECOM_BOT_ID
    delete process.env.WECOM_BOT_SECRET
    try {
        const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-aibot-home-'))
        process.env.DSH_HOME = home
        fs.writeFileSync(path.join(home, 'wecom-bot.json'), JSON.stringify({ bot_id: 'bot-from-file', bot_secret: 'sec-from-file' }))
        const fromFile = resolveWeComBotCreds(os.tmpdir(), {})
        assert.equal(fromFile.botId, 'bot-from-file')
        assert.equal(fromFile.secret, 'sec-from-file')

        const fromCfg = resolveWeComBotCreds(os.tmpdir(), { botId: 'bot-cfg', secret: 'sec-cfg' })
        assert.equal(fromCfg.botId, 'bot-cfg', 'config wins')

        delete process.env.DSH_HOME
        process.env.WECOM_BOT_ID = 'bot-env'
        process.env.WECOM_BOT_SECRET = 'sec-env'
        const fromEnv = resolveWeComBotCreds(fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-aibot-empty-')), {})
        assert.equal(fromEnv.botId, 'bot-env')
        assert.equal(fromEnv.secret, 'sec-env')
    } finally {
        if (saved.id === undefined) delete process.env.WECOM_BOT_ID
        else process.env.WECOM_BOT_ID = saved.id
        if (saved.sec === undefined) delete process.env.WECOM_BOT_SECRET
        else process.env.WECOM_BOT_SECRET = saved.sec
        if (saved.home === undefined) delete process.env.DSH_HOME
        else process.env.DSH_HOME = saved.home
    }
})

test('plugin apply() registers the wecom_bot channel and its tool family', async () => {
    const { apply } = await import('../src/plugin.js')
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-aibot-plugin-'))
    const tools: Array<{ name: string }> = []
    const prompts: string[] = []
    const fakeAgent = {
        id: 'a1',
        followup: () => undefined,
        session: { id: 's1', header: { cwd: tmp }, events: [] },
    }
    const ctx = {
        roots: () => [fakeAgent],
        registerTool: (t: unknown) => { tools.push(t as { name: string }) },
        promptSection: (s: { name: string }) => { prompts.push(s.name) },
        onDispose: () => undefined,
    }
    const layer = apply(ctx as never, {
        logFile: path.join(tmp, 'layer.log'),
        scoring: { enabled: false },
        router: { enabled: false },
        channels: { wecom_bot: { botId: 'bot-1', secret: 'sec-1', sdk: makeFakeSdk().sdk } },
    } as never)
    assert.ok(layer)
    const names = tools.map((t) => t.name)
    for (const suffix of ['send_message', 'send_card', 'wait_reply', 'listener', 'auth_state']) {
        assert.ok(names.includes(`wecom_bot_${suffix}`), `wecom_bot_${suffix} registered`)
    }
    assert.ok(prompts.includes('wecom_bot-channel'))
    layer!.teardown()
})
