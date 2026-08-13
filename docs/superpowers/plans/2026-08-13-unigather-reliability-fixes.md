# UniGather 通讯录、邮箱测试、任务布局与批量发送修复实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复通讯录数据分散、邮箱连接测试不真实、任务单位选择器低效及批量发送漏项问题，并恢复旧通讯录数据。

**Architecture:** SQLite 作为通讯录唯一数据源，数据库固定在可执行文件目录。邮箱测试由 Rust 分别建立收件和发件连接；发送批次通过事务保存并在发送前核对数量。

**Tech Stack:** Tauri 2、Rust、rusqlite、React/Vite 前端、Windows Credential Manager。

## Global Constraints

- 当前运行目录为 `E:\software\unigather`。
- 合并恢复前备份当前数据库，旧数据库不得删除。
- 本次仅生成本地安装包，不推送 GitHub、不发布 Release。

---

### Task 1: 数据库路径与通讯录恢复

- [ ] 增加数据库路径回归测试并确认旧行为失败。
- [ ] 将生产数据库解析为可执行文件同目录的 `unigather.db`。
- [ ] 备份当前运行数据库，只合并旧库的单位和联系人。
- [ ] 验证合并结果为 46 家单位、65 位联系人。

### Task 2: 通讯录 CRUD

- [ ] 增加联系人结构、增删改和最后联系人级联删除测试。
- [ ] 扩展 `company_list` 返回结构化联系人。
- [ ] 实现 `company_contact_create/update/delete`。
- [ ] 通讯录页面改为 SQLite 数据源，增加新增、保存、取消和删除操作。

### Task 3: 邮箱双连接测试

- [ ] 增加收件/发件结果独立聚合测试。
- [ ] 实现 IMAP/POP3 登录退出测试和 SMTP 登录退出测试。
- [ ] 支持读取 Windows 凭据管理器中的邮箱及代理密码。
- [ ] 界面分别显示收件与发件的测试状态、耗时和错误。

### Task 4: 顶部区域和任务窗口

- [ ] 增加任务选择器紧凑布局结构测试。
- [ ] 删除硬编码日期和全局重复按钮。
- [ ] 删除步骤标签，将单位行压缩到约 36–40px，并保持底部按钮固定。

### Task 5: 发送批次可靠性

- [ ] 增加同批文件 ID 唯一性、事务回滚和批次数量一致性测试。
- [ ] 使用纳秒时间和进程递增序号生成文件 ID。
- [ ] 实现事务化 `send_batch_save`，失败时不保留残缺批次。
- [ ] 发送前强制保存并核对页面文件数、数据库条目数和单位邮件数。
- [ ] 保存失败或数量不一致时阻止 SMTP 发送。

### Task 6: 完整验证与本地安装包

- [ ] 运行 `npm test`。
- [ ] 运行 `cargo test --manifest-path src-tauri/Cargo.toml`。
- [ ] 运行 `npm run build`。
- [ ] 运行 `npm run tauri -- build`。
- [ ] 核查 NSIS/MSI 产物且确认不会覆盖现有数据库。
