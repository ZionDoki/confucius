# 发表场所评级目录

[English](venue-ratings.md) · 简体中文

[维护者指南](README.zh-CN.md) · [使用指南](../../docs/literature-research.zh-CN.md#发表场所评级)

## 内置来源

内置事实快照包括 CCF 2026 第七版期刊和会议 681 条，以及 ICORE2026 已评级会议
825 条。名称、缩写、等级和 CCF 分类转换为 Confucius 自己的结构，同时保留官方网址
和固定提交的数据快照链接：

- CCF：[haozhou-wong/ccf-recommended-list-2026-markdown 的 dcf1a023 提交](https://github.com/haozhou-wong/ccf-recommended-list-2026-markdown/blob/dcf1a02335fb44dcaf785997d5c535ab41628a16/data/ccf-2026.json)，
  整理自[官方第七版 PDF](https://www.ccf.org.cn/ccf/contentcore/resource/download?ID=112CF3BF7E1140ACEB271ADAED12A67ADFABB8FF099E40C2759502A85C8A281F)。
- CORE：[qirunzeng/VenueRank-Lens 的 a68b51cb 提交](https://github.com/qirunzeng/VenueRank-Lens/blob/a68b51cbf0eaa2bce03b6a51dfffca239ceba857/WebExtension/core_catalog.json)，
  来自[官方 ICORE2026 导出表](https://portal.core.edu.au/conf-ranks/?search=&by=all&source=ICORE2026&do=Export)。

上游实现声明软件使用 MIT 协议，这不改变原始出版物的归属；本实现没有复制上游代码。
ShowJCR 软件使用 GPL-3.0，Confucius 不附带其代码或 JCR、中科院、新锐数据集。
这些目录仅通过用户的本地 CSV 导入，界面标注导入文件名和 ShowJCR 来源。

`scripts/sync-venue-catalogs.mjs` 固定两个提交，校验年份、数量和等级，生成
`host/data/venueCatalogs.json`，记录原始内容的 SHA-256。
运行 `npm run sync-venue-catalogs:check` 可对照固定版本的 GitHub 文件检查可复现性。
更新提交须先核对官方版本、审查名称和评级变化，再重新生成并测试。
正常检索使用内置文件，不联网获取评级目录。

九个经核对的主会缩写复用另一评级体系的确切全称：NeurIPS、AAAI、ACL、EMNLP、
ICML、ICLR、CVPR、ICCV、SIGIR。生成器要求两个体系各有唯一会议条目，
不会根据相似标题或任意会议缩写推导别名。

## 匹配与读取

OpenAlex 转换保留来源 ID、类型、ISSN-L、ISSN 及原始来源名，排除仓储来源。
先匹配 ISSN，再匹配规范化后的确切名称、经核对的全称别名和缩写。
ISSN 冲突或身份有歧义时不显示匹配。规范化处理 Unicode、标点、大小写和 &；会议可移除
开头的“Proceedings of the”前缀再做确切全称匹配，原始来源及赛道名称仍用于范围判断，
不使用子串、编辑距离或模型猜测。

明确标为预印本的记录不套用出版版本评级。无法确认会议的丛书不视为会议；
原始会议名确切匹配时可识别论文集。Findings、演示、短文、附属赛道和主会附属
研讨会不套用主会评级；独立列入目录的研讨会可通过自己的全称或缩写匹配。

`LiteratureService.list/get/review` 在读取时计算当前评级，不把评级写入候选决策，
也不增加任何修订号。界面及三种运行时的工具读取同一结果。审阅适配器附带元数据标识，
串行读取可在相同领域修订号下刷新；较早的领域修订及相同元数据仍被忽略。
候选选择、确认、到达提醒及批注修订逻辑保持原有语义。元数据视图携带版本、
来源和学科分类；纯状态视图保持精简。CSV 内容是不可信元数据，不是 Agent 指令，
也不代表论文质量证据。

## 本地导入约定

用户 RPC 为 `literature/ratings/list`、`literature/ratings/import`（本地文件路径）及
`literature/ratings/remove`（导入目录 ID），Agent 工具列表不提供导入或移除工具。
导入后向已加载任务发送 `literature_updated`，不携带新增文献，也不改修订号。
两个导入入口复用 `venueRatings.ts`，审阅仍走公共批注/候选组件。

解析器支持 ShowJCR 期刊 CSV 的 JCR、中科院及新锐表头，包括 UTF-8 BOM、引号内
逗号/换行及双引号转义，保留所有可用学科、大类、小类分区、排名、Top 和影响因子。
年份来自一致的指标表头、记录年份及标准文件名；缺少或冲突的年份、错误列会拒绝整份
文件。中科院止于 2025 年，新锐单独分类；不支持会议 CSV 或任意 CSV 结构。

文件须为不超过 32 MiB 的普通 UTF-8 CSV。解析上限为 60,000 条数据、160 列、
单字段 16,384 字符。目录保存在本地配置的
`confucius/runtime-v1/venue-ratings/catalogs.json`，结构版本为 1，
ID 为 `<system>_<year>`。同年份只替换同体系目录，各体系显示最新年份，旧版本保留
到用户移除。写入串行且原子化，解析或保存失败保留旧文件和内存目录。
损坏的导入会显示不可用，内置匹配及文献调研仍可正常使用。

导入不改动标签、Zotero 字段、候选决策、写入权限、确认或获取流程，
切换任务和重启 Zotero 后仍保留。

## 验证

运行 `npm test`、`npm run typecheck`、`npm run sync-venue-catalogs:check` 和
`npm run build`。`node --import tsx scripts/live-venue-ratings.mjs` 将普通构建 XPI
安装到隔离配置，验证真实 Host 事件、本地 CSV 读取及存储、卡片和列表显示与重启。
模型、OpenAlex 及文件选择结果使用固定测试输入，分区指标为虚构测试值。
原始数据、截图和结果保存在忽略的 `output/`，实际平台结果见
[2026-10-11 验收记录（英文原文）](acceptance/venue-ratings-2026-10-11.md)。
