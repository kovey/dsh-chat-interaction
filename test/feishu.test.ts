/**
 * Feishu adapter pure-function tests: content parsing, image-ref extraction,
 * doc links, and card rebuild from the card store.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
    buildUpdatedCard,
    extractDocIds,
    extractImageRefs,
    parseCardAction,
    parseContent,
    parseSenderIdentity,
    resolveFeishuCreds,
} from '../src/adapters/feishu.js'

test('parseContent flattens text and post messages', () => {
    assert.equal(parseContent('text', JSON.stringify({ text: '你好' })), '你好')
    assert.equal(parseContent('post', JSON.stringify({
        title: '日报',
        content: [[{ tag: 'text', text: '第一行' }], [{ tag: 'a', href: 'https://x.cn/doc/1' }]],
    })), '日报 第一行 https://x.cn/doc/1')
    assert.equal(parseContent('unknown', 'raw'), 'raw')
})

test('extractDocIds finds doc/wiki links', () => {
    const links = extractDocIds('看下 https://abc.feishu.cn/docx/AbCdEf123 这个文档')
    assert.equal(links.length, 1)
    assert.equal(links[0].docId, 'AbCdEf123')
})

test('extractImageRefs handles image / media / post contents', () => {
    assert.deepEqual(extractImageRefs('image', JSON.stringify({ image_key: 'img_1' })), [{ key: 'img_1', type: 'image', name: '' }])
    assert.deepEqual(extractImageRefs('media', JSON.stringify({ file_key: 'file_2', mime_type: 'image/png', file_name: 'a.png' })), [{ key: 'file_2', type: 'file', name: 'a.png' }])
    assert.deepEqual(extractImageRefs('post', JSON.stringify({ content: [[{ tag: 'img', image_key: 'img_3' }]] })), [{ key: 'img_3', type: 'image', name: '' }])
    assert.equal(extractImageRefs('text', '{}').length, 0)
})

test('buildUpdatedCard rebuilds the card with the clicked choice', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-cards-'))
    fs.writeFileSync(path.join(dir, 'om-1.json'), JSON.stringify({
        title: '收尾提交方式',
        body: '有未推送改动',
        buttons: [{ value: 'A', label: '提交+推送+部署' }, { value: 'D', label: '暂不提交' }],
    }))
    const card = buildUpdatedCard(dir, 'om-1', 'A') as {
        header: { title: { content: string } }
        elements: Array<{ tag: string; text?: { content: string } }>
    }
    assert.ok(card)
    assert.equal(card.header.title.content, '收尾提交方式')
    const chosen = card.elements.find((e) => e.tag === 'div' && e.text?.content.includes('已选择'))
    assert.ok(chosen, 'choice is reflected')
    assert.match(chosen!.text!.content, /提交\+推送\+部署/)
    // unknown message id → null
    assert.equal(buildUpdatedCard(dir, 'om-missing', 'A'), null)
})

test('resolveFeishuCreds falls back through the chain', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-creds-'))
    const env = resolveFeishuCreds(tmp, {})
    assert.equal(typeof env.appId, 'string') // env may be empty; just never throws
    // explicit config wins
    const cfg = resolveFeishuCreds(tmp, { appId: 'cli_a', appSecret: 'sec_b' })
    assert.equal(cfg.appId, 'cli_a')
    assert.equal(cfg.appSecret, 'sec_b')
})


test('parseSenderIdentity: open_id is the primary identity (user_id may be absent)', () => {
    assert.deepEqual(parseSenderIdentity({ open_id: 'ou_boss' }), {
        senderId: 'ou_boss',
        senderOpenId: 'ou_boss',
    })
    // user_id-only payloads still work (fallback + explicit field)
    assert.deepEqual(parseSenderIdentity({ user_id: 'u_1' }), {
        senderId: 'u_1',
        senderUserId: 'u_1',
    })
    // both present → open_id wins for senderId, both exposed
    assert.deepEqual(parseSenderIdentity({ open_id: 'ou_a', user_id: 'u_a' }), {
        senderId: 'ou_a',
        senderOpenId: 'ou_a',
        senderUserId: 'u_a',
    })
    assert.equal(parseSenderIdentity(undefined).senderId, '')
})

test('parseCardAction: operator.open_id alone yields a usable sender; chatType stays unknown', () => {
    const data = {
        event: {
            operator: { open_id: 'ou_boss' }, // Feishu card callbacks often omit user_id
            action: { value: { choice: 'approve:abc' } },
            context: { open_chat_id: 'oc_1', open_message_id: 'om_1' },
        },
    }
    const parsed = parseCardAction(data)
    assert.ok(parsed)
    assert.equal(parsed!.senderId, 'ou_boss')
    assert.equal(parsed!.senderOpenId, 'ou_boss')
    assert.equal(parsed!.senderUserId, undefined)
    assert.equal(parsed!.chatType, 'unknown', '卡片点击不得声称 p2p（群聊点击会污染 P2P 标记）')
    assert.equal(parsed!.chatId, 'oc_1')
    assert.equal(parsed!.choice, 'approve:abc')

    // missing chat/choice → null
    assert.equal(parseCardAction({ event: { operator: { open_id: 'x' } } }), null)
})

test('resolveFeishuCreds: chat-interaction/ wins over the legacy flat project file', () => {
    const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-creds-'))
    const pluginRoot = path.join(proj, '.dsh', 'chat-interaction')
    fs.mkdirSync(pluginRoot, { recursive: true })
    fs.writeFileSync(path.join(proj, '.dsh', 'feishu-app.json'), JSON.stringify({ app_id: 'cli_old', app_secret: 'old' }))
    fs.writeFileSync(path.join(pluginRoot, 'feishu-app.json'), JSON.stringify({ app_id: 'cli_new', app_secret: 'new' }))
    const creds = resolveFeishuCreds(proj, {} as never)
    assert.equal(creds.appId, 'cli_new')
    assert.equal(creds.appSecret, 'new')
})
