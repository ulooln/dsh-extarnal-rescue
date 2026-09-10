# 变更日志

本文件记录每个版本的变更、**实测结论**与**当时已知的限制**。版本号遵循 `package.json` 的 `version`，对应 git tag `v<version>`。

---

## v0.1.0 — 2026-09-10

首个版本。`@dsh-external/dsh-rescue`：DSH 本体起不来时，用独立于失败组合的极简创造模式 agent 诊断并修复本体。

### 新增

- **独立救援 CLI**（`lib/cli.js`，bin `dsh-rescue`），五个子命令：
  - `doctor` —— 确定性诊断，不启动、不调模型：部署平面可用性、每个 profile 的 bundle 解析、`link:` 目标与 junction 一致性、每层 patch 的解析与 id 重复、孤儿 patch、禁用行、不可解析的插入行、模型路由、凭据可得性（只报有无，不打印值）、最近一次启动失败。
  - `verify` —— 真启一次目标 profile，完整捕获 stdout+stderr、退出码、耗时。
  - `fix [--dry-run]` —— 只做可证明的机械修复，写前备份、写前用 Loader 自己的 YAML 方言验证新内容。
  - `repair [任务...]` —— 拉起极简创造模式 agent；带任务=一次性，不带=交互 REPL。
  - `supervise [-- <dsh 参数>]` —— 先启；起不来→机械修复→复验；还不行才叫 agent。
  - `shim` —— 在 `$DSH_HOME/rescue/` 下落一个短启动器。
- **不读失败组合的启动路径**：只用部署平面里的 `@deepseek-ai/dsh-base` + 本包 `rescue.cordis.yml` 另起一棵树；不读 profile 的 `cordis.patch.yml`、`$DSH_HOME/cordis.patch.yml`、profile 的 bundle 列表，也不走 `apps/cli` 的 profile 启动代码。平面按 `显式 → $DSH_RESCUE_PLANE → $DSH_HOME/profiles/node_modules → 本包 node_modules → checkout/apps/cli/node_modules` 顺序探测回退。
- **创造模式工具面**：救援树挂 `cordis-host-runner` + `tool-cordis`，因此 agent 拿到全套 `cordis_inspect_*` / `cordis_define` / `cordis_run` / `cordis_stop` / `cordis_undefine`，外加 fs/shell/skill/subagent 等 `dsh-base` 自带工具。
- **失败现场捕获**：`incidents/<时间戳>/` 下 `incident.json`（命令、cwd、退出码、耗时、是否起来、完整输出、识别出的诊断行）+ `output.log` + 失败那一刻的 `package.json` / `cordis.patch.yml` / 首页 patch / `settings.yaml` 快照；`incidents/latest.json` 指向最新一次。
- **进程内 bundle 面**：三个模型工具 `rescue_doctor` / `rescue_handoff` / `rescue_launch`；挂载时在 `$DSH_HOME/rescue/` 写短启动器。
- **随包技能** `skills/rescue-repair-playbook`：把启动诊断映射到具体文件与最小修法；另引用部署自带的 `editing-cordis-compositions`。

### 实测结论（Windows 11 · Node v24.20.0 · DSH 0.1.3-alpha.1）

全部为真实执行结果，非推断：

| 验证项 | 结果 |
| --- | --- |
| 本体崩了救援还能起 | ✅ 故意让目标 profile 插入一个不存在的包 → `dsh` 启动失败 → 救援 agent 正常启动并完成一轮模型对话 |
| 创造模式工具真的可用 | ✅ agent 调用 `cordis_inspect_list`，返回 `Service, Event, Builtin, Tool` |
| 错误信息拿得准 | ✅ incident 逐字保存失败原文；agent 读后精确报出 `ROW=drill-broken-row PKG=@dsh-external/dsh-nonexistent-drill` |
| agent 能读外部证据并落盘 | ✅ 读取 workspace 外的 incident，并把 3 行报告写进运行目录的 `report.md` |
| 全自动修复闭环 | ✅ `supervise`：没起来 → 捕获 → 机械修复 → 复验 → `came up after 1 mechanical fix(es); no agent needed`，exit 0，全程未调模型 |
| 交互 REPL | ✅ `repair` 无任务时进入 `rescue>`，`/help`、`/exit` 正常，退出码 0 |
| 进程内工具注册 | ✅ `rescue_doctor` / `rescue_handoff` / `rescue_launch` 出现在会话工具表；热装配 + 重载均通过 |

### 实测暴露并修掉的两个缺陷

1. **子路径导出被误判为坏行**：早期判定「某行解析不了」时拿整个 specifier 去找 `node_modules/<specifier>/package.json`，于是把 `@deepseek-ai/dsh-web-app/startup`、`@deepseek-ai/dsh-tool-subagent/model-selection-settings` 这类正常行当成坏行**自动禁用**——那会把 Web 面直接干碎。已改为先剥子路径得到包名；并加第二道防线：**机械修复后复验失败即整体回滚**，自动写入者证明不了自己有用时不得留下痕迹。
2. **验证命令丢参数**：supervisor 用 `--port 3099` 启动，交给 agent 的验证命令却没带，agent 复验会撞 `EADDRINUSE`。已把 supervisor 的启动参数透传进验证命令。

### 已知限制

- 需要一个可用的部署平面（`@deepseek-ai/cordis`、`cordis-plugin-include`、`dsh-app-boot`、`dsh-base` 至少在一个 `node_modules` 里）。全都没有时退出码 2，只剩静态诊断。
- `fix` 只自动处理「插入的行解析不了」这一类；重复 entry id、悬空 junction、bundle 装不上需要人工决定，只报告。
- `supervise` 只覆盖启动窗口（默认 25s）内的失败。
- 救援 agent 的 `pwsh`/`bash` 工具以管道方式起子进程：宿主进程若跑在限制命名管道的沙箱里会 `spawn EPERM`，此时 fs 类工具仍可用。
- 若宿主的文件沙箱拒绝「覆盖已存在文件」（Windows 上表现为 ACL 保留的原子替换报 `EPERM`），agent 改不动 profile 文件；走 `dsh-rescue fix`（直写 `node:fs`）或由人工执行 agent 报出的精确改法。
- 仅在 Windows + DSH `0.1.3-alpha.1` 上实测；`rescue.cordis.yml` 按 `dsh-base` 的行 id 覆盖，跨大版本升级后需以 `doctor` 报错为准。
- 仓库未附 `LICENSE` 文件（`package.json` 声明 BSD-3-Clause，版权人未指定）。

### 安装

```sh
git clone https://github.com/ulooln/dsh-extarnal-rescue.git C:/Home/skyer/dsh-rescue
# 进程内面：把它装进 profile
dsh plugin --profile web add C:/Home/skyer/dsh-rescue
# 崩了的时候（不需要上面那一步）
node C:/Home/skyer/dsh-rescue/lib/cli.js supervise --profile web
```

`lib/` 已随仓库提交，克隆即可用，不需要构建工具链——救援工具必须在本体已经坏掉、构建环境不可用时也能跑。
