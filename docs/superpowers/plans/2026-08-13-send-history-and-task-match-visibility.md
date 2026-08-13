# UniGather 邮件签名、历史详情与任务匹配可视化实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 完成邮件发送全宽匹配、默认签名和历史详情，并修复已过截止时间的新任务从未执行首次匹配且任务详情看不到匹配邮件的问题。

**Architecture:** SQLite 继续作为唯一数据源；发送批次保存独立签名并记录发送模式，历史详情按批次读取全部发送尝试和逐单位结果。收件任务将每次同步写入 `sync_runs`，提供任务匹配详情命令；前端在任务详情中展示同步摘要和命中邮件，并允许新任务无论截止时间是否已过都执行一次首次匹配。

**Tech Stack:** Tauri 2、Rust、rusqlite、React-free 原生 DOM 前端、JavaScript ES modules、Node test runner、SQLite。

## Global Constraints

- 默认邮件签名固定为“中国联通总部数据安全工作组”，每个批次可临时修改并可保存为默认签名。
- AI 和邮件发送安全规则保持不变，不上传附件内容。
- 历史记录不得删除旧批次；数据库迁移使用安全默认值。
- 任务第一次匹配允许覆盖已经结束的历史时间窗口，完成后不再超出截止时间自动轮询。
- 仅生成本地安装包，不推送 GitHub、不发布 Release。

---

### Task 1: 发送正文与状态展示纯函数

**Files:**
- Modify: `tests/core.test.mjs`
- Modify: `src/core/send-workbench.js`

**Interfaces:**
- Produces: `composeSendBody(body, signature) -> string`
- Produces: `sendItemStatusMeta(status, error) -> { label, tone, detail }`

- [ ] **Step 1: Write failing tests** covering default signature append, blank signature, and all four item status labels.
- [ ] **Step 2: Run `npm test` and verify failures are caused by missing exports.**
- [ ] **Step 3: Implement the two minimal pure functions.**
- [ ] **Step 4: Run `npm test` and verify green.**

### Task 2: 发送批次签名与历史详情持久化

**Files:**
- Modify: `src-tauri/src/db.rs`
- Modify: `src-tauri/src/models.rs`
- Modify: `src-tauri/src/lib.rs`

**Interfaces:**
- Extends: `SendBatchInput.signature: String`
- Extends: `SendBatchSummary.signature: String`
- Produces: `mail_signature_get() -> String`
- Produces: `mail_signature_save(signature: String) -> Result<(), String>`
- Produces: `send_history_detail(batch_id: String) -> SendHistoryDetail`

- [ ] **Step 1: Add failing Rust tests** for the default signature setting and a history detail containing two runs and their send items.
- [ ] **Step 2: Run targeted `cargo test` and verify expected failures.**
- [ ] **Step 3: Add idempotent `send_batches.signature` and `send_runs.mode` migrations.**
- [ ] **Step 4: Persist/load signature and return batch/run/item history details.**
- [ ] **Step 5: Run targeted tests and verify green.**

### Task 3: 邮件发送工作台 UI

**Files:**
- Modify: `src/index.html`
- Modify: `src/styles.css`
- Modify: `src/main.js`

**Interfaces:**
- Consumes: `composeSendBody`, `sendItemStatusMeta`, `mail_signature_get/save`, `send_history_detail`

- [ ] **Step 1: Add DOM fixture assertions** for full-width match card, signature controls and history detail modal.
- [ ] **Step 2: Run `npm test` and verify the new markup test fails.**
- [ ] **Step 3: Expand the match card to full width and render status chips/details inside each row.**
- [ ] **Step 4: Add signature editor, default-save action and ensure preview/formal body use identical composed content.**
- [ ] **Step 5: Make history rows clickable and render batch metadata, all attempts and per-unit results in a modal.**
- [ ] **Step 6: Run `npm test` and verify green.**

### Task 4: 任务同步记录与匹配邮件接口

**Files:**
- Modify: `src-tauri/src/db.rs`
- Modify: `src-tauri/src/models.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `tests/core.test.mjs`
- Modify: `src/core/task-schedule.js`

**Interfaces:**
- Produces: `task_match_detail(task_id: String) -> TaskMatchDetail`
- Extends: `sync_runs.task_id`, `sync_runs.processed`, `sync_runs.duplicates`, `sync_runs.status`
- Produces: `shouldRunInitialTaskSync(task, lastReceiveTimestamp) -> boolean`

- [ ] **Step 1: Add failing JS test** proving an active never-synced task with an expired deadline still needs one initial run.
- [ ] **Step 2: Add failing Rust test** proving task match detail returns matched and unmatched messages with reasons and attachments.
- [ ] **Step 3: Run JS and Rust tests and verify expected failures.**
- [ ] **Step 4: Add idempotent sync-run migrations and persist start/completion/failure counters.**
- [ ] **Step 5: Implement task detail query joining matches, messages, companies and attachments.**
- [ ] **Step 6: Implement the one-time initial-run scheduling rule.**
- [ ] **Step 7: Run targeted tests and verify green.**

### Task 5: 任务详情匹配邮件 UI

**Files:**
- Modify: `src/index.html`
- Modify: `src/styles.css`
- Modify: `src/main.js`

**Interfaces:**
- Consumes: `task_match_detail`, `shouldRunInitialTaskSync`

- [ ] **Step 1: Add DOM fixture assertions** for recent sync summary, match filters and matched-mail rows.
- [ ] **Step 2: Run `npm test` and verify expected failure.**
- [ ] **Step 3: Add task-detail summary cards for checked, matched, pending-review and unmatched counts.**
- [ ] **Step 4: Add filterable mail rows showing sender, subject, time, company, match reason, status and attachments.**
- [ ] **Step 5: Trigger one immediate background sync after a newly created task and surface failures in task detail.**
- [ ] **Step 6: Run `npm test` and verify green.**

### Task 6: Full verification and local installer

**Files:**
- Verify: all changed files

- [ ] **Step 1: Run `node --check src/main.js`.**
- [ ] **Step 2: Run `npm test`.**
- [ ] **Step 3: Run `cargo test --manifest-path src-tauri/Cargo.toml`.**
- [ ] **Step 4: Run `npm run build`.**
- [ ] **Step 5: Run `npm run tauri -- build`.**
- [ ] **Step 6: Inspect NSIS/MSI filenames and timestamps and report exact local paths.**
- [ ] **Step 7: Run `git diff --check` and confirm no GitHub push or Release was performed.**

## Self-review

- Spec coverage: all three confirmed sending requirements and the newly reported task-progress defect have dedicated tasks.
- Placeholder scan: no TBD/TODO or deferred implementation step remains.
- Type consistency: signature, history detail and task match detail names are consistent from Rust commands through frontend consumers.
