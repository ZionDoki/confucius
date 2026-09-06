# Windows 实机验收记录：2026-09-06

本记录针对 `f1e2161` 基础上的本地未发布修改，版本字段仍为 `0.4.0-beta.1`。
**不代表 GitHub 已发布的 beta.1 包具备本轮修复，也不构成全部发布验收通过。**
Kimi、Codex 完成真实文献、长上下文及进程重启续接；Native 完成实际成果和副作用恢复，
但重启后的原始约束标记召回失败，保留为未通过项。

## 环境与方法

- Windows 11 专业版，`10.0.26200` / build `26200`，64 位；Zotero `10.0.1`。
- 在独立 `.scaffold/windows-acceptance-C7iHaT/profile`、`data` 中普通安装 XPI，
  AddonManager 报告 `temporarilyInstalled: false`。未更改主库或停止用户已有 Zotero。
- 最终实测包 SHA-256：
  `064d49860f7d05bc4419965f06fa0e3f5c2e3ab038e66389a55056b4edec92da`。
  构建时间戳会改变后续重建包的摘要；本地候选未发布。
- Native：DSLAB 的 `MiniMax-M3`，`https://mirror.lzu.edu.cn`，OpenAI 兼容接口；
  配置容量 256,000。服务没有提供可核对的模型权重修订号。自动换窗专项将**测试配置**
  调为 32,768，不把它描述成触及服务的 256K 上限。
- Kimi Code CLI `0.40.1`，`kimi-code/k3-256k`，thinking `high`。
- Codex CLI `0.153.4`，`gpt-6-astra`，reasoning `low`。
- 同一真实论文：[Attention Is All You Need，arXiv:1706.03762v7](https://arxiv.org/abs/1706.03762v7)，
  15 个 PDF 物理页。三个引擎分别使用独立父条目和附件，实际读原文、保存 report、
  提议并提交恰好两条高亮。通过 Zotero 实体、成果 revision 和任务 trace 核对，
  不用模型的“完成”状态代替写入证据。RPC 输入使用与工作区相同的 AgentHost。
- 人工核对了论文第 1、8 页渲染及报告。Table 2 为 base `27.3/38.1`、big
  `28.4/41.8`（英德/英法）；第 8 页正文却写英法 big `41.0`，属于原文内部差异。

## 真实文献成果

| 引擎   | 实际 report               | 两条实际批注 key（物理页）       | 质量核对                                                                               |
| ------ | ------------------------- | -------------------------------- | -------------------------------------------------------------------------------------- |
| Native | `art_mtpgf865_ssk3iu`，r2 | `96PGQAJR`（2）、`MSVDV782`（1） | 初稿误写“编码器自回归自注意力”；收到核查反馈后 r2 修正。保留初稿失败记录，不算一次成功 |
| Kimi   | `art_mtpgm6a1_hfrugf`，r1 | `WK7SPG2U`（2）、`XEC8GFGN`（8） | 报告区分 base/big，注明页码及 41.0/41.8 原文差异                                       |
| Codex  | `art_mtph03ya_s3vp5u`，r1 | `MAAJTXMX`（2）、`SL2U6C8Q`（8） | 报告区分 base/big，注明页码及 41.0/41.8 原文差异                                       |

各附件均有且仅有两条高亮，带原文文本、矩形坐标及 `WIN-REAL-<ENGINE>` 评论。
长上下文、取消、继续、强制退出、重启后六个 key 均未改变；三个父条目没有新增 Zotero 笔记。
这是三个单任务样本，不能推导一般成功率。Native、Kimi 的报告篇幅超过提示中的近似字数要求。

## 长上下文与中断续接

Kimi、Codex 分三轮接收同一论文各 8 份重复审阅文本，合计约 95 万字符。
这是可复现的容量压力测试，不是多篇不同论文的综述质量评测。

| 项目               | Native                                                                                       | Kimi                                                             | Codex                                                        |
| ------------------ | -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------ |
| 容量处理           | 32,768 测试配置下自动换窗；最终窗口号 4                                                      | CLI 输出出现两次压缩记录；宿主协议用量仍 `unknown`，不编造百分比 | 运行时报告进入窗口 2；最终输入 238,447 / 容量 258,400 tokens |
| 两种继续入口       | `task/continue`、文本“继续”均恢复同一 run；已用迭代不减少                                    | 同一 run，已有工具预算不刷新；内部请求数不可观察                 | 同一 run，已有工具预算不刷新；内部请求数不可观察             |
| 强制结束进程后     | 恢复 `interrupted`，无自动执行                                                               | 同左                                                             | 同左                                                         |
| 显式继续后的写入   | 已有 report r2、两条高亮不变                                                                 | report r1、两条高亮不变                                          | report r1、两条高亮不变                                      |
| 原始标记及约束召回 | **未通过**：重启后把 `WIN-LONG-NATIVE-青铜17` 误答成论文原句；之前一次换窗后还漏答 base 数字 | 正确回复 `WIN-LONG-KIMI-青铜17`、四个 BLEU 与批注 key            | 正确回复 `WIN-LONG-CODEX-青铜17`、四个 BLEU 与批注 key       |

进程终止前 / 重启后 / 显式继续完成后的预算（迭代、工具调用、执行器启动数）：

| 引擎   | 终止前       | 重启后       | 继续完成后    |
| ------ | ------------ | ------------ | ------------- |
| Native | 12 / 18 / 2  | 12 / 18 / 2  | 22 / 32 / 3   |
| Kimi   | 未知 / 9 / 2 | 未知 / 9 / 2 | 未知 / 11 / 3 |
| Codex  | 未知 / 7 / 2 | 未知 / 7 / 2 | 未知 / 20 / 3 |

外部协议中内部模型请求不可见；存储字段中的迭代 `0` 不表示零次实际模型调用。
Native 的原始约束在历史和 r2 报告中仍存在，问题出在恢复后未正确取回；
持久化和副作用幂等通过，语义召回失败必须单独保留。
明确反馈错误后，Native 用 `history_read` 找回了正确标记，但又误称标记不在 r2 报告中
（实际在报告第 3 行）。该纠错轮次另存 `native-corrective-feedback` trace，不将首次失败改记为通过。

## Windows 平台结果

| 场景                           | 结果与实际证据                                                                                                                                                                                                                                                                                                |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 旧版升级和两次重启             | **通过**。真实 `v0.3.8` XPI → 最终候选；17 个旧 runtime 文件参与核对。笔记 `GVQKQKWC` 不重复，成果 r2、原窗口 ID、2 个工作笔记版本保留，导出 21 条历史、23 个事件且无读取缺口。模型为确定性本地服务，此项不计真实引擎成绩                                                                                     |
| 迁移复制 / 索引中断            | **通过**。从保留的旧版测试库重放真实迁移：先备份隔离目标目录，分别在实际历史正文复制后、migration 索引原子写入后暂停 IO 并终止已验证 PID。重启从 `copying` 进入 `active`，源文件逐文件摘要不变，任务状态和 run 与迁移前基线一致，工作笔记 2 版完整。该源任务本来为 `failed`，没有把它冒充恢复为 `interrupted` |
| Windows 长路径                 | **通过**。实机复现超过 260 字符的历史写入失败；扩展 IO 路径修复后，157 条积压历史全部保存，最终三个 trace 均无读取缺口。ID 和逻辑文件路径不变                                                                                                                                                                 |
| 本地文件占用                   | **通过**。真实 .NET `FileShare.None` 持有文件；替换失败时原正文保留，释放后同路径可读写                                                                                                                                                                                                                       |
| WPS 测试路径                   | **通过本地路径读写和占用恢复**。使用 WPS Cloud 下唯一命名测试目录；runtime 仍在本地 profile。未观察云端同步完成，不将其计为云端验收                                                                                                                                                                           |
| intent 未落盘                  | **通过**。锁住实际 operation 文件时零笔记派发；旧 call ID 保留失败且无副作用的回执。释放后用新 call ID 显式重试，仅新增一条真实笔记，再重放不新增                                                                                                                                                             |
| 十条批注成功八条               | **通过宿主工具专项**。首次 8 条写入、2 条定位失败；修复后只新增 2 条，原 8 个 key 保留；不预先读取直接再次提交新增 0 条                                                                                                                                                                                       |
| 人工删除、无关元数据           | **通过专项**。修改父条目标题、人工删除一条已完成高亮后再次提交，没有冲突误报，也没有重建被删除高亮                                                                                                                                                                                                            |
| 空白 PDF、扫描件               | **修复后通过**。保留真实物理第 1 页及空文本，跨 Reader/Worker 的 `DataCloneError` 已修复；不伪造 OCR 文本                                                                                                                                                                                                     |
| 多附件、同句多处命中、替换 PDF | **通过**。多附件要求明确 attachmentKey；歧义句不写入；PDF 替换后拒绝旧 proposal，返回需重新定位，零新增                                                                                                                                                                                                       |
| 正式 XPI 正则 Worker           | **通过**。真实论文正常查询 `28\.4` 返回物理页定位；耗时查询约 1.1 秒返回 1000 ms deadline，宿主未卡死                                                                                                                                                                                                         |
| Reader 初始化取消              | **通过故障注入专项**。让 Reader 初始化保持等待，约 350 ms 取消；返回取消错误，主窗口定时心跳仍运行，没有派发写入                                                                                                                                                                                              |
| 报告导出                       | 运行中、失败后、重启后通过真实 `task/trace` 和正式 HTML renderer 导出。最终 HTML 约 2.3 / 11.2 / 8.6 MB；中文目录正常保存，JSON 无读取缺口。已修复短测试密钥误伤数字和 ID。未将这些程序化导出算成保存对话框和按钮禁用状态的 UI 验收                                                                           |

## 本轮修复

1. 外部运行时连接当前 Zotero HTTP listener，避免非默认端口仍连接 23119。
2. 适配 Codex `0.153.4` 的 MCP transport consent elicitation，只放行当前线程的
   Confucius 工具入口；实际工具仍由宿主权限和执行租约检查，其他表单及服务器拒绝。
3. PDF fallback 参数先复制进 Reader compartment，再发送给 PDF Worker。
4. Windows IO 使用扩展路径，覆盖历史、操作记录、迁移、状态与成果读写。
5. 短凭据只在明确凭据字段、标注位置及完整值中脱敏，避免全局替换 `1` 破坏科学数据。

`npm test`：**719 通过**；`npm run typecheck`、`npm run lint` 通过；最终候选构建通过。

## 证据与复现

本机原始数据在 `output/windows-acceptance/`（包含论文和任务正文，未提交到 Git）：

- `evidence-literature.json`、`evidence-long-context.json`、`evidence-final.json`：实际实体、成果及预算。
- `context-recovery.json`、`real-restart.json`：两种继续入口和进程重启前后状态。
- `platform.json`、`platform-retest.json`、`storage.json`：首次失败、同场景复测、文件锁。
- `upgrade-final.json`、`migration-copy-verified.json`、`migration-index-verified.json`。
- `诊断报告/{native,kimi,codex}-final.{json,html}`；对应 `*-final-report.md` 保存文献报告。

可复用脚本均只针对自建隔离配置；启动真实引擎的脚本会产生模型用量。
先将指定论文 PDF 及逐页抽取文本放入 `output/windows-acceptance/papers/`，运行
`scripts/create-windows-acceptance-pdfs.py` 生成四种边界样本，然后按序运行：

```powershell
npm run build --workspace=@confucius/zotero-addon
node scripts/live-windows-acceptance.mjs
node scripts/live-windows-platform.mjs
node scripts/live-windows-storage.mjs
node scripts/live-windows-context.mjs
node scripts/live-windows-restart.mjs
node --import tsx scripts/collect-windows-evidence.mjs final
node scripts/live-upgrade.mjs --zotero 'C:/Program Files/Zotero/zotero.exe' --output output/windows-acceptance/upgrade.json
node scripts/live-windows-migration.mjs copy
node scripts/live-windows-migration.mjs index
```

Windows 启动器可能转交给另一个 Zotero PID。脚本通过当前 RDP 中的真实进程号和
精确 profile/data 路径校验后终止测试进程，不依赖启动器句柄推断已完成重启。

## 未通过或未执行

- **Native 的重启后原始约束标记召回未通过**，不能宣布三引擎全部验收通过。
- 未使用容量受限测试卷制造真实磁盘满；未做独立 DACL 权限拒绝专项。
- 未穷举每个引擎 × 阅读/准备/写入/保存各阶段 × 响应丢失的全部组合；
  相关内容被人工修改后的重准备、写入成功但响应丢失后的进程级对账仍需补测。
- 未验证 Zotero 7/8、WPS 云端同步状态、PDF Worker 损坏资源、初始化自然超时，
  以及诊断导出按钮/系统保存对话框的 UI 行为。
- 未发布新 Release，也未运行发布后的 Beta 1 → Beta 2 自动下载安装闭环。
