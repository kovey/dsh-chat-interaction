const CORE_LINES = (d) => [
    `${d.label} integration (dsh-chat-interaction channel "${d.name}") is active:`,
    `- 默认不连接: 插件绝不自行建立${d.label}连接。仅当用户明确要求 (如「连接${d.label}」「开启${d.label}监听」) 时才调用 ${d.name}_listener(action=start) 建立连接; 用户要求断开时调用 action=stop; 查看状态用 action=status。禁止在用户没有明确要求时自行连接或断开。`,
    `- Inbound ${d.label} messages arrive as user turns starting with [${d.label}消息] or [${d.label}卡片点击]; each carries an exact chat_id (and message_id for dedupe only).`,
    `- Reply with the ${d.name}_send_message tool using that chat_id verbatim; never invent chat_ids.`,
    `- For confirmations / multiple-choice questions use ${d.name}_send_card (short button values like A/B/yes/no); the user's click arrives as a new [${d.label}卡片点击] message whose text is the button value.`,
    `- ${d.name}_wait_reply(chat_id, timeoutMs) blocks until the user's next message in that chat (consumed by the call; no extra turn) — use it for strict Q&A sequencing.`,
    `- ${d.name}_auth_state() reports permission mode / allowlist / pending questions.`,
    `- A message that carries images includes 图片文件: <本地绝对路径> — read them with the read_image tool (dsh native multimodal); answer from what you actually see in the image, not from guesses.`,
    `- Simple commands (git status, 最近提交, 文件列表…), confirmation answers, and casual chat (unrecognized messages are answered by the plugin's LLM directly) are handled by the plugin itself; requirement / bugfix tasks reach you and follow their existing skills. If a chat message reaches you because the plugin's model was unavailable, answer it conversationally in ${d.label}. ${d.label} is the remote surface, not a new process.`,
];
/** Task-session policy lines (task-active markers + closing commit cards). */
export const TASK_POLICY_LINES = (d) => [
    `- 任务连续性 (task-active, **按项目隔离**): 需求/修复类任务开始时, 插件会**自动**写 <当前项目仓库>/.dsh/${d.name}-task-active/<chat_id>.json (含任务名/started_at/updated_at), 并在任务期间每收到一条消息就**自动续期** —— 你无需手动创建或续期。` +
        `任务模式下的**所有**消息都由插件作为**本轮任务的补充或回答**转交给你（不会被命令自治、闲聊直答或消歧卡截走），请按任务上下文继续处理，不要当作新的无关话题；如确属新话题，先用卡片与用户确认再切换。` +
        `**任务收尾（完成/取消）后必须删除该标记**（或覆写 {}），以立即退出任务模式（否则会一直占到空闲 8 小时或绝对上限 12 小时才自动失效）。绝不写全局 ~/.dsh/${d.name}-task-active —— 任务会话与项目强相关, 必须区分项目。`,
    `- 任务收尾铁律 (每次任务结束都必须遵守, 与技能加载无关): 任何需求/修复/实现类任务收尾时, 若当前分支存在未推送的本地提交或未提交改动, 必须用 ${d.name}_send_card 发「收尾提交方式」卡, 按钮固定四个: A|提交+推送+部署 (primary) / B|提交并推送 / C|仅本地提交 / D|暂不提交; 用户点 A → 先 git push origin <当前分支>(master/main 时降级仅本地提交, 绝不 force) 再调用部署(deploy)技能流程(其自带权限卡+预检+二次确认); 点 B → 仅 push; 点 C → 仅本地提交; 点 D → 不动。禁止以 [完成]/[Done] 文本直接收尾而不给推送/部署入口。`,
];
/** Scoring guidance, appended when the scoring step is enabled. */
export const SCORING_PROMPT_LINES = (d) => [
    `- 消息评分与模型路由 (scoring): 入站消息会先被打分 (复杂度 0-1, 规则或模型评估), 按分数档位 (low/medium/high) 自动选择执行模型。你会在用户回合中看到「消息评分: 0.85 (high) → 执行模型: xxx」的标注 — 这是插件的自动决策, 无需你操作。`,
];
/** Build the system-prompt section text for one channel. */
export function buildPromptSection(desc, opts = {}) {
    const lines = [...CORE_LINES(desc)];
    if (opts.taskPolicy !== false)
        lines.push(...TASK_POLICY_LINES(desc));
    if (opts.scoring)
        lines.push(...SCORING_PROMPT_LINES(desc));
    if (opts.extraLines && opts.extraLines.length) {
        lines.push('- 附加规则:', ...opts.extraLines.map((l) => `  ${l}`));
    }
    return lines.join('\n');
}
/**
 * Format one inbound message into the user-turn text handed to
 * `agent.followup` — the exact pattern dsh-feishu uses, parameterized,
 * plus the optional scoring annotation.
 */
export function formatInbound(desc, msg, note, score) {
    const kind = msg.isCardAction ? `${desc.label}卡片点击` : `${desc.label}消息`;
    const lines = [
        `[${kind}] chat_id: ${msg.chatId} | chat_type: ${msg.chatType} | message_id: ${msg.messageId || ''} | message_type: ${msg.messageType || ''}`,
    ];
    if (msg.docLinks && msg.docLinks.length)
        lines.push(`文档链接: ${msg.docLinks.map((d) => d.url).join(' ')}`);
    if (msg.imagePaths && msg.imagePaths.length)
        lines.push(`图片文件: ${msg.imagePaths.join(' ')}`);
    if (msg.imageErrors && msg.imageErrors.length)
        lines.push(`图片下载失败: ${msg.imageErrors.join('; ')}`);
    if (msg.isBotMentioned)
        lines.push('注意: 群聊中 @提及了本机器人');
    lines.push(`内容: ${msg.text}`);
    if (note)
        lines.push(`插件上下文: ${note}`);
    if (score) {
        lines.push(`消息评分: ${score.score.toFixed(2)} (${score.level}) → 执行模型: ${score.model || '会话默认'} [${score.source}]`);
        if (score.reasoning)
            lines.push(`评分依据: ${score.reasoning}`);
    }
    lines.push('');
    lines.push('处理要求:');
    lines.push(`1. 用 ${desc.name}_send_message 工具向上述 chat_id 回复（message_id 仅用于去重，不要填进工具参数）。`);
    lines.push('2. 图片消息: 用 read_image 读取 图片文件 中的本地路径, 基于图片实际内容作答。');
    lines.push(`3. 需要用户确认/选择的问题：用 ${desc.name}_send_card 发卡片，等用户点击后按新的 [${desc.label}卡片点击] 消息继续。`);
    lines.push('4. 需求/修复/部署类任务：按对应技能流程执行；权限与确认走卡片。');
    lines.push('5. 查询/状态类命令：直接执行并回复结果。');
    return lines.join('\n');
}
