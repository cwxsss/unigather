# Mail UI, Pagination and Body Archive Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Improve mail readability, make task matches navigable, and archive no-attachment mail bodies as usable Word files.

**Architecture:** The SMTP layer emits escaped HTML with independently styled body and signature blocks. The collection pipeline creates a DOCX attachment for attachment-less messages using the same matched/unmatched archive routing. The frontend uses small pure helpers for pagination and drilldown filtering, then renders the confirmed compact two-column and four-column layouts.

**Tech Stack:** Tauri 2, Rust, `docx-rs`, vanilla JavaScript, CSS, Node test and Cargo test.

## Global Constraints

- Body style is 仿宋_GB2312 14pt; signature is Microsoft YaHei 9pt.
- Existing mail, tasks and archive records remain intact.
- Exact sender-email matching remains higher priority than sender display-name matching.
- Build local NSIS/MSI only; do not commit, push, tag, or publish.

---

### Task 1: Send HTML with required fonts

**Files:** `src-tauri/src/send.rs`, `src-tauri/src/lib.rs` tests.

- [x] Write a failing MIME test asserting `Content-Type: text/html`, body font `仿宋_GB2312`/`14pt`, signature font `Microsoft YaHei`/`9pt`, and HTML escaping.
- [x] Run `cargo test --manifest-path src-tauri/Cargo.toml`; expect failure.
- [x] Add a body/signature renderer and use it for SMTP MIME content.
- [x] Run Cargo tests; expect pass.

### Task 2: Archive attachment-less mail as DOCX

**Files:** `src-tauri/Cargo.toml`, `src-tauri/src/archive.rs`, `src-tauri/src/lib.rs`.

- [x] Write a failing archive test that creates a no-attachment message and asserts a DOCX exists in the matched/unmatched directory with Word document content.
- [x] Run Cargo tests; expect failure.
- [x] Add `docx-rs`, implement `archive_task_body`, and insert the generated DOCX into `attachments` as a generated body record.
- [x] Run Cargo tests; expect pass.

### Task 3: Task paging and drilldown contracts

**Files:** `src/core/task-feedback.js`, `tests/core.test.mjs`.

- [x] Write failing tests for 10/20/31/40/50 page sizes, clamped pages, and four drilldown filters.
- [x] Run `npm test`; expect failure.
- [x] Implement pure pagination/filter helpers.
- [x] Run Node tests; expect pass.

### Task 4: Apply confirmed inbox and match UI

**Files:** `src/index.html`, `src/main.js`, `src/styles.css`, `tests/core.test.mjs`.

- [x] Write a failing DOM contract for the pager, drilldown modal, and compact match columns.
- [x] Run Node tests; expect failure.
- [x] Implement the two-column inbox, four-column match list, pager, detail drawer, and Word actions.
- [x] Run Node tests and `npm run build`; expect pass.

### Task 5: Final verification

- [x] Run `npm test`, `cargo test --manifest-path src-tauri/Cargo.toml`, `npm run build`, `npm run tauri -- build`, and `git diff --check`.
- [x] Verify current NSIS/MSI timestamps and report paths; do not publish.
