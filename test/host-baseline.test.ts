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

/** 本版声明的 DSH 基线（devDependencies 精确锁定它，编译与测试都跑在它上面）。 */
const BASELINE = '0.2.2-rc.4'
const DSH_PEERS = ['@deepseek-ai/dsh-agent', '@deepseek-ai/dsh-llm', '@deepseek-ai/dsh-tools']

/* ------------------------------------------------------------------ *
 * 极简 semver：只回答"这条 caret 范围是否包含这个版本"。
 *
 * 不引 semver 包：本仓库没有该依赖，为一条守卫测试加依赖不划算。
 * 与 npm 的判定对齐（已用 `npm view "<pkg>@<range>" version` 交叉验证）：
 *  - 稳定版落在 [下界, 下一个 minor) 内即满足；
 *  - **预发布版**还必须有一个**同 [major,minor,patch]** 且自身带预发布号的比较子，
 *    否则不算满足（semver spec #11：`^0.2.1-rc.1` 不含 `0.2.2-rc.4`）。
 * ------------------------------------------------------------------ */

type Semver = { major: number; minor: number; patch: number; pre: (string | number)[] }

function parseSemver(text: string): Semver {
    const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(text.trim())
    if (!m) throw new Error(`不是合法版本号：${text}`)
    const pre = m[4] ? m[4].split('.').map((id) => (/^\d+$/.test(id) ? Number(id) : id)) : []
    return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre }
}

function compareIdentifiers(a: string | number, b: string | number): number {
    if (typeof a === 'number' && typeof b === 'number') return a - b
    if (typeof a === 'number') return -1 // 数字标识符 < 字母标识符
    if (typeof b === 'number') return 1
    return a < b ? -1 : a > b ? 1 : 0
}

function compareVersions(a: Semver, b: Semver): number {
    const core = a.major - b.major || a.minor - b.minor || a.patch - b.patch
    if (core !== 0) return core
    if (a.pre.length === 0 && b.pre.length === 0) return 0
    if (a.pre.length === 0) return 1 // 同版本号：稳定版 > 预发布
    if (b.pre.length === 0) return -1
    for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
        const left = a.pre[i]
        const right = b.pre[i]
        if (left === undefined) return -1 // 前缀相同则短的更小（1.0.0-rc < 1.0.0-rc.1）
        if (right === undefined) return 1
        const cmp = compareIdentifiers(left, right)
        if (cmp !== 0) return cmp
    }
    return 0
}

function satisfiesCaret(version: string, range: string): boolean {
    const comparator = range.trim()
    if (!comparator.startsWith('^')) throw new Error(`本守卫只覆盖 caret 范围：${comparator}`)
    const lower = parseSemver(comparator.slice(1))
    const upper = lower.major === 0
        ? parseSemver(`0.${lower.minor + 1}.0-0`) // 0.x 的 caret 只放开 patch
        : parseSemver(`${lower.major + 1}.0.0-0`)
    const candidate = parseSemver(version)
    if (compareVersions(candidate, lower) < 0) return false
    if (compareVersions(candidate, upper) >= 0) return false
    if (candidate.pre.length > 0) {
        const sameTuple = lower.major === candidate.major && lower.minor === candidate.minor && lower.patch === candidate.patch
        if (!(lower.pre.length > 0 && sameTuple)) return false
    }
    return true
}

test('peer 只声明 0.2.0 线（v0.2.0 起不再支持更早的宿主）', () => {
    for (const name of DSH_PEERS) {
        assert.equal(pkg.peerDependencies[name], '^0.2.0-rc.1 || ^0.2.1-rc.1 || ^0.2.2-rc.1', `${name} 的 peer 必须显式覆盖 0.2.0-rc.x 与 0.2.1-rc.x`)
    }
    const joined = DSH_PEERS.map((n) => pkg.peerDependencies[n]).join(' ')
    assert.doesNotMatch(joined, /0\.1\.\d/, '不得再声明 0.1.x 线（本版明确不支持）')
    assert.equal(pkg.peerDependencies['@deepseek-ai/cordis'], '^4.0.2')
    assert.equal(pkg.devDependencies['@deepseek-ai/cordis'], '4.1.0')
})

test('peer 范围在语义上覆盖基线版本，且不覆盖已放弃的宿主线', () => {
    const range = pkg.peerDependencies['@deepseek-ai/dsh-agent']!
    const satisfies = (version: string): boolean => range.split('||').some((part) => satisfiesCaret(version, part))

    // 基线本身必须被自己声明的 peer 范围覆盖 —— 否则宿主装得进去、插件却被版本闸门拒绝。
    assert.ok(satisfies(BASELINE), `peer 范围 ${range} 必须覆盖基线 ${BASELINE}`)

    for (const version of ['0.2.0-rc.1', '0.2.0-rc.2', '0.2.1-rc.1', '0.2.1-rc.5', '0.2.2-rc.1', '0.2.2-rc.2', '0.2.2-rc.3', '0.2.2']) {
        assert.ok(satisfies(version), `peer 范围必须覆盖 ${version}`)
    }
    for (const version of ['0.1.5-rc.1', '0.1.7-rc.2', '0.1.8', '0.2.3-rc.1', '0.3.0-rc.1']) {
        assert.ok(!satisfies(version), `peer 范围不得覆盖 ${version}（0.1.x 已放弃；0.2.3/0.3.x 尚未核实）`)
    }

    // 预发布规则本身的回归：`^0.2.1-rc.1` 按 semver 不含 `0.2.2-rc.4`（跨 patch）。
    assert.ok(!satisfiesCaret('0.2.2-rc.4', '^0.2.1-rc.1'), 'semver #11：跨 patch 的预发布版不满足 caret 范围')
})

test('devDependencies 与声明的基线一致（编译与测试跑在该基线上）', () => {
    for (const name of [...DSH_PEERS, '@deepseek-ai/dsh-user-approval']) {
        assert.equal(pkg.devDependencies[name], BASELINE, `${name} 的 devDependency 必须精确锁定 ${BASELINE}`)
    }
})

test('README 声明了基线版本与卸载/旧线指引', () => {
    assert.match(readme, new RegExp(`v${BASELINE.replace(/\./g, '\\.')}`), 'README 顶部必须写明依赖基线')
    // Since v0.3.x the peer range covers the 0.2.0 / 0.2.1 / 0.2.2 lines; the old
    // "only 0.2.0 line" claim is no longer true and must not be asserted.
    assert.match(readme, /0\.2\.0 \/ 0\.2\.1 \/ 0\.2\.2/, 'README 必须说明 peer 覆盖的三条宿主线')
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

test('CHANGELOG 已收口当前版本；破坏性发布的历史记录仍保留', () => {
    assert.match(changelog, new RegExp(`## \\[${pkg.version.replace(/\./g, '\\.')}\\]`), `CHANGELOG 必须有 [${pkg.version}] 段落`)
    assert.doesNotMatch(changelog.split('\n')[0]!, /^## /, '文件必须以 # Changelog 标题开头')
    // 破坏性变更记录在 0.2.0 段（"只支持 0.2.0 线"那一次）；后续版本滚动不得丢失。
    // 注意切片要停在下一个版本标题，否则会读到后面版本的正文（旧断言的漏洞）。
    const start = changelog.indexOf('## [0.2.0]')
    assert.ok(start >= 0, 'CHANGELOG 必须保留 [0.2.0] 段落')
    const after = changelog.indexOf('\n## [', start + 1)
    const breaking = changelog.slice(start, after === -1 ? undefined : after)
    assert.match(breaking, /破坏性变更/)
    assert.match(breaking, /incompatible-version/)
})

test('UPGRADE 写明前置条件（宿主必须先到基线）与豁免机制', () => {
    assert.match(upgrade, /前置条件/, 'UPGRADE 必须先给前置条件')
    assert.match(upgrade, /version-exemptions/, '必须记录官方豁免命令（列表）')
    assert.match(upgrade, /allow-version[\s\S]{0,120}--accept-risk/, '必须记录 allow-version 的完整参数')
    assert.match(upgrade, /不继承/, '必须说明豁免不随升级继承')
    assert.match(upgrade, /dsh --profile <profile> --dump-config-schema|--dump-config-schema/, '自检应包含 schema dump')
})
