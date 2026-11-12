# Changelog

本文件记录本项目的所有重要变更，格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)（0.x 阶段：minor = 新能力，patch = 修复）。

> 安装：`dsh plugin --profile <profile> add github:kovey/dsh-chat-interaction#<tag>`

## [0.3.7] - 2026-11-12

### 适配 DSH v0.2.2-rc.2

- devDependencies → **0.2.2-rc.2**（dsh-agent / dsh-llm / dsh-tools / dsh-user-approval）；
  `cordis` 仍为 **4.1.0**（无变化）
- **破坏性变化已修**：`AgentRegistry.roots()` 被移除，改为 **`list()`**（全部 live agent，
  按注册顺序；另有 `get(id)`）。`harnessFromCordis` 现在优先 `list()`、回退旧 `roots()`——
  否则 rc.2 宿主上会找不到 agent、永远无法唤醒（已加回归测试）
- `dsh-agent` 移除子会话所有权参数（`parentAgent`、`enter(agent, owner)`）—— 本插件不创建子会话，不受影响
- `dsh-llm`：`HarnessError` 改为从 `@deepseek-ai/dsh-error` 再导出；`LlmError` 构造参数收窄为
  `BuiltinLlmFailureCode` 并新增 `LlmError.fromFailure()`；`LlmFailure` 带 `status` / `providerRetryAfterMs`
- **采纳 `providerRetryAfterMs`**：重投守卫在服务端要求等待时**至少等那么久**
  （上限 `retryAfterCapMs`，默认 30s，避免限流时过早重试把配额打空）；新增 2 条测试
- `dsh-tools`：`ToolGuard` 可返回 `ToolGuardDenial`（返回字符串仍合法）、`checkGuards` 返回对象、
  新增 `ToolContextUnavailableError` 与 `APPROVAL_*` 错误码 —— 本插件只注册 guard（返回字符串），兼容
- `dsh-user-approval`：仅版本与 peer 提升（无类型变化），审批契约测试照常通过
- 测试：套件 **247/247** 通过（含 list() 回退与 providerRetryAfterMs 用例）；strict typecheck 通过

## [0.3.6] - 2026-11-10

### 变更 —— 插件状态目录统一到 `<repo>/.dsh/chat-interaction/`

- 新增 `chatStateDir(cwd)`（= `<repo>/.dsh/chat-interaction/`），`statePaths` 的全部字段以此为根：
  active chat / p2p 标记 / 权限模式 / allowlist / 审批人 / 审批账本 / 卡片 / 媒体 / 任务标记。
- 同一目录下还有：`pending/`（待答问题）、`chat-history/`（每 chat 记忆）、
  `chat-interaction-lease-*.json`（渠道租约）、`<channel>-app.json`（项目级凭据源码）。
  不再与工程套件的 `.dsh/specs`、`.dsh/missions`、`.dsh/state` 等台账混在一层。
- **自动迁移**（幂等、只复制不删除）：首次运行时把旧 `<repo>/.dsh/*` 下的
  active-chat / p2p / 权限模式 / allowlist / 审批人 / 审批账本 / 凭据，以及 `pending/`、`chat-history/`
  复制到新目录；卡片、媒体、任务标记与租约不迁移（可重建或进程内）。
  已存在的新文件不会被旧文件覆盖。
- **凭据顺序**：`chat-interaction/<channel>-app.json` → 旧 `<repo>/.dsh/<channel>-app.json`
  → `~/.dsh/<channel>-app.json` → 环境变量（旧路径继续可读，现有部署无需改动）。
- 文档：README 新增「项目内运行时目录」；UPGRADE 更新状态位置表与迁移说明；API.md 的 `p2pChat` 路径同步。
- 测试：新增迁移（复制/幂等/不迁移 cards-media-lease/空目录无副作用）与凭据优先级用例 → 套件 239 → 244。

## [0.3.5] - 2026-11-09

### 修复 —— 飞书身份只取 user_id 导致白名单必然失败

- **问题**：飞书卡片点击回调的 `operator` 通常**只带 `open_id`**（`user_id` 依赖权限、外部用户没有），
  而适配器只取 `user_id` → `senderId=''` → 审批人名单（open_id）**必然拒绝**，回答被当成“名单外”
  丢弃。普通消息事件的 `sender.sender_id` 同样只取了 `user_id`。
- **修复**：身份解析改为 **`open_id` 优先、`user_id` 回退**（`parseSenderIdentity`）；
  `InboundMessage` / `WaitResult` 新增 `senderOpenId` / `senderUserId`；
  审批人名单与 API `from` 过滤改为**任一可用标识命中即通过**，全部缺失时仍 fail closed；
  审批决定的 `by` 记录实际匹配到的标识（open_id-only 时不再记成空）。
- **顺带修复**：卡片点击不再硬编码 `chatType: 'p2p'`（改为 `'unknown'`）——群聊里的点击
  不会再把群 chatId 写进项目的 `<channel>-last-p2p-chat.txt`。
- 测试：新增 5 项（`parseSenderIdentity` 三种组合 / `parseCardAction` 仅 open_id 且 chatType=unknown /
  审批名单 open_id 与 user_id 均可匹配 / API from 按 senderOpenId 匹配 / 卡片点击不写 P2P 标记）
  → 套件 233 → 238

## [0.3.4] - 2026-11-09

### 新增 —— 交互 API 的答案出处与可观测性（审批问责）

- **答案出处**：`AskAnswer` / `ActionAnswer` 新增 **`chatId`**（答案来自哪个会话）与
  **`chatKind`**（`p2p` | `group`，平台报告时才存在）——审批台账可写清"谁、从哪个会话、哪条消息"。
  类型来自收到答案的那条入站消息的 `chatType`，回退到项目 p2p 标记
- **被忽略的回答可观测**：新增 `api.onAnswerIgnored(handler)` 与 `api.stats()`
  （`askedQuestions` / `ignoredAnswers` / `ignoredBySender` / `ignoredByOptions`），
  并打 warn 日志。非白名单发送者或不匹配选项的回答**不再静默**（以前只表现为超时，看不出被冒名）；
  忽略只影响那条消息，`ask()` 继续等待，合法回答仍生效
- **会话类型查询**：新增 `api.chatKind(target)` 与 `api.resolveChat(target)`（来自已观测入站消息
  或项目 p2p 标记）；未知会话返回 `unknown-chat` 而不是猜
- **文档**：API.md 明确 **`p2pChat` = 最后一个私聊者**（不是通用目标/审批人），新增字段与方法的
  用法说明；README 同步
- 测试：新增 4 项（出处断言、白名单忽略事件+计数+日志、option-mismatch 计数、chatKind/resolveChat
  含 unknown-chat、无 chatType 时字段省略）→ 套件 229 → 233

## [0.3.3] - 2026-11-06

### 适配 DSH v0.2.2-rc.1（跨 0.2.1-rc.3/rc.4/rc.5 与 0.2.2-alpha.2/alpha.3）

- devDeps → **0.2.2-rc.1**（dsh-agent / dsh-llm / dsh-tools / dsh-user-approval）+
  **cordis 4.0.5 → 4.1.0**
- peer → **`^0.2.0-rc.1 || ^0.2.1-rc.1 || ^0.2.2-rc.1`**（覆盖 0.2.0 / 0.2.1 / 0.2.2 三条 rc 线
  与 0.2.x 稳定版；0.3.x 排除）
- **模型选择接缝重构**（0.2.2 破坏性变化）：`ModelSelectionRef` 移除；改为 agent 自持
  `agent.model.current()` / `agent.model.select({ provider, model, reasoningEffort })`，
  `installModelSelection(agentCtx)` 只安装 pre-step 切换通知监听。`src/model-selection.ts` 已改为：
  完整选择（缺省 provider/model 取 agent options 或当前选择）、未知 effort 丢弃、
  回合结束用 agent options 恢复默认、无 seam 的旧宿主只告警（策略降级）
- 核实（0.2.1-rc.2 → 0.2.2-rc.1）：
  - 0.2.1-rc.2 → rc.5 无依赖变化；0.2.2-alpha.2 起新增 `dsh-official-bundles`、
    `dsh-experimental-forge-bundle`、`dsh-experimental-liveshare`、`dsh-personalized-recommendations`
    （`dsh-cua-bundle` 在 alpha.3 移除）；`schemastery` → 3.19.0
  - **cordis 4.1.0**：公开导出零变化（类型仅内部字段调整）
  - `dsh-tools` 拆出 `contracts` 并新增 `projectToolSchema`；`dsh-llm` 新增 `llm/models-updated`
    事件与 `LlmModelBadge`；`dsh-user-approval` 改为注入 `sessionProjections`
    —— 审批契约测试补 projection handle 桩（仍覆盖真实 decide()/归一化路径）
- 测试：model-selection 测试改为断言 `agent.model.select`；plugin 评分测试改用新接缝；
  套件 228/228 通过（含真实 cordis 4.1.0 Context 与真实 0.2.2-rc.1 服务）

## [0.3.2] - 2026-11-06

### 修复 —— cordis `provide` 第三参导致 chatInteraction 服务无法被 inject

- **症状**：其他插件用 `ctx.inject(['chatInteraction'], cb)` 等待本插件时，回调**永不触发**
  （`interaction_status` 报 `phase=absent:从未出现`），而 `ctx.get('chatInteraction')` 能取到值 ——
  "一次性 get 探测"完全看不出问题。
- **根因**：cordis 4.0.5 的签名是 `provide(name, value, check?)`，第三个参数是**可用性谓词**
  （check），不是 override 开关。本插件传了 `true` → `_checkImpl` 执行 `impl.check.call(...)`
  → TypeError → 被 catch → 该依赖从消费者 store 删除 → `inject` 永不满足。
- **修复**：`harnessFromCordis.provide` 只透传 `(key, value)`（注释明确禁止第三参）；
  `apply()` 的调用点去掉 `true`。真实 cordis 4.0.5 实测：
  传 `true` → `inject fired=0`；不传 → `fired=1`；传 `() => true` → `fired=1`
  （三种情况下 `ctx.get` 都可用，所以必须用 inject 验证）。
- **可观测性**：provide 失败不再被 `safely()` 静默吞掉 —— 记 error 级日志（含 key 与原因），
  但保持**降级不抛**（抛出会让 apply 整体失败、连渠道都不可用）；对敌意 ctx（属性访问即抛）
  也做了防御。
- **测试**：新增 `test/provide-contract.test.ts`（4 项，**真实 cordis Context**）：
  apply 后 `ctx.inject(['chatInteraction'])` 必须触发、`harness.provide` 只透传两参、
  provide 失败记 error 且不抛、宿主无 provide 方法时静默。修复前该测试失败
  （`fired=0` / `Missing expected exception`），修复后通过。套件 223 → 227。
- 既有的 `test/cordis-integration.test.ts` 用假 ctx 桩（`provide: (key, value) => …` 会忽略第三参），
  这正是该缺陷长期未被发现的原因；现补真实 Context 回归。

## [0.3.1] - 2026-11-05

### 修复 —— 状态作用域审计（该在项目里的都放回项目）

**问题**：凭据与多数状态是**项目级**，但一批状态写在 `~/.dsh` 全局：两个项目会互相阻塞、
互相覆盖，甚至泄漏彼此的授权上下文。逐项修复：

| 状态 | 旧位置（全局） | 新位置（项目内） |
|---|---|---|
| 渠道租约 | `~/.dsh/chat-interaction-lease-<channel>*.json` | `<项目>/.dsh/chat-interaction-lease-<channel>-<accountKey>.json` |
| 待答问题（pending） | `~/.dsh/chat-pending` | `<项目>/.dsh/pending` |
| 卡片存档（点击回查） | `~/.dsh/<channel>-cards` | `<项目>/.dsh/<channel>-cards` |
| 对话记忆（router 分类/追问） | `~/.dsh/chat-history` | `<项目>/.dsh/chat-history` |
| 全局 active chat 回退 | `~/.dsh/<channel>-active-chat.txt`（**只写不读**） | **删除**（多项目互相覆盖/泄漏授权） |

- **租约身份改为「项目 + 渠道 + 机器人指纹」**：项目之间不再互相阻塞；同一项目内同一个 bot
  仍然互斥（双 WS 会分流丢消息）。旧版渠道级租约若仍活跃，会提示 legacy 并等待其过期。
- **`projStateDir` 修正**：非 git 目录过去默认落到 `.claude`（判断写反），新项目现在落到
  `<项目>/.dsh`；已存在 legacy `.claude` 的项目继续沿用（兼容）。
- **共享凭据提示**：凭据来自全局 `~/.dsh/*-app.json` 回退时打 warn（同一 bot 不要跨项目同时连），
  不新增任何全局状态。
- 保留全局（有意为之，且可配置）：`logFile`（集中排障）、`spoolFile`（入站 tee，记录含
  channel/chatId）、`~/.dsh/settings.yaml`（宿主级模型配置）。
- 测试：新增 `test/state-scope.test.ts`（2 项作用域断言）与租约跨项目用例 → 套件 220 → 223。

## [0.3.0] - 2026-10-30

### 新增 —— 面向其他插件的交互 API（`layer.api`）

- `ctx.get('chatInteraction').api`，契约版本 `apiVersion = 1`，类型随包导出：
  - 发送：`sendText` / `sendRichText` / `sendCard` / `sendFile`（能力降级 + 文件包含校验）
  - 问答：`ask`（按钮值 / 选项值 / 标签 / 序号作答，`from` 白名单，`defaultOption`）、
    `confirm`（超时 fail-closed）
  - 通知：`notify`（level + 按钮）→ `waitForAction`（token 绑定，只消费本卡点击）
  - 扩展：`registerCommand`（`/name`，优先于待确认问题与任务模式）、`onInbound`（只读观察）
  - 元信息：`info` / `channels` / `capabilities` / `status` / `connect` / `disconnect` / `authState`
- 安全语义：`ask:`/`act:` 一次性 token（旧卡/异卡点击不命中，不会误判为新答案）；
  `sendFile` 做 realpath 包含校验（拒绝 `../` 逃逸与指向外部的符号链接）
- 底层新增：`hub.waitFor(predicate)`（只消费匹配消息）与 `hub.onInbound`（观察者），
  因此等待按钮不会再吞掉普通聊天
- 测试：新增 `test/api.test.ts`（14 项）→ 套件 200 → 214
- 文档：新增 `API.md`（完整参考 / 错误码 / 版本策略 / 示例插件），README 增索引

## [0.2.2] - 2026-10-22

### 适配 DSH v0.2.1-rc.2

- devDeps 升到 **0.2.1-rc.2**（dsh-agent / dsh-llm / dsh-tools / dsh-user-approval）+
  **cordis 4.0.4 → 4.0.5**
- peer 显式覆盖两条 rc 基线：**`^0.2.0-rc.1 || ^0.2.1-rc.1 || ^0.2.1-rc.2`**
  （原 `^0.2.0-rc.1 || ^0.2.0-rc.2` 在 semver 预发布规则下**不覆盖** 0.2.1-rc.x）
- 核实（0.2.0-rc.2 → 0.2.1-rc.2）：
  - **cordis 4.0.4 → 4.0.5**：顶层导出零增删
  - 依赖树新增 10 个包、移除 6 个（hooks-claude-code / hooks-codex / webhook / webhook-github /
    tool-ralph / experimental-schedule-bundle）—— 与本插件无关，但 profile patch 若显式引用会
    `failed to import`，已写入 UPGRADE
  - `dsh-tools` 新增 `PtcDispatchEventData.meta`（PTC 嵌套调用的可重放呈现元数据）；
    本插件注册的是普通工具、不做 PTC，**不接入**该字段
  - 四个包顶层导出零增删；`model-selection` / `runtime-types` / `tools types`+`schema` /
    `user-approval types` 逐文件比对通过（schema 仅注释措辞变化）
  - rc.1 → rc.2 为纯版本滚动（依赖零增删）
- 200/200 测试通过（含真实 0.2.1-rc.2 服务跑的审批契约与真实 cordis 4.0.5 Context 集成测试）
- 真机：真实 0.2.1-rc.2 宿主装配到 `dsh-chat-interaction ready`

## [0.2.1] - 2026-09-30

### 适配 DSH v0.2.0-rc.2

- devDeps 升到 **0.2.0-rc.2**（dsh-agent / dsh-llm / dsh-tools / dsh-user-approval；`cordis` 仍 4.0.4）
- peer **显式覆盖 rc.1 与 rc.2**：`^0.2.0-rc.1` → **`^0.2.0-rc.1 || ^0.2.0-rc.2`** ——
  原范围在 semver 上已覆盖 rc.2，但把被测基线显式写进清单，宿主闸门 / 安装器 / 人都能直接读到
- 核实（rc.1 → rc.2，**纯版本滚动**）：依赖树零增删（82 → 82）、非 dsh 依赖无变化；四个包
  **顶层导出零增删**；关键类型文件（`model-selection` / `runtime-types` / `tools types`+`schema` /
  `user-approval types` / `session types`+`known-event-types`+`repair`+`surface`）**逐文件一致**
- 200/200 测试通过（含用**真实 0.2.0-rc.2 服务**跑的审批契约与真实 cordis Context 集成测试）
- 真机：真实 0.2.0-rc.2 宿主装配到 `dsh-chat-interaction ready`，宿主输出零行

## [0.2.0] - 2026-09-29

### 破坏性变更

- **只支持 DSH 0.2.0 线**：`peerDependencies` 由 `^0.1.5-rc.1 || ^0.1.7-rc.1 || ^0.1.7-rc.2`
  收窄为 **`^0.2.0-rc.1`**（覆盖 0.2.0-rc.1、0.2.0 与未来 0.2.x；不覆盖 0.3.x）。
  在 0.1.5-rc.x / 0.1.7-rc.x 宿主上本版会被 `dsh-plugin-manager` 的版本闸门以
  `incompatible-version` 拒绝 —— 需要旧宿主请继续用 **v0.1.8**。

### 适配 DSH v0.2.0-rc.1

- devDeps 升到 0.2.0-rc.1（dsh-agent / dsh-llm / dsh-tools / dsh-user-approval；`cordis` 仍 4.0.4）
- 核实结论（0.1.7-rc.2 → 0.2.0-rc.1 的包内类型定义逐文件比对 + 真机启动）：
  四个包的**顶层导出零增删**，`createUserMessage` / `defineTool` / `validateJsonSchemaValue` /
  `installModelSelection` / `ModelSelectionRef` / 会话事件表面（`snapshotEvents` 等）/
  审批契约（`ApprovalOutcome`）/ 插件 manifest 字段（`dsh.runtime` / `dsh.bundle`）**全部一致**；
  唯一新增 API 是 `dsh-session` 的 `ToolCallRecovery`（宿主内部工具调用恢复，不构成插件扩展点）
- 194/194 测试通过（含用**真实 0.2.0-rc.1 服务**跑的审批契约测试与真实 cordis Context 集成测试）
- 真机验证：真实 0.2.0-rc.1 宿主装配到 `dsh-chat-interaction ready`

### 新能力对接（宿主 0.2.0 侧）

- **HMR 正式化（`dsh-hmr`）**：启动器提供 `profileContext` 时 base 以 `root: []` 启用 HMR，
  TUI / web profile 默认开启（headless / sdk / acp 默认禁用，可用 patch 重新启用）。本插件已是
  HMR-ready：teardown 停心跳定时器、释放渠道租约、排空 hub waiter、恢复模型覆盖、摘除本次 apply
  注册的 SIGINT/SIGTERM 处理器；且**不依赖 HMR 专有接缝**（官方只有 `hmr/change`、`hmr/reload`
  两个重载后事件，无重载前钩子）
- **插件版本兼容与豁免**：本插件用**范围** peer，天然通过闸门；豁免流程记入 README / UPGRADE
  （`dsh plugin --profile <p> version-exemptions` /
  `allow-version <pkg@ver> --dsh-version <runtime> --accept-risk` / `revoke-version`；
  豁免存于 profile 的 `compatibility.json`，且**插件升级与 DSH 升级都不继承**）
- **`dsh --dump-config-schema`**：记入 README 排障 —— 不挂载插件即可检查本插件的 config schema

### 测试

- 新增「依赖与文档一致性守卫」：peer 只含 0.2.0 线、devDeps 等于基线、README / UPGRADE / CHANGELOG
  中的版本引用与 `package.json` 一致（防止发版时文档漏改）

## [0.1.8] - 2026-09-28

### 变更

- **peer 显式声明 rc.2**：`@deepseek-ai/{dsh-agent,dsh-llm,dsh-tools}` 的 peer 从
  `^0.1.5-rc.1 || ^0.1.7-rc.1` 改为 **`^0.1.5-rc.1 || ^0.1.7-rc.1 || ^0.1.7-rc.2`**。
  原范围在 semver 上已覆盖 rc.2（v0.1.7 的宿主闸门实测未跳过本插件），但清单里只写 rc.1
  会让宿主闸门、安装器与人都无法直接看出"本版适配 rc.2" —— 现在把**被测基线显式写进清单**，
  不再依赖预发布版本的匹配细节。覆盖实测：0.1.5-rc.1 / 0.1.5-rc.3 / 0.1.7-rc.1 / **0.1.7-rc.2** /
  0.1.7（未来稳定版）✓，0.2.x ✗（正确排除）。README / UPGRADE 中的 peer 文本同步更新。

## [0.1.7] - 2026-09-28

### 适配 DSH v0.1.7-rc.2

- devDeps 升到 **0.1.7-rc.2**（dsh-agent / dsh-llm / dsh-tools / dsh-user-approval）；
  `cordis` 仍是 4.0.4。**peer 声明无需改动** —— `^0.1.7-rc.1` 已覆盖 rc.2（semver 预发布规则实测匹配）
- 接口逐符号比对 rc.1 → rc.2：`createUserMessage`、`defineTool`、`validateJsonSchemaValue`、
  `installModelSelection`、`snapshotEvents`、`ApprovalOutcome` **完全一致**；194/194 测试通过
- 真机验证：真实 **0.1.7-rc.2** 宿主装配到 `dsh-chat-interaction ready`（工具注册 / 审批门 /
  租约 / 服务导出 / teardown 全部正常），宿主输出里没有任何关于本插件的跳过或错误
- **rc.2 新增插件版本闸门**：peer 精确锁定旧版本的插件会被宿主跳过
  （`skipping profile bundle … is incompatible with dsh 0.1.7-rc.2`）。本插件用范围 peer
  （`^0.1.5-rc.1 || ^0.1.7-rc.1`）天然不受影响

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

[0.3.7]: https://github.com/kovey/dsh-chat-interaction/releases/tag/v0.3.7
[0.3.6]: https://github.com/kovey/dsh-chat-interaction/releases/tag/v0.3.6
[0.3.5]: https://github.com/kovey/dsh-chat-interaction/releases/tag/v0.3.5
[0.3.4]: https://github.com/kovey/dsh-chat-interaction/releases/tag/v0.3.4
[0.3.3]: https://github.com/kovey/dsh-chat-interaction/releases/tag/v0.3.3
[0.3.2]: https://github.com/kovey/dsh-chat-interaction/releases/tag/v0.3.2
[0.3.1]: https://github.com/kovey/dsh-chat-interaction/releases/tag/v0.3.1
[0.3.0]: https://github.com/kovey/dsh-chat-interaction/releases/tag/v0.3.0
[0.2.2]: https://github.com/kovey/dsh-chat-interaction/releases/tag/v0.2.2
[0.2.1]: https://github.com/kovey/dsh-chat-interaction/releases/tag/v0.2.1
[0.2.0]: https://github.com/kovey/dsh-chat-interaction/releases/tag/v0.2.0
[0.1.8]: https://github.com/kovey/dsh-chat-interaction/releases/tag/v0.1.8
[0.1.7]: https://github.com/kovey/dsh-chat-interaction/releases/tag/v0.1.7
[0.1.6]: https://github.com/kovey/dsh-chat-interaction/releases/tag/v0.1.6
[0.1.5]: https://github.com/kovey/dsh-chat-interaction/releases/tag/v0.1.5
[0.1.4]: https://github.com/kovey/dsh-chat-interaction/releases/tag/v0.1.4
[0.1.3]: https://github.com/kovey/dsh-chat-interaction/releases/tag/v0.1.3
[0.1.2]: https://github.com/kovey/dsh-chat-interaction/releases/tag/v0.1.2
[0.1.1]: https://github.com/kovey/dsh-chat-interaction/releases/tag/v0.1.1
[0.1.0]: https://github.com/kovey/dsh-chat-interaction/releases/tag/v0.1.0
