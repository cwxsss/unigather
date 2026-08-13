# Pending Feedback Export and Sender Name Matching Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users view and export every unit that has not yet confirmed feedback, and match collection-task mail by sender display name when its email is not in the address book.

**Architecture:** Add a read-only Tauri command that returns task-company feedback rows with structured contacts. Add pure UI helpers for the export contract. Extend the existing deterministic Rust matcher with normalized sender-name matching only after exact email matching fails; ambiguous display-name matches remain manual review.

**Tech Stack:** Tauri 2, Rust, SQLite/rusqlite, vanilla JavaScript, SheetJS/XLSX, Node test, Cargo test.

## Global Constraints

- Do not send, upload, delete, or alter existing mailbox data.
- “待反馈单位” means every task unit not in `confirmed` state; the export labels `pending` as 待反馈 and `needs_review` as 待确认.
- Sender-name matching must never override exact sender-email matching and must route multi-company matches to manual review.
- Build a local installer only; do not push GitHub or publish a Release.

---

### Task 1: Define pending-feedback data and export contract

**Files:**
- Create: `src/core/pending-feedback.js`
- Modify: `tests/core.test.mjs`

**Interfaces:**
- Produces `normalizePendingFeedbackCompanies(rows)` and `buildPendingFeedbackExportRows(task, rows)`.

- [ ] **Step 1: Write the failing test**

```js
assert.deepEqual(buildPendingFeedbackExportRows(
  { name: '报名表', deadline: '2026-08-20T18:00' },
  [{ companyName: '陕西省分公司', feedbackStatus: 'pending', contacts: [{ contactName: '张三', email: 'a@example.com', phone: '1' }] }],
), [{ 序号: 1, 任务名称: '报名表', 单位名称: '陕西省分公司', 反馈状态: '待反馈', 联系人: '张三', 邮箱: 'a@example.com', 电话: '1', 截止时间: '2026-08-20T18:00' }]);
```

- [ ] **Step 2: Run the Node test to verify it fails**

Run: `npm test`

Expected: failure because `pending-feedback.js` does not exist.

- [ ] **Step 3: Write the minimal helper implementation**

```js
export function normalizePendingFeedbackCompanies(rows = []) {
  return Array.isArray(rows) ? rows.filter((row) => row?.companyName && row.feedbackStatus !== 'confirmed') : [];
}

export function buildPendingFeedbackExportRows(task, rows) {
  return normalizePendingFeedbackCompanies(rows).map((row, index) => ({
    序号: index + 1,
    任务名称: task.name ?? '',
    单位名称: row.companyName,
    反馈状态: row.feedbackStatus === 'needs_review' ? '待确认' : '待反馈',
    联系人: row.contacts.map((item) => item.contactName).filter(Boolean).join('、'),
    邮箱: row.contacts.map((item) => item.email).filter(Boolean).join('；'),
    电话: row.contacts.map((item) => item.phone).filter(Boolean).join('、'),
    截止时间: task.deadline ?? '',
  }));
}
```

- [ ] **Step 4: Run Node tests to verify they pass**

Run: `npm test`

Expected: all tests pass.

### Task 2: Return pending task companies and match by sender display name

**Files:**
- Modify: `src-tauri/src/models.rs`
- Modify: `src-tauri/src/lib.rs`

**Interfaces:**
- Produces `task_pending_companies(task_id) -> Vec<TaskFeedbackCompany>`.
- Extends `evaluate_task_match(message, rule)` with sender-name fallback reason `sender_name_and_subject` / `sender_name_and_body`.

- [ ] **Step 1: Write failing Rust tests**

```rust
assert_eq!(evaluate_task_match(&message("陕西省分公司本部 <unknown@example.com>", "报名", ""), &rule).1, Some("shanxi".to_string()));
assert_eq!(load_task_pending_companies(&connection, "t").unwrap().len(), 2);
```

- [ ] **Step 2: Run Cargo tests to verify they fail**

Run: `cargo test --manifest-path src-tauri/Cargo.toml`

Expected: failure because the pending-company query and sender-name matcher do not exist.

- [ ] **Step 3: Implement the minimum Rust model/query/matcher changes**

```rust
let email_candidates = rule.companies.iter().filter(|company| company.emails.iter().any(|email| normalize_sender(email) == sender)).collect::<Vec<_>>();
let candidates = if email_candidates.is_empty() {
    sender_name_candidates(&message.sender, &rule.companies)
} else { email_candidates };
```

- [ ] **Step 4: Run Cargo tests to verify they pass**

Run: `cargo test --manifest-path src-tauri/Cargo.toml`

Expected: all tests pass.

### Task 3: Render the task detail table and create an XLSX export

**Files:**
- Modify: `src/index.html`
- Modify: `src/main.js`
- Modify: `src/styles.css`
- Modify: `tests/core.test.mjs`

**Interfaces:**
- Consumes `task_pending_companies(taskId)` and `buildPendingFeedbackExportRows(task, rows)`.
- Adds button `#export-pending-companies`.

- [ ] **Step 1: Write a failing DOM-contract test**

```js
assert.match(html, /id="export-pending-companies"/);
```

- [ ] **Step 2: Run Node tests to verify it fails**

Run: `npm test`

Expected: failure because the export action is absent.

- [ ] **Step 3: Implement table, empty state, status chips and XLSX download**

```js
const workbook = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(rows), '待反馈单位');
downloadBlob(filename, XLSX.write(workbook, { bookType: 'xlsx', type: 'array' }), XLSX_MIME);
```

- [ ] **Step 4: Run Node tests to verify they pass**

Run: `npm test`

Expected: all tests pass.

### Task 4: Verify local deliverables

**Files:**
- Modify: only files from Tasks 1–3.

- [ ] **Step 1: Run full test and build suite**

Run: `npm test`, `cargo test --manifest-path src-tauri/Cargo.toml`, `npm run build`, `npm run tauri -- build`.

Expected: all pass; NSIS and MSI installers are generated locally.

- [ ] **Step 2: Inspect diff and generated installer paths**

Run: `git diff --check` and list `src-tauri/target/release/bundle/nsis` and `src-tauri/target/release/bundle/msi`.

Expected: no whitespace errors; no push, tag, or release occurs.
