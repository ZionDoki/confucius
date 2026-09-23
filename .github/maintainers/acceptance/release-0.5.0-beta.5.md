# 0.5.0-beta.5 发布验收

2026-09-23 UTC，macOS、Zotero 10.0.3、本地 Node.js 23.10.0。
基于主干 `c80b226`，审查文献调研、子 Agent、模型设置、来源授权、恢复和升级。
发布源码由 `v0.5.0-beta.5` 固定；本地候选与公开 CI 安装包分别记录。

## 审查与修复

- 用户可以在确认前选择仅用摘要，或在全文获取过程中按当前结果继续。同一候选版本
  的选择跨重复工具调用及重启保留；候选变化后重新决定。继续不另行授权入库、绑定或
  下载，不主动启动已停止的调研，迟到的下载结果不重新运行任务。
- 缺失摘要按本地 Zotero、OpenAlex、Crossref 有限时查找。记录来源、失败冷却，
  校验 DOI，清理 JATS，凭据不跨站传递。摘要不计作已读取全文，子任务范围不扩张。
- 审查复现并修复远端搜索占用文献状态锁：用户继续和修改候选无需等待网络，返回的
  搜索页合入最新状态，不丢失新决定。
- 审查复现并修复确认绑定失败后丢失复核入口：保留待确认状态，重试不重复建条目。
- 修复继续后迟到预览重新展开及忙碌期间状态更新丢失。实机人为暂停预览请求，点击
  继续并等主任务完成，再释放旧响应；确认内容没有重新出现。

## 发布前检查

- 1,144 项自动化测试通过，零失败、零跳过：根脚本 8、harness 169、mcp-client 5、
  memory 66、protocol 121、skill-format 10、zotero-tools 17、agent-sidecar 31、addon 717。
- 类型检查、lint、构建、版本一致性、技能同步检查通过。发布说明校验使用
  `npm run release:check -- v0.5.0-beta.5`。
- 根包、workspace、锁文件、协议常量、XPI 和更新记录一致；插件 ID、兼容范围
  `6.999–10.*`、本次 tag 下载链接和 SHA-512 一致，只有 Beta 更新文件。
- 本地候选 XPI 为 707,088 bytes，SHA-256：
  `da060a0be202b21fd25b254c698f4eb69223a85d6ab8bb2dc4527789fd2349fb`。

## 隔离 Zotero 实机验证

正常安装候选 XPI，使用独立 profile、空文库与合成数据，未操作日常文库或模型凭据。

- `scripts/live-literature.mjs`：24 组通过。包含实际 PDF 导入及无效文件拒绝、权限
  边界、确认后恢复主任务／子任务、摘要继续、部分全文继续、重复 acquire、慢摘要、
  迟到预览、继续选择和文献池重启保留。中文浅色及英文深色、常规／420／280 px
  检查覆盖率、按钮、列表滚动、胶囊与回到最新的布局。UI 错误为空。
- `scripts/live-subagents.mjs`：17 组通过。最多三个运行、其余排队；停止／重试，
  共享居中气泡、完整公开 trace／归档、切换后阅读位置、过期响应和父任务等待结束正常。
  常规、窄窗和短窗口的头尾按钮可见、无横向溢出，卡片与聊天内容对齐。
- `scripts/live-model-settings.mjs`：串行复验 9 组通过。真实 models.dev 目录筛选、
  有样式的滚动列表、键盘、输入法、空结果、失败重试、旧响应丢弃及保留网关地址／别名／
  密钥正常；自定义思考参数实际请求及英文深色窄窗、重启持久化通过。首轮目录返回
  60 条时列表已收起，尺寸检查失败；单独重跑完整流程通过，未以该次失败作为通过证据。
- `scripts/live-update-window.mjs`：7 组通过。窗口／侧栏热更新保留当前任务、中文
  草稿、布局及更新设置；重复更新正常，原本关闭的工作区保持关闭。实际热安装立即生效，
  暂存重启文案通过受控状态检查。
- 从公开 Beta 4 升级本地候选：26 项通过。旧包真实创建论文、PDF、批注、笔记、报告
  修订、历史、草稿、记忆、待审提案、候选与子任务。升级及完整重启保留数据和来源、
  预算，历史正文逐文件摘要相同；继续中断任务不重复写笔记，不额外分配预算。
- 匿名 OpenAlex 检索实际返回 100 条文献；models.dev 在线目录成功。

## 复现与限制

```sh
CONFUCIUS_LITERATURE_OUTPUT=output/release-0.5.0-beta.5/literature node scripts/live-literature.mjs
CONFUCIUS_SUBAGENT_OUTPUT=output/release-0.5.0-beta.5/subagents node scripts/live-subagents.mjs
CONFUCIUS_MODEL_SETTINGS_OUTPUT=output/release-0.5.0-beta.5/model-settings node scripts/live-model-settings.mjs
CONFUCIUS_UPDATE_OUTPUT=output/release-0.5.0-beta.5/hot-update node scripts/live-update-window.mjs output/release-0.5.0-beta.4/public/confucius.xpi
node output/release-0.5.0-beta.5/upgrade.mjs
```

原始日志、截图、包摘要和升级驱动在被忽略的 `output/release-0.5.0-beta.5/`。
模型输出与大部分检索是确定性数据；Crossref 回退、超时、取消和错误身份通过注入传输
验证，不代表真实摘要覆盖率。未实测付费模型、外部 Codex／Kimi 端到端、机构登录、
带密钥全文获取、Windows、Linux、其他 Zotero 版本、大型个人文库或 forced-colors。
自动化覆盖 Beta 转同基础稳定版、渠道独立设置、网络／限流／资产／摘要失败，未注入
真实公网故障。公开发布、资产及真实更新器升级结果在发布后补充。
