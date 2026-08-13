# 任务单位选择器紧凑化实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 提升新建/编辑收集任务时单位选择列表的可读性，并在相同窗口高度显示更多单位。

**Architecture:** 保持现有 `renderTaskCompanyPicker` 的数据和选择行为不变，只通过 CSS 调整列表行的尺寸、字体和列间距。测试从页面生成代码和样式声明验证该视觉契约，避免影响单位筛选、全选与保存逻辑。

**Tech Stack:** 原生 HTML/CSS/JavaScript、Node 内置测试。

## Global Constraints

- 仅调整 `.task-picker-redesigned` 内的单位选择列表。
- 单位名称为 14px 加粗，联系人/邮箱摘要为 12px。
- 单行高度约 40px，列表行间距为 2px。
- 保留文本省略与 `title` 悬停完整信息。
- 不改变单位筛选、勾选、全选、清空和任务保存行为。

---

### Task 1: 单位选择器视觉契约

**Files:**
- Modify: `tests/core.test.mjs`
- Modify: `src/styles.css`

**Interfaces:**
- Consumes: `.task-picker-redesigned .task-company-option`、`.task-company-option strong`、`.task-company-option small`。
- Produces: 40px 紧凑行、14px 单位名称、12px 联系人摘要、2px 行间距的样式契约。

- [ ] **Step 1: 写入失败的样式契约测试**

```js
test('uses readable and compact task company picker rows', () => {
  const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
  assert.match(css, /\.task-picker-redesigned \.task-company-option\{[^}]*height:40px/);
  assert.match(css, /\.task-picker-redesigned \.task-company-option strong\{[^}]*font-size:14px/);
  assert.match(css, /\.task-picker-redesigned \.task-company-option small\{[^}]*font-size:12px/);
});
```

- [ ] **Step 2: 运行测试并确认失败**

运行：`npm test`

预期：新测试因尚未出现 40px、14px、12px 的选择器样式而失败。

- [ ] **Step 3: 仅修改单位选择器 CSS**

```css
.task-picker-redesigned .task-company-list { gap: 2px; }
.task-picker-redesigned .task-company-option { height: 40px; min-height: 40px; }
.task-picker-redesigned .task-company-option strong { font-size: 14px; }
.task-picker-redesigned .task-company-option small { font-size: 12px; }
```

- [ ] **Step 4: 运行测试并确认通过**

运行：`npm test`

预期：全部前端测试通过。

- [ ] **Step 5: 构建桌面安装包**

运行：`npm run build`、`npm run tauri -- build`

预期：生成 NSIS 与 MSI 本地安装包；不推送 GitHub、不发布 Release。
