/**
 * WeCom credential-resolution tests: config → credsFile → project/home
 * wecom-app.json → env, field by field (mirrors the Feishu chain).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { resolveWeComCreds } from '../src/adapters/wecom.js'

const ENV_KEYS = ['WECOM_CORP_ID', 'WECOM_CORPID', 'WECOM_CORP_SECRET', 'WECOM_AGENT_ID', 'WECOM_TOKEN', 'WECOM_AES_KEY']
const DSH_ENV = ['DSH_HOME']

function withCleanEnv(fn: () => void) {
    const saved = new Map<string, string | undefined>()
    for (const k of [...ENV_KEYS, ...DSH_ENV]) {
        saved.set(k, process.env[k])
        delete process.env[k]
    }
    try {
        fn()
    } finally {
        for (const [k, v] of saved) {
            if (v === undefined) delete process.env[k]
            else process.env[k] = v
        }
    }
}

test('resolveWeComCreds: explicit config wins over everything', () => {
    withCleanEnv(() => {
        process.env.WECOM_CORP_ID = 'from-env'
        const c = resolveWeComCreds('/tmp', { corpId: 'from-config', corpSecret: 'sec' })
        assert.equal(c.corpId, 'from-config')
        assert.equal(c.corpSecret, 'sec')
    })
})

test('resolveWeComCreds: project wecom-app.json is read (snake_case + aliases)', () => {
    withCleanEnv(() => {
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-wecom-creds-'))
        fs.mkdirSync(path.join(tmp, '.dsh'), { recursive: true })
        fs.writeFileSync(path.join(tmp, '.dsh', 'wecom-app.json'), JSON.stringify({
            corp_id: 'ww-project',
            corp_secret: 'secret-project',
            agent_id: 1000002, // numeric agent id is accepted
            token: 'tok',
            aes_key: 'aes',
        }))
        const c = resolveWeComCreds(tmp, {})
        assert.equal(c.corpId, 'ww-project')
        assert.equal(c.corpSecret, 'secret-project')
        assert.equal(c.agentId, '1000002')
        assert.equal(c.token, 'tok')
        assert.equal(c.aesKey, 'aes')
    })
})

test('resolveWeComCreds: credsFile overrides the project file', () => {
    withCleanEnv(() => {
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-wecom-creds-'))
        fs.mkdirSync(path.join(tmp, '.dsh'), { recursive: true })
        fs.writeFileSync(path.join(tmp, '.dsh', 'wecom-app.json'), JSON.stringify({ corp_id: 'ww-project' }))
        const explicit = path.join(tmp, 'explicit.json')
        fs.writeFileSync(explicit, JSON.stringify({ corp_id: 'ww-explicit', token: 'tok-explicit' }))
        const c = resolveWeComCreds(tmp, { credsFile: explicit })
        assert.equal(c.corpId, 'ww-explicit', 'credsFile wins')
        assert.equal(c.token, 'tok-explicit')
    })
})

test('resolveWeComCreds: ~/.dsh/wecom-app.json via DSH_HOME, env fills the gaps', () => {
    withCleanEnv(() => {
        const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-wecom-home-'))
        fs.writeFileSync(path.join(home, 'wecom-app.json'), JSON.stringify({ corp_id: 'ww-home', corp_secret: 'sec-home' }))
        process.env.DSH_HOME = home
        process.env.WECOM_TOKEN = 'tok-env'
        process.env.WECOM_AES_KEY = 'aes-env'
        const c = resolveWeComCreds(os.tmpdir(), {})
        assert.equal(c.corpId, 'ww-home', 'home file provides corpId')
        assert.equal(c.corpSecret, 'sec-home')
        assert.equal(c.token, 'tok-env', 'env fills the missing fields')
        assert.equal(c.aesKey, 'aes-env')
    })
})

test('resolveWeComCreds: nothing configured → empty strings (no throw)', () => {
    withCleanEnv(() => {
        const c = resolveWeComCreds(os.tmpdir(), {})
        assert.deepEqual(c, { corpId: '', corpSecret: '', agentId: '', token: '', aesKey: '' })
    })
})
