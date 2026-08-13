# 任务立即刷新与定时轮询 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (inline execution in the current session). Steps use checkbox syntax for tracking.

**Goal:** 修复任务关键词提示遮挡，并让任务支持按起止时间立即收件、匹配单位、更新进度和按轮询间隔自动收件。

**Architecture:** 复用现有 `sync_start`/`sync_status` 流程；同步任务接收可选结束时间，在逐封邮件入库后根据任务单位邮箱、主题和正文规则写入 `matches` 并更新 `task_companies.feedback_status`。前端在任务详情提供独立刷新按钮，并由托盘运行期间的定时器按任务 `poll_minutes` 触发同一同步入口。

**Tech Stack:** Vanilla JavaScript, Node test runner, Tauri 2, Rust, rusqlite, IMAP/POP3 adapters.

## Global Constraints

- 只修改本地工作区，不推送 GitHub 或发布 Release。
- 收件仍支持现有 IMAP/POP3、SSL/TLS 和代理配置。
- 附件内容不上传 AI；本次匹配只使用发件人、主题和正文规则。
- 任务截止时间晚于当前时间时，立即刷新实际收取到当前时间。

---

### Task 1: 时间范围和匹配纯逻辑

**Files:**
- Create: `src/core/task-sync.js`
- Modify: `tests/core.test.mjs`

- [ ] **Step 1: Write failing tests** for inclusive time-window filtering and deterministic sender/subject/body matching.
- [ ] **Step 2: Run `npm test` and confirm the new imports fail because the module is absent.**
- [ ] **Step 3: Implement `normalizeSyncEnd`, `isWithinSyncWindow`, and `matchMessageToCompanyTask` with no browser or database dependencies.**
- [ ] **Step 4: Run `npm test` and confirm the focused and existing tests pass.**

### Task 2: Backend task-scoped sync and progress updates

**Files:**
- Modify: `src-tauri/src/models.rs`
- Modify: `src-tauri/src/mail.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Add `until` to `sync_start` input and pass it through the worker.**
- [ ] **Step 2: Filter parsed messages by `[since, until]`, where an empty/future `until` becomes `Utc::now()`.**
- [ ] **Step 3: Load the target task rules and selected company emails before processing messages.**
- [ ] **Step 4: After inserting each message, create a `matches` row and mark the matched task company confirmed; update sync counters and progress text.**
- [ ] **Step 5: Register any required command/model changes and run `cargo fmt` plus `cargo test`.**

### Task 3: Frontend immediate refresh and scheduler

**Files:**
- Modify: `src/index.html`
- Modify: `src/styles.css`
- Modify: `src/main.js`

- [ ] **Step 1: Move modal hint text below the input with normal margin and line height.**
- [ ] **Step 2: Add an “立即刷新” button and progress area to task details.**
- [ ] **Step 3: Start a task-scoped sync using task start/deadline and poll its progress, refreshing task summaries and detail view after completion.**
- [ ] **Step 4: Add a single application timer that checks active tasks and triggers due polling while the app is running; prevent overlapping runs.**
- [ ] **Step 5: Keep the inbox’s generic sync behavior unchanged and show explicit errors for missing mailbox or task selection.**

### Task 4: Verification and local package

**Files:**
- Modify: `README.md` if the task usage steps need the new behavior.

- [ ] **Step 1: Run `npm test`, `cargo test`, `npm run build`, and `git diff --check`.**
- [ ] **Step 2: Build local NSIS and MSI installers with `npm run tauri -- build`.**
- [ ] **Step 3: Inspect the final working tree and report package paths; do not commit, push, or release.**
