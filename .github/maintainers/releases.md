# 版本与发布规范

本文约束 Confucius 的版本号、Beta 开关、更新说明和 GitHub Release 流程。
[AGENTS.md](../../AGENTS.md) 要求涉及发布的修改遵循本文。产品版本以根
`package.json` 为准，发布说明以 [CHANGELOG.md](../../CHANGELOG.md) 为准。

## 版本号与渠道

| 类型   | 包版本示例     | Git tag         | GitHub Release                                           |
| ------ | -------------- | --------------- | -------------------------------------------------------- |
| 稳定版 | `0.4.0`        | `v0.4.0`        | `prerelease: false`；发布当前稳定线的新版本时设为 Latest |
| Beta   | `0.4.0-beta.2` | `v0.4.0-beta.2` | `prerelease: true`；`make_latest: false`                 |

- 使用 SemVer 的数值顺序，不按字符串或发布时间排序。数字不能有前导零，Beta
  序号从 1 开始；公开版本暂只使用稳定版和 `beta.N`，不用 `latest`、日期、
  `-dev`、`+build` 或临时后缀作产品版本。
- 稳定线的兼容修复递增 PATCH；新增功能通常递增 MINOR；破坏性公共接口变更
  在 1.0 之后递增 MAJOR。0.x 阶段的破坏性变更递增 MINOR，并在升级说明中列明。
- 同一个目标版本的 Beta 递增序号，例如
  `0.4.0-beta.1 → 0.4.0-beta.2 → 0.4.0`。`beta.10` 高于 `beta.2`，
  同基础版本的稳定版高于所有 Beta。
- 已发布的代码或 XPI 有变化就必须使用新版本。不要移动已发布的 tag、覆盖同版本
  XPI，或把同版本不同内容当作可自动更新的修复。仅补正文错字时保留事实与原版本。
- 普通开发不必每次改动都升版，先维护 `Unreleased`；准备发布候选时再统一升版。
  Beta 转正式版时使用同基础版本的稳定版号；每次发版先核对远端，不能照抄示例。

`releases/latest`、README 下载链接和徽章代表稳定渠道。需要维护旧稳定线时，
不要让较低版本的补丁覆盖当前稳定线的 Latest；修改发布工作流的 Latest 设置后
核对实际结果。

## 插件更新与 Beta 开关

入口是 **Confucius 设置 → 更新 → 接收测试版更新（可能不稳定）**。

| 状态                                 | 检查行为                                          |
| ------------------------------------ | ------------------------------------------------- |
| 关闭测试版开关                       | 只比较已公开的稳定版                              |
| 开启测试版开关                       | 比较稳定版和 Beta，提供其中高于当前版本的最高版本 |
| Beta 用户关闭开关                    | 保留当前安装版本；等待更高的稳定版，不自动降级    |
| 没有更高版本                         | 成功获取并比较发布信息后显示“已是最新版本”        |
| 网络错误、限流、发布包缺失或校验失败 | 显示错误或稍后重试提示，不显示“已是最新版本”      |

“自动检查更新”是另一项独立设置：启动约 30 秒后检查，之后每 6 小时检查，
安装由用户点击“下载并安装”触发。关闭自动检查仍可手动检查，也不会改变 Beta 选择。

用户的显式渠道选择保存在 `extensions.zotero.confucius.updateChannel`：
`stable` 表示关闭，`beta` 表示开启。初始 `auto` 状态按当前安装包决定：稳定包默认
关闭，手动安装的 Beta 包默认开启。一旦用户切换，后续升级不得按新包类型覆盖选择。

更新服务直接读取 GitHub Releases API，过滤 draft 和不符合渠道的版本；下载
`confucius.xpi` 时使用该资产的 GitHub API 地址，核对资产大小和 SHA-256，再确认
插件 ID、包版本和 Zotero 兼容性。Zotero 只承担最终 XPI 安装接口；检查和定时器
不依赖 Zotero 的全局自动更新开关。

首次迁移到这个更新器的旧安装包仍运行旧更新逻辑，必要时需要手动安装包含新
更新器的 XPI。`npm start` 启动的临时开发插件用于开发验证，不代表普通安装包
已经完成升级与重启验收。

## 更新说明

日常修改在 `## Unreleased` 下记录。准备发版时，将本次实际包含的改动整理为
`## <完整版本号> - YYYY-MM-DD`，日期使用发布日的 UTC 日期，按新到旧排列。
同一版本只能有一个条目；`Unreleased` 不进入 GitHub Release 正文。

Beta 说明记录相对上一次公开版本的变化；转为稳定版时，汇总自上一个稳定版以来
已经验收的用户变化，不能只写最后一个 Beta 的增量。稳定版的 Full Changelog
链接比较前一个稳定版，Beta 的链接比较前一个公开版本。

CHANGELOG 继续使用英文作为发布正文，中文操作说明放在本文和中文 README。
每条说明交代用户遇到的情况和改变后的行为；技术实现仅在解释兼容性、迁移或
限制时展开。不得直接粘贴 commit 列表，也不得把历史验证结果写成新版本实测。

每个新发布条目包含以下内容：

1. 用户可感知的新增、变化和修复，可按 `Added`、`Changed`、`Fixed` 分组，空组省略。
2. `Upgrade notes`：适用渠道、进入 Beta 的方法、需要重启／重新配置的步骤、迁移与
   回退限制；没有迁移时明确说明，无需重复完整安装教程。
3. `Validation and known limits`：本次实际执行的检查、OS／Zotero 环境、结果和证据
   链接；未执行或失败的验收必须明确标注，Beta 尤其需要说明剩余限制。

以下是格式示例，不表示这些测试已经执行；正式发布必须用本次事实替换说明：

```markdown
## 0.4.0-beta.2 - 2026-09-06

### Fixed

- Confucius can discover newer releases when Zotero's global automatic updates
  are disabled. The Beta switch controls whether preview releases are offered.

### Upgrade notes

- This is a Beta release. Enable Include prereleases in Confucius Settings →
  Update. Older packages without that switch require a manual XPI installation.
- State whether this release migrates data and describe any rollback limits.

### Validation and known limits

- Record the checks actually run, their results and the tested environments.
- List remaining limitations and link to the corresponding acceptance records.
```

发布前用 `npm run release:check -- v<版本号>` 检查版本一致性、tag 和更新说明。
该命令检查版本格式、tag 完全匹配、条目唯一性、真实日期和非空正文／占位符；
变化描述是否准确、验收是否充分仍须人工按本文核对。
GitHub Release 正文通过 `node scripts/release-notes.mjs v<版本号>` 提取，脚本补充
Full Changelog 比较链接；不要单独手写一份不同的 Release 正文。标题固定为
`Confucius v<版本号>`，tag、标题、正文所属版本和 XPI 版本必须一致。
正式条目中的仓库文档链接使用固定到本次 tag 的完整 GitHub URL，避免相对链接在
Release 页面失效，或链接到后来已变化的 `master` 文档。

## 准备与本地检查

以下命令在仓库根目录执行，`0.4.0-beta.2` 仅作示例。

1. 检查 `git status`、同步远端，查看现有 tag 和 Release，确定版本未被使用、提交
   范围正确。保留与本次发布无关的用户改动。
2. 用 npm 同步根包和全部 workspace 的版本：

   ```sh
   npm version 0.4.0-beta.2 --workspaces --include-workspace-root --no-git-tag-version
   ```

   同步修改 `packages/protocol/src/version.ts` 的 `CONFUCIUS_VERSION`。确认
   `package-lock.json` 顶层、`packages[""]` 和所有本地 workspace 条目的版本
   也已更新，随后运行 `npm run versions:check`。

3. 整理 CHANGELOG 的对应版本条目及受影响的 README、迁移与验收文档。
4. 完成发布前检查：

   ```sh
   npm run release:check -- v0.4.0-beta.2
   npm run sync-skills:check
   npm test
   npm run typecheck
   npm run lint
   npm run build
   ```

5. 核对以下产物，并在隔离的 Zotero 配置中验证安装和升级。测试报告记录提交号、
   XPI 摘要、环境与结果。构建成功不等于安装验收通过；本地构建与 CI 构建的时间戳
   可能不同，不应声称它们的二进制摘要必然相同。

### 必须核对的产物

构建目录：`apps/zotero-addon/.scaffold/build/`。

| 产物／字段                | 要求                                                                                                                        |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `confucius.xpi`           | 固定文件名；内含 `manifest.json`；插件 ID 为 `confucius@zotero.plugin`                                                      |
| XPI manifest 的 `version` | 等于根包版本，不能带 `v`                                                                                                    |
| Zotero 兼容范围           | manifest 与更新文件一致，声明范围内有相应验证依据                                                                           |
| Beta 更新文件             | 必须有 `update-beta.json`；不得把 Beta 写进稳定 `update.json`                                                               |
| 稳定版更新文件            | 必须有 `update.json`；当前 scaffold 同时生成 `update-beta.json`                                                             |
| 更新记录的 `version`      | 等于本次发布的完整版本                                                                                                      |
| `update_link`             | 指向本次 tag 下的 `confucius.xpi`，格式为 `https://github.com/ZionDoki/confucius/releases/download/v<版本号>/confucius.xpi` |
| 更新文件的 `update_hash`  | 与本次实际 XPI 的 SHA-512 一致                                                                                              |
| GitHub XPI 资产           | `state: uploaded`，正确的非零 `size`，存在 `sha256:<64 位十六进制>` 的 `digest`；与下载包核对                               |

JSON 更新文件保留给 Zotero 原生更新地址的兼容用途；插件自己的更新器读取
GitHub Release 与资产信息。两者都要正确，不能只上传 JSON 而遗漏 XPI。
构建应从干净的输出开始，不能把上次稳定构建留下的 `update.json` 混入 Beta。

## 发布与发布后验收

完成准备后，在本次发布提交上创建与版本完全一致的 tag。将发布提交和 tag 推送
到远端会触发 `.github/workflows/ci.yml`；按当前任务已有的发布授权执行这一步。
仅准备代码和文档时，不应把工作描述成“已发布”。

CI 会在 Node.js 22、24 上验证，再构建并上传 Release 产物。Beta 必须保持
prerelease 且不成为 Latest。发布说明必须由版本条目生成，所有资产上传完成后
再以用户视角检查：

| 场景                            | 预期                                             |
| ------------------------------- | ------------------------------------------------ |
| 旧稳定版、Beta 开关关闭         | 看不到 Beta；存在更高稳定版时可发现它            |
| 同一安装、Beta 开关开启         | 能发现更高的 Beta，并下载、校验、安装            |
| Beta 1 → Beta 2                 | 正确比较序号并发现更新                           |
| Beta → 同基础版本的稳定版       | 能升级至稳定版                                   |
| Beta 用户关闭开关               | 不降级；开关状态重启后保留                       |
| Zotero 全局自动更新关闭         | Confucius 手动检查及自身自动检查仍正常           |
| 网络中断、HTTP 限流或资产不完整 | 明确显示失败，可重试，不误报最新                 |
| 打开工作区设置点击安装          | 自动重载插件和工作区，保留所选会话、草稿、布局和设置页；显示新版本，无需手动开窗 |
| 连续热更新、工作区预先关闭      | 后续仍可检查更新、切换渠道；已关闭的工作区不会被自动打开 |
| 安装后重启                      | 实际版本已改变，已有配置、任务与数据符合迁移约定 |

安装后重启是额外的持久化验收，不代表所有更新都必须重启。分别验证安装已完成与
暂存等待重启的结果；发布操作说明按实际状态描述，不能统一要求重启。

涉及数据或运行时迁移时，按 [升级验收](acceptance/upgrade-acceptance.md) 的方法建立新的
版本验收记录；Windows 的专项检查参考 [Windows 验收](acceptance/windows-acceptance.md)。
旧文档的“已通过”仅适用于其明确记录的版本和环境。

若发布资产上传失败，可对同一源码提交重试尚未完成的发布，但不要用新代码替换
已经可供用户下载的同版 XPI。已公开的版本存在功能缺陷时发布更高补丁版或下一个
Beta；必要时在原 Release 说明中标明缺陷和替代版本。
