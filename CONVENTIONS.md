# 发布与文档规范

> 本仓库的版本号、commit、tag、Release、CHANGELOG、文档格式的固定约定。**规则只有在被机器检查时才算规则**，所以每条能自动化的都对应一道门禁（见文末）。

## 一、版本号

**格式：`vMAJOR.MINOR.PATCH`**（SemVer 三段，带 `v` 前缀）。tag、Release 标题、`package.json` 的 `version`（无 `v`）、`src/version.ts` 的 `PACKAGE_VERSION`、README 头部、CHANGELOG 最新段——六处必须一致。

| 段 | 何时递增 | 例 |
| --- | --- | --- |
| MAJOR | 快照/记录格式不兼容，或使用方式破坏性变化 | |
| MINOR | 新功能、新命令、新的修复类别 | `0.2.0`：bundle 机械修复 + boot 崩溃归因 |
| PATCH | bug 修复、文案、文档、内部强化 | |

**硬规则：**

1. **禁止四段版本号**（`0.3.3.1` 不是 semver，包管理器会拒绝安装依赖它的东西）。
2. **版本号一旦对外出现（commit / 文档 / Release）绝不回收复用**。发布前预留的号被降级复用，会让迁移文档的版本引用错乱。
3. 发布前三查：`package.json` version == tag == Release 标题；`npm test` 绿。

## 二、Commit 消息

**格式：`<type>(<scope>?): <中文描述>`**。type 用英文标准词，描述用中文，一条 commit 一个意图。

| type | 用途 |
| --- | --- |
| `feat` | 新功能 |
| `fix` | bug 修复 |
| `docs` | 文档 |
| `test` | 测试与门禁 |
| `refactor` | 重构 |
| `chore` | 构建、配置、杂务 |
| `release` | 发版专用 |

`scope` 可选：`cli` / `host` / `doctor` / `repair` / `runner` / `tools` / `docs`。

**细则：**

- 发版 commit 写 `vX.Y.Z 摘要A + 摘要B`，版本号后**不加冒号**；变更明细放 CHANGELOG，body 最多列 3–5 条要点。
- 破坏性变更用 `feat!:`，body 里写迁移说明。
- 描述直接写功能本身，不写内部规划编号。

## 三、Tag 与 Release

**Tag：`vX.Y.Z`**，打在对应的 `release:` commit 上，与 Release 同时创建。**Release 标题固定为纯版本号 `vX.Y.Z`**。

Release 正文模板：

```markdown
vX.Y.Z · YYYY-MM-DD

## 亮点
（最多 3 条，一句话一条，面向用户价值）

## 新增
## 修复
## 升级注意
（无则整节省略；写破坏性变化与迁移要点）

## 安装
（安装与升级命令）

完整变更见 CHANGELOG 对应锚点。
```

## 四、CHANGELOG

遵循 Keep a Changelog。版本标题 `## [X.Y.Z] - YYYY-MM-DD`，**新版本在最上**（`check-version` 会验证最新段就是当前版本，而不只是「存在」）。

段名只用：**新增 / 变更 / 优化 / 修复 / 安全 / 测试**。面向用户写「做了什么、为什么」；内部实现细节（函数名、哈希机制）只在影响理解时保留。

每个版本段还应记录**实测结论**与**当时已知的限制**：这份文件是「这版到底验证过什么」的唯一出处，README 描述现状、不写演进史。

## 五、文档

- 双语：**本仓库只有中文文档**。这是一个明确决定，不是遗漏：项目的使用者与维护者是同一批中文用户，维护一份会漂移的英文副本比不维护更糟。若将来出现英文使用者，再按 `README.en.md` / `CHANGELOG.en.md` 成对补，且**改了中文必须同步英文**。
- README 头部固定一行：`**版本 X.Y.Z** · 日期 · 许可 · 状态 · 变更见 CHANGELOG.md`。
- 版本注记（「v0.2.0 起」）只允许出现在 CHANGELOG；README 描述现状。

## 六、叙述文本

适用于 commit 标题、Release / CHANGELOG 条目、README 功能描述：

1. **禁用修辞**：不写比喻、排比、感叹、口号。只写事实、原因、结果；形容词仅在传达可验证信息时保留。
2. **不用破折号引导叙述**；用逗号、句号或括号衔接。
3. 结构性符号不受限：表格、列表、代码块、命令行、markdown 标题照常。

## 七、门禁

| 门禁 | 命令 | 挡什么 |
| --- | --- | --- |
| 版本一致 | `npm run check:version` | 六处版本不一致；四段版本号；CHANGELOG 最新段不是当前版本 |
| 体积 | `npm run check:size` | 整体积或单文件超限 |
| 逻辑回归 | `node tools/smoke-test.mjs` | 崩溃分类、specifier→包名、命令行文法、boot 握手、bundle 判据与机械修复、裸名基址、PATH 判定、平面告警级别 |

`npm test` = 三道门禁依次执行。新增一条**能自动判定的约定**时，同时加一道门禁；只写进本文档而不检查的规则会腐烂。
