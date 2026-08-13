# 任务单位时间与邮箱凭据体验优化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (inline execution in the current session). Steps use checkbox syntax for tracking.

**Goal:** 重新设计任务单位与时间范围界面，并让已保存邮箱凭据在重启后保持可用且不会因空密码提交被删除。

**Architecture:** 新增少量前端纯函数承载单位摘要、时间快捷范围和凭据保留校验；任务弹窗采用单列单位行和时间范围卡片。Rust 继续使用 Windows Credential Manager，并增加凭据存在性查询；空密码保存表示保持已有凭据，明确清除操作才删除。

**Tech Stack:** Vanilla JavaScript, Node test runner, Tauri 2, Rust, keyring, SQLite.

## Global Constraints

- 密码和代理密码不写入 SQLite、localStorage 或日志。
- 只修改本地工作区，不推送 GitHub 或发布 Release。
- 继续支持原生日历选择器、键盘输入、单位搜索、全选和清空。

---

### Task 1: Pure UI and credential regression tests

**Files:**
- Create: `src/core/task-form-ui.js`
- Modify: `src/core/mailbox.js`
- Modify: `tests/core.test.mjs`

- [ ] Write failing tests for company row metadata, time presets, time-range validation, and preserving a stored credential when the password field is blank.
- [ ] Run `npm test` and confirm the new module/functions fail before implementation.
- [ ] Implement the minimal pure helpers and run all tests.

### Task 2: Redesigned task unit and time controls

**Files:**
- Modify: `src/index.html`
- Modify: `src/styles.css`
- Modify: `src/main.js`

- [ ] Replace the compact unit picker markup with a single-column row list showing checkbox, name, contact, email count, and selected state.
- [ ] Add a dedicated time-range card with two datetime inputs, quick preset buttons, range summary, and immediate validation.
- [ ] Keep selected IDs, keyboard entry, search, select-all, clear, and edit-mode restoration intact.

### Task 3: Persisted mailbox credential status

**Files:**
- Modify: `src-tauri/src/lib.rs`
- Modify: `src/main.js`
- Modify: `src/index.html`
- Modify: `src/styles.css`

- [ ] Change blank password save behavior to preserve an existing keyring entry.
- [ ] Add a `mailbox_credentials_status` command and display “已保存密码” after startup without revealing it.
- [ ] Add an explicit “清除已保存密码” action; retain password validation for first-time setup.
- [ ] Make automatic/manual sync use the saved credential when the visible password field is empty.

### Task 4: Verification and local package

- [ ] Run `npm test`, `cargo fmt --check`, `cargo test`, `npm run build`, and `git diff --check`.
- [ ] Build local NSIS/MSI installers.
- [ ] Inspect final status and report local installer paths only.
