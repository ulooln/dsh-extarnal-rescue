# 变更日志

本文件记录每个版本的变更、**实测结论**与**当时已知的限制**。版本号遵循 `package.json` 的 `version`，对应 git tag `v<version>`。格式规则见 [CONVENTIONS.md](CONVENTIONS.md)。

---

## [0.3.2] - 2026-09-18

### 修复

- **`--plane <目录>` 只在这个目录恰好叫 `node_modules` 时才有效**。Node 的裸包名解析**总会**在基址与包名之间插入一段 `node_modules`，而救援树此前把平面根本身当作基址。于是指向任何别的名字时，它不报错也不提示，只是**一行都解析不出来**，然后按设计回退到别的平面，用起来像是「平面参数没生效」，实际是整个救援树没从指定平面启动。现在基址是 `<state-root>/runtime`（该目录的 `node_modules` 指向平面），任何名字的平面都能启动整棵树。0.3.0 修的是同一件事的另一半（兼容性检查里的包解析），那一半只影响诊断，这一半影响启动。
- **`dsh-rescue` 不在 PATH 上时被 shell 报成「命令不存在」**。启动器写在 `$DSH_HOME/rescue/`，而这个目录默认不在 PATH 上，裸敲名字得到 `CommandNotFoundException`，看上去像插件没装、或工具不存在。现在挂载时检查一次：不在 PATH 上就在 stderr 打一条提示，含「用完整路径现在就能调」的原始命令、以及「放上 PATH 的一次性命令（写完要重开终端）」，并说明那个目录同时存放救援状态。
- **健康部署的第一次 `doctor` 会以一条警告开场**：本包自己的 `node_modules`（只有编译期链接）被列成候选平面，缺包就报 warn，于是 `worstLevel` 恒为 warn、结尾提示也变成「没发现阻塞性错误」。这条警告用户无法处理（那是设计如此），只会训练人忽略警告。现在该来源改报 info 并说明原因；**部署自己的平面**缺包仍然是 warn。实测：当前部署的 `doctor` 由「WARN plane-unusable (package)」变为全 info 收尾。

### 实测结论

| 验证项 | 结果 |
| --- | --- |
| `--plane` 指向一个不叫 `node_modules`、与 checkout 无关的独立平面 | ✅ 救援 agent 从该平面完整跑通一轮（exit 0）：stderr 点名该平面（origin `explicit`）、`runtime/node_modules` 链接指向它、transcript 里的验证命令也用它 |
| 反证：那棵树确实是这个平面加载的 | ✅ 把该平面里的 `dsh-base` 换成会抛错的桩 → 失败信息点名 `proof-plane\@deepseek-ai\dsh-base\cordis.patch.yml`（ENOENT），随后按设计回退到下一个可用平面并说明 |
| 门禁 | ✅ 92 项逻辑回归（新增 11 项：裸名基址的真实导入解析、PATH 判定的大小写/分隔符/引号/尾分隔符；另加 2 项覆盖平面缺包的告警级别） |

### 已知限制

- 裸名基址的回归用例建在临时目录里（临时平面 + 真实导入一个探针包），它证明的是解析机制本身；「从任意名字的平面启动整棵树」由上面那条端到端实测覆盖，两者互补。
- PATH 提示只在**挂载时**出现一次，且刻意不改任何环境变量，把它放上 PATH 与否由人来决定（该目录同时装着救援状态）。
- 其余限制同 0.3.1。

---

## [0.3.1] - 2026-09-14

### 修复

- **启动失败的部署被判成「已启动」**，于是 `supervise` 会跳过修复、`verify` 会给出错误的结论。判据此前只看**进程是否还活着**：装载失败的 DSH 并不马上退出——实测它要 **13.6 秒**才死（`dsh-base` + `dsh-web-app` 的失败路径，装上本插件后 14.2 秒，所以这 13 秒是 DSH 自己的收尾，不是本插件拖的）。窗口短于这段时间时，`verify` 就把一具正在死掉的尸体报成「came up」，`supervise` 随之认为无需修复——这正是本工具最不该犯的错。
  - 现在**判定基于证据而不只是存活**：退出码 0 = 起来了；非零 = 没起来；**仍然活着时，只有输出里没有任何失败特征才算起来**。
  - 输出**在等待期间持续监视**：失败特征一出现就立刻按失败处理（并留出 20 秒捕获退出码），不必等到窗口结束——失败在能知道的那一刻就知道。
  - 窗口到期而进程仍活着时，多留 **4 秒**再下结论，因为刚刚失败的 DSH 正是在这之后才打印错误并退出。
  - 失败特征表刻意收窄（比 `extractBootSignals` 窄得多）：这里判错一次就会把死掉的部署报成健康并跳过修复，而提取器只是给人看的线索。

### 实测结论

| 验证项 | 结果 |
| --- | --- |
| 窗口短于失败收尾时间（12s vs 14s） | ✅ 修复前报 `came up`；修复后报 `did NOT come up (exit 1, 12463ms)`，exit 4，落盘 incident |
| 健康部署 | ✅ 仍然 `came up`（窗口 18s + 结算 4s = 22s） |
| 失败耗时归因 | ✅ 无插件 13.6s / 有插件 14.2s → 13 秒的收尾来自 DSH，不是本插件 |
| 门禁 | ✅ 79 项逻辑回归（新增 10 项覆盖启动判定与失败特征表） |

### 已知限制

- 判定依赖失败特征表。若某次 DSH 升级换掉了错误措辞，表可能不再命中，于是又退回「活着就算起来」——那种情况下窗口本身是唯一的保险，默认 25 秒覆盖当前 14 秒的失败路径。
- 其余限制同 0.3.0。

---

## [0.3.0] - 2026-09-14

### 新增

- **更新 DSH 后的自检**：救援层是按 id 覆盖部署自己 `dsh-base` 行的，而**被覆盖的行不存在时 Loader 只警告、不报错**——救援照样启动，却悄悄退回默认权限：agent 被限制在工作目录内、审批请求又没有应答者，于是一个文件也写不动，而输出里不会有任何东西说明原因。现在这种沉默被拆成两半：
  - **启动前**：`doctor` / `rescue_doctor` 把救援层与当前部署的 base bundle 做一次组合比对，报出「覆盖了但不存在的行」「插入的行与部署冲突」「插入的行其包缺失」，并把权限行（`sandbox-policy` / `approval`）的缺失单独升级为 error 级。
  - **启动后**：`repair` / `supervise` 读回**已挂载**的树，确认权限覆盖真的生效；确认失败就**拒绝启动**而不是跑一个残废的 agent，并把原因与修法打出来。
  - 判据刻意收窄：行不存在、或解析后的标量值与要求不符 → 拒绝；值读不出来（Loader 内部形状变了）→ 只警告。宁可警告，也不能因为读不懂就把一个正常部署的救援否掉。

### 修复

- **平面内包解析只在目录恰好叫 `node_modules` 时才有效**：锚点此前落在平面自身，只有路径末尾是 `node_modules` 时 Node 的搜索才会碰巧命中。现在直接按平面根查一次，再把 Node 搜索作为回退。这个缺陷是被「构造一个改过名的平面」的演练逼出来的。
- **权限自检误报**：挂载后的 `options.config` 保留的是**未求值的 `!!js` 表达式**，解析后的值在 fiber 上。只读前者会把一个完全健康的部署判成残废并拒绝启动。

### 实测结论

| 验证项 | 结果 |
| --- | --- |
| 当前部署（dsh-base 0.1.3-alpha.1） | ✅ `ok: true`，8 个覆盖行与 2 个插入行全部命中，无冲突、无缺失 |
| 模拟一次重命名升级 | ✅ 构造一个把 `sandbox-policy` / `approval` 改名的平面 → `missingTargets` 与 `criticalMissing` 双双点名这两行，诊断升级为 error |
| 拒绝跑残废的救援 | ✅ `repair --plane <改名后的平面>` 跳过该平面并说明原因，随后回退到下一个可用平面 |
| 健康平面不误报 | ✅ 真实平面上 `repair` 正常启动并完成一轮对话，零警告 |
| 门禁 | ✅ 69 项逻辑回归（新增 13 项覆盖兼容性判定与权限自检） |

### 已知限制

- 兼容性判定比对的是**行 id 与插入行的可解析性**，不校验各行的**配置键**。若某次升级保留了行 id 但改了 config 键名，Loader 会在装载该行时报错——那属于启动失败，由捕获与机械修复覆盖，而不是这一检查。
- 只检查 `doctor` 所选的**那一个平面**；传入 `--plane` 时检查的是该平面。
- 其余限制同 0.2.0。

---

## [0.2.0] - 2026-09-10

### 新增

- **bundle 机械修复**：`fix` / `supervise` 现在也处理「某 bundle 装载不了」这一整类故障，做法是把它的名字从 `dsh.profile.bundles` 里移除。bundle 层**没有 disable 开关**，所以这是唯一的最小修法；包留在 `node_modules`、`dependencies` 条目也保留，装回来是一行的事。
  - 判据按**启动器自己的口径**实现，而不是「目录存不存在」：以 profile、harness home、部署平面依次为锚点走 Node 的真实包搜索解析到包，再加 manifest 声明了 `dsh.bundle.patch`、那个文件确实存在。
  - 诊断按失败原因分开报：`bundle-unresolved`（包解析不到）/ `bundle-no-patch`（装上了但不是 dsh bundle）/ `bundle-patch-missing`（patch 文件缺失），三者修复路径不同。
  - **绝不删掉挂载本插件自己的那个 bundle**：否则下一次崩溃就没有工具可用了。
- **崩溃归因（boot 握手）**：进程死掉时写不了遗言，所以握手反着来——插件挂载时把 `$DSH_HOME/rescue/boot-state.json` 打开为「未完成」，只有到达就绪状态才关成「已完成」；就绪信号优先取启动器自己的 `appReady`，没有该信号的界面回退到 30s 计时。于是**下一次挂载**、或 `dsh-rescue doctor`（读同一个文件），就知道上一次没起来，`lastGoodAt` 作为「最后正常启动时间」锚点保留。
  - 卸载时若还没就绪，记为 `cleanExit: true`——被主动停掉的启动不算崩溃，否则这个告警会被训练成噪音。
  - 崩溃当次就把日志签名分类写进记录（`session-corrupt` / `bundle-check` / `patch-tree` / `port-bind` / `settings` / `unknown`），免得日志滚动后归因丢失；每类都带一句对应的处置建议。
  - `doctor` 输出、`rescue_doctor` 工具、以及救援 agent 的 mission 都会带上这条历史。
- **工程门禁**：新增 `CONVENTIONS.md` 与三道门禁，`npm test` 一次跑完。
  - `npm run check:version`：多处版本号（`package.json` / `src/version.ts` / README 头部 / CHANGELOG 最新段）必须一致，且拒绝四段非 semver 写法。
  - `npm run check:size`：整体积与单文件上限。
  - `node tools/smoke-test.mjs`：纯逻辑回归，不需要 DSH、不需要网络、不调模型，全部在临时目录里自建 fixture 并自清理。

### 变更

- 源码按可测试性拆分：命令行文法移入 `src/args.ts`，机械修复移入 `src/repair.ts`，版本字面量移入 `src/version.ts`；`src/cli.ts` 只留命令实现（535 行 → 273 行）。此前 `cli.ts` 在被 import 时会自行执行，其中的逻辑无法直接测试。

### 实测结论

| 验证项 | 结果 |
| --- | --- |
| bundle 判据 | ✅ fixture 里四种 bundle（正常 / 包缺失 / 无 `dsh.bundle.patch` / patch 文件缺失）分别被报成 resolved / `bundle-unresolved` / `bundle-no-patch` / `bundle-patch-missing` |
| bundle 机械修复 | ✅ 一次移除三个装载不了的条目，保留正常 bundle 与本插件自身；manifest 已备份；rollback 还原全部五个条目 |
| 拒删救援自身 | ✅ 当本插件自己是唯一坏 bundle 时，`fix` 一条都不改并说明原因 |
| boot 握手 | ✅ 未完成记录 → `crashed: true` 且 `lastGoodAt` 保留；`cleanExit: true` → 不算崩溃；已完成记录 → 不算崩溃；无记录 → 首次运行 |

### 已知限制

- 需要一个可用的部署平面（`@deepseek-ai/cordis`、`cordis-plugin-include`、`dsh-app-boot`、`dsh-base` 至少在一个 `node_modules` 里）。全都没有时退出码 2，只剩静态诊断。
- `fix` 只自动处理两类故障：插入的行解析不了、bundle 装载不了。重复 entry id、悬空 junction、损坏的会话日志需要人工决定，只报告。
- `supervise` 只覆盖启动窗口（默认 25s）内的失败；崩溃**归因**不受此限制。
- boot 握手只能报告「上一次启动没到就绪」。首次运行之前没有记录，插件本身没被挂载时也不会有记录。
- 救援 agent 的 `pwsh`/`bash` 工具以管道方式起子进程：宿主进程若跑在限制命名管道的沙箱里会 `spawn EPERM`，此时 fs 类工具仍可用。
- 若宿主的文件沙箱拒绝「覆盖已存在文件」（Windows 上表现为 ACL 保留的原子替换报 `EPERM`），agent 改不动 profile 文件；走 `dsh-rescue fix`（直写 `node:fs`）或由人工执行 agent 报出的精确改法。
- 仅在 Windows + DSH `0.1.3-alpha.1` 上实测；`rescue.cordis.yml` 按 `dsh-base` 的行 id 覆盖，跨大版本升级后需以 `doctor` 报错为准。
- 仓库未附 `LICENSE` 文件（`package.json` 声明 BSD-3-Clause，版权人未指定）。

### 升级注意

`fix` 现在可能改动 profile 的 `package.json`（移除装载不了的 bundle 条目）。升级后第一次运行建议先 `dsh-rescue fix --dry-run` 看会改什么；所有写入都有 `.rescue-bak-<时间戳>` 备份。

---

## [0.1.0] - 2026-09-10

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
