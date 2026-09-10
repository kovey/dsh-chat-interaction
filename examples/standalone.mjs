/**
 * Standalone usage — no cordis, no SDKs, no network.
 * Build first (`npm run build`), then:  node examples/standalone.mjs
 *
 * Demonstrates:
 *  - hub + WeCom adapter with feed() push (external middleware integration)
 *  - a custom channel (simulated "钉钉") in ~15 lines
 *  - wait_reply consuming the next message instead of waking the agent
 *  - card sending with the "value|label|type" button dialect
 */
import { InteractionHub, WeComChannel, BaseChannel } from '../dist/index.js'

// ---- a fake agent: the harness side -------------------------------
const agent = {
    followups: [],
    followup(text) {
        this.followups.push(text)
        console.log('\n🤖 agent turn:\n' + text + '\n')
    },
}

// ---- the layer ------------------------------------------------------
const hub = new InteractionHub({
    spoolFile: '/tmp/chat-interaction-example-spool.jsonl',
    // 打分 → 模型路由: 真实用法是 RuleScorer/ModelScorer 或 apply() 的 scoring 配置
    score: async (msg) => {
        const hard = /(需求|报错|开发|实现)/.test(msg.text)
        return {
            score: hard ? 0.9 : 0.2,
            level: hard ? 'high' : 'low',
            model: hard ? 'deepseek-reasoner' : 'deepseek-chat',
            reasoning: hard ? '示例: 复杂任务' : '示例: 简单查询',
            source: 'rule',
        }
    },
    onFollowup: (msg, ctx) => {
        // 真实的 DSH 侧 = DshBridge.followup() → 应用 ctx.score 的模型覆盖 + agent.followup
        const label = msg.channel === 'wecom' ? '企业微信消息' : '钉钉消息'
        agent.followup(
            `[${label}] chat_id: ${msg.chatId}\n内容: ${msg.text}\n` +
            (ctx?.score ? `消息评分: ${ctx.score.score.toFixed(2)} (${ctx.score.level}) → 执行模型: ${ctx.score.model}\n` : '')
        )
        return true
    },
})

// ---- 渠道 1: 企业微信 (feed 模式, 无回调服务器) ---------------------
const wecom = new WeComChannel({ corpId: 'ww-demo', corpSecret: 'demo' })
hub.addChannel(wecom)

// ---- 渠道 2: 一个自定义渠道, ~15 行 --------------------------------
class DingChannel extends BaseChannel {
    name = 'ding'
    label = '钉钉'
    capabilities = { cards: false, richText: false, images: false, inbound: true }
    async connect() { this.setConnected(true); return { ok: true, connected: true } }
    async disconnect() { this.setConnected(false); return { ok: true, connected: false } }
    async sendText(chatId, text) { console.log(`📤 ding → ${chatId}: ${text}`); return { ok: true } }
}
hub.addChannel(new DingChannel())

// ---- 模拟企业微信平台推送 (解密后的事件 XML → feed) -----------------
await wecom.feed(
    '<xml><FromUserName><![CDATA[zhangsan]]></FromUserName><MsgType><![CDATA[text]]></MsgType>' +
    '<Content><![CDATA[帮我看看最近的提交]]></Content><MsgId>1001</MsgId>' +
    '<ChatId><![CDATA[zhangsan]]></ChatId><ChatType><![CDATA[single]]></ChatType></xml>'
)

// ---- wait_reply: agent 发问后阻塞等回复 (消费消息, 不再唤醒 agent) ----
const question = hub.waitReply('wecom', 'zhangsan', 10_000)
await wecom.feed(
    '<xml><MsgType><![CDATA[text]]></MsgType><Content><![CDATA[全量推送]]></Content>' +
    '<MsgId>1002</MsgId><ChatId><![CDATA[zhangsan]]></ChatId><ChatType><![CDATA[single]]></ChatType></xml>'
)
console.log('🔁 wait_reply 拿到:', JSON.stringify(await question))

// ---- 发卡片 (企业微信 template_card; 按钮用 value|label|type 简写) ---
const send = await hub.sendCard('wecom', 'wr-group-1', {
    title: '收尾提交方式',
    body: '当前分支有未推送改动',
    buttons: ['A|提交+推送+部署|primary', 'B|提交并推送', 'C|仅本地提交', 'D|暂不提交'],
})
console.log('📤 卡片发送结果:', JSON.stringify(send)) // 无网络时 ok=false + error, 永不 throw

// ---- 模拟卡片点击事件 (TaskId 回查映射, 还原 chat + 按钮值) ---------
if (send.ok) {
    await wecom.feed(
        '<xml><MsgType><![CDATA[event]]></MsgType><Event><![CDATA[template_card_event]]></Event>' +
        `<TaskId><![CDATA[${send.messageId}]]></TaskId><CardType><![CDATA[button_interaction]]></CardType>` +
        '<EventKey><![CDATA[A]]></EventKey></xml>'
    )
}

hub.teardown()
console.log('✅ done; agent turns:', agent.followups.length)
