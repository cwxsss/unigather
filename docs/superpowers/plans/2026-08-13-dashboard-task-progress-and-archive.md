# UniGather Dashboard, Task Progress, and Archive Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让仪表盘准确反映收件与发件两类工作，让收集任务进度按“已确认反馈单位数 / 应反馈单位总数”计算，并将任务附件按匹配状态分类归档、统一命名和定位打开。

**Architecture:** SQLite 继续作为任务、匹配和附件路径的唯一事实来源；Rust 后端负责反馈状态重算、归档路径与文件移动，React-less 原生前端只渲染后端返回的聚合结果。自动收件先完成匹配判定再选择归档目录，人工确认使用文件补偿操作与数据库事务保持路径和匹配状态一致。

**Tech Stack:** Tauri 2、Rust、rusqlite、原生 JavaScript、HTML/CSS、Node.js `node:test`、Windows Explorer、NSIS/MSI。

## Global Constraints

- 保留当前工作区内所有已有修改，不重置、不覆盖无关文件。
- 不删除或批量迁移历史任务、邮件、附件、发送批次和旧归档文件。
- 旧任务读取 `material_name=''` 时回退为任务名称。
- 新归档规则只用于后续任务同步及用户主动进行的人工确认/改派。
- 进度只按单位计算；邮件数、附件数和单次同步命中数均不得参与完成百分比。
- 数据库仍固定使用可执行文件目录中的 `unigather.db`。
- 本轮只生成本地安装包，不推送 GitHub、不创建标签、不发布 Release。
- 每个任务完成后运行该任务的最小测试；最终必须运行全部四项验收命令。

---

## Task 1: 扩展任务、匹配候选与附件详情数据模型

**Files:**

- Modify: `src-tauri/src/db.rs`
- Modify: `src-tauri/src/models.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src/core/tasks.js`
- Modify: `tests/core.test.mjs`

- [ ] **Step 1: 先写前端任务输入失败测试**

在 `tests/core.test.mjs` 的任务输入测试中加入：

```js
const input = buildTaskInput({
  name: '2026报名表',
  materialName: '',
  deadline: '2026-08-20T18:00',
});
assert.equal(input.material_name, '2026报名表');

const custom = buildTaskInput({
  name: '2026报名表',
  materialName: '数据安全报名表',
  deadline: '2026-08-20T18:00',
});
assert.equal(custom.material_name, '数据安全报名表');
```

- [ ] **Step 2: 运行测试并确认失败原因正确**

Run:

```powershell
npm test -- --test-name-pattern="task payload"
```

Expected: FAIL，`material_name` 当前不存在。

- [ ] **Step 3: 扩展 SQLite 模型和兼容迁移**

在 `tasks` 建表 SQL 中加入：

```sql
material_name TEXT NOT NULL DEFAULT ''
```

在初始化迁移中检测并执行：

```sql
ALTER TABLE tasks ADD COLUMN material_name TEXT NOT NULL DEFAULT ''
```

新增候选关系表，用于准确表达一封待确认邮件涉及哪些任务单位：

```sql
CREATE TABLE IF NOT EXISTS match_candidates (
  match_id TEXT NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  PRIMARY KEY(match_id, company_id)
);
CREATE INDEX IF NOT EXISTS idx_match_candidates_company
ON match_candidates(company_id);
```

不要从现有 `matches.reason` 文本反推候选单位。历史待确认记录没有候选数据时保留记录，但不凭空标记某个单位为 `needs_review`。

- [ ] **Step 4: 扩展 Rust DTO**

为 `TaskInput` 和 `TaskSummary` 增加：

```rust
#[serde(default)]
pub material_name: String,
```

将任务详情附件由 `Vec<String>` 改为结构化类型：

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskMatchAttachment {
    pub id: String,
    pub name: String,
    pub saved_path: String,
    pub parse_status: String,
    pub can_open: bool,
}
```

并将 `TaskMatchMessage.attachments` 改为 `Vec<TaskMatchAttachment>`。

- [ ] **Step 5: 贯通 task_create、task_update、task_list**

保存前统一规范：

```rust
let material_name = if input.material_name.trim().is_empty() {
    input.name.trim().to_string()
} else {
    input.material_name.trim().to_string()
};
```

创建、更新 SQL 保存 `material_name`；列表 SQL 使用：

```sql
COALESCE(NULLIF(t.material_name, ''), t.name)
```

作为兼容读取值。

- [ ] **Step 6: 更新前端 payload**

在 `buildTaskInput` 返回对象中加入：

```js
material_name: String(values.materialName ?? '').trim()
  || String(values.name ?? '').trim(),
```

- [ ] **Step 7: 增加并运行 Rust 迁移测试**

在 `src-tauri/src/db.rs` 测试模块中创建内存数据库，验证：

```rust
assert_eq!(column_count(&connection, "tasks", "material_name"), 1);
assert_eq!(table_count(&connection, "match_candidates"), 1);
```

Run:

```powershell
npm test -- --test-name-pattern="task payload"
cargo test --manifest-path src-tauri/Cargo.toml db::tests
```

Expected: PASS。

- [ ] **Step 8: 提交本任务**

```powershell
git add src-tauri/src/db.rs src-tauri/src/models.rs src-tauri/src/lib.rs src/core/tasks.js tests/core.test.mjs
git commit -m "feat: extend task archive metadata"
```

---

## Task 2: 建立安全、不可覆盖的任务附件归档模块

**Files:**

- Create: `src-tauri/src/archive.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/src/mail.rs`

- [ ] **Step 1: 先写归档文件名单元测试**

在 `src-tauri/src/archive.rs` 先建立测试模块，覆盖：

```rust
#[test]
fn sanitizes_windows_segments() {
    assert_eq!(sanitize_segment("重庆/分公司:*?"), "重庆_分公司___");
}

#[test]
fn builds_matched_and_unmatched_names() {
    assert_eq!(matched_name("重庆", "数据安全报名表", "原件.docx"),
               "重庆-数据安全报名表.docx");
    assert_eq!(unmatched_name("2026-08-13T10:20:30", "a@example.com", "报名表.xlsx"),
               "20260813-102030-a@example.com-报名表.xlsx");
}
```

另用 `std::env::temp_dir()` 下带纳秒 ID 的专属测试目录验证已有 `重庆-报名表.docx` 时生成 `重庆-报名表-2.docx`，测试结束只清理该专属目录。

- [ ] **Step 2: 运行归档测试并确认失败**

Run:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml archive::tests
```

Expected: FAIL，模块和函数尚不存在。

- [ ] **Step 3: 实现纯路径函数**

在 `archive.rs` 实现：

```rust
pub enum ArchiveBucket { Matched, Unmatched }

pub fn sanitize_segment(value: &str) -> String;
pub fn task_root(save_directory: &Path, task_name: &str) -> PathBuf;
pub fn bucket_directory(root: &Path, bucket: ArchiveBucket) -> PathBuf;
pub fn matched_name(company: &str, material: &str, original: &str) -> String;
pub fn unmatched_name(received_at: &str, sender: &str, original: &str) -> String;
pub fn unique_destination(directory: &Path, filename: &str) -> PathBuf;
```

具体规则：

- Windows 非法字符 `< > : \ / | ? *` 和控制字符替换为 `_`。
- 去除尾部空格和句点；空结果使用 `未命名`。
- 已匹配名称仅保留原扩展名，主体固定为 `单位-材料统一名称`。
- 序号从 `-2` 开始，循环检查 `Path::exists()`，绝不覆盖。
- `未匹配` 时间解析失败时使用当前本地时间生成 `yyyyMMdd-HHmmss`。

- [ ] **Step 4: 实现写入与移动原语**

提供：

```rust
pub fn write_new_attachment(directory: &Path, filename: &str, bytes: &[u8]) -> Result<PathBuf, String>;
pub fn move_with_cross_volume_fallback(source: &Path, target: &Path) -> Result<(), String>;
```

`move_with_cross_volume_fallback` 先尝试 `rename`；失败后复制到同目录临时文件、校验长度、再改名为最终目标，最后删除源文件。若源文件删除失败，返回包含源/目标路径的错误并保留可追溯文件。

- [ ] **Step 5: 将底层附件写入改为显式目标目录和名称**

把 `mail::write_attachment` 从“自行使用 message_id 命名”调整为接收后端已计算好的目标路径，或者只保留解码附件字节职责。归档目录与命名决策必须集中在 `archive.rs`，不得在 `mail.rs`、`lib.rs` 各复制一套规则。

- [ ] **Step 6: 注册模块并运行测试**

在 `src-tauri/src/lib.rs` 顶部加入：

```rust
mod archive;
```

Run:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml archive::tests
```

Expected: PASS，且重名测试确认旧文件内容未变化。

- [ ] **Step 7: 提交本任务**

```powershell
git add src-tauri/src/archive.rs src-tauri/src/lib.rs src-tauri/src/mail.rs
git commit -m "feat: add classified attachment archiving"
```

---

## Task 3: 按有效确认匹配重算单位反馈与任务进度

**Files:**

- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/src/models.rs`

- [ ] **Step 1: 先写反馈重算失败测试**

在 `src-tauri/src/lib.rs` 测试模块建立两家任务，写入如下场景：

1. 同一单位两封 `confirmed` 邮件，确认单位数仍为 1。
2. 忽略其中一封，单位仍为 `confirmed`。
3. 忽略最后一封，单位回退为 `pending`。
4. 一封 `needs_review` 通过 `match_candidates` 指向第二家，第二家状态为 `needs_review`。
5. 人工确认给第二家后，第二家变为 `confirmed`，进度为 2/2。

核心断言：

```rust
assert_eq!(feedback_status(&connection, "task-1", "company-1"), "pending");
assert_eq!(confirmed_company_count(&connection, "task-1"), 1);
```

- [ ] **Step 2: 运行并确认现有增量逻辑失败**

Run:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml task_feedback
```

Expected: FAIL，现有逻辑只能把状态改为已反馈，不能在唯一有效匹配消失后回退。

- [ ] **Step 3: 实现唯一重算函数**

新增：

```rust
fn recompute_task_feedback(connection: &Connection, task_id: &str) -> Result<(), String>
```

对任务范围内每家单位按优先级计算：

```text
存在 matches.status='confirmed' 且 company_id=当前单位 -> confirmed
否则存在 needs_review match 的 match_candidates -> needs_review
否则 -> pending
```

只考虑 `task_companies` 中属于该任务的单位。`unmatched`、`ignored` 不改变任何单位为完成。

- [ ] **Step 4: 修正任务列表完成数查询**

`task_list` 的 `confirmed_companies` 使用任务范围内有效匹配去重查询：

```sql
COUNT(DISTINCT CASE WHEN m.status='confirmed' THEN tc.company_id END)
```

查询必须通过 `tc.company_id = m.company_id AND tc.task_id = m.task_id` 关联，避免其他任务或已从任务范围删除的单位污染进度。

- [ ] **Step 5: 完整实现 match_resolve**

接口保持人工操作语义，至少支持：

- 指派或改派到指定 `task_id + company_id`；
- 标记 `ignored`；
- 从 `needs_review/unmatched` 确认为 `confirmed`；
- 操作后调用 `recompute_task_feedback`；
- 人工结果写入 `reviewed_at`，优先于自动匹配。

先只实现数据库状态和重算；文件搬移在 Task 5 接入补偿事务。

- [ ] **Step 6: 运行测试**

Run:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml task_feedback
```

Expected: PASS，确认进度可增加也可回退。

- [ ] **Step 7: 提交本任务**

```powershell
git add src-tauri/src/lib.rs src-tauri/src/models.rs
git commit -m "fix: recompute collection progress by company"
```

---

## Task 4: 自动收件先匹配、再分类归档并持久化候选

**Files:**

- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/src/mail.rs`

- [ ] **Step 1: 先写同步归档集成测试**

使用内存数据库和专属临时根目录，准备三封邮件：

- 发件人及关键词唯一命中重庆公司，附件 `原报名表.docx`；
- 多候选进入 `needs_review`，附件 `待确认.xlsx`；
- 无单位映射进入 `unmatched`，附件 `未知.txt`。

断言：

```rust
assert!(root.join("任务A/已匹配/重庆-数据安全报名表.docx").exists());
assert!(saved_path_for("待确认.xlsx").contains("任务A\\未匹配"));
assert!(saved_path_for("未知.txt").contains("任务A\\未匹配"));
assert_eq!(candidate_count_for(needs_review_match_id), 2);
```

再同步相同邮件，断言附件行和磁盘文件都没有重复增加。

- [ ] **Step 2: 运行并确认失败**

Run:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml task_sync_archive
```

Expected: FAIL，当前代码在匹配结果明确前即调用 `mail::write_attachment`，且未写入候选表。

- [ ] **Step 3: 重排任务同步数据流**

任务同步单封邮件采用固定顺序：

1. 校验任务时间范围。
2. 根据 `mailbox_id + external_id + content_hash` 判断消息是否已存在。
3. 计算任务规则和单位匹配结果。
4. 新增或更新 `matches`，并事务写入 `match_candidates`。
5. 对新邮件附件按匹配结果选择目录和文件名。
6. 保存 `attachments.saved_path` 和解析状态。
7. 单封邮件数据库事务成功后，再刷新同步进度事件。
8. 本轮任务完成后调用一次 `recompute_task_feedback`。

- [ ] **Step 4: 明确归档选择规则**

```rust
match match_status.as_str() {
    "confirmed" => ArchiveBucket::Matched,
    "needs_review" | "unmatched" => ArchiveBucket::Unmatched,
    _ => ArchiveBucket::Unmatched,
}
```

已匹配名称输入为单位名称、任务 `material_name`、原附件名；未匹配名称输入为接收时间、解析出的发件邮箱、原附件名。

直接在“收件箱”发起且没有 `task_id` 的同步继续使用现有全局收件归档方式，不伪造任务目录。

- [ ] **Step 5: 处理文件写入与数据库失败**

- 文件写入失败：不插入成功路径，附件标记 `archive_failed`，同步错误包含目标目录与系统错误。
- 附件数据库插入失败：删除本次刚创建且可确认属于当前事务的新文件；删除失败则在错误中同时报告残留路径。
- 已存在邮件：不重复写附件文件；允许补写缺失的匹配候选，但不能生成 `-2` 副本。

- [ ] **Step 6: 运行测试**

Run:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml task_sync_archive
```

Expected: PASS，三个状态进入正确目录，重复同步无重复文件。

- [ ] **Step 7: 提交本任务**

```powershell
git add src-tauri/src/lib.rs src-tauri/src/mail.rs
git commit -m "feat: archive task attachments by match status"
```

---

## Task 5: 人工确认时安全移动附件并支持打开所在目录

**Files:**

- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/src/models.rs`
- Modify: `src-tauri/tauri.conf.json` if shell scope needs adjustment
- Modify: `src/main.js`
- Modify: `src/styles.css`
- Modify: `tests/core.test.mjs`

- [ ] **Step 1: 先写人工移动和路径校验测试**

Rust 测试覆盖：

- `needs_review` 附件从 `未匹配` 移至 `已匹配` 并更新 `saved_path`；
- 目标同名时使用 `-2`；
- 第二个附件移动失败时，已移动的第一个附件补偿回原处，数据库路径不变；
- `material_open_location` 拒绝不在 `attachments.saved_path` 中的任意路径；
- 数据库路径存在但文件丢失时返回包含实际路径的错误。

- [ ] **Step 2: 运行并确认失败**

Run:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml match_resolve_archive
cargo test --manifest-path src-tauri/Cargo.toml material_open_location
```

Expected: FAIL，当前 `match_resolve` 未处理附件文件，且没有定位目录命令。

- [ ] **Step 3: 为 match_resolve 增加补偿式文件事务**

实现顺序：

1. 查询匹配记录、任务、目标单位和全部已归档附件。
2. 计算所有唯一目标路径，不修改数据库。
3. 逐个移动并记录 `(source, target)`。
4. 任一移动失败时按倒序移回已移动文件，不更新数据库。
5. 全部移动成功后开启 SQLite 事务，更新 `matches`、删除旧候选、更新每条 `attachments.saved_path`、重算任务反馈。
6. 数据库提交失败时，按倒序把文件移回；错误同时列出补偿失败路径。

禁止出现“数据库已确认但文件仍在未匹配目录”的静默成功。

- [ ] **Step 4: 实现 material_open_location**

接口：

```rust
#[tauri::command]
fn material_open_location(path: String, state: State<'_, AppState>) -> Result<String, String>
```

安全检查：

1. `path` 非空；
2. 数据库 `attachments.saved_path` 精确存在该路径；
3. 文件实际存在；
4. 文件时调用 `explorer.exe /select,<完整路径>`；若选中调用失败，回退打开父目录；
5. 目录时直接打开目录。

注册到 `invoke_handler`。现有 `material_open` 继续用于“打开文件”。

- [ ] **Step 5: 更新任务详情附件查询**

`load_task_match_detail` 查询：

```sql
SELECT id, original_name, COALESCE(saved_path,''), parse_status
FROM attachments
WHERE message_id=?1
ORDER BY original_name
```

后端计算 `can_open = !saved_path.is_empty() && Path::new(&saved_path).exists()`。

- [ ] **Step 6: 更新收件箱和任务详情附件按钮**

每个有路径的附件显示：

```text
[打开文件] [打开所在目录]
```

无路径时两个按钮禁用并显示“附件尚未归档到本地”；命令失败时通知中显示后端返回的实际路径和错误。不得再依赖点击整行附件触发单一操作。

- [ ] **Step 7: 运行测试**

Run:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml match_resolve_archive
cargo test --manifest-path src-tauri/Cargo.toml material_open_location
npm test -- --test-name-pattern="attachment"
```

Expected: PASS。

- [ ] **Step 8: 提交本任务**

```powershell
git add src-tauri/src/lib.rs src-tauri/src/models.rs src-tauri/tauri.conf.json src/main.js src/styles.css tests/core.test.mjs
git commit -m "feat: locate and reclassify archived attachments"
```

---

## Task 6: 新增系统级仪表盘聚合接口

**Files:**

- Modify: `src-tauri/src/models.rs`
- Modify: `src-tauri/src/lib.rs`
- Create: `src/core/dashboard.js`
- Modify: `tests/core.test.mjs`

- [ ] **Step 1: 先写仪表盘前端规范化失败测试**

在 `tests/core.test.mjs` 导入并测试：

```js
assert.deepEqual(normalizeDashboardSummary({
  collectionTaskCount: 4,
  activeCollectionTasks: 2,
  sendBatchCount: 3,
  todayReceived: 11,
  todaySentSuccess: 8,
  todaySentFailure: 1,
}), {
  collectionTaskCount: 4,
  activeCollectionTasks: 2,
  sendBatchCount: 3,
  todayReceived: 11,
  todaySentSuccess: 8,
  todaySentFailure: 1,
  latestReceiveStatus: '暂无收件记录',
  recentEvents: [],
});
```

- [ ] **Step 2: 运行并确认失败**

Run:

```powershell
npm test -- --test-name-pattern="dashboard"
```

Expected: FAIL，模块尚不存在。

- [ ] **Step 3: 定义后端 DTO**

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DashboardEvent {
    pub id: String,
    pub kind: String,
    pub title: String,
    pub detail: String,
    pub occurred_at: String,
    pub status: String,
    pub target_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DashboardSummary {
    pub collection_task_count: u32,
    pub active_collection_tasks: u32,
    pub send_batch_count: u32,
    pub today_received: u32,
    pub today_sent_success: u32,
    pub today_sent_failure: u32,
    pub latest_receive_status: String,
    pub recent_events: Vec<DashboardEvent>,
}
```

- [ ] **Step 4: 实现 dashboard_summary**

SQL 口径：

- 收集任务：`COUNT(*) FROM tasks`，进行中为 `status='active'`。
- 发送批次：`COUNT(*) FROM send_batches`。
- 今日收取：`messages.received_at` 按 SQLite `localtime` 当天计数。
- 今日发送成功/失败：`send_items` 关联 `send_runs`，仅 `mode='formal'` 且 `sent_at` 为本地当天。
- 最近收件状态：最新一条有 `task_id` 的 `sync_runs`。
- 最近动态：收件同步和正式发送记录按发生时间合并排序，最多 8 条；失败记录标题和 detail 必须带错误摘要。

注册命令 `dashboard_summary`。

- [ ] **Step 5: 实现前端纯函数并测试**

`src/core/dashboard.js` 提供：

```js
export function normalizeDashboardSummary(value = {}) { /* 数值归零、数组兜底 */ }
export function dashboardEventLabel(event = {}) { /* 收件/发送/失败中文标签 */ }
```

Run:

```powershell
npm test -- --test-name-pattern="dashboard"
cargo test --manifest-path src-tauri/Cargo.toml dashboard_summary
```

Expected: PASS。

- [ ] **Step 6: 提交本任务**

```powershell
git add src-tauri/src/models.rs src-tauri/src/lib.rs src/core/dashboard.js tests/core.test.mjs
git commit -m "feat: add system dashboard summary"
```

---

## Task 7: 重构仪表盘与收集任务界面

**Files:**

- Modify: `src/index.html`
- Modify: `src/main.js`
- Modify: `src/styles.css`
- Modify: `src/core/tasks.js`
- Modify: `tests/core.test.mjs`

- [ ] **Step 1: 先写 DOM 契约测试**

在 `tests/core.test.mjs` 读取 `src/index.html`，断言存在：

```js
for (const id of [
  'dashboard-collection-count',
  'dashboard-send-batch-count',
  'dashboard-received-today',
  'dashboard-sent-today',
  'dashboard-workspaces',
  'dashboard-activity',
  'task-summary-grid',
  'task-feedback-select',
  'task-feedback-panel',
  'task-material-name',
]) assert.match(html, new RegExp(`id="${id}"`));

assert.doesNotMatch(html, /id="dashboard-task-banner"/);
```

- [ ] **Step 2: 运行并确认失败**

Run:

```powershell
npm test -- --test-name-pattern="dashboard markup|task markup"
```

Expected: FAIL，页面仍是单任务仪表盘，任务页没有统计与统一名称字段。

- [ ] **Step 3: 重建仪表盘结构**

按已确认布局实现：

- 顶部 4 个紧凑指标卡：收集任务、发送批次、今日收取、今日成功发送；失败数在发送卡中以警示副文本显示。
- 中部两个同权重工作台卡片：`材料收集` 跳转 `tasks`，`邮件发送` 跳转 `send`。
- 底部最近系统动态列表；无记录显示明确空状态。
- 删除 `renderDashboardTask()` 以及旧单任务反馈图、任务邮件摘要相关 DOM 和渲染调用。
- 仪表盘聚合接口失败时显示局部错误，工作台入口仍可点击。

- [ ] **Step 4: 扩展收集任务页面**

顶部统计区显示：

1. 任务总数；
2. 进行中任务数；
3. 当前所选任务已完成反馈单位；
4. 当前所选任务待反馈/待确认。

维护状态：

```js
let selectedTaskSummaryId = '';
```

默认选择第一条进行中任务，否则选择第一条任务。任务下拉框切换时只更新当前任务统计、反馈分布和邮件列表，不能把多个任务的单位数相加。

每个任务行显示：

```text
任务名 | 已完成 X / Y 家 | 最近收件时间 | 完成进度 XX%
```

进度调用现有 `taskProgressPercent(task)`，其输入必须来自后端按有效单位匹配计算的 `confirmed_companies`。

- [ ] **Step 5: 增加反馈状态区和匹配邮件区**

当前任务显示：

- `confirmed` 已反馈单位数；
- `pending` 待反馈单位数；
- `needs_review` 待确认单位数；
- `unmatched` 未匹配邮件数（明确使用“封”，不混作单位数）；
- 匹配邮件列表展示发件人、主题、接收时间、状态、单位、匹配原因和结构化附件操作。

同步运行的 `matched` 只标注为“本次命中邮件”，不展示为任务进度。

- [ ] **Step 6: 更新新建/编辑任务表单**

在任务名称旁增加 `材料统一名称`：

- 新建时用户尚未输入时动态跟随任务名称；一旦用户手工修改，不再自动覆盖。
- 编辑时完整回显 `material_name`。
- 字段下方实时示例：`重庆-数据安全报名表.docx`。
- 保存传递给 `buildTaskInput({ materialName })`。

- [ ] **Step 7: 实现响应式科技感样式**

- 1280×720 下四个指标同排，任务列表和反馈区不遮挡。
- 低于 980px 时指标变为两列，工作台卡片变为单列。
- 复用现有深色玻璃面板、青色描边和状态色；不引入新 UI 框架。
- 邮件/附件行保持紧凑，长主题、路径和单位名省略并提供 `title`。
- 错误、待确认、成功状态分别使用现有红/橙/青色体系。

- [ ] **Step 8: 运行前端测试和构建**

Run:

```powershell
npm test
npm run build
```

Expected: PASS；构建无缺失选择器、未定义函数或重复 ID。

- [ ] **Step 9: 提交本任务**

```powershell
git add src/index.html src/main.js src/styles.css src/core/tasks.js tests/core.test.mjs
git commit -m "feat: redesign dashboard and collection progress"
```

---

## Task 8: 全量回归、Windows 安装包与本地验收

**Files:**

- Modify only if verification exposes defects: files touched in Tasks 1–7
- Verify: `src-tauri/target/release/bundle/nsis/`
- Verify: `src-tauri/target/release/bundle/msi/`

- [ ] **Step 1: 检查实现范围和残留旧逻辑**

Run:

```powershell
rg -n "dashboard-task-banner|renderDashboardTask|filename_template" src
rg -n "material_name|match_candidates|dashboard_summary|material_open_location|recompute_task_feedback" src-tauri/src src
git diff --check
```

Expected:

- 旧单任务仪表盘渲染不存在；
- `filename_template` 可保留数据库兼容读取，但新任务归档不得再依赖旧 `{task}_{company}_{filename}` 命名；
- 新数据字段、命令和反馈重算函数均有调用点；
- `git diff --check` 无空白错误。

- [ ] **Step 2: 运行完整自动测试**

```powershell
npm test
cargo test --manifest-path src-tauri/Cargo.toml
npm run build
```

Expected: 全部 PASS。若 `npm run build` 在 Vite/Rolldown 配置阶段出现 `spawn EPERM`，按项目环境规则使用已批准的 `npm run build` 前缀在沙箱外重跑，不把它误判为代码失败。

- [ ] **Step 3: 运行 Tauri 打包**

```powershell
npm run tauri -- build
```

Expected: Rust release build、NSIS 和 MSI 全部成功。

- [ ] **Step 4: 核验安装包和数据库兼容性**

检查：

```powershell
Get-ChildItem src-tauri/target/release/bundle/nsis -File | Select-Object Name,Length,LastWriteTime
Get-ChildItem src-tauri/target/release/bundle/msi -File | Select-Object Name,Length,LastWriteTime
```

在本地安装/升级验证前先复制 `E:\software\unigather\unigather.db` 为带时间戳的 `.bak`；不得删除或覆盖原数据库。启动后确认迁移只新增列和表，现有任务、邮件、发送记录仍可读取。

- [ ] **Step 5: 手工端到端验收**

按顺序验证：

1. 仪表盘同时显示收集与发送概况，不显示单任务进度。
2. 收集任务页选择具体任务，进度等于已反馈单位数/总单位数。
3. 同一单位多封确认邮件只增加一个完成单位。
4. 忽略唯一确认邮件后进度能够下降。
5. 匹配附件进入 `任务名\已匹配`，名称为 `单位-统一名称.ext`。
6. 待确认和未匹配附件进入 `任务名\未匹配`。
7. 人工确认后文件移动、重命名、路径更新。
8. 收件箱和任务详情的“打开文件”“打开所在目录”均可用。
9. 删除磁盘文件后界面显示准确路径和错误。
10. 旧附件仍从原路径打开，不发生自动搬迁。

- [ ] **Step 6: 形成交付说明**

交付时列出：

- 已完成的行为变化；
- 四项自动验证命令及结果；
- NSIS/MSI 安装包绝对路径、大小和生成时间；
- 未发布 GitHub/Release 的确认；
- 1–3 条不自动实施的后续建议。

- [ ] **Step 7: 提交最终验证修复（仅在确有修复时）**

```powershell
git add <仅本轮验证修复文件>
git commit -m "test: complete archive workflow verification"
```

若验证未产生新代码修改，则不创建空提交。

---

## Final Acceptance Contract

- 任务完成百分比唯一口径为 `confirmed unit count / task company count`。
- 多邮件、多附件不会重复计算单位完成数，忽略/改派后可以回退。
- 仪表盘只展示全局收发工作概况；具体单位反馈全部位于收集任务页。
- 新任务附件按 `已匹配/未匹配` 分类，匹配文件命名为 `单位-材料统一名称.ext` 且绝不覆盖。
- 人工确认时磁盘文件与数据库路径保持一致；失败时回滚或报告可追溯残留。
- 收件箱和任务详情都能打开附件及其所在目录，任意网页路径不能绕过数据库校验。
- 旧数据、旧归档、发送规则保持兼容。
- 本轮仅本地构建和验收，不推送、不发布。
