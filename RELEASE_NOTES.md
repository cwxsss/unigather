# UniGather v0.0.1

## 发布内容

- 首个 Windows 单机版 UniGather 材料收集系统。
- 深色科技感中文桌面界面：仪表盘、任务中心、单位管理、邮箱配置、材料归档和系统设置。
- 任务创建、列表刷新、删除任务和空状态展示。
- 单位 CSV 导入、模板下载、材料清单导出和本地设置保存。
- 邮箱配置表单重做：IMAP/POP3、端口联动、密码显示/隐藏、代理设置和连接配置校验。
- 修复 Windows 发布版启动时显示黑色控制台窗口的问题，发布版改为 GUI 子系统启动。
- 系统设置增加 GitHub Release 更新检查和新版安装包下载入口。
- 前端核心逻辑测试 10 项全部通过；Rust `cargo check` 和生产构建通过。

## 已知限制

真实 IMAP/POP3 收件、文本附件解析、Windows Credential Manager、托盘常驻/通知和 XLS/XLSX 二进制导入仍在后续版本接入。当前版本适合进行本地界面和任务流程验证。

## 安装包

- `UniGather_0.0.1_x64-setup.exe`：NSIS 安装包。
- `UniGather_0.0.1_x64_zh-CN.msi`：MSI 安装包。
