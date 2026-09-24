# Changelog

本文件记录本项目的所有重要变更，格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)（0.x 阶段：minor = 新能力，patch = 修复）。

> 安装：`dsh plugin --profile <profile> add github:kovey/dsh-chat-interaction#<tag>`

## [0.1.6] - 2026-09-24

### 修复

- **`scripts/` 未随包分发**：`files` 字段遗漏 `scripts/`，而 pnpm 从 git 安装时按 `files` 过滤 ——
  v0.1.5 的包里因此没有 `scripts/selfcheck.mjs`，但 UPGRADE.md / README 正让用户去执行它
  （文档指向不存在的文件）。现已把 `scripts/` 纳入 `files`。
  验证方式：`pnpm pack` 后检查 tarball 内容（本版实测 `package/scripts/selfcheck.mjs` 在其中，
  文件总数 56）。

## [0.1.5] - 2026-09-24

### 新增 —— IM 审批（P0–P3）


与工程套件的 `approval` 接缝对接，让规格审批 / 交付审核 / 规范放宽 / 新增依赖都能在 IM 上完成：

- **卡片按钮带一次性 token**（`approve:<nonce>`）：转发的卡与上一轮的旧卡点击都不能复用（记 `stale-click`，不消费当前卡）；
  纯文本回答（`yes`/`同意`…）默认仍被接受以保持兼容，需要"只认按钮点击"时打开
  `permission.requireTokenClick: true`（此后文本回答记 `text-rejected` 并回一句提示，不参与决策）；
- **项目级审批人名单**（`permission.requireApproverList` + `<project>/.dsh/<channel>-approvers.txt`）：
  名单外的人点击不生效、会被回一句"无权限"，且不消费这张卡；
- **沉默不是同意**：通道发起的任务在超时/发送失败时返回 `'cancelled'`（不再 `next()` 落到别的应答者）；
  非本通道发起的任务保持 `next()`，交给原来的界面回答；
- **决策带溯源**：`by` / `messageId` / `at` / `via` 落在 `<项目>/.dsh/<渠道>-approvals.jsonl` 与日志里
  （宿主 `approval/request` 只接受 outcome 字符串，元数据无法随返回值传递）；
- **结构化卡片**：解析理由里的 ```approval-context``` 块（kind/mission/revision/facts/artifacts）渲染字段，
  而不是把整段散文贴进卡片；纯文本应答者仍只看到 prose；
- **材料随卡送达**：`ChannelAdapter.sendFile`（飞书：上传文件后发文件消息）把需求文档等发给审批人；
- **决定落账**：每个决定与拒绝都写一行 `<project>/.dsh/<channel>-approvals.jsonl`（谁/何时/哪张卡/哪个 token）。
- **审批材料路径受限**：`artifacts` 解析为绝对路径并做 realpath 包含校验，必须落在项目工作区内，
  越界（绝对路径、`../` 逃逸、指向外部的符号链接）一律拒绝并记 warn —— 材料清单来自审批载荷，
  不能让模型诱导把 `~/.dsh/feishu-app.json` 这类工作区外文件发进聊天；
- **记账含来源**：ledger 每行补 `via: click | text`，区分按钮点击与文本作答（严格模式下的 `text-rejected` 也落账）。

### 适配 DSH v0.1.7-rc.1
### 适配 DSH v0.1.7-rc.1

- 依赖基线升到 **0.1.7-rc.1**（devDeps 精确锁定；`cordis` 4.0.2 → 4.0.4）；
  `peerDependencies` 声明 `^0.1.5-rc.1 || ^0.1.7-rc.1` —— semver 预发布规则下
  `^0.1.5-rc.1` **不覆盖** 0.1.7-rc.1（实测匹配数为 0），必须显式并列
- 逐项核实 0.1.5-rc.1 → 0.1.7-rc.1 的接口：`createUserMessage` / `defineTool` /
  `validateJsonSchemaValue` / `installModelSelection` / `ModelSelectionRef` /
  会话事件表面（`snapshotEvents` / `eventAt` / `ownEvents` / `firstLiveSeq`）**签名全部未变**；
  plugin 清单字段（`dsh.runtime` / `dsh.bundle`）未变
- 新版新增包（`dsh-plugin-manager` / `dsh-hmr` / `dsh-agent-preset` / `dsh-atomic-write` /
  `dsh-mcp-resources` / `dsh-skill-office` / `dsh-tool-workspace-dependencies` /
  `dsh-workflow-ptc` 等）不改变本层 manifest 需求

### 修复

- **harness 审批桥的返回值不符合宿主契约**（功能失效级）：`approval/request` 的应答必须是
  `ApprovalOutcome` 字符串，`dsh-user-approval` 会把任何非 outcome 值归一化成 `'unavailable'`
  （两版实现一致：`OUTCOMES.includes(outcome) ? outcome : 'unavailable'`）—— 原实现返回
  `{decision, by, messageId, at, source}` 对象，等于**用户点"通过"也不会放行**。
  现返回 `'allowed-once'` / `'rejected'` / `'cancelled'`；决策溯源（`by` / `messageId` / `via`）
  改走本插件账本与日志（宿主通道无法携带元数据）。
  **运行期核实**（不是读源码）：用真实 `ApprovalService` 分别跑 0.1.7-rc.1 与 0.1.5-rc.1 ——
  返回富对象一律得到 `'unavailable'`（连 `approval/decided` 审计事件也记成 unavailable，即
  "点了通过却等于无人应答"）；返回合法 outcome 字符串则原样通过。修复后的桥端到端复验：
  点通过 → `allowed-once`、点拒绝 → `rejected`、超时 → `cancelled`。
  新增 `test/harness-approval-contract.test.ts`（4 项，跑**真实**官方服务）与 devDep
  `@deepseek-ai/dsh-user-approval@0.1.7-rc.1` 固化该契约
- **热重载下的信号处理器泄漏**（dsh 0.1.7 引入 `dsh-hmr`，插件会在同一进程内被重新 apply）：
  原先每次 apply 都 `process.once('SIGINT'/'SIGTERM')` 且 teardown 从不摘除 —— 反复重载会累积
  处理器（Node max-listener 警告），并让旧 hub/lease 无法回收。现每次 apply 记录自己注册的
  处理器、teardown 逐一 `removeListener`；新增测试：连续 3 次 apply/teardown 后处理器计数回到基线



## [0.1.4] - 2026-09-22

### 修复

- **工具输出 schema 与实际返回值不一致**（用户报告：`feishu_auth_state` 调用报
  `tool "feishu_auth_state" returned invalid output: "value.activeChat" is not a declared
  property`）：输出 schema 写成 snake_case，而返回值是 camelCase，宿主的输出校验
  （`additionalProperties: false`）会直接拒绝整个调用。**受影响的不止 `auth_state`**：
  - `send_message` / `send_card`：`message_id` → `messageId`
  - `wait_reply`：`timed_out` / `message_id` / `is_card_action` → camelCase
  - `auth_state`：`active_chat` / `p2p_chat` / `listener_role` / `listener_connected` /
    `pending_questions` → camelCase
  → 全部对齐为 camelCase；新增 `test/tool-output-schema.test.ts`：用**宿主内部同一个**
  校验器 `validateJsonSchemaValue`（`@deepseek-ai/dsh-tools` 导出）校验每个渠道工具的
  每条返回路径（成功 / 无 messageId / 失败 / 超时 / 真实 hub 调用 / plugin 层 authState）
- **飞书可选依赖缺失时的报错不可执行**：原来只抛 `Cannot find package
  '@larksuiteoapi/node-sdk'` → 现在给出可直接执行的修复命令与最低版本要求

### 变更

- **平台 SDK 改为随插件自动安装**：`@larksuiteoapi/node-sdk`（飞书）与 `@wecom/crypto`（企微）
  从 *optional peerDependencies* 移到 **optionalDependencies** ——
  旧声明下 pnpm 不会安装它们，用户装完插件仍然 `Cannot find package '@larksuiteoapi/node-sdk'`，
  而宿主/市场的入口自检会按 `main ?? 'index.js'` 去解析这个缺失依赖，报出
  `Cannot find package '<pkg>/index.js'`，看起来像"插件缺 exports/main 字段"
- **测试隔离**：插件级测试会把渠道租约写进真实 `~/.dsh`，与用户正在运行的会话互抢
  （实测：租约被真实 interactive 会话持有导致用例失败）→ 测试进程的 `DSH_HOME`
  指向临时目录，测试结果不再随机器状态波动

## [0.1.3] - 2026-09-22

### 修复

- **任务连续性**：一轮任务开启后，任务期间收到的**所有**消息都作为本轮任务的补充或回答，
  不再被当作新的无关对话。核实中发现并修复 4 处不符 + 1 处会导致任务卡住的优先级缺陷：
  - 任务标记**不会自动创建**（依赖 agent 记得写，忘了整轮不生效）→ 判为需求/修复类任务时
    插件自动写入标记（`router.autoTaskMarker`，默认 `true`，可关）
  - 任务标记**不会续期**（> 空闲 TTL 8h 的长任务中途掉出任务模式）→ 任务期间每条消息自动
    续期；新增绝对上限 `router.maxTaskMs`（默认 12h，`0` = 不限）防止永久占用
  - 转交上下文过弱（只有一句「存在进行中的任务」）→ note 带上任务名，并明确
    「作为该任务的补充或回答继续处理；不要当作新的无关话题，确属新话题先用卡片确认」
  - 任务分支**抢先于插件待确认问题**：任务启动时发的权限模式卡被点击后会被吃掉，
    权限模式永远不落盘 → 路由顺序改为「插件问题的明确答案（卡片点击/选项/取消）→
    任务模式 → 普通路由」，歧义消息才落到任务模式
- **wait_reply 优先级**：插件有卡片问题悬着时，agent 的 `wait_reply` 收不到用户的普通文本
  回复，导致等待超时、任务中断 → 图片永远算新回合；卡片点击优先解决插件问题；
  普通文本优先喂给正在等待的工具调用

### 变更

- `prompt.ts` 任务策略改写：插件自动创建/续期标记，agent 收尾只需删除标记；
  明确「任务期消息 = 本轮任务的补充/回答」

### 测试

- 新增 `test/task-continuity.test.ts`（10 项）；套件 148 → 160

## [0.1.2] - 2026-09-11

### 修复

- **不再把回合路由到不存在的模型**：README 示例曾使用 `deepseek-chat` / `deepseek-reasoner`，
  而 provider 目录里并不存在这些 id，照抄会把该回合的请求指向不存在的模型 → 回合失败 →
  重试守卫反复重投直到耗尽
- 新增模型目录守卫（`src/model-catalog.ts`）：读取宿主模型目录（`~/.dsh/settings.yaml`，
  防御式解析，读不到＝不表态）
  - 打分档位的模型覆盖先过守卫：未知模型连同 provider/effort 一起丢弃（回退宿主默认模型），
    日志 warn 一次并列出可用模型
  - 评估/分类模型未声明 → 直接走规则路径，不做无效模型调用
  - reasoning effort 只接受 `off | low | high | max`，非法值丢弃该字段
- 文档：所有示例模型名改为真实 id，补「模型 id 从哪来」与守卫行为说明

### 测试

- 新增 `test/model-catalog.test.ts`（10 项，含把上述错误模型名固化的回归用例）

## [0.1.1] - 2026-09-11

### 修复

- **插件不再让宿主崩溃**（真实故障：挂进 profile 后启动即崩）：
  `cannot get property "roots" without inject` —— cordis 的 ctx 只允许访问 `inject` 声明过的
  服务，而为探测「扁平 HarnessContext」读取 `ctx.roots` 会抛错，导致整个 plugin tree 加载
  失败、宿主启动失败
  - `isHarnessContext()` 改用官方 `Context.is()` 品牌判断（global symbol，不触发属性读取）
  - `harnessFromCordis()` 的每个 host 服务访问独立 try/catch，异常降级为 no-op
  - `apply()` 拆为外壳 + 主体：任何异常都被捕获 → 记录 stack → 清理已建资源 → 返回 `null`
  - 崩溃留痕双通道：日志文件 + stderr；若崩溃早于日志配置，回落到
    `~/.dsh/chat-interaction.log`

### 新增

- `scripts/selfcheck.mjs`：不改 profile 的本地自检（真实 cordis ctx + 敌意 ctx 两条路径）
- 阶段日志（`channels ready` / `registering service export` …），崩溃时最后一行即定位点

### 测试

- 新增 `test/plugin-resilience.test.ts`（8 项，含把 `without inject` 固化的 inject-strict 回归）

## [0.1.0] - 2026-09-10

首个版本：DSH ⇄ IM 的抽象交互层。

### 新增

- **核心 hub（无 harness 依赖）**：消息去重、JSONL spool、按项目/渠道隔离的状态、
  `wait_reply` 阻塞问答（消费消息、不产生新回合）、即时回执、agent 唤醒、模型失败重投守卫
- **渠道抽象**：`ChannelAdapter` + `BaseChannel`；接新平台 = 实现接口 + 一段配置
- **飞书适配器**：WS 长连接、卡片点击重建卡片、图片落地、text/post/interactive 卡片出站
- **企业微信适配器（自建应用）**：内置回调服务器（URL 校验 + 签名 + AES 解密）或 `feed()`
  推送、`template_card` 任务映射、2048 字节分片
- **企业微信智能机器人（`wecom_bot`）**：官方 WS 长连接（`@wecom/aibot-node-sdk`，可选 peer），
  免公网回调；单聊/群聊会话 id 归一化、图片 `aeskey` 解密落盘、卡片事件
- **插件自治 router**：命令安全执行（白名单 + 禁止规则）、确认解析、闲聊直答（每 chat 记忆）、
  任务连续性；自动发起权限模式卡与消歧卡（`PendingStore` 闭环）
- **消息打分 → 模型路由**：规则 + 模型双评估（失败自动降级），分数映射档位再映射执行模型，
  经官方 `installModelSelection` 作用于该回合并在回合结束自动恢复；回合内标注评分与模型
- **渠道租约（24×7 心跳接管）**：`interactive`（TUI）抢占 `service`（launchd 常驻），
  被抢占方让位并可自动收回；心跳过期可被接管
- **审批门**：`manual` 模式下 `tools/pre-execute` 走渠道卡片（同意/拒绝/始终同意，超时 fail-closed）；
  可选 harness 审批桥（headless 24×7）
- **DSH 绑定半边（`dsh-chat-interaction/plugin`）**：官方 `createUserMessage` / `defineTool` /
  `installModelSelection`；`harnessFromCordis()` 适配真实 cordis ctx；按渠道生成工具族
  （`<渠道>_send_message` / `_send_card` / `_wait_reply` / `_listener` / `_auth_state`）
- 依赖基线 DSH **0.1.5-rc.1**（`^0.1.5-rc.1` + `cordis ^4.0.2`），已适配其
  `session.events → snapshotEvents()` 破坏性变化
- 安装：`github:` 直装（构建产物入库，免构建）；自带 `cordis.patch.yml`

[0.1.6]: https://github.com/kovey/dsh-chat-interaction/releases/tag/v0.1.6
[0.1.5]: https://github.com/kovey/dsh-chat-interaction/releases/tag/v0.1.5
[0.1.4]: https://github.com/kovey/dsh-chat-interaction/releases/tag/v0.1.4
[0.1.3]: https://github.com/kovey/dsh-chat-interaction/releases/tag/v0.1.3
[0.1.2]: https://github.com/kovey/dsh-chat-interaction/releases/tag/v0.1.2
[0.1.1]: https://github.com/kovey/dsh-chat-interaction/releases/tag/v0.1.1
[0.1.0]: https://github.com/kovey/dsh-chat-interaction/releases/tag/v0.1.0
