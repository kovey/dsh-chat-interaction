/**
 * WeCom adapter tests: XML parsing, message crypto round trip, feed()
 * normalization (text + template-card click routing via the task store).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { WeComChannel, parseWeComXml, wecomDecrypt, wecomSignature } from '../src/adapters/wecom.js'
import type { InboundMessage } from '../src/types.js'

const AES_KEY = crypto.randomBytes(32).toString('base64').slice(0, 43)
const TOKEN = 'test-token'

/** Mirror of the documented WeCom encrypt algorithm, for round-trip tests. */
function wecomEncrypt(aesKey: string, message: string, id: string): string {
    const key = Buffer.from(aesKey + '=', 'base64')
    const iv = key.subarray(0, 16)
    const msg = Buffer.from(message, 'utf8')
    const len = Buffer.alloc(4)
    len.writeUInt32BE(msg.length)
    const plain = Buffer.concat([crypto.randomBytes(16), len, msg, Buffer.from(id, 'utf8')])
    const padLen = 32 - (plain.length % 32)
    const padded = Buffer.concat([plain, Buffer.alloc(padLen, padLen)])
    const cipher = crypto.createCipheriv('aes-256-cbc', key, iv)
    cipher.setAutoPadding(false) // we pad manually, exactly like the platform
    return Buffer.concat([cipher.update(padded), cipher.final()]).toString('base64')
}

test('parseWeComXml handles CDATA and plain values', () => {
    const xml = '<xml><ToUserName><![CDATA[ww123]]></ToUserName><MsgId>456</MsgId><Content><![CDATA[hello <world>]]></Content></xml>'
    const out = parseWeComXml(xml)
    assert.equal(out.ToUserName, 'ww123')
    assert.equal(out.MsgId, '456')
    assert.equal(out.Content, 'hello <world>')
})

test('wecom crypto round trip: signature + decrypt', () => {
    const encrypt = wecomEncrypt(AES_KEY, '<xml><Content>hi</Content></xml>', 'ww-corp')
    const sig = wecomSignature(TOKEN, '1700000000', 'abc123', encrypt)
    assert.equal(sig, wecomSignature(TOKEN, '1700000000', 'abc123', encrypt)) // deterministic
    const { message, id } = wecomDecrypt(AES_KEY, encrypt)
    assert.equal(message, '<xml><Content>hi</Content></xml>')
    assert.equal(id, 'ww-corp')
})

test('feed() normalizes a text message to a p2p InboundMessage', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-wecom-'))
    const ch = new WeComChannel({ corpId: 'c', corpSecret: 's', taskStoreDir: path.join(dir, 'tasks'), mediaDir: path.join(dir, 'media') })
    const captured: { msg?: InboundMessage } = {}
    ch.setInboundHandler((m) => { captured.msg = m })

    const out = await ch.feed(
        '<xml><FromUserName><![CDATA[zhangsan]]></FromUserName><MsgType><![CDATA[text]]></MsgType>' +
        '<Content><![CDATA[帮我查个日志]]></Content><MsgId>1001</MsgId><ChatId><![CDATA[zhangsan]]></ChatId>' +
        '<ChatType><![CDATA[single]]></ChatType><CreateTime>1700000000</CreateTime></xml>'
    )
    assert.ok(out)
    assert.equal(out.channel, 'wecom')
    assert.equal(out.chatType, 'p2p')
    assert.equal(out.text, '帮我查个日志')
    assert.equal(out.messageId, '1001')
    assert.ok(captured.msg)
    assert.equal(captured.msg.chatId, 'zhangsan')
})

test('template_card_event routes back through the task store (no ChatId in event)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-wecom-'))
    const taskDir = path.join(dir, 'tasks')
    const ch = new WeComChannel({ corpId: 'c', corpSecret: 's', taskStoreDir: taskDir, mediaDir: path.join(dir, 'media') })
    const captured: { msg?: InboundMessage } = {}
    ch.setInboundHandler((m) => { captured.msg = m })

    // A card sent earlier: the adapter persisted task_id → {chatId, buttons}.
    fs.mkdirSync(taskDir, { recursive: true })
    fs.writeFileSync(path.join(taskDir, 'tsk-test.json'), JSON.stringify({
        chatId: 'wr-group-9',
        title: '收尾提交方式',
        body: '有未推送改动',
        buttons: [{ value: 'A', label: '提交+推送+部署' }, { value: 'D', label: '暂不提交' }],
    }))

    const out = await ch.feed(
        '<xml><ToUserName><![CDATA[ww-corp]]></ToUserName><FromUserName><![CDATA[zhangsan]]></FromUserName>' +
        '<CreateTime>1700000000</CreateTime><MsgType><![CDATA[event]]></MsgType>' +
        '<Event><![CDATA[template_card_event]]></Event><TaskId><![CDATA[tsk-test]]></TaskId>' +
        '<CardType><![CDATA[button_interaction]]></CardType><EventKey><![CDATA[A]]></EventKey></xml>'
    )
    assert.ok(out)
    assert.equal(out.isCardAction, true)
    assert.equal(out.chatId, 'wr-group-9')
    assert.equal(out.text, 'A')
    assert.ok(captured.msg)
    assert.equal(captured.msg.isCardAction, true)
})

test('unknown task_id is dropped without emitting', async () => {
    const ch = new WeComChannel({})
    let emitted = 0
    ch.setInboundHandler(() => { emitted += 1 })
    const out = await ch.feed(
        '<xml><Event><![CDATA[template_card_event]]></Event><TaskId><![CDATA[tsk-gone]]></TaskId><EventKey><![CDATA[A]]></EventKey></xml>'
    )
    assert.equal(out, null)
    assert.equal(emitted, 0)
})

test('connect without callback config reports the feed() mode', async () => {
    const ch = new WeComChannel({})
    const st = await ch.connect()
    assert.equal(st.ok, true)
    assert.equal(st.connected, false)
    assert.match(st.message || '', /feed\(\)/)
})
