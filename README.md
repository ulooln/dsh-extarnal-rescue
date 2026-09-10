# @dsh-external/dsh-rescue

DSH 本体自毁救援：**当 dsh 起不来、Web UI 也进不去的时候**，用一条命令拉起一个独立的、具备「创造模式」工具面的极简 agent，让它诊断并修复本体。

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

```
dsh-rescue doctor [--json]            纯静态诊断：不启动、不调模型
dsh-rescue verify                     真启一次目标 profile，报告起没起来
dsh-rescue fix [--dry-run]            只做「可证明」的机械修复（确定性，不调模型）
dsh-rescue repair [任务...]           拉起极简创造模式 agent 修复（给任务=一次性，不给=交互 REPL）
dsh-rescue supervise [-- <dsh 参数>]  先正常启目标 profile；起不来就自动修（先机械，后 agent）
dsh-rescue shim                       在 $DSH_HOME/rescue 下装一个短启动器
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

退出码：`0` 正常 / `1` 救援 agent 报告失败 / `2` 没有可用的部署平面 / `3` 救援树自己起不来 / `4` 目标 profile 没起来 / `5` 没有可机械修复的问题。

## 典型流程

```sh
# 1. 平时：确认部署健康，并在做危险动作前留一张交接条
dsh-rescue doctor

# 2. 崩了：先看证据
dsh-rescue verify                 # 真启一次，失败则把完整输出落盘
dsh-rescue doctor                 # 静态诊断 + 最近一次启动失败

# 3. 一条命令修：先启；起不来就机械修复→复验；还不行才叫 agent
dsh-rescue supervise -- --port 3080

# 4. 只想机械修复，不想要 agent
dsh-rescue fix --dry-run          # 先看会改什么
dsh-rescue fix

# 5. 想自己盯着改
dsh-rescue repair                 # 交互 REPL：rescue> 
```

## 修复策略：确定性优先，模型兜底

`supervise` 的三段式，按代价从低到高：

1. **捕获**：真启一次目标 profile（默认 25s 启动窗口）。窗口内还活着 = 起来了，直接退出；退出码非 0 = 失败，把命令、cwd、退出码、耗时、**完整 stdout+stderr**、识别出的诊断行，连同失败那一刻的配置文件快照，写进 `incidents/<时间戳>/`。
2. **机械修复**（不调模型）：目前只有一类故障有唯一最小修法——**插入的行其包解析不了**。做法是在 profile 自己的 `cordis.patch.yml` 末尾追加一条禁用补丁（写之前先备份，写之前先用 Loader 自己的 YAML 方言解析一遍新内容，解析不过就拒写）。不动 bundle、不删文件、不改 harness 源码。
   - **复验失败就整体回滚**：自动写入者证明不了自己有用时，必须把现场还原成它接手时的样子，让 agent 面对原始状态而不是一堆被否掉的改动。
   - 其余类别（重复 id、悬空 link、bundle 装不上）需要人来决定保哪个、装什么，只报告不猜。
3. **agent 兜底**：机械修复没救回来，才把「诊断 + 失败原文 + 机械修复已尝试并回滚」交给救援 agent。

`supervise` 全程退出码 `0` 的含义是：**profile 最终起来了**，无论靠机械修复还是靠 agent。

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
  sessions|storages|home/     救援 agent 自己的会话与状态（默认跟随部署，可被 --state-root 重定向）
```

## 为什么默认 `danger-full-access`

修复目标（`$DSH_HOME/profiles/...`、harness checkout）本来就在任何 workspace 之外；而终端救援没有审批应答者，`ask` 策略会 fail-closed，agent 一个字节也写不进去。所以这里**显式写下**权限，而不是继承环境变量（环境变量本身可能就是坏的那一环）。人的可见性来自 transcript 与会话日志——agent 跑的每条命令都在里面。要收紧就传 `--permission-mode workspace-write --workspace <dir>`，或 `read-only` 只诊断。

## 可靠性设计

- **平面回退**：一个平面起不来就换下一个可用平面；全都不行才放弃，并把诊断与失败原文打出来（退出码 3）。
- **不读坏组合**：救援树只由 `dsh-base` 的 bundle patch + 本包 `rescue.cordis.yml` + runner 行组成；`rescue.cordis.yml` 只按 id 覆盖基础行。
- **树基可解析**：救援树锚点与 runner 放在同一目录，该目录的 `node_modules` 指向平面——宿主行按 id 解析裸包名时也走这条路。
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
- `supervise` 只覆盖**启动窗口**内的失败（默认 25s）。起来之后才崩的情况不在它的职责内。

## 机械修复的判定口径（踩过的坑）

判断「某行解析不了」时，必须先把 subpath 剥掉：`@scope/pkg/sub` 和 `pkg/sub` 的包名分别是 `@scope/pkg` 和 `pkg`。早期版本拿整个 specifier 去找 `node_modules/<specifier>/package.json`，于是把 `@deepseek-ai/dsh-web-app/startup`、`@deepseek-ai/dsh-tool-subagent/model-selection-settings` 这类**子路径导出行**误判成坏行并自动禁用——那会把 Web 面直接干碎。现在这类误判被单测口径修正，并且复验失败会整体回滚，作为第二道防线。

## 构建

```sh
DSH_CHECKOUT=/path/to/deepseek-harness bash scripts/build.sh
```

编译 `src/` → `lib/`，并把编译期依赖链接到 checkout。运行时不需要这些链接：救援路径在 `$DSH_HOME/rescue/runtime/` 里自建指向部署平面的解析链。
