# Codex / Kimi 运行时识别

在 Confucius 设置中将路径留空，点击“重新检测”。安装或登录 CLI 后无需重启
Zotero。自定义目录可以填写程序的绝对路径；支持带空格、中文、外层引号和
`~/` 的路径。Windows 也支持 `%USERPROFILE%` 等常用路径变量。

## 自动检测范围

| 平台       | 安装入口                                                                                                                                                                |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| macOS      | Apple Silicon / Intel Homebrew、`~/.kimi-code/bin`、`~/.local/bin`、`~/Library/Python/*/bin`、`/Applications` 与 `~/Applications` 中 Codex / ChatGPT 应用内的 Codex CLI |
| Linux      | 系统目录、Linuxbrew、`~/.kimi-code/bin`、`~/.local/bin`、常见用户安装目录                                                                                               |
| Windows    | Codex Desktop 版本目录、`~/.kimi-code/bin`、npm、Python 用户安装的 Scripts、WinGet Links、Scoop shims、App Paths 注册项                                                 |
| 各平台共有 | 继承的 PATH、npm 自定义前缀、pnpm、Bun、Volta、uv / pipx 配置的 bin 目录；适用平台的 nvm、fnm、asdf、mise 安装目录                                                      |

没有 PATH 的图形界面启动也会检查这些目录。版本管理器的安装目录仅作有限深度
枚举；PATH 中的选择优先，未配置 PATH 时按目录修改时间和名称检查版本目录。
Windows 保留优先选择最新 Codex Desktop 版本的行为。

Codex 的 npm、pnpm、Bun 入口会解析到平台原生程序，覆盖 x64 / ARM64 的嵌套和
提升依赖，以及旧 `vendor/<target>/codex/codex`、新 `vendor/<target>/bin/codex`
布局。不需要在插件内引入 Node。Kimi 支持原生独立安装、Unix Python 脚本和
uv / pipx 符号链接，以及 Windows 的 Python `.exe` 启动器。

自定义 shell alias、只在交互式 shell 脚本中定义的安装位置、Windows 的 WSL
内安装，以及不在上述目录中的发行版需要手动指定宿主系统可执行的程序。
不执行登录 shell 来读取环境，也不通过 cmd / PowerShell 启动任意批处理脚本。
Windows 可以选 Codex 的 npm `.cmd`，宿主会解析其原生二进制；Kimi 请选择 `.exe`。

## 修复与诊断

此前 macOS 的自动发现会对尚不存在的候选目录调用 `PathUtils.normalize`。
Gecko 在 macOS 下会实际访问文件系统，因此一个缺失目录就会终止两个引擎的
全部发现过程。现在仅规范化已存在的候选文件；断开的符号链接、不可访问目录、
缺失的脚本解释器和没有执行权限的文件会被跳过，继续寻找下一项。

版本探测与实际连接使用相同的路径解析和子进程环境。子进程 PATH 包含已选入口、
原生程序目录和已知安装目录；Windows 去除大小写重复的 PATH，Python 使用 UTF-8。
参数以数组原样传递，包含空格和中文的程序路径不会变成 shell 命令。

手动填写的路径不会静默切换到另一份自动安装。设置会展示程序实际位置，故障区分：

- **不可用**：没有可用程序、执行权限不足、npm 平台依赖缺失，或版本命令不能运行。
- **需要登录**：程序已找到，但 Codex 账户或 Kimi 会话创建报告需要认证。
- **错误**：程序已找到，但 App Server / ACP 协议连接失败；保留已探测的版本与路径。

Codex 探测会读取账户状态；Kimi 会创建并关闭临时 ACP 会话以核实认证。
版本探测涵盖进程退出及管道读取的完整超时。初始化失败时关闭进程，避免反复点击
检测留下后台实例。

## 验证

回归测试使用模拟 Gecko 的文件系统语义，覆盖三个平台、六个平台 / 架构组合、
包布局、坏路径、引号与中文、环境变量、Python 解释器、权限、超时、认证与初始化
进程清理。Windows 和 Linux 是平台模拟测试，尚未进行原生系统实机验收。

macOS 实机在独立 Zotero 10 测试配置中复现了修复前两个引擎的
`PathUtils.normalize: NS_ERROR_FILE_NOT_FOUND`。修复后检测到 Codex 0.153.0
和 Kimi 0.40.1，并通过实际 App Server / ACP 就绪检查；未发送模型任务。
本机旧 npm Codex 缺少平台依赖，自动检测成功使用桌面应用内的 Codex CLI。

生产 XPI 安装到独立配置后，以 `PATH=/usr/bin:/bin` 冷启动 Zotero，两个引擎仍为
可用。另验证了手动指定损坏的 npm 入口会报告平台依赖缺失、带引号的 tilde Kimi
路径可连接、无效手动路径不会切换到另一安装，以及清空路径后两者恢复自动检测。

0.3.7 发布验收中，`npm test` 共 534 项通过，`npm run typecheck`、`npm run lint`、
技能同步与版本检查通过。macOS Zotero 10 的 113 项界面与运行时检查全部通过，
包括 Codex / Kimi 实际就绪检测；构建后另检查 XPI、版本号与更新文件的校验值。
