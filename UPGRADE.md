# 升级指南

> 变更明细见 [CHANGELOG.md](CHANGELOG.md)；安装/配置细节见 [README.md](README.md)。

## 谁需要升级到 v0.1.5

| 你的情况 | 建议 |
|---|---|
| 宿主是 **DSH 0.1.7-rc.1**（含 `dsh-hmr` / `dsh-plugin-manager`） | **必须升级** —— 旧的 peer 声明 `^0.1.5-rc.1` 在 semver 预发布规则下**不覆盖** 0.1.7-rc.1（实测匹配数为 0） |
| 用 `permission.bridgeHarnessApproval`（headless 24×7 审批桥） | **必须升级** —— v0.1.4 及更早返回的是对象，宿主会判成 `unavailable`：**点了"通过"也不放行**，且审计事件记成"无人应答" |
| 想让规格审批 / 交付审核 / 规范放宽 / 新增依赖审批走 IM | 需要 v0.1.5（IM 审批 P0–P3 在本版发布） |
| 只用飞书/企微消息收发，且宿主仍是 0.1.5-rc.x | 可留旧版，但升级无破坏性变更 |

## 怎么升级

```sh
# 生产面（如 tui profile）：pin 到 tag，可复现
dsh plugin --profile tui add github:kovey/dsh-chat-interaction#v0.1.6

# 测试面（如 nvim-tui profile）：跟 main
dsh plugin --profile nvim-tui add github:kovey/dsh-chat-interaction
```

**重启 dsh 会话**后确认版本 —— 插件启动日志的第一行会打印版本：

```sh
head -1 ~/.dsh/chat-interaction.log     # 期望: … dsh-chat-interaction v0.1.5 applying; …
```

## 宿主升到 0.1.7-rc.1 的注意事项

- `cordis` 依赖：`@deepseek-ai/cordis` 4.0.2 → **4.0.4**（本插件 peer 仍声明 `^4.0.2`，两条线都满足）
- **包改名**（0.1.7 起）：
  - `@deepseek-ai/dsh-agent-presets` → **`dsh-agent-preset`**（+ `dsh-agent-preset-registry`）
  - `dsh-code-runtime-worker-thread` → **`dsh-workflow-ptc`**
  - `cordis-plugin-hmr` → **`dsh-hmr`**
- 若你的 `~/.dsh/profiles/<profile>/cordis.patch.yml` 里**显式 insert 了旧包名**，宿主启动时会打印：

  ```
  dsh: warning: N entries did not activate
  agent-presets (@deepseek-ai/dsh-agent-presets): failed to import
  code-runtime (@deepseek-ai/dsh-code-runtime-worker-thread): failed to import
  ```

  这不是本插件的问题（本插件在该日志里应显示 `dsh-chat-interaction ready`）。处理方式二选一：
  把这两行改成新包名，或**直接删掉** —— 0.1.7 宿主已自带这些包，多数 profile 无需再手动装配。

## 版本兼容矩阵

| 插件版本 | 需要的宿主 | 关键内容 |
|---|---|---|
| **≥ 0.1.6** | 0.1.5-rc.x / **0.1.7-rc.x** | 同 0.1.5，且 `scripts/selfcheck.mjs` 随包分发（v0.1.5 的包里缺该脚本） |
| 0.1.5 | 0.1.5-rc.x / 0.1.7-rc.x | IM 审批 P0–P3、审批契约修复（真的会放行）、HMR 信号处理器修复、模型目录守卫 |
| 0.1.4 | 0.1.5-rc.x | 平台 SDK 随插件自动安装、工具输出 schema 对齐 |
| ≤ 0.1.3 | 0.1.5-rc.x | 无 IM 审批；审批桥点了通过也不放行；HMR 下泄漏信号处理器 |

## 升级后自检（可选）

```sh
# 1) 插件自检（不需要启动宿主）：真实 cordis ctx + 敌意 ctx 两条路径都不应抛
cd ~/.dsh/profiles/<profile>/node_modules/dsh-chat-interaction && node scripts/selfcheck.mjs

# 2) 日志里应看到 ready，且没有 CRASHED
grep -E "chat-interaction v|ready|CRASHED" ~/.dsh/chat-interaction.log | tail -5
```

## 不兼容变更

**无破坏性变更**：所有新增能力都是 opt-in —— `permission.requireApproverList`、`requireTokenClick`、
`sendApprovalArtifacts` 默认保持历史行为（名单不限、文本作答可用、材料照发）。

唯一的行为**修正**：`bridgeHarnessApproval` 下返回合法 outcome 后，IM 上的"通过"现在**真的会放行**
（旧版恒为 `unavailable`）。若你的流程刻意依赖了旧版"点通过也不放行"的表现，请改用
`permission.mode: manual` 或让操作方在 TUI 侧确认。
