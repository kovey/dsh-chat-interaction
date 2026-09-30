# 升级指南

> 变更明细见 [CHANGELOG.md](CHANGELOG.md)；安装/配置细节见 [README.md](README.md)。

## 谁需要升级到 v0.2.0

> **前置条件：宿主必须先升到 DSH ≥ 0.2.0-rc.1（rc.2 亦可，已核实）。** 本版 peer 声明为 `^0.2.0-rc.1 || ^0.2.0-rc.2`，
> 在 0.1.5-rc.x / 0.1.7-rc.x 宿主上会被版本闸门以 `incompatible-version` 拒绝加载；
> 那些宿主请继续使用 **v0.1.8**。

| 你的情况 | 建议 |
|---|---|
| 宿主已是 **DSH 0.2.0-rc.1 / rc.2**（或 0.2.x） | 升级到本版（v0.2.0）—— 这是唯一声明支持 0.2.0 线的版本 |
| 宿主仍是 0.1.5-rc.x / 0.1.7-rc.x | **留在 v0.1.8**；本版不会加载（peer 不满足） |
| 用 `permission.bridgeHarnessApproval`（headless 24×7 审批桥） | 升到 ≥ v0.1.5（审批返回值契约修复），本版同样包含 |
| 想让审批走 IM | ≥ v0.1.5 起支持（IM 审批 P0–P3） |

## 怎么升级

```sh
# 生产面（如 tui profile）：pin 到 tag，可复现
dsh plugin --profile tui add github:kovey/dsh-chat-interaction#v0.2.1

# 测试面（如 nvim-tui profile）：跟 main
dsh plugin --profile nvim-tui add github:kovey/dsh-chat-interaction
```

**重启 dsh 会话**后确认版本 —— 插件启动日志的第一行会打印版本：

```sh
head -1 ~/.dsh/chat-interaction.log     # 期望: … dsh-chat-interaction v0.1.5 applying; …
```

## 宿主升级注意事项（0.1.7-rc.x → 0.2.0-rc.1）

- **`cordis`**：0.1.5-rc.x 时代的 4.0.2 已升到 **4.0.4**（本插件 peer 声明 `^4.0.2`，依然满足）。
- **包改名（0.1.7 起）**：`@deepseek-ai/dsh-agent-presets` → **`dsh-agent-preset`**（+ `-registry`）；
  `dsh-code-runtime-worker-thread` → **`dsh-workflow-ptc`**；`cordis-plugin-hmr` → **`dsh-hmr`**。
  若 profile 的 `cordis.patch.yml` 里显式 insert 了旧包名，宿主启动会打印
  `dsh: warning: N entries did not activate` 与 `… failed to import` —— **与本插件无关**
  （本插件在同样输出里应是零行，日志里显示 `dsh-chat-interaction ready`）。处理：把旧行改成新包名，
  或直接删掉（新版宿主已自带这些包，多数 profile 无需手动装配）。
- **插件版本闸门（0.1.7-rc.2 起）**：宿主按插件声明的 DSH peer 范围检查运行时版本，不匹配即拒绝加载，
  错误码 `incompatible-version`（含未满足的 `peers` 列表）。本插件用**范围** peer，在 0.2.0 线上天然通过；
  需要混搭其它插件版本时才用上一节的官方豁免流程。
- **0.2.0-rc.1 自身没有包改名、也没有新的 manifest 字段要求**（`dsh.runtime` / `dsh.bundle` 不变）；
  它新增的实验包 `dsh-experimental-schedule-bundle` 与本插件无关。
- **HMR 在 TUI / web profile 默认开启**（headless / sdk / acp 默认禁用）→ 插件会被热重载，见下一节。

## 插件版本豁免（`dsh-plugin-manager`，0.1.7-rc.2 起）

宿主按插件声明的 DSH peer 范围检查运行时版本；不匹配的插件会被拒绝加载（错误码
`incompatible-version`，附未满足的 `peers`）。**本插件用范围 peer（`^0.2.0-rc.1 || ^0.2.0-rc.2`），
在 0.2.0 线上天然通过，不需要豁免** —— 本节只用于"确有需要把某个插件跑在不匹配的宿主上"。

```sh
# 1) 查看运行时版本与已有授权
dsh plugin --profile <profile> version-exemptions

# 2) 授权精确版本组合（会先打印风险警告；--accept-risk 表示已知晓"可能崩溃或数据丢失"）
dsh plugin --profile <profile> allow-version <package@version> \
    --dsh-version <runtime-version> --accept-risk

# 3) 撤销授权
dsh plugin --profile <profile> revoke-version <package@version> --dsh-version <runtime-version>
```

官方文档要点：

- 豁免保存在 **profile 自己的 `compatibility.json`**（与 `package.json`、`cordis.patch.yml` 并列），
  把精确的 `package-name@version` 映射到精确 DSH 运行时版本；写豁免**不改变**依赖、bundle 选择或 patch 层。
- **插件升级与 DSH 升级都不继承授权** —— 每次版本组合变化都要重新授权，别指望一次授权长期有效。
- 授权在**下一次组合**时生效：在线 profile 会在当前会话重新组合并挂载（报告 `applied`）；
  仅启动型 profile 报告 `restart-required`。
- 安装路径的检查时机：点名包的 `add` / 带 spec 的 `install` 在 pnpm 运行**之前**检查
  （本地路径直接读 `package.json`，registry spec 查 registry）；**git / tarball spec 必须先抓取、
  安装后才判定** —— 此时会恢复 profile 清单与锁文件并重装（我们推荐的 `github:…#tag` 属于这一类，
  所以装一个不兼容版本会看到"装完又回滚"）。
- 版本豁免**不授权依赖脚本**（构建脚本仍需单独批准）。

## HMR（0.2.0 起正式化）

- 启动器提供 `profileContext` 时，base 组合包以 `root: []` 启用 `dsh-hmr`：
  它监视 **profile manifest、profile 与 home 级 patch 文件**，通过统一串行重载重新组合各层 ——
  **TUI / web profile 默认开启**；**headless / sdk / acp 默认禁用**（可用 profile patch 重新启用，
  此时改配置需重启生效）。
- 对插件的要求：会被**卸载后重新 apply**，因此必须可重入、teardown 无泄漏。本插件已满足：
  teardown 停心跳定时器、释放渠道租约、排空 hub waiter 与定时器、恢复模型覆盖、摘除本次 apply
  注册的 SIGINT/SIGTERM 处理器；并有测试守住"连续 3 次 apply/teardown 后处理器计数回到基线"。
- HMR 只提供 `hmr/change`、`hmr/reload`（**重载后**通知），没有重载前钩子 —— 本插件不依赖任何
  HMR 专有接缝，启用与禁用 HMR 的 profile 行为一致。

## 版本兼容矩阵

| 插件版本 | 需要的宿主 | 关键内容 |
|---|---|---|
| **≥ 0.2.0** | **0.2.0-rc.1 及以后（含 rc.2）（0.2.x）** | 适配 DSH 0.2.0-rc.1：范围 peer、HMR-ready、豁免流程与新能力对接（旧宿主不再支持） |
| 0.1.7 / 0.1.8 | 0.1.5-rc.x / 0.1.7-rc.x（含 rc.2） | 适配 rc.2；v0.1.8 把 rc.2 显式写入 peer（**0.1.x 宿主的最后可用版本线**） |
| 0.1.6 | 0.1.5-rc.x / 0.1.7-rc.x | 同 0.1.5，且 `scripts/selfcheck.mjs` 随包分发（v0.1.5 的包里缺该脚本） |
| 0.1.5 | 0.1.5-rc.x / 0.1.7-rc.x | IM 审批 P0–P3、审批契约修复（真的会放行）、HMR 信号处理器修复、模型目录守卫 |
| 0.1.4 | 0.1.5-rc.x | 平台 SDK 随插件自动安装、工具输出 schema 对齐 |
| ≤ 0.1.3 | 0.1.5-rc.x | 无 IM 审批；审批桥点了通过也不放行；HMR 下泄漏信号处理器 |

## 升级后自检（可选）

```sh
# 1) 插件自检（不需要启动宿主）：真实 cordis ctx + 敌意 ctx 两条路径都不应抛
cd ~/.dsh/profiles/<profile>/node_modules/dsh-chat-interaction && node scripts/selfcheck.mjs

# 2) 日志里应看到 ready，且没有 CRASHED
grep -E "chat-interaction v|ready|CRASHED" ~/.dsh/chat-interaction.log | tail -5

# 3) 不挂载插件即可确认配置 schema 已注册（0.2.0 起可用）
dsh --profile <profile> --dump-config-schema | grep -A 30 chatInteraction
```

## 不兼容变更

### v0.2.0：只支持 DSH 0.2.0 线（本版唯一的破坏性变更）

- `peerDependencies` 由 `^0.1.5-rc.1 || ^0.1.7-rc.1 || ^0.1.7-rc.2` 收窄为 **`^0.2.0-rc.1 || ^0.2.0-rc.2`**。
  在 0.1.5-rc.x / 0.1.7-rc.x 宿主上，v0.2.0 会被版本闸门以 `incompatible-version` 拒绝加载 ——
  **那些宿主请继续使用 v0.1.8**（0.1.x 宿主的最后可用版本线）。
- 推荐升级顺序：**先把 dsh 升到 ≥ 0.2.0-rc.1** → 再把本插件升到 v0.2.0。反过来做会让插件暂时不加载。

### 历史版本的行为修正（均已包含在 v0.2.0 中）

- **审批桥真的会放行**：`bridgeHarnessApproval` 下返回合法 outcome 后，IM 上的"通过"才真正生效
  （v0.1.4 及更早返回对象，被宿主归一化成 `unavailable`）。若你的流程刻意依赖旧表现，
  请改用 `permission.mode: manual`，或让操作方在 TUI 侧确认。
- 其余新增能力都是 **opt-in**：`permission.requireApproverList`、`requireTokenClick`、
  `sendApprovalArtifacts` 默认保持历史行为（名单不限、文本作答可用、审批材料照发）。
