/**
 * 宿主基线守卫：`package.json` 的声明与三份文档必须与**声明的 DSH 基线**一致。
 *
 * 背景：这个仓库踩过两次同类问题 ——
 *   1) peer 里只写旧线（`^0.1.7-rc.1`），宿主 0.1.7-rc.2 的版本闸门虽然放行，
 *      但清单里读不出"适配了 rc.2"；
 *   2) 发版时忘记同步 README / UPGRADE / CHANGELOG 的版本引用。
 * 这些断言就是为它们准备的：任何一处漏改都会让测试失败（可证伪）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** 向上找到本包的根（源码 test/ 与产物 dist-test/test/ 深度不同）。 */
function findRoot(start: string): string {
    let dir = start
    for (let i = 0; i < 5; i++) {
        const pkg = path.join(dir, 'package.json')
        if (fs.existsSync(pkg)) {
            try {
                if ((JSON.parse(fs.readFileSync(pkg, 'utf8')) as { name?: string }).name === 'dsh-chat-interaction') return dir
            } catch { /* keep walking */ }
        }
        dir = path.dirname(dir)
    }
    throw new Error('未找到包根')
}

const root = findRoot(path.dirname(fileURLToPath(import.meta.url)))
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as {
    version: string
    peerDependencies: Record<string, string>
    devDependencies: Record<string, string>
}
const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8')
const changelog = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8')
const upgrade = fs.readFileSync(path.join(root, 'UPGRADE.md'), 'utf8')

/** 本版声明的 DSH 基线（peer 里唯一的一条 0.x 线）。 */
const BASELINE = '0.2.0-rc.2'
const DSH_PEERS = ['@deepseek-ai/dsh-agent', '@deepseek-ai/dsh-llm', '@deepseek-ai/dsh-tools']

test('peer 只声明 0.2.0 线（v0.2.0 起不再支持更早的宿主）', () => {
    for (const name of DSH_PEERS) {
        assert.equal(pkg.peerDependencies[name], '^0.2.0-rc.1 || ^0.2.0-rc.2', `${name} 的 peer 必须显式覆盖 rc.1 与 rc.2`)
    }
    const joined = DSH_PEERS.map((n) => pkg.peerDependencies[n]).join(' ')
    assert.doesNotMatch(joined, /0\.1\.\d/, '不得再声明 0.1.x 线（本版明确不支持）')
    assert.equal(pkg.peerDependencies['@deepseek-ai/cordis'], '^4.0.2')
})

test('devDependencies 与声明的基线一致（编译与测试跑在该基线上）', () => {
    for (const name of [...DSH_PEERS, '@deepseek-ai/dsh-user-approval']) {
        assert.equal(pkg.devDependencies[name], BASELINE, `${name} 的 devDependency 必须精确锁定 ${BASELINE}`)
    }
})

test('README 声明了基线版本与卸载/旧线指引', () => {
    assert.match(readme, new RegExp(`v${BASELINE.replace(/\./g, '\\.')}`), 'README 顶部必须写明依赖基线')
    assert.match(readme, /只支持 0\.2\.0 线|唯一支持线/, 'README 必须说明本版只支持 0.2.0 线')
    assert.match(readme, /v0\.1\.8/, 'README 必须指向旧宿主可用的最后版本线')
})

test('README / UPGRADE 的安装命令 pin 到当前版本', () => {
    for (const [name, text] of [['README.md', readme], ['UPGRADE.md', upgrade]] as const) {
        assert.match(
            text,
            new RegExp(`#v${pkg.version.replace(/\./g, '\\.')}`),
            `${name} 里的 pin 示例必须指向当前版本 v${pkg.version}（发版时容易漏改）`
        )
    }
})

test('CHANGELOG 已收口当前版本，且记录了破坏性变更', () => {
    assert.match(changelog, new RegExp(`## \\[${pkg.version.replace(/\./g, '\\.')}\\]`), `CHANGELOG 必须有 [${pkg.version}] 段落`)
    assert.doesNotMatch(changelog.split('\n')[0]!, /^## /, '文件必须以 # Changelog 标题开头')
    const section = changelog.slice(changelog.indexOf(`## [${pkg.version}]`))
    assert.match(section, /破坏性变更/, '0.2.0 是破坏性发布：必须先写破坏性变更')
    assert.match(section, /incompatible-version/, '破坏性变更要写明宿主侧的表现（错误码）')
})

test('UPGRADE 写明前置条件（宿主必须先到基线）与豁免机制', () => {
    assert.match(upgrade, /前置条件/, 'UPGRADE 必须先给前置条件')
    assert.match(upgrade, /version-exemptions/, '必须记录官方豁免命令（列表）')
    assert.match(upgrade, /allow-version[\s\S]{0,120}--accept-risk/, '必须记录 allow-version 的完整参数')
    assert.match(upgrade, /不继承/, '必须说明豁免不随升级继承')
    assert.match(upgrade, /dsh --profile <profile> --dump-config-schema|--dump-config-schema/, '自检应包含 schema dump')
})
