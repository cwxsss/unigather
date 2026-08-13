# Task Company Selection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task with verification checkpoints.

**Goal:** Add reliable per-task company selection with search, select-all, edit回显, and persisted task-company associations.

**Architecture:** Reuse the existing `TaskInput.company_ids` and SQLite `task_companies` table. Add a read model for companies and return selected IDs in `TaskSummary`; keep the UI selection state in the task modal and use stable local IDs only in browser preview fallback.

**Tech Stack:** Vanilla JavaScript, HTML/CSS, Node test runner, Tauri 2 Rust commands, SQLite/rusqlite.

## Global Constraints

- Desktop mode remains Windows-only, single-user, local SQLite.
- No GitHub push or release in this implementation turn.
- Existing tasks remain readable when no company IDs are present.

---

### Task 1: Test company selection state helpers

**Files:**
- Create: `src/core/company-selection.js`
- Modify: `tests/core.test.mjs`

- [ ] Write failing tests for deduplicating contacts into companies, selecting all/none, filtering by name/contact/email, and validating at least one selection.
- [ ] Run `npm test` and confirm the new imports/expectations fail before implementation.
- [ ] Implement pure helpers: `normalizeCompanyOptions`, `filterCompanyOptions`, `toggleAllCompanyIds`, and `validateCompanySelection`.
- [ ] Run `npm test` and confirm all tests pass.

### Task 2: Add company and task association commands

**Files:**
- Modify: `src-tauri/src/models.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] Add serializable `CompanySummary` and `company_ids` to `TaskSummary` with a default for old data.
- [ ] Add `company_list` to return stable company IDs, names, contact names, and email counts.
- [ ] Update `task_create` to reject empty `company_ids` when companies exist and insert the selected IDs.
- [ ] Update `task_update` to replace `task_companies` rows for the task inside the same database operation.
- [ ] Update `task_create` and `task_list` summaries to return selected `company_ids`; compile with `cargo test`.

### Task 3: Build the task modal company picker

**Files:**
- Modify: `src/index.html`
- Modify: `src/styles.css`
- Modify: `src/main.js`

- [ ] Add search input, count, select-all/clear buttons, and checkbox list to the task modal.
- [ ] Load company options from `company_list` with localStorage fallback and render the selection state.
- [ ] Include selected IDs in `saveTask`; restore IDs in `openTaskModal` for edit mode.
- [ ] Show clear validation for no companies and preserve keyboard focus/scroll behavior.
- [ ] Run `npm test` and `npm run build`.

### Task 4: End-to-end verification and local package

**Files:**
- Modify: `README.md` only if the usage steps need the new picker.

- [ ] Run `cargo fmt`, `cargo test`, `npm test`, `npm run build`, and `git diff --check`.
- [ ] Build a local Windows installer without pushing or creating a Release.
- [ ] Inspect `git status` and report the local installer paths plus any remaining product suggestions.
