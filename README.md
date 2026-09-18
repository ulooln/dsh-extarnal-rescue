# @dsh-external/dsh-rescue

**版本 0.4.0** · 2026-09-10 · 许可 BSD-3-Clause · 状态：可用（Windows + DSH `0.1.3-alpha.1` 端到端实测通过）· 变更见 [CHANGELOG.md](CHANGELOG.md)

DSH 本体自毁救援：**当 dsh 起不来、Web UI 也进不去的时候**，用一条命令拉起一个独立的、具备「创造模式」工具面的极简 agent，让它诊断并修复本体。

---

## ⚠️ 注意事项（先读这一节）

1. **救援 agent 默认以 `danger-full-access` 运行**，能写任何路径。这是有意的：修复目标（`$DSH_HOME/profiles/...`、harness checkout）本来就在任何 workspace 之外，而终端救援没有审批应答者，`ask` 策略会 fail-closed 到一个字节都写不进去。要收紧：`--permission-mode workspace-write --workspace <dir>`，或 `read-only` 只诊断。人能看到 agent 跑的每条命令（transcript + 会话日志）。
2. **`fix` / `supervise` 会改动你的 profile 文件**（`cordis.patch.yml` 与 `package.json`），写前一律备份为 `<文件>.rescue-bak-<时间戳>`。它只做两件事：在 profile 自己的 patch 层追加禁用补丁，以及从 `dsh.profile.bundles` 里移除启动器装载不了的 bundle。不碰 bundle 包本身、不删文件、不改 harness 源码；**复验失败会整体回滚**。移除 bundle 只是移出列表，包还在 `node_modules` 里、`dependencies` 条目也保留，装回来是一行的事。
3. **只覆盖启动窗口内的失败**（默认 25s，`--timeout` 可调）。起来之后才崩不在职责内；但**崩溃归因不依赖这个窗口**（见下）。
4. **需要一个可用的部署平面**：某个 `node_modules` 里仍有 `@deepseek-ai/cordis`、`cordis-plugin-include`、`dsh-app-boot`、`dsh-base`。连这些都丢了就只剩静态诊断（退出码 2）。
5. **`fix` 只自动处理两类故障**——插入的行其包解析不了、bundle 装载不了。重复 entry id、悬空 junction、损坏的会话日志需要人决定，只报告不猜。
6. **救援树只保证与 DSH `0.1.3-alpha.1` 同版本实测**；它按 `dsh-base` 的行 id 覆盖配置，跨大版本升级后行 id 可能变，届时以 `dsh-rescue doctor` 的报错为准。
7. **别把 `--state-root` 指到会被清理的目录**：救援会话、incident 现场、transcript 都在里面。
8. 两处环境限制（详见文末「已知限制」）：宿主进程若跑在限制命名管道的沙箱里，agent 的 `pwsh`/`bash` 工具起不来；若宿主的文件沙箱连「覆盖已存在文件」都拒绝，agent 改不动 profile 文件——这两条路径下用 `dsh-rescue fix`，或让 agent 把精确改法报给人工执行。

---

## 它解决什么问题

改 DSH 自身相关的东西（装插件、写 preset、改 profile 组合、注入 bundle）很容易把启动链弄断：profile 里的某个 bundle 解析不了、`cordis.patch.yml` 里 id 重复、junction 悬空、某个插件的 `apply()` 抛异常…… 结果 `dsh --profile web` 直接退出，Web UI 起不来，于是**没有 agent 可以帮你修**——修 DSH 的工具恰恰挂在修坏的那棵树上。

本插件的核心是一条**不读失败组合**的启动路径：

- 不读 profile 的 `cordis.patch.yml`，不读 `$DSH_HOME/cordis.patch.yml`，不读 profile 的 bundle 列表；
- 只用「部署平面」（一个完整的 `node_modules`）里的 `@deepseek-ai/dsh-base` + 本插件自己的组合文件，另起一棵极简树；
- 不经过 `apps/cli` 的 profile 启动代码，因此 profile 组合坏成什么样都不影响救援 agent 启动。

## 两个面

一个包，两个入口，分别对应「平时」和「已经崩了」：

| 面 | 入口 | 何时用 |
| --- | --- | --- |
| **独立救援 CLI** | `node <包目录>/lib/cli.js`（也写成 `$DSH_HOME/rescue/dsh-rescue.cmd`） | dsh 起不来时。**不依赖 DSH 启动路径**，只需要 Node。 |
| **进程内 bundle** | `cordis.patch.yml` 插入 `dsh-rescue` 行 | dsh 正常时。给模型三个工具：诊断、留交接条、把救援 agent 甩到独立进程里去。 |

## 用法

### 先记住怎么调用它

`dsh-rescue` **不是**一个装完就能敲的命令：启动器写在 `$DSH_HOME/rescue/`，而这个目录默认不在 PATH 上。直接敲裸名字会得到 `CommandNotFoundException`，看上去像「插件根本没装」，实际只是目录没上 PATH。所以先用完整路径把它调起来：

```powershell
# A. 完整路径（不动任何环境变量，崩了也能立刻用）
& "$env:USERPROFILE\.dsh\rescue\dsh-rescue.cmd" doctor

# 等价的原始形式（不依赖启动器是否存在）
node C:\Home\skyer\dsh-rescue\lib\cli.js doctor
```

```sh
# B. 让裸名字可用（Windows；写完要重开终端才生效）
[Environment]::SetEnvironmentVariable('Path', [Environment]::GetEnvironmentVariable('Path','User') + ';' + "$env:USERPROFILE\.dsh\rescue", 'User')
```

两点权衡：① 这个目录同时存放救援状态（会话、incident、transcript），放上 PATH 会让整个目录出现在命令补全里；② 不想动环境就固定用 A，两种方式完全等价。挂载时插件会自己检查这件事：目录不在 PATH 上就在 stderr 打一条提示（含上面那条一次性 PATH 命令），并且**只在状态变化时提示一次**（首次，或从在 PATH 变成不在 PATH），免得每次启动都重复同一段建议；`dsh-rescue shim` 是人工显式调用，仍然每次都说全。

```
dsh-rescue doctor [--json]            纯静态诊断：不启动、不调模型
dsh-rescue verify                     真启一次目标 profile，报告起没起来
dsh-rescue fix [--dry-run]            只做「可证明」的机械修复（确定性，不调模型）
dsh-rescue repair [任务...]           拉起极简创造模式 agent 修复（给任务=一次性，不给=交互 REPL）
dsh-rescue supervise [-- <dsh 参数>]  先正常启目标 profile；起不来就自动修（先机械，后 agent）
dsh-rescue shim                       在 $DSH_HOME/rescue 下装一个短启动器
dsh-rescue spare [--check]            建一个备用平面（升级期间的保险），或检查已有的那个
```

常用参数：

| 参数 | 说明 |
| --- | --- |
| `--plane <dir>` | 指定部署平面（`node_modules` 根）。默认按 显式 → `$DSH_RESCUE_PLANE` → `$DSH_HOME/profiles/node_modules` → 本包 node_modules → checkout 的 `apps/cli/node_modules` 顺序探测，取第一个可用的 |
| `--profile <name>` | 目标 profile，默认 `web` |
| `--state-root <dir>` | 救援产物与会话状态根目录，默认 `$DSH_HOME/rescue` |
| `--permission-mode <m>` | `read-only` / `workspace-write` / `danger-full-access`，默认 `danger-full-access` |
| `--model` / `--provider` | 覆盖救援 agent 的模型路由，默认沿用部署自己的 `agent-default-model` |
| `--timeout <ms>` | 启动窗口，默认 25000。窗口内仍存活 = 起来了 |
| `--no-llm` | 只做确定性那一段，绝不调模型 |
| `--from <dir>` / `--dest <dir>` | `spare`：从哪个平面建、建到哪里，默认「第一个可用平面」→ `<state-root>/plane` |
| `--copy` | `spare`：复制包而不是链接（物理独立，代价与源平面等量的磁盘） |
| `--check` | `spare`：只报告已有备用平面的状态，不重建 |

退出码：`0` 正常 / `1` 救援 agent 报告失败 / `2` 没有可用的部署平面 / `3` 救援树自己起不来 / `4` 目标 profile 没起来 / `5` 没有可机械修复的问题 / `6` 备用平面缺失或不完整。

## 典型流程

下面用 `$rescue` 指代「怎么调用」里的那条完整路径；已经把它放上 PATH 的话直接写 `dsh-rescue`。

```powershell
$rescue = "$env:USERPROFILE\.dsh\rescue\dsh-rescue.cmd"   # 或 node <包目录>\lib\cli.js

# 1. 平时：确认部署健康，并在做危险动作前留一张交接条
& $rescue doctor

# 2. 崩了：先看证据
& $rescue verify                  # 真启一次，失败则把完整输出落盘
& $rescue doctor                  # 静态诊断 + 最近一次启动失败

# 3. 一条命令修：先启；起不来就机械修复→复验；还不行才叫 agent
& $rescue supervise -- --port 3080

# 4. 只想机械修复，不想要 agent
& $rescue fix --dry-run           # 先看会改什么
& $rescue fix

# 5. 想自己盯着改
& $rescue repair                  # 交互 REPL：rescue>
```

## 修复策略：确定性优先，模型兜底

`supervise` 的三段式，按代价从低到高：

1. **捕获**：真启一次目标 profile（默认 25s 启动窗口）。**判定不只看进程是否还活着**：装载失败的 DSH 要十几秒才退出（实测 13.6s），所以进程仍活着时还会看输出里有没有失败特征，并在窗口到期后多留 4 秒再下结论——否则会把一具正在死掉的尸体报成「已启动」，进而跳过修复。退出码 0 = 起来了；非零 = 没起来；仍在运行且输出无失败特征 = 起来了。失败则把命令、cwd、退出码、耗时、**完整 stdout+stderr**、识别出的诊断行，连同失败那一刻的配置文件快照，写进 `incidents/<时间戳>/`。
2. **机械修复**（不调模型）：只有两类故障有唯一最小修法，两类都是启动器本身逼出来的：
   - **插入的行其包解析不了** —— 在 profile 自己的 `cordis.patch.yml` 末尾追加一条禁用补丁。不删任何内容，无论这条 insert 来自 profile 还是它下面的 bundle 都有效。
   - **bundle 装载不了** —— bundle 层**没有 disable 开关**，所以唯一的最小修法是把它的名字从 `dsh.profile.bundles` 里移除。包留在 `node_modules`、`dependencies` 条目也留着，装回来是一行的事。判据与启动器一致：包能按 Node 的真实解析搜到、manifest 里有 `dsh.bundle.patch`、那个文件确实存在——三者任一不满足，整棵树都装载失败（诊断里分别报 `bundle-unresolved` / `bundle-no-patch` / `bundle-patch-missing`）。
   - **绝不删掉挂载本插件自己的那个 bundle**：否则下一次崩溃就没有工具可用了。
   - 每次写入前都先证明新内容可解析（patch 层或 manifest 解析不了会让整棵树拒绝装载），并备份为 `<文件>.rescue-bak-<时间戳>`。
   - **复验失败就整体回滚**：自动写入者证明不了自己有用时，必须把现场还原成它接手时的样子，让 agent 面对原始状态而不是一堆被否掉的改动。
   - 其余类别（重复 id、悬空 link、损坏会话）需要人决定保哪个、装什么，只报告不猜。
3. **agent 兜底**：机械修复没救回来，才把「诊断 + 失败原文 + 机械修复已尝试并回滚」交给救援 agent。

`supervise` 全程退出码 `0` 的含义是：**profile 最终起来了**，无论靠机械修复还是靠 agent。

## 更新 DSH 之后还能用吗

救援层是**按 id 覆盖**部署自己 `dsh-base` 的那些行（persona、权限、状态目录、技能目录）的。**被覆盖的行一旦不存在，Loader 只警告、不报错**——救援照样启动，却悄悄退回 dsh-base 的默认值：agent 被限制在工作目录内，审批策略又回到 `ask` 而终端救援没有应答者，于是一个文件也写不动，而输出里不会有任何东西说明原因。

所以这件事被拆成两道：

- **启动前**：`dsh-rescue doctor`（或 `rescue_doctor`）把救援层与当前部署的 base bundle 做组合比对，报出覆盖了但不存在的行、与部署冲突的插入行、包缺失的插入行；权限行缺失直接报 error，并指出该改哪个文件。
- **启动后**：`repair` / `supervise` 读回**已挂载**的树确认权限覆盖真的生效；确认失败就**拒绝启动**，而不是跑一个修不了东西的 agent。它只在「行不存在」或「解析后的值确实不符」时拒绝；值读不出来只警告——不能因为读不懂就否掉一个正常部署。

判定用的是**启动器自己的口径**：按 Node 的真实包搜索解析 + 组合后的行 id 集合。当前 dsh-base `0.1.3-alpha.1` 上的结论是 `ok: true`（8 个覆盖行 + 2 个插入行全部命中）。

升级 DSH 后的推荐动作：

```sh
dsh-rescue doctor          # 先看 rescue-composition 那一条
dsh-rescue fix --dry-run   # 顺带看部署本身有没有需要机械修复的
```

若报 `rescue-composition-critical`，说明这次升级挪动了权限行；改 `rescue.cordis.yml` 里的行 id 即可，或用 `--plane` 指向一个仍然匹配的平面（例如旧的安装）。

### 拿它当「升级保险」：管什么、不管什么

可以拿它守着升级，但先分清边界：升级时最容易坏的是**配置面**（profile 组合、patch 层、bundle 列表、插件兼容），这正是它的主场；升级前 `doctor` 一次、用 `rescue_handoff` 留条，升级后起不来就 `supervise`。

它**不是**升级器，也兜不住下面这几类：

| 升级带来的问题 | 能不能救 | 原因 |
| --- | --- | --- |
| profile 组合 / patch 层 / bundle 列表坏了 | 能 | 救援路径不读这些文件，另起一棵树 |
| 装插件、写 preset 之后启动链断掉 | 能 | 同上（exit code 3 只表示「所有平面都起不来」） |
| 新版本挪了行 id、权限覆盖失效 | 能提前发现 | `doctor` 报 `rescue-composition-critical`，改 `rescue.cordis.yml` 的行 id |
| **checkout 自己编译坏了**（`pnpm build` 失败、`lib/` 缺文件） | **不能** | 平面里的包就是坏的那一份；`--plane` 指向另一个完好安装才有救 |
| 升级把 `node_modules` 删空 / 依赖装不上 | **不能** | 没有可用平面时只剩静态诊断（退出码 2） |
| 想退回上一个版本 | **不能** | 它只改 profile 的 patch 层与 bundle 列表，不管版本 |

**把「不能」那一栏变成「能」的办法**：升级前先建一个**备用平面**。

```powershell
& $rescue spare                  # 从当前可用平面建一个备用平面（默认 <state-root>/plane）
& $rescue spare --check          # 升级后确认它还完好
& $rescue repair --plane "$env:USERPROFILE\.dsh\rescue\plane"   # 本体起不来时从备用平面救援
```

两种模式，区别就是这个功能的全部意义：

| 模式 | 命令 | 挡得住 | 挡不住 |
| --- | --- | --- | --- |
| **links**（默认） | `spare` | profile / patch / bundle / 插件层面的损坏；瞬时完成，不占额外磁盘 | 源安装的**包本身**被替换或删除（链接跟着走） |
| **copy** | `spare --copy` | 上面全部，外加源安装被整体替换：备用平面是物理独立的 | 占用与源平面等量的磁盘；建立时要遍历复制 |

它和正在被升级的安装互不影响，因为救援只从平面读包，不读 profile 组合，也不要求平面叫 `node_modules`。

## 崩溃归因：没人看着也能知道上次崩了

`supervise` 要求有人先在终端敲它。**boot 握手补上了这个缺口**：进程自己死掉时无法写遗言，所以握手反着来——

- 进程内插件挂载时先把记录打开为「未完成」（`$DSH_HOME/rescue/boot-state.json`，`ok: false`）；
- 只有真正到达就绪状态才把它关成「已完成」。就绪信号优先取启动器自己的 `appReady`；没有该信号的界面回退到 30s 计时；
- 于是**下一次挂载**（或 `dsh-rescue doctor`，它读同一个文件）就知道上一次没起来，`lastGoodAt` 作为「最后正常启动时间」锚点活了下来；
- 卸载时若还没就绪，记录为 `cleanExit: true`——**被主动停掉的启动不算崩溃**，否则这个告警会被训练成噪音；
- 崩溃当次就把日志签名分类**写进记录**（`session-corrupt` / `bundle-check` / `patch-tree` / `port-bind` / `settings` / `unknown`），免得日志滚动之后归因丢失。

`doctor`、`rescue_doctor`、以及救援 agent 的 mission 都会带上这条历史与对应的处置建议。

## 救援 agent 拿到什么

启动前先做**确定性诊断**（`doctor`，不调模型），再把诊断 + **失败原文**一起塞进 mission：

- 失败现场：命令、cwd、退出码、耗时、是否起来、**完整 stdout+stderr 原文**、识别出的诊断行；
- 现场快照：失败那一刻的 `package.json`、`cordis.patch.yml`、home patch、`settings.yaml` 副本；
- 静态诊断：平面可用性、每个 profile 的 bundle 解析、`link:` 目标与 junction 一致性、每层 patch 的解析与 id 重复、孤儿 patch、禁用行、模型路由、凭据可得性（只报有没有，绝不打印值）；
- 路径坐标：`$DSH_HOME`、profiles 目录、目标 profile、救援平面、源码 checkout、本次产物目录、**验证命令原文**；
- 修复手册：先加载 `rescue-repair-playbook` 技能（把启动诊断映射到具体文件和最小修法），再加载随部署发行的 `editing-cordis-compositions`。

工具面与「创造模式」一致：`read/write/edit/glob/grep`、`pwsh`/`bash`、`str_replace_editor`、`skill`、`todo_write`、`web_search/web_fetch`，以及全套自指工具 `cordis_inspect_*` / `cordis_define` / `cordis_run` / `cordis_stop` / `cordis_undefine`。

## 产物位置

```
$DSH_HOME/rescue/
  dsh-rescue.cmd|.sh          短启动器
  handoff.md                  进程内 rescue_handoff 写的交接条（mission 会带上）
  boot.log                    最近一次启动捕获
  incidents/<时间戳>/          失败现场：incident.json / output.log / 现场快照
  incidents/latest.json       最新一次，doctor 会读
  runs/<时间戳>/              每次救援：doctor.txt|json / mission.md / transcript.txt
  runtime/                    救援树锚点 + 指向平面的 node_modules 链接
  plane/                      备用平面（dsh-rescue spare 建；--plane 可直接指它）
  .shim-path-state            PATH 提示上次出现时的状态，用来避免重复提示
  sessions|storages|home/     救援 agent 自己的会话与状态（默认跟随部署，可被 --state-root 重定向）
```

## 为什么默认 `danger-full-access`

修复目标（`$DSH_HOME/profiles/...`、harness checkout）本来就在任何 workspace 之外；而终端救援没有审批应答者，`ask` 策略会 fail-closed，agent 一个字节也写不进去。所以这里**显式写下**权限，而不是继承环境变量（环境变量本身可能就是坏的那一环）。人的可见性来自 transcript 与会话日志——agent 跑的每条命令都在里面。要收紧就传 `--permission-mode workspace-write --workspace <dir>`，或 `read-only` 只诊断。

## 可靠性设计

- **平面回退**：一个平面起不来就换下一个可用平面；全都不行才放弃，并把诊断与失败原文打出来（退出码 3）。
- **不读坏组合**：救援树只由 `dsh-base` 的 bundle patch + 本包 `rescue.cordis.yml` + runner 行组成；`rescue.cordis.yml` 只按 id 覆盖基础行。
- **树基可解析**：救援树锚点与 runner 放在同一目录，该目录的 `node_modules` 指向平面，宿主行按 id 解析裸包名时也走这条路。Node 的裸名解析**总会**插入一段 `node_modules`，所以基址必须是「含有 `node_modules` 的那个目录」，而不是平面根本身：把平面根交出去只有在平面恰好叫 `node_modules` 时才成立。早期版本就是这么错的，于是 `--plane <任意别的目录>` 不报错、只是**一行都解析不出来**，然后悄悄回退到别的平面，看上去像「平面参数没生效」。现在 `--plane` 指向任何名字的平面都能启动（实测：一个叫 `alt-plane` 的独立安装平面完整跑通救援 agent；把该平面里的 `dsh-base` 换成会抛错的桩之后，失败信息点名该平面路径，反证前一次的成功确实来自它）。
- **模型路由预检**：每轮之前先跑一次「请求装配」预检（不发网络请求），把 `REQUEST_EXTENSION` 这类不透明错误变成点名到包的具体错误。
- **无模型也能用**：没 key、没网、模型过期都不影响 `doctor`/`verify`/`supervise --no-llm` 给出结论。
- **启动器自愈**：`runtime/` 与 `node_modules` 链接每次运行校验重建。

## 进程内工具

| 工具 | 作用 |
| --- | --- |
| `rescue_doctor` | 在当前会话里跑同一套确定性诊断 |
| `rescue_handoff` | 把「我在干什么、下一步该做什么」写进 `$DSH_HOME/rescue/handoff.md`，并给出救援命令 |
| `rescue_launch` | 把救援 agent 甩到一个**独立进程**（脱离当前进程），返回 pid 与日志路径 |

危险自改之前的标准动作：先 `rescue_handoff` 留条，必要时 `rescue_launch`；真崩了就在终端 `dsh-rescue supervise`。

## 已知限制

- 救援树依赖部署平面里的 `@deepseek-ai/*`。如果连 `@deepseek-ai/cordis` / `dsh-base` / `dsh-app-boot` 这些核心包本身都被删了，那就没有任何平面可用（退出码 2），只剩静态诊断。
- 平台自带的 `pwsh`/`bash` 工具以管道方式起子进程；如果宿主进程本身跑在限制命名管道的沙箱里，这些工具会失败。此时 fs 类工具仍可用，agent 会按 mission 要求改用文件编辑 + 把精确改法报给人工。
- 若宿主的文件沙箱连「覆盖已存在文件」都拒绝（Windows 上表现为 ACL 保留的原子替换报 EPERM），agent 改不动 profile 文件。这条路径下用 `dsh-rescue fix`（走 `node:fs` 直写，不经工具层）或让 agent 把改法报出来由人工执行。
- `supervise` 只覆盖**启动窗口**内的失败（默认 25s）。起来之后才崩的情况不在它的职责内；崩溃**归因**不受这个窗口限制（见「崩溃归因」）。
- boot 握手只能报告「上一次启动没到就绪」。首次运行之前没有记录，插件本身没被挂载时也不会有记录。

## 机械修复的判定口径（踩过的坑）

判断「某行解析不了」时，必须先把 subpath 剥掉：`@scope/pkg/sub` 和 `pkg/sub` 的包名分别是 `@scope/pkg` 和 `pkg`。早期版本拿整个 specifier 去找 `node_modules/<specifier>/package.json`，于是把 `@deepseek-ai/dsh-web-app/startup`、`@deepseek-ai/dsh-tool-subagent/model-selection-settings` 这类**子路径导出行**误判成坏行并自动禁用——那会把 Web 面直接干碎。现在这类误判被单测口径修正，并且复验失败会整体回滚，作为第二道防线。

判断「某个 bundle 装载不了」时用的是**启动器自己的判据**，不是「目录存不存在」：按 Node 的真实包搜索（从 profile、harness home、部署平面依次为锚点）解析到包 + manifest 里声明了 `dsh.bundle.patch` + 那个文件确实存在。直接拼 `node_modules/<name>` 会把父级目录本可提供的包报成缺失，而这个检查存在的意义就是和刚失败的那次启动保持一致。

## 构建与门禁

```sh
DSH_CHECKOUT=/path/to/deepseek-harness bash scripts/build.sh
npm test            # = check:version + check:size + smoke-test
```

编译 `src/` → `lib/`，并把编译期依赖链接到 checkout。运行时不需要这些链接：救援路径在 `$DSH_HOME/rescue/runtime/` 里自建指向部署平面的解析链。

三道门禁（`npm test` 一次跑完）：

| 门禁 | 挡什么 |
| --- | --- |
| `npm run check:version` | 版本号四处不一致：`package.json`、`src/version.ts` 的 `PACKAGE_VERSION`、README 头部、CHANGELOG 最新段；以及四段版本号这类非 semver 写法 |
| `npm run check:size` | 整体积或单文件超限（挡住误提交的构建树、附件） |
| `npm run smoke-test` | 纯逻辑回归：崩溃分类、specifier→包名、命令行文法、boot 握手、bundle 判据与机械修复（含 dry-run 不写、rollback 还原、拒删救援自身）、裸名基址（平面不叫 `node_modules` 也能解析）、PATH 判定 |

`smoke-test` 跑在 `lib/` 上，所以先 `npm run build`。它不需要 DSH、不需要网络、不调模型，全部在临时目录里自建 fixture 并自清理。

版本、commit、tag、Release、CHANGELOG 的格式规则见 [CONVENTIONS.md](CONVENTIONS.md)。
