/**
 * 状态作用域审计：凡是"按项目生效"的状态都必须落在项目里。
 *
 * 背景（真实缺陷）：凭据、active chat、审批人、账本、媒体、任务标记都是项目级，
 * 但历史上租约、卡片存档、待答问题、全局 active chat 回退散落在 `~/.dsh`。
 * 这些断言把"项目级"钉住，防止回退。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { dshHome, projStateDir, statePaths, writeActiveChat } from '../src/state.js'

test('cards / media / 审批账本 / 权限模式都落在项目目录内', () => {
    const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-scope-'))
    const p = statePaths('feishu', proj)
    const inside = (f: string) => f.startsWith(projStateDir(proj) + path.sep)
    for (const key of ['activeChat', 'p2pChat', 'modeFile', 'allowlist', 'approvers', 'approvalLedger', 'cardStore', 'mediaDir', 'taskActiveDir'] as const) {
        assert.ok(inside(p[key]), `${key} 必须在项目内，实际 ${p[key]}`)
    }
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
