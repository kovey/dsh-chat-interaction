/**
 * 状态作用域审计：凡是"按项目生效"的状态都必须落在项目里，并且统一放在
 * 插件自己的根目录 `<repo>/.dsh/chat-interaction/` 下。
 *
 * 背景（真实缺陷）：凭据、active chat、审批人、账本、媒体、任务标记都是项目级，
 * 但历史上租约、卡片存档、待答问题、全局 active chat 回退散落在 `~/.dsh`；
 * 后来这些又都平铺在 `<repo>/.dsh/` 根下，和工程套件的台账混在一起。
 * 这些断言把"项目级 + 插件自有子目录"钉住，防止回退。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { chatStateDir, dshHome, migrateLegacyState, projStateDir, statePaths, writeActiveChat } from '../src/state.js'

test('cards / media / 审批账本 / 权限模式都落在插件自有目录内', () => {
    const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-scope-'))
    const p = statePaths('feishu', proj)
    const inside = (f: string) => f.startsWith(chatStateDir(proj) + path.sep)
    for (const key of ['activeChat', 'p2pChat', 'modeFile', 'allowlist', 'approvers', 'approvalLedger', 'cardStore', 'mediaDir', 'taskActiveDir'] as const) {
        assert.ok(inside(p[key]), `${key} 必须在 ${chatStateDir(proj)} 内，实际 ${p[key]}`)
    }
    // the plugin root itself sits under the project's .dsh (and never under ~/.dsh)
    assert.equal(chatStateDir(proj), path.join(proj, '.dsh', 'chat-interaction'))
    assert.equal(p.proj, chatStateDir(proj))
})

test('active chat 只写项目内，不再写全局回退文件', () => {
    const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-scope-'))
    const p = statePaths('feishu', proj)
    const globalSlot = path.join(dshHome(), 'feishu-active-chat.txt')
    const existedBefore = fs.existsSync(globalSlot)
    writeActiveChat(p, 'oc_test', proj)
    assert.equal(fs.readFileSync(p.activeChat, 'utf8').trim(), 'oc_test')
    if (!existedBefore) assert.equal(fs.existsSync(globalSlot), false, '不得再写全局 active chat（多项目会互相覆盖）')
})

// ---------------------------------------------------------------------------
// legacy migration: old flat <repo>/.dsh/* → <repo>/.dsh/chat-interaction/
// ---------------------------------------------------------------------------

test('migration copies small state files into chat-interaction/ and keeps the originals', () => {
    const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-migrate-'))
    const legacy = projStateDir(proj)
    fs.mkdirSync(path.join(legacy, 'pending', 'feishu'), { recursive: true })
    fs.mkdirSync(path.join(legacy, 'chat-history', 'feishu'), { recursive: true })
    fs.writeFileSync(path.join(legacy, 'feishu-active-chat.txt'), 'oc_1')
    fs.writeFileSync(path.join(legacy, 'feishu-approvers.txt'), 'ou_boss\n')
    fs.writeFileSync(path.join(legacy, 'feishu-permission-mode.txt'), 'manual\n')
    fs.writeFileSync(path.join(legacy, 'feishu-approvals.jsonl'), '{"decision":"allow"}\n')
    fs.writeFileSync(path.join(legacy, 'feishu-app.json'), JSON.stringify({ app_id: 'cli_old' }))
    fs.writeFileSync(path.join(legacy, 'pending', 'feishu', 'oc_1.json'), '{"id":"oc_1"}')
    fs.writeFileSync(path.join(legacy, 'chat-history', 'feishu', 'oc_1.json'), '[]')

    const result = migrateLegacyState(proj)
    const target = chatStateDir(proj)
    assert.equal(result.target, target)
    assert.ok(result.copied >= 7, `expected the files to be copied, got ${result.copied}`)
    assert.equal(fs.readFileSync(path.join(target, 'feishu-active-chat.txt'), 'utf8'), 'oc_1')
    assert.equal(fs.readFileSync(path.join(target, 'feishu-approvers.txt'), 'utf8'), 'ou_boss\n')
    assert.equal(fs.readFileSync(path.join(target, 'pending', 'feishu', 'oc_1.json'), 'utf8'), '{"id":"oc_1"}')
    assert.equal(fs.readFileSync(path.join(target, 'chat-history', 'feishu', 'oc_1.json'), 'utf8'), '[]')
    // copy, never move
    assert.ok(fs.existsSync(path.join(legacy, 'feishu-active-chat.txt')), 'legacy file must remain')
})

test('migration is idempotent and never overwrites a newer file', () => {
    const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-migrate-'))
    const legacy = projStateDir(proj)
    const target = chatStateDir(proj)
    fs.mkdirSync(legacy, { recursive: true })
    fs.mkdirSync(target, { recursive: true })
    fs.writeFileSync(path.join(legacy, 'feishu-active-chat.txt'), 'old')
    fs.writeFileSync(path.join(target, 'feishu-active-chat.txt'), 'new')
    const result = migrateLegacyState(proj)
    assert.equal(result.copied, 0)
    assert.ok(result.skipped >= 1)
    assert.equal(fs.readFileSync(path.join(target, 'feishu-active-chat.txt'), 'utf8'), 'new')
    // second run is a no-op too
    const again = migrateLegacyState(proj)
    assert.equal(again.copied, 0)
})

test('migration leaves cards / media / task markers / leases behind', () => {
    const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-migrate-'))
    const legacy = projStateDir(proj)
    fs.mkdirSync(path.join(legacy, 'feishu-cards'), { recursive: true })
    fs.mkdirSync(path.join(legacy, 'feishu-media'), { recursive: true })
    fs.mkdirSync(path.join(legacy, 'feishu-task-active'), { recursive: true })
    fs.writeFileSync(path.join(legacy, 'feishu-cards', 'om_1.json'), '{}')
    fs.writeFileSync(path.join(legacy, 'feishu-media', 'img.png'), 'x')
    fs.writeFileSync(path.join(legacy, 'feishu-task-active', 'oc_1.json'), '{}')
    fs.writeFileSync(path.join(legacy, 'chat-interaction-lease-feishu-abc.json'), '{"pid":1}')
    migrateLegacyState(proj)
    const target = chatStateDir(proj)
    assert.equal(fs.existsSync(path.join(target, 'feishu-cards')), false)
    assert.equal(fs.existsSync(path.join(target, 'feishu-media')), false)
    assert.equal(fs.existsSync(path.join(target, 'feishu-task-active')), false)
    assert.equal(fs.existsSync(path.join(target, 'chat-interaction-lease-feishu-abc.json')), false)
})

test('migration without any legacy state is a harmless no-op', () => {
    const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-migrate-'))
    const result = migrateLegacyState(proj)
    assert.equal(result.copied, 0)
    assert.equal(fs.existsSync(chatStateDir(proj)), false)
})
