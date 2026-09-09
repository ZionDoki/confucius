# 陪读、按需报告与私有阅读分支

此文档描述 0.4.5 起的实现。既有成果窗口、原生批注授权和
原文定位入口继续使用。用户说明见 [陪读使用文档](../../docs/reading-companion.md)。

## 成果与工作流

`deep_read` 继续使用同一 ID、修订历史与 citations。Markdown body 新增可选
`readingGuide`，其 `version: 1` 包含 overview、原文顺序的 checkpoints，以及
实际批注结果 annotationsMarkdown。路标与重点都使用稳定 ID；重点包含 reading
与 writing 两种解释，可追加 further、question、hint。原语言节选保存在共享
citations 的 quote 中，来源引用不能为重复或无法解析的 ID。

`artifact_read(part=guide)` 分页读取陪读。`artifact_patch` 支持完整替换
readingGuide、初始化/替换 reportMarkdown，以及既有 report 文本 edits。
省略字段保留，关联字段在同一次乐观版本检查和原子写入内提交。全文 upsert
仍表示完整替换；推荐修订始终使用 patch。新字段不改变历史 body 的解析。

深读工作流 v3 检查已复核的 readingGuide。报告可为空；不得因为未请求报告而
延长任务。沿用已有的 draft → 原文及实际批注送达模型 → 修正/ready 证据门禁。
技能、模板、共享提示与 Native/外部网关使用同一契约。保存的 v1/v2 工作流保持
旧完成条件；只有旧报告但没有 run 的任务也继续旧格式。

`artifact/generateReport` 接收 artifactId 和 expectedRevision，在所属主任务
发起独立请求。来源绑定回该成果的原 PDF，而非窗口当前聚焦的 PDF。任务启动前
和提交入口均检查忙碌状态；重复请求复用已有执行，中断请求走原有继续机制。
`run.reportArtifactId` 固定补报告目标，成果工具拒绝另建文件、操作其他成果或
替换陪读。报告阶段不暴露批注写入工具，仍可读原文与实际批注并复核。

## 私有讨论边界

ReadingDiscussionStore 使用 `runtime-v1/reading-discussions/<artifactId>.json`，
与 HistoryStore、主任务日志和记忆存储分开。文件包含本地阅读状态及该成果的私有
分支记录、模型配置快照（不含 Native API key）、独立恢复句柄、检查点与私有归档。
它从不注册为 ResearchTaskRecord，不进入主任务列表或自动记忆处理。

第一次提问时，ReadingDiscussions 创建 `rd_` ID。种子仅含论文基本信息、当前
checkpoint、该位置引用的来源与必要前后衔接。指纹按 checkpoint、相关来源与
衔接内容规范序列化并计算 SHA-256，不含报告正文或版本号。这样报告新增不重置
讨论，而源段修订保留旧问答并创建新版分支。入口会检查当前成果指纹，历史问答
只读。模型配置在第一次提问时冻结；Native 密钥仅在执行时由仍存在的对应配置取用。

Native 直接复用 TurnLoop、WindowContext、取消和预算机制，使用单独的事件接收器、
检查点和私有归档回调。Codex/Kimi 复用 ExternalBackend 与 PluginRuntimeHost，
使用自己的 taskId、runId、turnId、外部会话句柄及 Zotero-only 工作目录。既有
主任务句柄从不传入。每个回答有独立步骤/工具额度与 15 分钟执行上限。

ReadingDiscussionTools 的白名单只有论文只读工具与 reading_discussion_history。
准备和执行两层都检查来源 item/PDF；显式附件不能绕开来源范围。禁止任意文库搜索、
主任务历史、记忆、知识库、成果及批注写入。外部网关每次都核对私有运行租约，
工具执行完成后再次核对，以拒绝取消后的迟到输出。私有事件不调用 AgentHost 的
主任务事件发布或历史注册路径。

接口包括 readingDiscussion/open（create=false 可检查但不创建）、prompt、events、
abort、continue。events 返回当前讨论快照及有序私有事件游标；事件尾部有界，完整
问答仍保留在消息记录。切换位置及关窗只结束 UI 轮询。重启将 running 变为
interrupted，不自动执行。删除主任务会中断并释放分支、删除私有文件及该分支的
宿主工作目录。外部 CLI/服务商自有日志不属于 Confucius 本地清理范围。

## 阅读与写回

artifactWorkspace 默认用同一 artifact.xhtml 文档铺满工作区，原任务 DOM 保留并 inert，
返回后恢复交互。artifactWindowView 提供返回与转为独立窗口的入口；转出前等待阅读
状态写入，再挂载独立文档。再次从任务打开时先关闭该成果的独立窗口并等待状态保存，
避免两个视图争写草稿。iframe 隔离文档样式、固定输入框及元素 ID，工作区卸载时清理。
artifactWindowView 保留版本、状态、写回以及来源组件，增加两视图切换。陪读
沿论文顺序连续排版，普通段落用短路标、重点用原文与拆解穿插。保留稳定 checkpoint
ID 与相对视窗偏移来恢复位置；主题与字体继承已有工作区变量。
`artifact/readingState` 单独保存视图、位置、展开状态、引用与草稿，不增加成果版本。
划选工具只捕获单个段落内的文字；底部只有一个输入框，按引用所属 checkpoint
连接独立分支。滚动位置与问答归属分开保存，滚动不改变输入框中的上下文。
readingGuideFollow 在窗口内订阅相关 PDF 的页码变化和双击，不写入任务事件。
只匹配相同文库与附件；按来源起始物理页选择位置，同页优先保留当前 checkpoint。
阅读器主视图与分栏副视图都可绑定，优先聚焦视图并在焦点返回陪读时保留当前分栏。
初次绑定只恢复当前论文的视觉关联，已有阅读位置不跳动；后续翻页才滚动联动。
关窗、切换版本与插件卸载会清理监听器，离开对应 PDF 时清除当前论文标记。
总结块滚出正文后显示在滚动区上方的独立区域；PDF 联动时对应块固定在这里，保留
暖色底、柔光及“正在读”。同一 checkpoint 内不重建浮块或反复滚动；手动滚动陪读
解除固定，正文中的 PDF 当前块仍保留颜色。该区域实际占位，正文与来源链接不会
被遮住。悬停、按下和键盘焦点各有反馈；点击时省略 annotationKey，回到起始页。
问答 UI 的异步响应和轮询均绑定其挂载实例及分支 ID，卸载后不能更新其他位置。
发送前冻结文本与引用；等待返回时新输入的草稿不被清空。收起时先恢复输入框焦点，
再隐藏气泡，避免 focus 事件重新打开问答。

写回的 view 和 revision 从预览到审批、准备操作及实际写入一并固定，操作 ID 和
准备缓存也区分视图。readingBodyForView 只序列化正式成果，不能读取讨论存储。
未生成的报告不能写回。已有 pending 审批与原子写入的取消语义保持原样。

用户入口为“保存 Zotero 笔记”。弹窗使用按钮切换正式视图，以整页笔记预览替代
原生 select 与 Markdown 前后双栏；已有内容折叠供核对，其他目标保留在“保存位置”
菜单。笔记操作显式指定 `format: markdown`，默认纯文本工具语义不变。准备操作、
笔记预览及实际保存共用 Markdown HTML 转换，公式转换为 Zotero 原生 math 节点，
来源链接保留。预览只复制允许的文本结构，不继承已有笔记的脚本、样式和外部资源。

## 验证入口

- `apps/zotero-addon/test/reading-guide.test.mjs`：兼容读写、原子修订、引用完整性、
  v2/v3 完成条件、指定报告目标、私有源范围、Native 输入隔离、Codex/Kimi 租约与
  独立句柄、取消、重启、版本指纹及阅读状态。
- `scripts/live-reading-companion.mjs`：显式运行真实引擎与隔离 Zotero；需要 `--pdf`，
  可传 `--backend`、`--executable`、`--prefs`、`--output`。只在新建测试文库导入指定
  PDF，授权本测试任务的原生批注。保存成果、trace 和结果到忽略目录，不进入离线测试。
- 常规检查：npm test、npm run typecheck、npm run lint、npm run build、
  npm run sync-skills:check。具体真实引擎与窗口实测范围见
  [本次验收记录](acceptance/reading-companion.md)。
