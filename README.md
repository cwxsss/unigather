# UniGather 材料收集系统

UniGather 是一款面向公司总部工作人员的 Windows 单机桌面应用，用于集中收集分子公司通过邮件反馈的材料，并追踪哪些单位已经反馈、哪些单位仍待反馈。

> 当前版本为 Windows 单机版，可配置邮箱并通过 IMAP/POP3 收件、归档附件和追踪单位反馈。

- GitHub 项目：<https://github.com/cwxsss/unigather>
- v0.0.3 发布页：<https://github.com/cwxsss/unigather/releases/tag/v0.0.3>
- v0.0.2 发布页：<https://github.com/cwxsss/unigather/releases/tag/v0.0.2>
- v0.0.1 历史发布页：<https://github.com/cwxsss/unigather/releases/tag/v0.0.1>

## 功能概览

- **任务中心**：创建、查看和删除材料收集任务；设置截止时间、主题关键词、轮询间隔和 AI 匹配开关。
- **任务补查**：任务支持设置“查收起始时间”，可选择过去时间重新查询历史邮件并执行匹配。
- **单位管理**：下载 Excel 模板，导入包含“单位名称、姓名、邮箱”的 XLS/XLSX 或 CSV 文件；导入后可直接编辑单行数据。
- **收件箱**：Foxmail 式左右分栏查看已同步邮件、发件人、主题、正文、抄送和附件。
- **邮箱配置**：配置 IMAP/POP3、服务器、端口、加密方式、账号密码和 HTTP/SOCKS5 代理；支持协议端口联动、密码显示/隐藏、代理展开和连接配置校验。
- **AI 配置**：在系统设置中配置 API 地址、模型和 API Key；Windows 版本使用凭据管理器保存 API Key。
- **匹配规则**：按发件人邮箱、主题关键词和正文关键词进行确定性匹配；多任务冲突进入待人工确认逻辑。
- **材料与报表**：材料清单可导出 CSV；附件命名逻辑避免同名覆盖。
- **本地安全**：任务和单位数据保存在本机 SQLite；浏览器预览模式使用 localStorage 回退；密码不会写入任务数据库或日志。
- **桌面体验**：深色科技感中文界面、Windows 安装包、最小化到托盘偏好设置入口。

## 使用方式

1. 打开“邮箱配置”，填写收件服务器、账号、密码和加密方式，点击“测试连接”。
2. 打开“分子公司”，下载模板并填写单位名称及邮箱，导入 CSV 文件。
3. 打开“收集任务”，点击“新建任务”，填写任务名称、主题关键词和截止时间。
4. 在任务中心查看任务状态；删除任务使用每行右侧的 `×` 按钮。
5. 同步完成后，在“材料归档”中导出材料清单。

## 安装与运行

### 直接安装

从 GitHub Release 下载以下任一安装包：

- `UniGather_0.0.3_x64-setup.exe`：NSIS 安装包，适合普通用户。
- `UniGather_0.0.3_x64_zh-CN.msi`：MSI 安装包，适合企业软件分发。

发布版使用 Windows GUI 子系统启动，不会额外弹出黑色控制台窗口。

在“系统设置”中点击“检查更新”，应用会查询 GitHub Release。发现新版本后可以直接下载对应安装包，关闭应用后运行安装包即可升级。

### 本地开发

环境要求：Node.js 18+、Rust stable、Visual Studio C++ Build Tools（Windows）。

```powershell
npm install
npm run dev
```

运行 Tauri 桌面开发版：

```powershell
npm run tauri -- dev
```

生成 Windows 安装包：

```powershell
npm run tauri -- build
```

## 验证命令

```powershell
npm test
npm run build
```

Rust 侧检查（需要 MSVC 开发者环境）：

```powershell
cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check
cargo check --manifest-path src-tauri/Cargo.toml
```

## 数据位置与安全边界

- SQLite 数据库文件名：`unigather.db`，位于应用运行目录。
- 附件归档目录由任务配置指定，应用不会覆盖同名文件。
- AI 辅助匹配只允许发送主题、正文和附件名称，设计上不发送附件内容。
- 当前版本不会代发催办邮件，也不接入 OA、SSO 或 Exchange API。

## 当前限制

以下能力已在界面和 Tauri 命令中预留，但尚未替换为生产适配器：

- 真实 IMAP/POP3 SSL/TLS 收件和代理连接；
- PDF、Word、Excel、TXT 附件的实际文本解析；
- Windows Credential Manager 密码托管；
- 系统托盘常驻、Windows 通知和关闭确认；
- XLS/XLSX 二进制单位导入（当前可直接导入 CSV）。

这些未完成能力会显示明确提示，不会伪造“连接成功”或“已归档”状态。

## 目录结构

```text
src/                  前端界面、交互和纯逻辑模块
src/core/             匹配、附件、任务、邮箱等可测试逻辑
src-tauri/src/        Tauri Rust 命令、SQLite 初始化和数据模型
tests/                Node 核心逻辑测试
```
