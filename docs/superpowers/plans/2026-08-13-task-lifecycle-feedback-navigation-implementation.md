# UniGather 任务生命周期、反馈分页与导航体验实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让收集任务支持安全删除与恢复、让反馈邮件按页浏览，并修复导航和收件箱时间交互。

**Architecture:** Rust/SQLite 为任务软删除与反馈分页的唯一数据源；前端只维护筛选、页码和页大小。任务删除不再物理删除关联数据，而是写入删除元数据；恢复时重置为已中断，阻止意外自动收件。

**Tech Stack:** Tauri 2、Rust、rusqlite、SQLite、原生 HTML/CSS/JavaScript、Node Test Runner。

## Global Constraints

- Windows 单机、单用户应用，沿用现有深色科技感与原生 HTML/CSS/JavaScript。
- 删除为软删除；邮件、附件、匹配记录和发送记录不得删除。
- 已删除任务恢复后状态固定为 `paused`，不自动收件。
- 只生成本地 NSIS/MSI 安装包，不提交、推送或发布 GitHub Release。
- 每个行为变更遵循 Red → Green → Refactor；PowerShell 命令使用 PowerShell 7。

---

## 文件边界

- `src-tauri/src/db.rs`：SQLite 迁移和查询辅助。
- `src-tauri/src/models.rs`：任务和分页响应模型。
- `src-tauri/src/lib.rs`：任务软删除/恢复、任务列表筛选、反馈分页 Tauri 命令与 Rust 测试。
- `src/core/tasks.js`：前端分页参数、页码边界及删除状态纯函数。
- `src/main.js`：任务管理、确认删除、恢复、反馈分页、收件箱时间交互。
- `src/index.html`：导航顺序、统计卡、反馈分页器、删除确认对话框、收件箱操作区。
- `src/styles.css`：固定侧栏、主内容滚动、分页器和危险确认样式。
- `tests/core.test.mjs`：UI 标记及纯前端行为测试。

## Task 1: 数据库软删除与任务生命周期接口

**Files:**
- Modify: `src-tauri/src/db.rs`
- Modify: `src-tauri/src/models.rs`
- Modify: `src-tauri/src/lib.rs`

**Interfaces:**
- Produces `task_delete(task_id) -> Result<TaskLifecycleResult, String>`：将任务标记删除。
- Produces `task_restore(task_id) -> Result<TaskLifecycleResult, String>`：清除删除标记，状态设为 `paused`。
- Extends `task_list(include_deleted: bool) -> Vec<TaskSummary>`：正常调用仅返回非删除任务；已删除筛选调用返回删除任务。

- [ ] **Step 1: 编写失败的 Rust 测试**

在 `lib.rs` 的测试模块增加：

```rust
#[test]
fn deleting_a_task_keeps_its_matches_and_restore_pauses_it() {
    let mut connection = test_connection();
    let task_id = insert_task_with_match(&mut connection, "active");
    soft_delete_task(&mut connection, &task_id).unwrap();
    assert_eq!(task_status(&connection, &task_id), Some("deleted".to_string()));
    assert_eq!(match_count(&connection, &task_id), 1);
    restore_task(&mut connection, &task_id).unwrap();
    assert_eq!(task_status(&connection, &task_id), Some("paused".to_string()));
}
```

- [ ] **Step 2: 验证测试失败**

Run: `cargo test --manifest-path src-tauri/Cargo.toml deleting_a_task_keeps_its_matches_and_restore_pauses_it`

Expected: FAIL，因为 `soft_delete_task` 和 `restore_task` 尚不存在。

- [ ] **Step 3: 实现迁移和最小生命周期逻辑**

在迁移中增加字段：

```sql
ALTER TABLE tasks ADD COLUMN deleted_at TEXT;
ALTER TABLE tasks ADD COLUMN deleted_previous_status TEXT;
```

使用迁移辅助函数忽略“duplicate column name”。实现同一事务中的软删除：保存当前状态到 `deleted_previous_status`，写入 `deleted_at`，将 `status` 设为 `deleted`。恢复时清空两个删除字段，状态固定写为 `paused`。不删除 `matches`、`sync_runs`、`task_companies`。

- [ ] **Step 4: 增加 Tauri 命令与任务筛选**

```rust
#[tauri::command]
fn task_restore(task_id: String, state: State<'_, AppState>) -> Result<TaskLifecycleResult, String>;

#[tauri::command]
fn task_list(include_deleted: Option<bool>, state: State<'_, AppState>) -> Result<Vec<TaskSummary>, String>;
```

正常任务查询使用 `WHERE deleted_at IS NULL`；已删除查询使用 `WHERE deleted_at IS NOT NULL`。注册 `task_restore`。

- [ ] **Step 5: 验证 Rust 测试通过**

Run: `cargo test --manifest-path src-tauri/Cargo.toml deleting_a_task_keeps_its_matches_and_restore_pauses_it`

Expected: PASS；匹配记录计数仍为 1，恢复后为 `paused`。

## Task 2: 后端反馈邮件分页

**Files:**
- Modify: `src-tauri/src/models.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src/core/tasks.js`

**Interfaces:**
- Produces `task_feedback_page(task_id, status_filter, page, page_size) -> TaskFeedbackPage`。
- `TaskFeedbackPage = { messages, total, page, page_count, page_size, confirmed, needs_review, unmatched }`。

- [ ] **Step 1: 编写失败的 Rust 测试**

```rust
#[test]
fn task_feedback_page_returns_only_requested_rows_and_total() {
    let connection = connection_with_task_messages(51);
    let page = load_task_feedback_page(&connection, "task-1", "all", 2, 20).unwrap();
    assert_eq!(page.messages.len(), 20);
    assert_eq!(page.total, 51);
    assert_eq!(page.page_count, 3);
}
```

- [ ] **Step 2: 验证测试失败**

Run: `cargo test --manifest-path src-tauri/Cargo.toml task_feedback_page_returns_only_requested_rows_and_total`

Expected: FAIL，因为分页加载函数不存在。

- [ ] **Step 3: 实现分页查询**

将现有任务反馈查询拆为状态计数查询与分页列表查询。页码最小为 1，页大小仅允许 `10, 20, 31, 40, 50`，其他值回退为 20；超过范围页码回退到最后有效页。SQL 使用 `LIMIT ? OFFSET ?`，排序保持既有邮件时间倒序。

- [ ] **Step 4: 编写失败的 Node 纯函数测试**

在 `tests/core.test.mjs` 增加：

```js
test('normalizes feedback paging and resets page on a filter change', () => {
  assert.deepEqual(normalizeFeedbackPage({ page: 0, pageSize: 99, total: 51 }), { page: 1, pageSize: 20, pageCount: 3 });
  assert.equal(nextFeedbackPage({ page: 3, pageCount: 3 }, 'next'), 3);
  assert.equal(nextFeedbackPage({ page: 2, pageCount: 3 }, 'filter-change'), 1);
});
```

- [ ] **Step 5: 实现前端分页纯函数并验证**

在 `src/core/tasks.js` 导出 `normalizeFeedbackPage` 和 `nextFeedbackPage`，再运行：

Run: `npm test`

Expected: 新测试及现有测试全部 PASS。

## Task 3: 任务管理、确认删除与恢复界面

**Files:**
- Modify: `src/index.html`
- Modify: `src/main.js`
- Modify: `src/styles.css`
- Modify: `tests/core.test.mjs`

**Interfaces:**
- Consumes `task_delete`、`task_restore` 和 `task_list(includeDeleted)`。
- Produces `openDeleteTaskConfirm(task)`、`restoreTask(task)`。

- [ ] **Step 1: 编写失败的 UI 标记测试**

```js
test('includes deleted task management and a confirmation dialog', () => {
  const html = readFileSync(new URL('../src/index.html', import.meta.url), 'utf8');
  ['task-deleted-count', 'task-delete-confirm-modal', 'confirm-task-delete', 'restore-task'].forEach((id) => assert.match(html, new RegExp(`id="${id}"`)));
  assert.match(html, /已删除/);
});
```

- [ ] **Step 2: 验证测试失败**

Run: `npm test`

Expected: FAIL，缺少已删除统计和确认对话框标记。

- [ ] **Step 3: 实现统计、任务管理和确认对话框**

将第四统计卡改为“已删除”，其筛选值为 `deleted`。任务管理筛选增加 `deleted`。新增确认对话框，包含任务名称、影响说明、取消和 `id="confirm-task-delete"` 的危险确认按钮。删除按钮仅调用 `openDeleteTaskConfirm`；确认后调用 `task_delete` 并重新加载正常任务和已删除计数。

已删除行只显示删除时间、恢复按钮和查看详情；恢复按钮调用 `task_restore`，成功后提示“已恢复为已中断，请按需立即运行”。

- [ ] **Step 4: 实现样式与键盘行为**

确认弹窗初始焦点为取消按钮，Esc/遮罩关闭不产生写入；确认按钮在请求中禁用并显示“删除中…”。添加危险按钮颜色、已删除状态标签和任务管理空状态。

- [ ] **Step 5: 验证前端测试通过**

Run: `npm test`

Expected: 所有 UI 标记、纯函数和既有测试 PASS。

## Task 4: 反馈表格分页与收件箱跳转

**Files:**
- Modify: `src/index.html`
- Modify: `src/main.js`
- Modify: `src/styles.css`
- Modify: `tests/core.test.mjs`

**Interfaces:**
- Consumes `task_feedback_page`。
- Produces `loadTaskFeedbackPage(taskId)` 和 `openFeedbackMessageInInbox(mailId)`。

- [ ] **Step 1: 编写失败的 UI 测试**

```js
test('renders feedback paging controls without an internally scrolling full table', () => {
  const html = readFileSync(new URL('../src/index.html', import.meta.url), 'utf8');
  assert.match(html, /task-feedback-pagination/);
  assert.match(html, /task-feedback-page-size/);
});
```

- [ ] **Step 2: 验证测试失败**

Run: `npm test`

Expected: FAIL，分页控件尚不存在。

- [ ] **Step 3: 实现反馈分页渲染**

反馈区域保留现有筛选器，新增页大小选择器和底部分页器。筛选或页大小改变后重置为第 1 页；上一页/下一页在边界禁用。加载时显示骨架行并禁用分页按钮；无结果显示“当前筛选下暂无邮件”。移除一次性将 `detail.messages` 渲染到表格的逻辑。

- [ ] **Step 4: 移除内部全表滚动**

将 `.pending-feedback-table-wrap` 的长列表滚动行为替换为当前页正常表格高度；主内容区域负责页面滚动。保持表头、列宽和“查看邮件”跳转行为。

- [ ] **Step 5: 验证前端测试通过**

Run: `npm test`

Expected: PASS，且分页控件结构存在。

## Task 5: 固定导航、导航顺序与收件箱时间控件

**Files:**
- Modify: `src/index.html`
- Modify: `src/main.js`
- Modify: `src/styles.css`
- Modify: `tests/core.test.mjs`

**Interfaces:**
- Consumes `normalizeInboxStartTime(value)`。
- Produces独立滚动的应用壳层布局。

- [ ] **Step 1: 编写失败的 UI 顺序测试**

```js
test('places contacts before inbox and removes the inbox refresh action', () => {
  const html = readFileSync(new URL('../src/index.html', import.meta.url), 'utf8');
  assert.ok(html.indexOf('data-view="companies"') < html.indexOf('data-view="inbox"'));
  assert.doesNotMatch(html, /id="refresh-inbox"/);
  assert.match(html, /id="inbox-since"/);
});
```

- [ ] **Step 2: 验证测试失败**

Run: `npm test`

Expected: FAIL，因为通讯录尚在收件箱之后且刷新按钮仍存在。

- [ ] **Step 3: 调整导航与滚动壳层**

将通讯录导航移动到仪表盘下方，收件箱移到其后。侧栏使用 `position:sticky; top:0; height:100vh; overflow:hidden`；应用壳层限定 `height:100vh; overflow:hidden`，主内容区使用 `height:100vh; overflow-y:auto`。保留模态打开时的背景滚动锁定。

- [ ] **Step 4: 调整收件箱操作区**

保留 `type="datetime-local"` 的 `#inbox-since`，补充“留空时默认收取近 7 天”的辅助文本；删除 `#refresh-inbox` 标记和对应事件监听。`立即收件`继续使用 `normalizeInboxStartTime`，非法值显示明确错误并阻止请求。

- [ ] **Step 5: 验证前端测试通过**

Run: `npm test`

Expected: PASS。

## Task 6: 集成验证与本地安装包

**Files:**
- Verify only: `src-tauri/target/release/bundle/nsis/UniGather_0.0.4_x64-setup.exe`
- Verify only: `src-tauri/target/release/bundle/msi/UniGather_0.0.4_x64_zh-CN.msi`

- [ ] **Step 1: 运行完整测试**

Run: `npm test`

Expected: 全部 Node 测试通过。

Run: `cargo test --manifest-path src-tauri/Cargo.toml`

Expected: 全部 Rust 测试通过。

- [ ] **Step 2: 构建前端与桌面安装包**

Run: `npm run build`

Expected: Vite 构建退出码为 0。

Run: `npm run tauri -- build`

Expected: 生成 NSIS 与 MSI 安装包，退出码为 0。

- [ ] **Step 3: 验证交付物与工作区**

Run: `git diff --check`

Run: `Get-Item src-tauri\target\release\bundle\nsis\UniGather_0.0.4_x64-setup.exe, src-tauri\target\release\bundle\msi\UniGather_0.0.4_x64_zh-CN.msi`

Expected: 无空白错误，两个安装包存在且具有本次构建时间。

## 自检

- 软删除、恢复、分页、固定侧栏、导航调整、时间控件和删除刷新按钮均由任务 1–5 覆盖。
- 每个任务包含失败测试、失败验证、最小实现和通过验证。
- 接口名称前后一致；没有 TODO/TBD 或不确定实现占位。
- 不包含提交、推送或发布步骤。
