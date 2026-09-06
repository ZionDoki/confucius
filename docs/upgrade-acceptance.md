# 0.3.8 → 0.4.0-beta.1 升级验收

2026-09-06 在 macOS、Zotero 10.0.1 完成。结论：**本轮第 1 项通过**。真实基础模型与 Windows 验收按发布取舍留到下个版本，见 [Windows 后续验收](windows-acceptance.md)。

## 使用的包与环境

旧包直接下载自 GitHub 已发布的 `v0.3.8/confucius.xpi`，SHA-256 为 `4c0a498a3a52597d7c38fb32d892021e1585102dff84b05ab1713402ea451b32`，与发布资产的摘要一致。候选为仓库构建的 `0.4.0-beta.1` XPI。

脚本每次创建独立的 `.scaffold/upgrade-acceptance-*/profile` 和 `data`，通过 Zotero 的 AddonManager 安装候选包，确认运行版本确已切换。模型请求发往本机确定性测试服务；文献条目、笔记、任务、历史、检查点和成果均由真实旧版插件及 Zotero API 产生。未使用个人模型凭据，未迁移当前开发库或用户主库。

## 已核对结果

| 检查           | 结果                                                                                         |
| -------------- | -------------------------------------------------------------------------------------------- |
| 旧版实际写入   | 创建 1 条真实 Zotero 笔记，保存成功调用的检查点与返回结果                                    |
| 跨窗口历史     | 保留第 2 个上下文窗口的原 ID，旧版 17 个 runtime 文件参与核对                                |
| 工作笔记与成果 | 工作笔记的 2 个版本、同一 artifact 的 2 个 revision 保留，内容和身份一致                     |
| 强制中断与升级 | 在笔记已写入、后续模型响应未返回时停止测试进程；旧版恢复后通过正常 AddonManager 升级         |
| 源文件与备份   | 旧历史正文逐文件 SHA-256 一致；迁移源保留，`state.json.pre-v4-backup` 与升级源状态一致       |
| 第一次新版重启 | 任务为可继续的 interrupted 状态，检查点完整，升级和重启期间模型请求数为 0                    |
| 显式继续       | 测试服务再次请求同一已完成调用，复用旧结果；笔记仍为 1 条、key 不变，消耗的迭代从 2 累计到 4 |
| 完成后再次重启 | 任务仍为 completed，笔记和成果内容不变，artifact revision 保持 2                             |
| 诊断报告       | 可导出 23 个可用事件、21 条历史记录和 2 个工作笔记版本，无读取缺口                           |

这是包升级、持久化与实际副作用的验收，不代表真实模型的自主任务成功率评测。原始结果保存在运行机器的 `output/upgrade-acceptance.json`，包含 XPI 摘要、环境、各阶段实体和检查记录。CI 重建包的时间戳可能改变二进制摘要，源码版本与行为验证范围应一并核对。

原迁移源和备份用于诊断与恢复。新版写入的 runtime 状态不会自动同步回旧版目录，降级不能视为一次反向迁移。

## 复现

在 macOS 安装 Zotero 后，从仓库根目录执行：

```sh
mkdir -p output/release-acceptance/v0.3.8
gh release download v0.3.8 --repo ZionDoki/confucius \
  --pattern confucius.xpi --dir output/release-acceptance/v0.3.8
npm run build --workspace=@confucius/zotero-addon
node scripts/live-upgrade.mjs
```

可通过 `--zotero`、`--old-xpi`、`--new-xpi` 和 `--output` 指定程序、安装包与报告位置。脚本只停止自己创建的进程，保留隔离测试目录供排查；Windows 的启动与版本兼容验收尚未完成。
