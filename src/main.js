import { invokeCommand } from './bridge.js';
import { buildMailboxPayload, buildMailboxStorage, mailboxDefaults, validateMailboxForm, validateMailboxSave } from './core/mailbox.js';
import { buildTaskInput, taskStatusLabel, validateTaskInput, normalizeFeedbackPage, nextFeedbackPage } from './core/tasks.js';
import { decodeCsvBuffer, parseCompanyMatrix, parseCompanyRows } from './core/attachments.js';
import { DEFAULT_MATERIAL_PATH, normalizeMaterialPath } from './core/materials.js';
import { filterInboxMessages, normalizeInboxMessage, sortInboxMessages } from './core/inbox.js';
import { normalizeInboxStartTime } from './core/sync.js';
import { syncProgressLabel, syncProgressPercent } from './core/sync-progress.js';
import { normalizeAiConfig, validateAiConfig } from './core/ai.js';
import { formatDownloadProgress, isNewerVersion, pickInstallerAsset } from './core/update.js';
import { filterCompanyOptions, normalizeCompanyOptions, toggleAllCompanyIds, validateCompanySelection } from './core/company-selection.js';
import { normalizeSyncEnd } from './core/task-sync.js';
import { buildTimePresetRange, formatCompanyOptionMeta, validateTimeRange } from './core/task-form-ui.js';
import { formatTaskScheduleCountdown, formatTaskScheduleTime, getTaskSchedule, shouldRunInitialTaskSync } from './core/task-schedule.js';
import { formatSendProgress } from './core/send.js';
import { buildSendBatchItems, composeSendBody, formatBatchProgress, groupSendBatchItems, parseBatchCc, sendItemStatusMeta, validateSendBatch, validateBatchPersistence } from './core/send-workbench.js';
import { dashboardEventLabel, normalizeDashboardSummary } from './core/dashboard.js';
import { buildPendingFeedbackExportRows, normalizePendingFeedbackCompanies, pendingFeedbackStatusLabel } from './core/pending-feedback.js';
import { drilldownItems, paginateTaskMatches } from './core/task-feedback.js';
import * as XLSX from 'xlsx';

const navItems = document.querySelectorAll('.nav-item');
const views = document.querySelectorAll('.view');
const toast = document.querySelector('#toast');
const TASK_STORAGE_KEY = 'unigather.tasks.v1';
const MAILBOX_STORAGE_KEY = 'unigather.mailbox.v1';
const MATERIAL_PATH_STORAGE_KEY = 'unigather.material-path.v1';
const AI_CONFIG_STORAGE_KEY = 'unigather.ai-config.v1';
const TASK_SYNC_STORAGE_KEY = 'unigather.task-sync-times.v1';
const TASK_LAST_RECEIVE_STORAGE_KEY = 'unigather.task-last-receive.v1';
const APP_VERSION = '0.0.4';
const RELEASES_ENDPOINT = 'https://api.github.com/repos/cwxsss/unigather/releases/latest';
let tasks = [];
let deletedTasks = [];
let companyRows = [];
let companyOptions = [];
let selectedCompanyIds = [];
let inboxMessages = [];
let selectedMessageId = '';
let inboxQuery = '';
let editingTaskId = '';
let detailTaskId = '';
let selectedTaskSummaryId = '';
let pendingFeedbackCompanies = [];
let taskMatchPage = 1;
let taskMatchPageSize = 20;
let taskManagementFilter = 'all';
let taskFeedbackDetail = null;
let taskFeedbackPage = 1;
let taskFeedbackPageSize = 20;
let taskFeedbackFilter = 'all';
let taskFeedbackTaskId = '';
let pendingDeleteTask = null;
let materialNameManuallyEdited = false;
let activeSyncRunId = '';
let activeSyncTaskId = '';
let syncPollTimer = 0;
let taskPollingTimer = 0;
let mailboxCredentialPresent = false;
let sendBatch = { id: '', name: '', sourceDir: '', recursive: true, files: [], items: [], subject: '', body: '', signature: '中国联通总部数据安全工作组', cc: [] };
let sendBatchHistory = [];
let activeSendRunId = '';
let sendPollingTimer = 0;
let sendTestConfirmed = false;

function notify(message, tone = 'info') {
  if (!toast) return;
  toast.textContent = message;
  toast.dataset.tone = tone;
  toast.classList.add('show');
  window.clearTimeout(notify.timer);
  notify.timer = window.setTimeout(() => toast.classList.remove('show'), 2800);
}

function showView(name) {
  navItems.forEach((item) => item.classList.toggle('active', item.dataset.view === name));
  views.forEach((view) => view.classList.toggle('active', view.id === `${name}-view`));
  if (name === 'tasks') renderTasks();
  if (name === 'dashboard') void loadDashboardSummary();
  if (name === 'send') { renderSendWorkbench(); void loadSendHistory(); }
}

function readLocalTasks() {
  try {
    const parsed = JSON.parse(localStorage.getItem(TASK_STORAGE_KEY) ?? '[]');
    return Array.isArray(parsed) ? parsed.filter((task) => task && task.id && task.name) : [];
  } catch { return []; }
}

function writeLocalTasks() {
  localStorage.setItem(TASK_STORAGE_KEY, JSON.stringify(tasks));
}

function readTaskLastReceiveTimes() {
  try {
    const value = JSON.parse(localStorage.getItem(TASK_LAST_RECEIVE_STORAGE_KEY) ?? '{}');
    return value && typeof value === 'object' ? value : {};
  } catch { return {}; }
}

function writeTaskLastReceiveTime(taskId, timestamp = Date.now()) {
  const values = readTaskLastReceiveTimes();
  values[taskId] = timestamp;
  localStorage.setItem(TASK_LAST_RECEIVE_STORAGE_KEY, JSON.stringify(values));
}

function taskSchedule(task, now = Date.now()) {
  const receiveTimes = readTaskLastReceiveTimes();
  const scheduleTimes = readTaskSyncTimes();
  return getTaskSchedule(task, receiveTimes[task.id], now, scheduleTimes[task.id]);
}

function taskScheduleSummary(task, now = Date.now()) {
  const schedule = taskSchedule(task, now);
  const nextText = schedule.stopped
    ? '已停止'
    : `${formatTaskScheduleTime(schedule.nextSyncAt)}（${formatTaskScheduleCountdown(schedule.nextSyncAt, now)}）`;
  return {
    lastText: `上次收件：${formatTaskScheduleTime(schedule.lastSyncAt)}`,
    nextText: `下次自动收件：${nextText}`,
  };
}

function fallbackTaskSummary(input) {
  return { id: `local-${Date.now()}`, name: input.name, material_name: input.material_name, status: 'active', total_companies: input.company_ids.length, confirmed_companies: 0, company_ids: input.company_ids, deadline: input.deadline, start_time: input.start_time, poll_minutes: input.poll_minutes, save_directory: input.save_directory, subject_keywords: input.subject_keywords, body_keywords: input.body_keywords, ai_enabled: input.ai_enabled };
}

async function loadTasks() {
  const localTasks = readLocalTasks();
  const [result, deletedResult] = await Promise.all([
    invokeCommand('task_list', { includeDeleted: false }, () => localTasks),
    invokeCommand('task_list', { includeDeleted: true }, () => []),
  ]);
  tasks = Array.isArray(result) ? result : localTasks;
  deletedTasks = Array.isArray(deletedResult) ? deletedResult : [];
  // Remove the two old demo records if they were saved by an earlier preview build.
  tasks = tasks.filter((task) => !['task-q3', 'task-audit'].includes(task.id) && !['2026 年第三季度经营材料收集', '审计整改闭环材料'].includes(task.name));
  writeLocalTasks();
  const syncTimes = readTaskSyncTimes();
  tasks.filter((task) => task.status === 'active').forEach((task) => { if (!syncTimes[task.id]) syncTimes[task.id] = Date.now(); });
  localStorage.setItem(TASK_SYNC_STORAGE_KEY, JSON.stringify(syncTimes));
  renderTasks();
  void loadDashboardSummary();
  renderSendWorkbench();
}

function formatDeadline(value) {
  if (!value) return '未设置截止时间';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('zh-CN', { year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function renderTasks() {
  const list = document.querySelector('#task-list');
  if (!list) return;
  if (!tasks.some((task) => task.id === selectedTaskSummaryId)) selectedTaskSummaryId = tasks.find((task) => task.status === 'active')?.id ?? tasks[0]?.id ?? '';
  const selected = tasks.find((task) => task.id === selectedTaskSummaryId);
  const setText = (selector, value) => { const element = document.querySelector(selector); if (element) element.textContent = value; };
  setText('#task-total-count', tasks.length);
  setText('#task-active-count', tasks.filter((task) => task.status === 'active').length);
  setText('#task-completed-count', tasks.filter((task) => task.status === 'completed').length);
  setText('#task-deleted-count', deletedTasks.length);
  const selector = document.querySelector('#task-feedback-select');
  if (selector) {
    selector.replaceChildren(...tasks.map((task) => { const option = document.createElement('option'); option.value = task.id; option.textContent = task.name; option.selected = task.id === selectedTaskSummaryId; return option; }));
  }
  list.replaceChildren();
  if (!tasks.length) {
    list.innerHTML = '<div class="panel empty-state"><span class="empty-state-icon">＋</span><h3>还没有收集任务</h3><p>创建任务后，在这里查看反馈进度、同步记录和待反馈单位。</p><button class="primary-button" type="button" data-open-task>创建第一个任务</button></div>';
    list.querySelector('[data-open-task]')?.addEventListener('click', openTaskModal);
    const feedback = document.querySelector('#task-feedback-content');
    if (feedback) feedback.innerHTML = '<div class="feedback-empty compact"><span>＋</span><strong>暂无任务</strong><p>创建任务后可查看单位反馈与匹配邮件。</p></div>';
    return;
  }
  const activeTasks = tasks.filter((task) => task.status === 'active');
  if (!activeTasks.length) {
    list.innerHTML = '<div class="panel empty-state compact"><span class="empty-state-icon">◎</span><h3>暂无进行中的任务</h3><p>可从上方任务管理入口恢复中断任务，或新建收集任务。</p></div>';
  }
  activeTasks.forEach((task, index) => {
    const row = document.createElement('article');
    row.className = 'task-list-row';
    row.dataset.taskId = task.id;
    const badge = document.createElement('div');
    badge.className = `task-badge${index % 2 ? ' purple' : ''}`;
    badge.textContent = task.name.slice(0, 2);
    const detail = document.createElement('div');
    detail.innerHTML = `<strong></strong><small></small><div class="task-schedule-line"><span></span><span></span></div>`;
    detail.querySelector('strong').textContent = task.name;
    detail.querySelector('small').textContent = `${task.total_companies ?? 0} 家单位　·　截止 ${formatDeadline(task.deadline)}　·　每 ${task.poll_minutes ?? 30} 分钟`;
    const schedule = taskScheduleSummary(task);
    detail.querySelector('.task-schedule-line span:first-child').textContent = schedule.lastText;
    detail.querySelector('.task-schedule-line span:last-child').textContent = schedule.nextText;
    const status = document.createElement('span');
    status.className = `status ${task.status === 'completed' ? 'completed' : task.status === 'paused' ? 'overdue' : 'progress'}`;
    status.textContent = taskStatusLabel(task.status);
    const progress = document.createElement('b');
    progress.title = '单位反馈完成度';
    progress.textContent = `已反馈 ${task.confirmed_companies ?? 0}/${task.total_companies ?? 0}`;
    const actions = document.createElement('div');
    actions.className = 'task-row-actions';
    const open = document.createElement('button');
    open.className = 'icon-button'; open.type = 'button'; open.title = '打开任务'; open.textContent = '→';
    open.addEventListener('click', () => openTaskDetail(task));
    const remove = document.createElement('button');
    remove.className = 'icon-button danger-icon'; remove.type = 'button'; remove.title = '删除任务'; remove.textContent = '×';
    remove.addEventListener('click', () => deleteTask(task));
    actions.append(open, remove);
    row.addEventListener('click', (event) => { if (!event.target.closest('button')) openTaskDetail(task); });
    row.append(badge, detail, progress, status, actions);
    list.append(row);
  });
  void renderTaskFeedbackPanel(selectedTaskSummaryId);
}

function taskManagementLabel(filter) {
  return { all: '全部任务', active: '进行中的任务', completed: '已完成任务', deleted: '已删除任务' }[filter] ?? '任务管理';
}

function filteredManagedTasks(filter) {
  if (filter === 'deleted') return deletedTasks;
  return filter === 'all' ? tasks : tasks.filter((task) => task.status === filter);
}

function openTaskManagement(filter = 'all') {
  const modal = document.querySelector('#task-management-modal');
  if (!modal) return;
  taskManagementFilter = filter;
  const selector = modal.querySelector('#task-management-filter');
  if (selector) selector.value = filter;
  renderTaskManagement();
  modal.classList.add('open');
  modal.setAttribute('aria-hidden', 'false');
}

function closeTaskManagement() {
  const modal = document.querySelector('#task-management-modal');
  modal?.classList.remove('open');
  modal?.setAttribute('aria-hidden', 'true');
}

function renderTaskManagement() {
  const modal = document.querySelector('#task-management-modal');
  const list = modal?.querySelector('#task-management-list');
  if (!modal || !list) return;
  const visible = filteredManagedTasks(taskManagementFilter);
  modal.querySelector('#task-management-title').textContent = taskManagementLabel(taskManagementFilter);
  modal.querySelector('#task-management-count').textContent = `${visible.length} 个任务`;
  list.replaceChildren();
  if (!visible.length) { list.innerHTML = '<div class="send-empty">该状态下暂无任务。</div>'; return; }
  visible.forEach((task) => {
    const row = document.createElement('article');
    row.className = 'task-management-row';
    row.innerHTML = `<div><strong>${escapeHtml(task.name)}</strong><small>${task.status === 'deleted' ? `删除于 ${escapeHtml(formatDeadline(task.deleted_at))}` : `${taskStatusLabel(task.status)} · ${task.total_companies ?? 0} 家单位 · 截止 ${escapeHtml(formatDeadline(task.deadline))}`}</small></div><span class="status ${task.status === 'completed' ? 'completed' : task.status === 'paused' || task.status === 'deleted' ? 'overdue' : 'progress'}">${taskStatusLabel(task.status)}</span><div class="task-management-actions"></div>`;
    const actions = row.querySelector('.task-management-actions');
    if (task.status === 'deleted') {
      const restore = document.createElement('button'); restore.type = 'button'; restore.className = 'primary-button'; restore.textContent = '恢复任务'; restore.addEventListener('click', () => void restoreTask(task));
      actions.append(restore); list.append(row); return;
    }
    const detail = document.createElement('button'); detail.type = 'button'; detail.className = 'ghost-button'; detail.textContent = '查看详情'; detail.addEventListener('click', () => { closeTaskManagement(); openTaskDetail(task); });
    const edit = document.createElement('button'); edit.type = 'button'; edit.className = 'ghost-button'; edit.textContent = '编辑'; edit.addEventListener('click', () => { closeTaskManagement(); openTaskModal(task); });
    const rename = document.createElement('button'); rename.type = 'button'; rename.className = 'ghost-button'; rename.textContent = '重命名'; rename.addEventListener('click', () => void renameTask(task));
    const run = document.createElement('button'); run.type = 'button'; run.className = 'ghost-button'; run.textContent = task.status === 'active' ? '立即运行' : '重新运行'; run.addEventListener('click', () => void rerunTask(task));
    const state = document.createElement('button'); state.type = 'button'; state.className = 'ghost-button'; state.textContent = task.status === 'active' ? '停止任务' : task.status === 'completed' ? '恢复任务' : '恢复任务'; state.addEventListener('click', () => void setTaskState(task, task.status === 'active' ? 'paused' : 'active'));
    const complete = document.createElement('button'); complete.type = 'button'; complete.className = 'ghost-button'; complete.textContent = '标记完成'; complete.disabled = task.status === 'completed'; complete.addEventListener('click', () => void setTaskState(task, 'completed'));
    const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'ghost-button danger-button'; remove.textContent = '删除'; remove.addEventListener('click', () => void deleteTask(task, true));
    actions.append(detail, edit, rename, run, state, complete, remove); list.append(row);
  });
}

async function restoreTask(task) {
  try {
    await invokeCommand('task_restore', { taskId: task.id });
    await loadTasks();
    renderTaskManagement();
    notify('任务已恢复为已中断状态，可编辑后重新运行。');
  } catch (error) { notify(`恢复任务失败：${error.message ?? error}`, 'error'); }
}

async function setTaskState(task, status) {
  try {
    await invokeCommand('task_set_status', { taskId: task.id, status });
    await loadTasks(); renderTaskManagement();
    notify(status === 'paused' ? '任务已中断，将不再自动收件。' : status === 'completed' ? '任务已标记为完成。' : '任务已恢复。');
  } catch (error) { notify(`更新任务状态失败：${error.message ?? error}`, 'error'); }
}

async function rerunTask(task) {
  try {
    if (task.status !== 'active') await invokeCommand('task_set_status', { taskId: task.id, status: 'active' });
    await loadTasks();
    const updated = tasks.find((item) => item.id === task.id) ?? { ...task, status: 'active' };
    await runTaskSync(updated, { manual: true });
    renderTaskManagement();
  } catch (error) { notify(`重新运行失败：${error.message ?? error}`, 'error'); }
}

async function renameTask(task) {
  const name = window.prompt('请输入新的任务名称：', task.name);
  if (name === null) return;
  const trimmed = name.trim();
  if (!trimmed) { notify('任务名称不能为空。', 'error'); return; }
  try {
    await invokeCommand('task_rename', { taskId: task.id, name: trimmed });
    await loadTasks(); renderTaskManagement(); notify('任务名称已更新。');
  } catch (error) { notify(`重命名失败：${error.message ?? error}`, 'error'); }
}

function createAttachmentActions(attachment) {
  const wrapper = document.createElement('span'); wrapper.className = 'attachment-actions';
  const name = document.createElement('small'); name.textContent = attachment.name || '未命名附件'; name.title = attachment.savedPath || '';
  const open = document.createElement('button'); open.type = 'button'; open.className = 'link-button'; open.textContent = '打开文件'; open.disabled = !attachment.savedPath;
  const locate = document.createElement('button'); locate.type = 'button'; locate.className = 'link-button'; locate.textContent = '打开所在目录'; locate.disabled = !attachment.savedPath;
  open.addEventListener('click', async () => { try { await invokeCommand('material_open', { path: attachment.savedPath }); } catch (error) { notify(`无法打开附件：${error.message ?? error}`, 'error'); } });
  locate.addEventListener('click', async () => { try { await invokeCommand('material_open_location', { path: attachment.savedPath }); } catch (error) { notify(`无法打开所在目录：${error.message ?? error}`, 'error'); } });
  wrapper.append(name, open, locate);
  return wrapper;
}

async function renderTaskFeedbackPanel(taskId) {
  const content = document.querySelector('#task-feedback-content');
  const task = tasks.find((item) => item.id === taskId);
  if (!content || !task) return;
  if (taskFeedbackTaskId !== taskId) {
    taskFeedbackTaskId = taskId;
    taskFeedbackPage = 1;
    taskFeedbackFilter = 'all';
  }
  content.innerHTML = '<div class="send-empty">正在读取任务反馈…</div>';
  try {
    const [detail, feedbackPage, rawPendingCompanies] = await Promise.all([
      invokeCommand('task_match_detail', { taskId }),
      invokeCommand('task_feedback_page', { taskId, statusFilter: taskFeedbackFilter, page: taskFeedbackPage, pageSize: taskFeedbackPageSize }),
      invokeCommand('task_pending_companies', { taskId }),
    ]);
    if (selectedTaskSummaryId !== taskId) return;
    pendingFeedbackCompanies = normalizePendingFeedbackCompanies(rawPendingCompanies);
    taskFeedbackDetail = detail;
    const normalizedPage = normalizeFeedbackPage(feedbackPage ?? {});
    taskFeedbackPage = normalizedPage.page;
    taskFeedbackPageSize = normalizedPage.pageSize;
    const pending = Math.max(0, Number(task.total_companies || 0) - Number(task.confirmed_companies || 0));
    content.innerHTML = `<div class="task-feedback-stats"><button type="button" data-feedback-drilldown="confirmed"><span>已反馈单位</span><strong>${task.confirmed_companies ?? 0}</strong><small>查看明细 →</small></button><button type="button" data-feedback-drilldown="pending"><span>待反馈单位</span><strong>${pending}</strong><small>查看明细 / 导出 →</small></button><button type="button" data-feedback-drilldown="needs_review"><span>待确认邮件</span><strong>${feedbackPage.needsReview ?? detail.needsReview ?? 0}</strong><small>查看明细 →</small></button><button type="button" data-feedback-drilldown="unmatched"><span>未匹配邮件</span><strong>${feedbackPage.unmatched ?? detail.unmatched ?? 0}</strong><small>查看明细 →</small></button></div><section class="task-feedback-results"><div class="pending-feedback-head"><div><strong>反馈情况</strong><small>显示本任务收取并完成匹配判断的邮件；可按结论筛选并直接打开收件箱详情。</small></div><div class="task-feedback-controls"><select id="task-feedback-result-filter" aria-label="筛选反馈情况"><option value="all">全部邮件</option><option value="confirmed">已匹配</option><option value="needs_review">待确认</option><option value="unmatched">未匹配</option></select><select id="task-feedback-page-size" aria-label="每页显示数量"><option value="10">10 条/页</option><option value="20">20 条/页</option><option value="31">31 条/页</option><option value="40">40 条/页</option><option value="50">50 条/页</option></select></div></div><div class="pending-feedback-table-wrap"><table class="pending-feedback-table task-feedback-result-table"><thead><tr><th>邮件主题</th><th>已识别单位</th><th>状态</th><th>匹配说明</th><th>操作</th></tr></thead><tbody id="task-feedback-result-list"></tbody></table></div><div class="task-feedback-pagination" id="task-feedback-pagination"></div></section>`;
    const list = content.querySelector('#task-feedback-result-list');
    const filterControl = content.querySelector('#task-feedback-result-filter');
    const pageSizeControl = content.querySelector('#task-feedback-page-size');
    filterControl.value = taskFeedbackFilter;
    pageSizeControl.value = String(taskFeedbackPageSize);
    const messages = feedbackPage.messages ?? [];
    list.replaceChildren();
    if (!messages.length) { list.innerHTML = '<tr><td colspan="5" class="pending-feedback-empty">当前筛选条件下没有邮件。</td></tr>'; }
    messages.forEach((message) => {
      const [label, tone] = taskMatchStatus(message.status);
      const row = document.createElement('tr');
      row.innerHTML = `<td><strong>${escapeHtml(message.subject || '(无主题)')}</strong><small>${escapeHtml(message.sender)} · ${escapeHtml(formatDeadline(message.receivedAt))}</small></td><td>${escapeHtml(message.companyName || '未识别单位')}</td><td><span class="send-state-chip ${tone}">${label}</span></td><td title="${escapeHtml(taskMatchReason(message.reason))}">${escapeHtml(taskMatchReason(message.reason))}</td><td><button class="link-button" type="button">查看邮件</button></td>`;
      row.querySelector('button').addEventListener('click', () => openFeedbackMessageInInbox(message.messageId));
      list.append(row);
    });
    const pager = content.querySelector('#task-feedback-pagination');
    pager.innerHTML = feedbackPage.total ? `<span>第 ${taskFeedbackPage} / ${normalizedPage.pageCount} 页，共 ${feedbackPage.total} 封</span><button class="ghost-button" type="button" data-feedback-page="previous" ${taskFeedbackPage <= 1 ? 'disabled' : ''}>‹ 上一页</button><button class="ghost-button" type="button" data-feedback-page="next" ${taskFeedbackPage >= normalizedPage.pageCount ? 'disabled' : ''}>下一页 ›</button>` : '<span>共 0 封邮件</span>';
    filterControl.addEventListener('change', (event) => { taskFeedbackFilter = event.currentTarget.value; taskFeedbackPage = nextFeedbackPage({ page: taskFeedbackPage, pageCount: normalizedPage.pageCount }, 'filter-change'); void renderTaskFeedbackPanel(taskId); });
    pageSizeControl.addEventListener('change', (event) => { taskFeedbackPageSize = Number(event.currentTarget.value); taskFeedbackPage = nextFeedbackPage({ page: taskFeedbackPage, pageCount: normalizedPage.pageCount }, 'page-size-change'); void renderTaskFeedbackPanel(taskId); });
    pager.querySelectorAll('[data-feedback-page]').forEach((button) => button.addEventListener('click', () => { taskFeedbackPage = nextFeedbackPage({ page: taskFeedbackPage, pageCount: normalizedPage.pageCount }, button.dataset.feedbackPage); void renderTaskFeedbackPanel(taskId); }));
    content.querySelectorAll('[data-feedback-drilldown]').forEach((button) => button.addEventListener('click', () => openTaskFeedbackDrilldown(button.dataset.feedbackDrilldown, task, detail)));
  } catch (error) { content.innerHTML = `<div class="send-empty">任务反馈读取失败：${escapeHtml(error.message ?? error)}</div>`; }
}

function confirmedCompaniesForDetail(detail) {
  const names = [...new Set((detail.messages ?? []).filter((item) => item.status === 'confirmed' && item.companyName).map((item) => item.companyName))];
  return names.map((companyName) => {
    const option = companyOptions.find((item) => item.name === companyName);
    return {
      companyName,
      feedbackStatus: 'confirmed',
      contacts: [{ contactName: (option?.contacts ?? []).join('、'), email: (option?.emails ?? []).join('；'), phone: (option?.phones ?? []).join('、') }],
    };
  });
}

function openTaskFeedbackDrilldown(kind, task, detail = taskFeedbackDetail) {
  const modal = document.querySelector('#task-feedback-drilldown-modal');
  const title = document.querySelector('#task-feedback-drilldown-title');
  const content = document.querySelector('#task-feedback-drilldown-content');
  if (!modal || !title || !content || !detail) return;
  const labels = { confirmed: '已反馈单位', pending: '待反馈单位', needs_review: '待确认邮件', unmatched: '未匹配邮件' };
  title.textContent = `${task.name} · ${labels[kind] ?? '任务明细'}`;
  const companies = kind === 'confirmed' ? confirmedCompaniesForDetail(detail) : pendingFeedbackCompanies;
  const items = drilldownItems(kind, detail.messages ?? [], companies);
  if (!items.length) {
    content.innerHTML = '<div class="send-empty">当前没有可查看的明细。</div>';
  } else if (kind === 'confirmed') {
    content.innerHTML = `<section class="task-drilldown-table-wrap"><table class="task-drilldown-table single-column"><thead><tr><th>单位</th></tr></thead><tbody>${items.map((item) => `<tr><td><strong>${escapeHtml(item.companyName)}</strong></td></tr>`).join('')}</tbody></table></section>`;
  } else if (kind === 'pending') {
    content.innerHTML = `<div class="task-drilldown-toolbar"><span>${items.length} 家待反馈或待确认单位</span><button class="ghost-button" type="button" id="export-pending-from-drilldown">⇩ 导出待反馈单位</button></div><section class="task-drilldown-table-wrap"><table class="task-drilldown-table"><thead><tr><th>单位</th><th>联系人</th><th>邮箱</th><th>状态</th></tr></thead><tbody>${items.map((item) => {
      const contacts = item.contacts ?? [];
      const contactNames = contacts.map((contact) => contact.contactName).filter(Boolean).join('、') || '—';
      const emails = contacts.map((contact) => contact.email).filter(Boolean).join('；') || '—';
      return `<tr><td><strong>${escapeHtml(item.companyName)}</strong></td><td title="${escapeHtml(contactNames)}">${escapeHtml(contactNames)}</td><td title="${escapeHtml(emails)}">${escapeHtml(emails)}</td><td><span class="send-state-chip ${item.feedbackStatus === 'needs_review' ? 'warning' : 'muted'}">${pendingFeedbackStatusLabel(item.feedbackStatus)}</span></td></tr>`;
    }).join('')}</tbody></table></section>`;
    content.querySelector('#export-pending-from-drilldown')?.addEventListener('click', () => exportPendingFeedbackCompanies(task));
  } else {
    content.replaceChildren();
    const list = document.createElement('section');
    list.className = 'task-drilldown-table-wrap';
    const table = document.createElement('table');
    table.className = 'task-drilldown-table task-drilldown-mail-table';
    table.innerHTML = '<thead><tr><th>邮件主题</th><th>已识别单位</th><th>匹配结论</th><th>归档材料</th></tr></thead>';
    const body = document.createElement('tbody');
    items.forEach((item) => {
      const row = document.createElement('tr');
      row.innerHTML = `<td><strong>${escapeHtml(item.subject || '(无主题)')}</strong><small>${escapeHtml(item.sender || '未知发件人')} · ${escapeHtml(formatDeadline(item.receivedAt))}</small></td><td>${escapeHtml(item.companyName || '未识别单位')}</td><td><span class="send-state-chip ${kind === 'needs_review' ? 'warning' : 'danger'}">${kind === 'needs_review' ? '待确认' : '未匹配'}</span><small>${escapeHtml(taskMatchReason(item.reason))}</small></td><td><div class="task-drilldown-actions"></div></td>`;
      const actions = row.querySelector('.task-drilldown-actions');
      (item.attachments ?? []).forEach((attachment) => actions.append(createAttachmentActions(attachment)));
      if (!(item.attachments ?? []).length) actions.textContent = '无附件';
      body.append(row);
    });
    table.append(body); list.append(table); content.append(list);
  }
  modal.classList.add('open');
  modal.setAttribute('aria-hidden', 'false');
}

function closeTaskFeedbackDrilldown() {
  const modal = document.querySelector('#task-feedback-drilldown-modal');
  modal?.classList.remove('open');
  modal?.setAttribute('aria-hidden', 'true');
}

function exportPendingFeedbackCompanies(task) {
  const rows = buildPendingFeedbackExportRows(task, pendingFeedbackCompanies);
  if (!task || !rows.length) { notify('当前任务没有待反馈或待确认单位可导出。', 'error'); return; }
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(rows), '待反馈单位');
  downloadBlob(`UniGather-${task.name.replace(/[\\/:*?"<>|]/g, '_')}-待反馈单位.xlsx`, XLSX.write(workbook, { bookType: 'xlsx', type: 'array' }), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  notify(`已导出 ${rows.length} 家待反馈单位。`);
}

async function openFeedbackMessageInInbox(messageId) {
  if (!messageId) { notify('该匹配记录未关联原始邮件，无法跳转。', 'error'); return; }
  await loadInbox({ quiet: true });
  if (!inboxMessages.some((message) => message.id === messageId)) { notify('收件箱中未找到该邮件，可能已被清理。', 'error'); return; }
  selectedMessageId = messageId;
  inboxQuery = '';
  const search = document.querySelector('#inbox-search');
  if (search) search.value = '';
  showView('inbox');
  renderInboxList();
  renderInboxDetail();
}

function renderDashboardSummary(raw) {
  const summary = normalizeDashboardSummary(raw);
  const assign = (selector, value) => { const element = document.querySelector(selector); if (element) element.textContent = value; };
  assign('#dashboard-collection-count', summary.collectionTaskCount);
  assign('#dashboard-collection-subtitle', `进行中 ${summary.activeCollectionTasks} 个`);
  assign('#dashboard-send-batch-count', summary.sendBatchCount);
  assign('#dashboard-received-today', summary.todayReceived);
  assign('#dashboard-receive-status', summary.latestReceiveStatus);
  assign('#dashboard-sent-today', summary.todaySentSuccess);
  assign('#dashboard-send-failures', `失败 ${summary.todaySentFailure} 封`);
  const activity = document.querySelector('#dashboard-activity');
  if (!activity) return;
  activity.replaceChildren();
  if (!summary.recentEvents.length) {
    activity.innerHTML = '<div class="feedback-empty compact"><span>◎</span><strong>暂无系统动态</strong><p>任务收件或正式发送后会显示在这里。</p></div>';
    return;
  }
  summary.recentEvents.forEach((event) => {
    const row = document.createElement('button'); row.type = 'button'; row.className = 'dashboard-event';
    row.innerHTML = `<i class="${event.status === 'failed' ? 'failed' : ''}"></i><div><strong>${escapeHtml(event.title)}</strong><small>${escapeHtml(event.detail)}</small></div><span>${escapeHtml(dashboardEventLabel(event))}<small>${escapeHtml(formatDeadline(event.occurredAt ?? event.occurred_at))}</small></span>`;
    row.addEventListener('click', () => showView(event.kind === 'send' ? 'send' : 'tasks'));
    activity.append(row);
  });
}

async function loadDashboardSummary() {
  try {
    const summary = await invokeCommand('dashboard_summary', {}, () => ({ collectionTaskCount: tasks.length, activeCollectionTasks: tasks.filter((task) => task.status === 'active').length }));
    renderDashboardSummary(summary);
  } catch (error) {
    renderDashboardSummary({ collectionTaskCount: tasks.length, activeCollectionTasks: tasks.filter((task) => task.status === 'active').length, latestReceiveStatus: `统计读取失败：${error.message ?? error}` });
  }
}

function openTaskDetail(task) {
  const detailModal = document.querySelector('#task-detail-modal');
  if (!detailModal || !task) return;
  detailTaskId = task.id;
  detailModal.querySelector('#task-detail-title').textContent = task.name;
  const totalCompanies = Number(task.total_companies ?? 0);
  const confirmedCompanies = Number(task.confirmed_companies ?? 0);
  const completionPercent = totalCompanies ? Math.round((confirmedCompanies / totalCompanies) * 100) : 0;
  detailModal.querySelector('#task-detail-percent').textContent = `${completionPercent}%`;
  detailModal.querySelector('#task-detail-progress-label').textContent = `单位反馈完成度 · 已反馈 ${confirmedCompanies}/${totalCompanies} 家`;
  detailModal.querySelector('#task-detail-progress-bar').style.width = `${completionPercent}%`;
  const detailStatus = detailModal.querySelector('#task-detail-status');
  detailStatus.textContent = taskStatusLabel(task.status);
  detailStatus.className = `status ${task.status === 'completed' ? 'completed' : task.status === 'paused' ? 'overdue' : 'progress'}`;
  detailModal.querySelector('#task-detail-start').textContent = formatDeadline(task.start_time);
  detailModal.querySelector('#task-detail-deadline').textContent = formatDeadline(task.deadline);
  detailModal.querySelector('#task-detail-poll').textContent = `每 ${task.poll_minutes ?? 30} 分钟`;
  const schedule = taskScheduleSummary(task);
  detailModal.querySelector('#task-detail-last-receive').textContent = schedule.lastText.replace('上次收件：', '');
  detailModal.querySelector('#task-detail-next-receive').textContent = schedule.nextText.replace('下次自动收件：', '');
  const companyIds = task.company_ids ?? task.companyIds ?? [];
  const companyList = detailModal.querySelector('#task-detail-company-list');
  const companyCount = detailModal.querySelector('#task-detail-company-count');
  const selectedCompanies = companyIds
    .map((id) => companyOptions.find((option) => option.id === id))
    .filter(Boolean);
  if (companyCount) companyCount.textContent = `共 ${selectedCompanies.length || totalCompanies} 家`;
  if (companyList) {
    companyList.replaceChildren();
    if (!selectedCompanies.length) {
      companyList.innerHTML = '<div class="task-company-empty">暂未选择单位</div>';
    } else {
      selectedCompanies.forEach((company) => {
        const item = document.createElement('div');
        item.className = 'task-detail-company-item';
        const contacts = Array.isArray(company.contacts) ? company.contacts.join('、') : company.contacts;
        const emails = Array.isArray(company.emails) ? company.emails.join('、') : company.emails;
        const summary = [contacts, emails].filter(Boolean).join(' · ');
        item.title = summary ? `${company.name}\n${summary}` : company.name;
        const name = document.createElement('strong');
        name.textContent = company.name;
        const meta = document.createElement('small');
        meta.textContent = summary || '未填写联系人或邮箱';
        item.append(name, meta);
        companyList.append(item);
      });
    }
  }
  detailModal.querySelector('#task-detail-subject').textContent = (task.subject_keywords ?? []).join('、') || '未设置';
  detailModal.querySelector('#task-detail-body').textContent = (task.body_keywords ?? []).join('、') || '未设置（不限制正文）';
  detailModal.querySelector('#task-detail-directory').textContent = task.save_directory || readMaterialPath();
  const refreshButton = detailModal.querySelector('#refresh-task-detail');
  if (refreshButton) { refreshButton.disabled = Boolean(activeSyncRunId); refreshButton.textContent = activeSyncTaskId === task.id ? '收件中…' : '↻ 立即刷新'; }
  detailModal.classList.add('open'); detailModal.setAttribute('aria-hidden', 'false');
  document.body.classList.add('task-workbench-open');
}

function taskMatchStatus(status) {
  return { confirmed: ['已匹配', 'success'], needs_review: ['待确认', 'warning'], unmatched: ['未匹配', 'danger'] }[status] ?? ['未知', 'muted'];
}

function taskMatchReason(reason) {
  return { sender_and_subject: '发件邮箱与主题均符合', sender_and_body: '发件邮箱与正文均符合', sender_name_and_subject: '发件人名称与主题均符合', sender_name_and_body: '发件人名称与正文均符合', sender_not_in_task: '发件人邮箱或名称不属于所选单位', subject_keyword_mismatch: '主题关键词不符合', body_keyword_mismatch: '正文关键词不符合', multiple_company_matches: '同一发件信息关联多个单位', no_rule_match: '未通过任务规则' }[reason] ?? reason ?? '未记录原因';
}

async function loadTaskMatchDetail(taskId) {
  const list = document.querySelector('#task-match-list');
  const summary = document.querySelector('#task-match-summary');
  const pager = document.querySelector('#task-match-pagination');
  if (!list || detailTaskId !== taskId) return;
  list.innerHTML = '<div class="send-empty">正在读取任务匹配记录…</div>';
  try {
    const detail = await invokeCommand('task_match_detail', { taskId });
    if (detailTaskId !== taskId) return;
    const processedMessages = Number(detail.processedMessages ?? detail.messages?.length ?? 0);
    const totalMessages = Math.max(processedMessages, Number(detail.totalMessages ?? processedMessages));
    const matchPercent = totalMessages ? Math.round((processedMessages / totalMessages) * 100) : 0;
    const task = tasks.find((item) => item.id === taskId);
    const detailModal = document.querySelector('#task-detail-modal');
    if (detailModal?.classList.contains('open')) {
      detailModal.querySelector('#task-detail-percent').textContent = `${matchPercent}%`;
      detailModal.querySelector('#task-detail-progress-label').textContent = `邮件匹配进度 ${processedMessages}/${totalMessages} 封 · 单位已反馈 ${task?.confirmed_companies ?? 0}/${task?.total_companies ?? 0}`;
      detailModal.querySelector('#task-detail-progress-bar').style.width = `${matchPercent}%`;
    }
    const filter = document.querySelector('#task-match-filter')?.value ?? 'all';
    const pageSizeControl = document.querySelector('#task-match-page-size');
    taskMatchPageSize = Number(pageSizeControl?.value ?? taskMatchPageSize);
    const filteredRows = (detail.messages ?? []).filter((item) => filter === 'all' || item.status === filter);
    const page = paginateTaskMatches(filteredRows, taskMatchPage, taskMatchPageSize);
    taskMatchPage = page.page;
    const rows = page.items;
    const run = detail.latestRun;
    if (summary) summary.textContent = run ? `邮件匹配 ${processedMessages}/${totalMessages} 封 · 已匹配 ${detail.matched} · 待确认 ${detail.needsReview} · 未匹配 ${detail.unmatched} · 显示 ${page.total ? `${(page.page - 1) * page.pageSize + 1}-${Math.min(page.page * page.pageSize, page.total)}` : 0}/${page.total}${run.error ? ` · ${run.error}` : ''}` : '尚未执行收件';
    list.replaceChildren();
    if (!rows.length) {
      list.innerHTML = '<div class="send-empty">当前筛选没有邮件；点击“立即刷新”可按任务时间范围重新检查。</div>';
    }
    rows.forEach((item) => {
      const [label, tone] = taskMatchStatus(item.status);
      const row = document.createElement('article'); row.className = 'task-match-row';
      row.innerHTML = `<div class="task-match-mail"><strong>${escapeHtml(item.subject || '(无主题)')}</strong><small>${escapeHtml(item.sender)} · ${escapeHtml(formatDeadline(item.receivedAt))}</small></div><div class="task-match-company"><strong>${escapeHtml(item.companyName || '未识别单位')}</strong><small>${escapeHtml(taskMatchReason(item.reason))}</small></div><span class="send-state-chip ${tone}">${label}</span><div class="task-match-files"><strong>${(item.attachments ?? []).length ? `${(item.attachments ?? []).length} 个归档材料` : '无附件'}</strong><span class="task-match-attachment-actions"></span></div>`;
      const attachmentArea = row.querySelector('.task-match-attachment-actions');
      (item.attachments ?? []).forEach((attachment) => attachmentArea.append(createAttachmentActions(typeof attachment === 'string' ? { name: attachment, savedPath: '' } : attachment)));
      if (!(item.attachments ?? []).length) attachmentArea.textContent = '无附件';
      list.append(row);
    });
    if (pager) {
      pager.innerHTML = page.total > 0 ? `<span>第 ${page.page} / ${page.pageCount} 页，共 ${page.total} 封</span><button class="ghost-button" type="button" data-task-match-page="previous" ${page.page <= 1 ? 'disabled' : ''}>‹ 上一页</button><button class="ghost-button" type="button" data-task-match-page="next" ${page.page >= page.pageCount ? 'disabled' : ''}>下一页 ›</button>` : '';
      pager.querySelectorAll('[data-task-match-page]').forEach((button) => button.addEventListener('click', () => {
        taskMatchPage += button.dataset.taskMatchPage === 'next' ? 1 : -1;
        void loadTaskMatchDetail(taskId);
      }));
    }
  } catch (error) { list.innerHTML = `<div class="send-empty">读取匹配记录失败：${escapeHtml(error.message ?? error)}</div>`; }
}

function closeTaskDetail() {
  const detailModal = document.querySelector('#task-detail-modal');
  detailModal?.classList.remove('open'); detailModal?.setAttribute('aria-hidden', 'true');
  document.body.classList.remove('task-workbench-open');
  detailTaskId = '';
}

function refreshTaskScheduleDisplays() {
  document.querySelectorAll('.task-list-row[data-task-id]').forEach((row) => {
    const task = tasks.find((item) => item.id === row.dataset.taskId);
    if (!task) return;
    const schedule = taskScheduleSummary(task);
    const labels = row.querySelectorAll('.task-schedule-line span');
    if (labels[0]) labels[0].textContent = schedule.lastText;
    if (labels[1]) labels[1].textContent = schedule.nextText;
  });
  const detailModal = document.querySelector('#task-detail-modal');
  const task = tasks.find((item) => item.id === detailTaskId);
  if (!detailModal?.classList.contains('open') || !task) return;
  const schedule = taskScheduleSummary(task);
  detailModal.querySelector('#task-detail-last-receive').textContent = schedule.lastText.replace('上次收件：', '');
  detailModal.querySelector('#task-detail-next-receive').textContent = schedule.nextText.replace('下次自动收件：', '');
}

async function deleteTask(task, fromManagement = false) {
  pendingDeleteTask = { task, fromManagement };
  const modal = document.querySelector('#task-delete-confirm-modal');
  const copy = document.querySelector('#task-delete-confirm-copy');
  if (copy) copy.textContent = `任务“${task.name}”会移入“已删除”，邮件、附件和匹配记录将保留，可随时恢复。`;
  modal?.classList.add('open');
  modal?.setAttribute('aria-hidden', 'false');
}

function closeTaskDeleteConfirm() {
  const modal = document.querySelector('#task-delete-confirm-modal');
  modal?.classList.remove('open');
  modal?.setAttribute('aria-hidden', 'true');
  pendingDeleteTask = null;
}

async function confirmTaskDelete() {
  const pending = pendingDeleteTask;
  if (!pending) return;
  const button = document.querySelector('#confirm-task-delete');
  if (button) { button.disabled = true; button.textContent = '删除中…'; }
  try {
    await invokeCommand('task_delete', { taskId: pending.task.id }, () => null);
    await loadTasks();
    if (pending.fromManagement) renderTaskManagement();
    closeTaskDeleteConfirm();
    notify('任务已移入“已删除”，可在任务管理中恢复。');
  } catch (error) { notify(`删除失败：${error.message ?? error}`, 'error'); }
  finally { if (button) { button.disabled = false; button.textContent = '确认删除'; } }
}

const modal = document.querySelector('#task-modal');
const taskForm = document.querySelector('#task-form');
function openTaskModal(task = null) {
  if (!modal) return;
  taskForm?.reset();
  editingTaskId = task?.id ?? '';
  materialNameManuallyEdited = Boolean(task);
  selectedCompanyIds = Array.isArray(task?.company_ids) ? [...task.company_ids] : Array.isArray(task?.companyIds) ? [...task.companyIds] : [];
  const companySearch = document.querySelector('#task-company-search');
  if (companySearch) companySearch.value = '';
  const modalEyebrow = document.querySelector('#task-modal-eyebrow');
  const modalTitle = document.querySelector('#task-modal-title');
  const saveButton = document.querySelector('#save-task');
  if (modalEyebrow) modalEyebrow.textContent = task ? '编辑收集任务' : '新建收集任务';
  if (modalTitle) modalTitle.textContent = task ? '更新任务规则' : '配置任务规则';
  if (saveButton) saveButton.textContent = task ? '保存修改' : '保存任务';
  const startInput = document.querySelector('#task-start-time');
  if (startInput) startInput.value = task?.start_time || currentDateTimeLocal();
  if (task) {
    document.querySelector('#task-name').value = task.name ?? '';
    document.querySelector('#task-material-name').value = task.material_name ?? task.name ?? '';
    document.querySelector('#task-subject-keywords').value = (task.subject_keywords ?? []).join(', ');
    document.querySelector('#task-body-keywords').value = (task.body_keywords ?? []).join(', ');
    document.querySelector('#task-deadline').value = task.deadline ?? '';
    document.querySelector('#task-poll-minutes').value = String(task.poll_minutes ?? 30);
    document.querySelector('#task-ai-enabled').checked = Boolean(task.ai_enabled);
  }
  renderTaskMaterialExample();
  renderTaskTimeSummary();
  renderTaskCompanyPicker();
  modal.classList.add('open'); modal.setAttribute('aria-hidden', 'false');
  window.setTimeout(() => document.querySelector('#task-name')?.focus(), 0);
}
function closeModal() { modal?.classList.remove('open'); modal?.setAttribute('aria-hidden', 'true'); }

function renderTaskMaterialExample() {
  const taskName = document.querySelector('#task-name')?.value.trim() ?? '';
  const material = document.querySelector('#task-material-name');
  if (material && !materialNameManuallyEdited) material.value = taskName;
  const example = document.querySelector('#task-material-example');
  if (example) example.textContent = `归档示例：重庆-${material?.value.trim() || taskName || '材料统一名称'}.docx`;
}

function initTaskMaterialName() {
  document.querySelector('#task-name')?.addEventListener('input', renderTaskMaterialExample);
  document.querySelector('#task-material-name')?.addEventListener('input', () => { materialNameManuallyEdited = true; renderTaskMaterialExample(); });
}

function currentDateTimeLocal() {
  const date = new Date();
  date.setMinutes(date.getMinutes() - date.getTimezoneOffset());
  return date.toISOString().slice(0, 16);
}

function renderTaskTimeSummary() {
  const start = document.querySelector('#task-start-time')?.value ?? '';
  const end = document.querySelector('#task-deadline')?.value ?? '';
  const summary = document.querySelector('#task-time-summary');
  const errors = validateTimeRange(start, end);
  const range = document.querySelector('.task-time-range');
  range?.toggleAttribute('data-invalid', Boolean(Object.keys(errors).length));
  if (summary) summary.textContent = Object.keys(errors).length ? Object.values(errors)[0] : `${formatDeadline(start)} 至 ${formatDeadline(end)}`;
}

function applyTimePreset(preset) {
  const range = buildTimePresetRange(preset);
  const start = document.querySelector('#task-start-time');
  const end = document.querySelector('#task-deadline');
  if (start) start.value = range.start;
  if (end) end.value = range.end;
  renderTaskTimeSummary();
}

function initTaskTimeRange() {
  document.querySelectorAll('[data-time-preset]').forEach((button) => button.addEventListener('click', () => applyTimePreset(button.dataset.timePreset)));
  ['#task-start-time', '#task-deadline'].forEach((selector) => document.querySelector(selector)?.addEventListener('input', renderTaskTimeSummary));
}

async function saveTask(event) {
  event.preventDefault();
  const values = { name: document.querySelector('#task-name')?.value, materialName: document.querySelector('#task-material-name')?.value, subjectKeywords: document.querySelector('#task-subject-keywords')?.value, bodyKeywords: document.querySelector('#task-body-keywords')?.value, startTime: document.querySelector('#task-start-time')?.value, deadline: document.querySelector('#task-deadline')?.value, pollMinutes: document.querySelector('#task-poll-minutes')?.value, saveDirectory: readMaterialPath(), aiEnabled: document.querySelector('#task-ai-enabled')?.checked, companyIds: selectedCompanyIds };
  const errors = { ...validateTaskInput(values), ...validateTimeRange(values.startTime, values.deadline), ...validateCompanySelection(selectedCompanyIds, companyOptions) };
  if (Object.keys(errors).length) { notify(Object.values(errors)[0], 'error'); return; }
  const input = buildTaskInput(values);
  const createdNew = !editingTaskId;
  try {
    const saved = editingTaskId
      ? await invokeCommand('task_update', { taskId: editingTaskId, input }, () => ({ ...fallbackTaskSummary(input), ...tasks.find((task) => task.id === editingTaskId), id: editingTaskId, name: input.name, material_name: input.material_name, company_ids: input.company_ids, total_companies: input.company_ids.length, deadline: input.deadline, start_time: input.start_time, poll_minutes: input.poll_minutes, save_directory: input.save_directory, subject_keywords: input.subject_keywords, body_keywords: input.body_keywords, ai_enabled: input.ai_enabled }))
      : await invokeCommand('task_create', { input }, () => fallbackTaskSummary(input));
    const summary = saved ?? fallbackTaskSummary(input);
    tasks = editingTaskId
      ? tasks.map((task) => task.id === editingTaskId ? summary : task)
      : [summary, ...tasks.filter((task) => task.id !== summary.id)];
    writeTaskSyncTime(summary.id);
    writeLocalTasks(); closeModal(); renderTasks(); void loadDashboardSummary(); showView('tasks');
    notify(editingTaskId ? '任务已更新。' : '任务已创建，已显示在任务列表中。');
    editingTaskId = '';
    if (createdNew) void runTaskSync(summary, { manual: false });
  } catch (error) { notify(`保存失败：${error.message ?? error}`, 'error'); }
}

function collectMailboxValues() {
  const protocol = document.querySelector('input[name="mailbox-protocol"]:checked')?.value ?? 'IMAP';
  return { name: document.querySelector('#mailbox-name')?.value, protocol, host: document.querySelector('#mailbox-host')?.value, port: document.querySelector('#mailbox-port')?.value, username: document.querySelector('#mailbox-username')?.value, password: document.querySelector('#mailbox-password')?.value, encryption: document.querySelector('#mailbox-encryption')?.value, smtpHost: document.querySelector('#mailbox-smtp-host')?.value, smtpPort: document.querySelector('#mailbox-smtp-port')?.value, smtpEncryption: document.querySelector('#mailbox-smtp-encryption')?.value, smtpSenderName: document.querySelector('#mailbox-smtp-sender-name')?.value, useProxy: document.querySelector('#mailbox-use-proxy')?.checked, proxyType: document.querySelector('#mailbox-proxy-type')?.value, proxyHost: document.querySelector('#mailbox-proxy-host')?.value, proxyPort: document.querySelector('#mailbox-proxy-port')?.value, proxyUsername: document.querySelector('#mailbox-proxy-username')?.value, proxyPassword: document.querySelector('#mailbox-proxy-password')?.value, proxyUrl: buildProxyUrl() };
}

function validateMailboxForSync(values) {
  const errors = validateMailboxForm(values);
  // Desktop mode loads the password from Windows Credential Manager in Rust.
  // Keep the visible password field optional after the first successful save.
  if (!values.password) delete errors.password;
  return errors;
}

function buildProxyUrl() {
  if (!document.querySelector('#mailbox-use-proxy')?.checked) return '';
  const type = document.querySelector('#mailbox-proxy-type')?.value ?? 'http';
  const host = document.querySelector('#mailbox-proxy-host')?.value?.trim() ?? '';
  const port = document.querySelector('#mailbox-proxy-port')?.value ?? '';
  return host ? `${type}://${host}${port ? `:${port}` : ''}` : '';
}

function parseProxyUrl(value) {
  try {
    const url = new URL(value);
    return { type: url.protocol.replace(':', '') || 'http', host: url.hostname, port: url.port };
  } catch { return { type: 'http', host: '', port: '' }; }
}

function setMailboxConnectionStatus(kind, state, titleText, detail) {
  const node = document.querySelector(`#mailbox-${kind}-status`);
  if (!node) return;
  node.dataset.state = state; node.querySelector('strong').textContent = titleText; node.querySelector('span').textContent = detail;
}

function resetMailboxStatuses() {
  setMailboxConnectionStatus('incoming', 'idle', '收件服务器：尚未测试', '将测试连接、加密和账号认证，不下载邮件。');
  setMailboxConnectionStatus('outgoing', 'idle', '发件服务器：尚未测试', '将测试 SMTP 连接和认证，不发送邮件。');
}

function renderMailboxCredentialStatus() {
  const status = document.querySelector('#mailbox-password-status');
  const clearButton = document.querySelector('#clear-mailbox-password');
  if (status) status.textContent = mailboxCredentialPresent ? '已保存密码' : '尚未保存密码';
  if (clearButton) clearButton.disabled = !mailboxCredentialPresent;
}

async function loadMailboxCredentialStatus() {
  const username = document.querySelector('#mailbox-username')?.value?.trim() ?? '';
  if (!username) {
    mailboxCredentialPresent = false;
    renderMailboxCredentialStatus();
    return;
  }
  try {
    const present = await invokeCommand('mailbox_credentials_status', { username }, () => false);
    if (document.querySelector('#mailbox-username')?.value?.trim() === username) mailboxCredentialPresent = Boolean(present);
  } catch {
    mailboxCredentialPresent = false;
  }
  renderMailboxCredentialStatus();
}

async function testMailbox() {
  const values = collectMailboxValues();
  const errors = validateMailboxSave(values, mailboxCredentialPresent);
  if (Object.keys(errors).length) { setMailboxConnectionStatus('incoming', 'error', '收件服务器：配置不完整', Object.values(errors)[0]); notify(Object.values(errors)[0], 'error'); return; }
  const config = { ...buildMailboxPayload(values), password: values.password ?? '', proxy_username: values.proxyUsername ?? '', proxy_password: values.proxyPassword ?? '' };
  setMailboxConnectionStatus('incoming', 'testing', '收件服务器：测试中…', '正在连接并验证账号，请稍候。');
  setMailboxConnectionStatus('outgoing', 'testing', '发件服务器：测试中…', '正在连接并验证 SMTP 账号，请稍候。');
  try {
    const result = await invokeCommand('mailbox_test', { config }, () => ({ incoming: { status: 'not_configured', message: '浏览器预览模式不建立真实连接', elapsedMs: 0 }, outgoing: { status: 'not_configured', message: '浏览器预览模式不建立真实连接', elapsedMs: 0 } }));
    [['incoming', '收件服务器', result.incoming], ['outgoing', '发件服务器', result.outgoing]].forEach(([kind, label, item]) => {
      const state = item?.status === 'success' ? 'success' : (item?.status === 'not_configured' ? 'idle' : 'error');
      const elapsed = Number(item?.elapsedMs ?? item?.elapsed_ms ?? 0);
      setMailboxConnectionStatus(kind, state, `${label}：${item?.status === 'success' ? '连接成功' : (item?.status === 'not_configured' ? '未配置' : '连接失败')}`, `${item?.message ?? '未返回结果'}${elapsed ? ` · ${elapsed} ms` : ''}`);
    });
    const failed = [result.incoming, result.outgoing].some((item) => item?.status === 'error');
    notify(failed ? '连接测试已完成，请查看收件和发件的具体结果。' : '收件与发件连接测试完成。', failed ? 'error' : 'success');
  } catch (error) { setMailboxConnectionStatus('incoming', 'error', '收件服务器：测试失败', error.message ?? String(error)); setMailboxConnectionStatus('outgoing', 'error', '发件服务器：测试失败', error.message ?? String(error)); notify('邮箱连接测试失败，请检查配置。', 'error'); }
}

function initMailbox() {
  let stored = null;
  try { stored = JSON.parse(localStorage.getItem(MAILBOX_STORAGE_KEY) ?? 'null'); } catch { stored = null; }
  if (stored) {
    [['name','name'],['host','host'],['port','port'],['username','username'],['encryption','encryption'],['smtp-host','smtpHost'],['smtp-port','smtpPort'],['smtp-encryption','smtpEncryption'],['smtp-sender-name','smtpSenderName']].forEach(([field, key]) => { const node = document.querySelector(`#mailbox-${field}`); if (node && stored[key] != null) node.value = stored[key]; });
    const radio = document.querySelector(`input[name="mailbox-protocol"][value="${stored.protocol}"]`); if (radio) radio.checked = true;
    const proxy = stored.proxyUrl ? parseProxyUrl(stored.proxyUrl) : { type: stored.proxyType ?? 'http', host: stored.proxyHost ?? '', port: stored.proxyPort ?? '' };
    const useProxy = Boolean(stored.useProxy || stored.proxyUrl || stored.proxyHost);
    const proxyToggle = document.querySelector('#mailbox-use-proxy'); if (proxyToggle) proxyToggle.checked = useProxy;
    const proxyFields = document.querySelector('#proxy-fields'); if (proxyFields) proxyFields.hidden = !useProxy;
    [['proxy-type', proxy.type], ['proxy-host', proxy.host], ['proxy-port', proxy.port], ['proxy-username', stored.proxyUsername ?? '']].forEach(([key, value]) => { const node = document.querySelector(`#mailbox-${key}`); if (node && value != null) node.value = value; });
  }
  renderMailboxCredentialStatus();
  loadMailboxCredentialStatus();
  document.querySelectorAll('input[name="mailbox-protocol"]').forEach((radio) => radio.addEventListener('change', () => {
    const defaults = mailboxDefaults(radio.value); const port = document.querySelector('#mailbox-port'); const encryption = document.querySelector('#mailbox-encryption');
    if (port) port.value = defaults.port; if (encryption) encryption.value = defaults.encryption;
    const hint = document.querySelector('#port-hint'); if (hint) hint.textContent = `${radio.value} + SSL/TLS 通常为 ${defaults.port}`;
  }));
  document.querySelector('#toggle-mailbox-password')?.addEventListener('click', (event) => { const input = document.querySelector('#mailbox-password'); const visible = input.type === 'text'; input.type = visible ? 'password' : 'text'; event.currentTarget.textContent = visible ? '显示' : '隐藏'; event.currentTarget.setAttribute('aria-pressed', String(!visible)); });
  document.querySelector('#mailbox-username')?.addEventListener('input', () => { mailboxCredentialPresent = false; renderMailboxCredentialStatus(); loadMailboxCredentialStatus(); });
  document.querySelector('#mailbox-use-proxy')?.addEventListener('change', (event) => { const fields = document.querySelector('#proxy-fields'); if (fields) fields.hidden = !event.currentTarget.checked; });
  document.querySelector('#mailbox-test')?.addEventListener('click', testMailbox);
  document.querySelector('#mailbox-reset')?.addEventListener('click', () => { document.querySelector('#mailbox-form')?.reset(); const fields = document.querySelector('#proxy-fields'); if (fields) fields.hidden = true; mailboxCredentialPresent = false; renderMailboxCredentialStatus(); resetMailboxStatuses(); });
  document.querySelector('#clear-mailbox-password')?.addEventListener('click', async () => {
    const username = document.querySelector('#mailbox-username')?.value?.trim() ?? '';
    if (!username) { notify('请先填写收件账号。', 'error'); return; }
    if (typeof window.confirm === 'function' && !window.confirm('确定清除该账号在本机保存的邮箱和代理密码吗？')) return;
    try {
      await invokeCommand('mailbox_credentials_clear', { username }, () => null);
      mailboxCredentialPresent = false;
      document.querySelector('#mailbox-password').value = '';
      document.querySelector('#mailbox-proxy-password').value = '';
      renderMailboxCredentialStatus();
      notify('已清除本机保存的密码。');
    } catch (error) { notify(`清除密码失败：${error.message ?? error}`, 'error'); }
  });
  document.querySelector('#mailbox-form')?.addEventListener('submit', async (event) => { event.preventDefault(); const values = collectMailboxValues(); const errors = validateMailboxSave(values, mailboxCredentialPresent); if (Object.keys(errors).length) { notify(Object.values(errors)[0], 'error'); return; } const config = buildMailboxPayload(values); localStorage.setItem(MAILBOX_STORAGE_KEY, JSON.stringify(buildMailboxStorage(values))); try { await invokeCommand('mailbox_credentials_save', { username: values.username, password: values.password, proxyUsername: values.proxyUsername ?? '', proxyPassword: values.proxyPassword ?? '' }, () => null); await invokeCommand('mailbox_config_save', { config: { ...config, password: '', proxy_username: values.proxyUsername ?? '', proxy_password: '' } }, () => null); } catch (error) { notify(`邮箱配置已保存，但凭据保存失败：${error.message ?? error}`, 'error'); return; } if (values.password?.trim()) mailboxCredentialPresent = true; renderMailboxCredentialStatus(); notify('邮箱配置已保存，收件与发信服务器、代理和账号会在下次打开时恢复；密码由 Windows 凭据管理器保存。'); });
  document.querySelector('.summary-edit')?.addEventListener('click', () => document.querySelector('#mailbox-name')?.focus());
}

function downloadText(filename, content, mime = 'text/plain;charset=utf-8') {
  downloadBlob(filename, content, mime);
}

function downloadBlob(filename, content, mime = 'application/octet-stream') {
  const url = URL.createObjectURL(new Blob([content], { type: mime }));
  const link = document.createElement('a'); link.href = url; link.download = filename; link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function companyRowsForImport(rows) {
  return rows.flatMap((row) => row.emails.map((email) => ({ company_name: row.name, contact_name: row.contactName ?? '', email, phone: row.phone ?? '', aliases: (row.aliases ?? []).join(';') })));
}

function localCompanyOptionRows() {
  return companyRows.flatMap((row) => (row.emails ?? []).map((email) => ({
    id: `local-${row.name}`,
    name: row.name,
    contact_name: row.contactName ?? '',
    email,
    phone: row.phone ?? '',
    aliases: row.aliases ?? [],
  })));
}

async function loadCompanyOptions() {
  const localOptions = normalizeCompanyOptions(localCompanyOptionRows());
  try {
    const result = await invokeCommand('company_list', {}, () => localOptions);
    const backendOptions = Array.isArray(result) && result.length ? result : localOptions;
    companyOptions = normalizeCompanyOptions(backendOptions);
  } catch {
    companyOptions = localOptions;
  }
  selectedCompanyIds = selectedCompanyIds.filter((id) => companyOptions.some((option) => option.id === id));
  renderTaskCompanyPicker();
  renderSendWorkbench();
}

function getSendCompanyOptions() {
  const byName = new Map(companyRows.map((row) => [String(row.name ?? '').trim(), row]));
  return normalizeCompanyOptions(companyOptions.map((option) => {
    const local = byName.get(option.name);
    return { ...option, emails: [...new Set([...(option.emails ?? []), ...(local?.emails ?? [])])], phones: [...new Set([...(option.phones ?? []), ...(local?.phone ? [local.phone] : [])])], aliases: [...new Set([...(option.aliases ?? []), ...(local?.aliases ?? [])])] };
  }));
}

function collectSendValues() {
  return { testRecipient: document.querySelector('#send-test-recipient')?.value.trim() ?? '', subject: document.querySelector('#send-subject')?.value ?? '', body: document.querySelector('#send-body')?.value ?? '', signature: document.querySelector('#send-signature')?.value ?? '', cc: parseBatchCc(document.querySelector('#send-cc')?.value ?? ''), testConfirmed: sendTestConfirmed };
}

function collectSendMailbox() {
  const values = collectMailboxValues();
  const payload = buildMailboxPayload(values);
  return { ...payload, proxy_username: values.proxyUsername ?? '', proxy_password: values.proxyPassword ?? '', password: values.password ?? '' };
}

function renderSendPreflight(message = '') {
  const node = document.querySelector('#send-preflight'); if (!node) return;
  const result = validateSendBatch(sendBatch.items, collectSendValues());
  const error = result.errors[0];
  node.className = `send-preflight${error ? ' has-error' : ''}`;
  node.innerHTML = `<strong>${error ? '发送前检查未通过' : '发送前检查'}</strong><p>${escapeHtml(message || error || (result.warnings[0] ?? `已匹配 ${groupSendBatchItems(sendBatch.items).length} 家单位，可先发送测试邮件。`))}</p>`;
}

function updateSendProgress(progress) {
  const panel = document.querySelector('#send-progress'); if (!panel) return;
  panel.hidden = false;
  document.querySelector('#send-progress-text').textContent = progress.message || '正在发送…';
  document.querySelector('#send-progress-count').textContent = formatBatchProgress(progress);
  document.querySelector('#send-progress-bar').style.width = `${progress.total ? Math.round((progress.processed / progress.total) * 100) : 0}%`;
}

async function pollSendStatus() {
  if (!activeSendRunId) return;
  try {
    const progress = await invokeCommand('send_status', { runId: activeSendRunId });
    if (progress) {
      updateSendProgress(progress);
      if (['completed', 'completedWithFailures', 'failed'].includes(progress.status)) {
        const failed = progress.failure > 0 || progress.status === 'failed';
        if (!failed) sendTestConfirmed = true;
        notify(failed ? `发送完成：失败 ${progress.failure ?? 0} 封。` : '测试邮件发送成功，可以进行正式发送。', failed ? 'error' : 'success');
        ['#send-test', '#send-start'].forEach((selector) => { const button = document.querySelector(selector); if (button) { button.disabled = false; button.textContent = selector === '#send-test' ? '① 发送测试邮件' : '发送正式邮件'; } });
        activeSendRunId = ''; window.clearTimeout(sendPollingTimer); sendPollingTimer = 0; return;
      }
    }
  } catch (error) { notify(`读取发送进度失败：${error.message ?? error}`, 'error'); activeSendRunId = ''; return; }
  sendPollingTimer = window.setTimeout(pollSendStatus, 600);
}

async function runSend(mode) {
  if (activeSendRunId) { notify('已有发送任务进行中，请稍候。', 'error'); return; }
  const values = collectSendValues();
  const validation = validateSendBatch(sendBatch.items, values);
  if (validation.errors.length) { renderSendPreflight(validation.errors[0]); notify(validation.errors[0], 'error'); return; }
  if (validation.warnings.length && !window.confirm(`${validation.warnings.join('\n')}\n\n仍要继续吗？`)) return;
  if (mode === 'formal') {
    if (window.prompt('正式发送前请确认，输入“确认发送”继续：') !== '确认发送') { notify('已取消正式发送。'); return; }
  }
  const button = document.querySelector(mode === 'test' ? '#send-test' : '#send-start');
  if (button) { button.disabled = true; button.textContent = mode === 'test' ? '测试发送中…' : '正式发送中…'; }
  try {
    await persistSendBatch();
    const input = { batchId: sendBatch.id, subject: values.subject, body: values.body, signature: values.signature, cc: values.cc, testRecipient: values.testRecipient, companyIds: groupSendBatchItems(sendBatch.items).map((item) => item.companyId) };
    const progress = await invokeCommand(mode === 'test' ? 'send_test' : 'send_start', { input, mailbox: collectSendMailbox() });
    activeSendRunId = progress.runId; updateSendProgress(progress); void pollSendStatus();
  } catch (error) { if (button) { button.disabled = false; button.textContent = mode === 'test' ? '① 发送测试邮件' : '发送正式邮件'; } notify(`启动发送失败：${error.message ?? error}`, 'error'); }
}

async function persistSendBatch() {
  const values = collectSendValues();
  sendBatch.name = document.querySelector('#send-batch-name')?.value.trim() || `材料发送 ${new Date().toLocaleString('zh-CN')}`;
  sendBatch.subject = values.subject; sendBatch.body = values.body; sendBatch.signature = values.signature; sendBatch.cc = values.cc;
  const summary = await invokeCommand('send_batch_save', { batchId: sendBatch.id, input: { name: sendBatch.name, sourceDir: sendBatch.sourceDir, recursive: sendBatch.recursive, subject: sendBatch.subject, body: sendBatch.body, signature: sendBatch.signature, cc: sendBatch.cc }, items: sendBatch.items.map((item) => ({ id: item.id, fileName: item.fileName, filePath: item.filePath, companyId: item.companyId, companyName: item.companyName, recipients: item.recipients, matchMethod: item.matchMethod, confidence: item.confidence, status: item.status, error: item.error })) });
  const persistence = validateBatchPersistence(sendBatch.items, summary);
  if (!persistence.ok) throw new Error(persistence.message);
  sendBatch.id = summary.id;
  return summary;
}

function renderSendMatchList() {
  const list = document.querySelector('#send-match-list'); if (!list) return;
  const filter = document.querySelector('#send-match-filter')?.value ?? 'all';
  const items = sendBatch.items.filter((item) => filter === 'all' || item.status === filter);
  document.querySelector('#send-match-count').textContent = `${sendBatch.items.length} 个文件 · 待确认 ${sendBatch.items.filter((item) => item.status === 'needs_review' || item.status === 'unmatched').length}`;
  list.replaceChildren();
  if (!items.length) { list.innerHTML = '<div class="send-empty">当前筛选没有材料。</div>'; return; }
  const options = getSendCompanyOptions();
  items.forEach((item) => {
    const row = document.createElement('div'); row.className = `send-match-row status-${item.status}`;
    const info = document.createElement('div'); info.className = 'send-match-file'; info.innerHTML = `<strong>${escapeHtml(item.fileName)}</strong><small>${escapeHtml(item.matchMethod || '未匹配')} · ${Math.round((item.confidence || 0) * 100)}%</small>`;
    const select = document.createElement('select'); select.className = 'form-select'; select.innerHTML = '<option value="">选择单位</option>' + options.map((option) => `<option value="${escapeHtml(option.id)}" ${option.id === item.companyId ? 'selected' : ''}>${escapeHtml(option.name)}</option>`).join('');
    select.addEventListener('change', async () => { const option = options.find((candidate) => candidate.id === select.value); item.companyId = option?.id ?? ''; item.companyName = option?.name ?? ''; item.recipients = option?.emails ?? []; item.status = option?.emails?.length ? 'matched' : 'needs_review'; item.matchMethod = 'manual'; item.confidence = 1; item.error = option?.emails?.length ? '' : '单位没有有效邮箱'; renderSendWorkbench(); if (sendBatch.id) { try { await invokeCommand('send_batch_resolve', { batchId: sendBatch.id, itemId: item.id, companyId: item.companyId, decision: item.status }); } catch {} } });
    const meta = sendItemStatusMeta(item.status, item.error);
    const status = document.createElement('div'); status.className = 'send-match-state'; status.innerHTML = `<span class="send-state-chip ${meta.tone}">${meta.label}</span><span class="send-match-detail">${escapeHtml(item.status === 'matched' ? `${item.companyName} · ${item.recipients.join('、')} · ${meta.detail}` : meta.detail)}</span>`;
    const ignore = document.createElement('button'); ignore.type = 'button'; ignore.className = 'ghost-button send-ignore-button'; ignore.textContent = item.status === 'ignored' ? '恢复' : '忽略'; ignore.addEventListener('click', async () => { item.status = item.status === 'ignored' ? (item.companyId && item.recipients.length ? 'matched' : 'needs_review') : 'ignored'; item.error = item.status === 'ignored' ? '已忽略' : ''; renderSendWorkbench(); if (sendBatch.id) { try { await invokeCommand('send_batch_resolve', { batchId: sendBatch.id, itemId: item.id, companyId: item.companyId || null, decision: item.status }); } catch {} } });
    row.append(info, select, status, ignore); list.append(row);
  });
}

function renderSendPreview() {
  const node = document.querySelector('#send-preview-list'); if (!node) return;
  const groups = groupSendBatchItems(sendBatch.items); document.querySelector('#send-preview-count').textContent = `${groups.length} 封`;
  const values = collectSendValues();
  node.replaceChildren(); if (!groups.length) { node.innerHTML = '<div class="send-empty">完成匹配后显示按单位拆分的邮件。</div>'; return; }
  groups.forEach((group) => { const item = document.createElement('article'); item.className = 'send-preview-item'; const previewBody = composeSendBody(values.body, values.signature).replaceAll('{单位名称}', group.companyName); item.innerHTML = `<strong>${escapeHtml(group.companyName)}</strong><small>To：${escapeHtml(group.recipients.join('、'))}</small><span>${group.attachments.length} 个附件 · ${escapeHtml(previewBody.slice(-60))}</span>`; node.append(item); });
}

function renderSendWorkbench() { const mailbox = collectMailboxValues(); const service = document.querySelector('#send-service-summary'); if (service) service.textContent = mailbox.smtpHost ? `发信服务：${mailbox.smtpHost}:${mailbox.smtpPort || 465} · ${mailbox.smtpEncryption || 'SSL/TLS'} · 账号 ${mailbox.username || '未填写'}` : '发信服务未配置，请先在邮箱配置中设置 SMTP。'; renderSendMatchList(); renderSendPreview(); renderSendPreflight(); }

async function openSendHistoryDetail(batchId) {
  const modal = document.querySelector('#send-history-detail-modal'); const content = document.querySelector('#send-history-detail-content');
  if (!modal || !content) return;
  modal.classList.add('open'); modal.setAttribute('aria-hidden', 'false'); content.innerHTML = '<div class="send-empty">正在加载发送记录…</div>';
  try {
    const detail = await invokeCommand('send_history_detail', { batchId }); const batch = detail.batch;
    document.querySelector('#send-history-detail-title').textContent = batch.name || '发送批次';
    const runs = (detail.runs ?? []).map((run) => `<section class="send-run"><div class="send-run-head"><strong>${run.mode === 'test' ? '测试发送' : run.mode === 'formal' ? '正式发送' : '历史发送'} · ${escapeHtml(run.startedAt)}</strong><span class="send-state-chip ${run.failureCount ? 'danger' : 'success'}">${escapeHtml(run.status)} · 成功 ${run.successCount} / 失败 ${run.failureCount}</span></div>${(run.items ?? []).map((item) => `<div class="send-run-item"><strong>${escapeHtml(item.companyName)}</strong><span>${escapeHtml(item.recipients.join('、'))}</span><span>${escapeHtml(item.status)}</span><small>${escapeHtml(item.error || item.sentAt || '')}</small></div>`).join('') || '<div class="send-empty">没有逐单位明细。</div>'}</section>`).join('');
    content.innerHTML = `<div class="send-history-meta"><div><small>材料目录</small><strong>${escapeHtml(batch.sourceDir)}</strong></div><div><small>附件数量</small><strong>${batch.itemCount}</strong></div><div><small>邮件主题</small><strong>${escapeHtml(batch.subject)}</strong></div><div><small>邮件签名</small><strong>${escapeHtml(batch.signature || '未设置')}</strong></div></div>${runs || '<div class="send-empty">该批次尚未发送。</div>'}`;
  } catch (error) { content.innerHTML = `<div class="send-empty">读取历史详情失败：${escapeHtml(error.message ?? error)}</div>`; }
}

async function loadSendHistory() { try { sendBatchHistory = await invokeCommand('send_history', {}); } catch { sendBatchHistory = []; } const node = document.querySelector('#send-history-list'); if (!node) return; node.replaceChildren(); if (!sendBatchHistory.length) { node.innerHTML = '<div class="send-empty">暂无发送记录。</div>'; return; } sendBatchHistory.forEach((run) => { const row = document.createElement('div'); row.className = 'send-history-row'; row.tabIndex = 0; const info = document.createElement('span'); info.innerHTML = `<strong>${escapeHtml(run.name || run.id || '发送批次')}</strong><small>${escapeHtml(run.status || '')} · ${escapeHtml(run.updatedAt || run.updated_at || '')} · ${run.itemCount ?? 0} 个附件</small>`; row.append(info); const detail = document.createElement('button'); detail.className = 'ghost-button'; detail.type = 'button'; detail.textContent = '查看详情'; detail.addEventListener('click', (event) => { event.stopPropagation(); void openSendHistoryDetail(run.id); }); row.append(detail); row.addEventListener('click', () => void openSendHistoryDetail(run.id)); if (run.failedCount > 0 && run.lastRunId) { const retry = document.createElement('button'); retry.className = 'ghost-button'; retry.type = 'button'; retry.textContent = `重试失败项（${run.failedCount}）`; retry.addEventListener('click', async (event) => { event.stopPropagation(); try { const progress = await invokeCommand('send_retry', { runId: run.lastRunId, mailbox: collectSendMailbox() }); activeSendRunId = progress.runId; updateSendProgress(progress); void pollSendStatus(); notify('已启动失败项重试。', 'success'); } catch (error) { notify(`重试失败：${error.message ?? error}`, 'error'); } }); row.append(retry); } node.append(row); }); }

async function initSendModule() {
  const dir = document.querySelector('#send-source-dir');
  try { const signature = await invokeCommand('mail_signature_get', {}, () => '中国联通总部数据安全工作组'); document.querySelector('#send-signature').value = signature || '中国联通总部数据安全工作组'; } catch { document.querySelector('#send-signature').value = '中国联通总部数据安全工作组'; }
  document.querySelector('#send-select-source')?.addEventListener('click', async () => { try { const { open } = await import('@tauri-apps/plugin-dialog'); const selected = await open({ directory: true, multiple: false }); if (typeof selected === 'string') dir.value = selected; } catch { const selected = window.prompt('请输入材料目录路径'); if (selected) dir.value = selected; } });
  document.querySelector('#send-scan')?.addEventListener('click', async () => { const sourceDir = dir?.value.trim(); if (!sourceDir) { notify('请先选择材料目录', 'error'); return; } const button = document.querySelector('#send-scan'); button.disabled = true; button.textContent = '扫描中…'; try { const recursive = document.querySelector('#send-recursive')?.checked ?? true; const files = await invokeCommand('send_batch_scan', { sourceDir, recursive }); sendBatch = { ...sendBatch, sourceDir, recursive, files, items: buildSendBatchItems(files, getSendCompanyOptions()), id: '' }; document.querySelector('#send-scan-count').textContent = `发现 ${files.length} 个文件`; renderSendWorkbench(); await persistSendBatch(); notify(`扫描完成：发现 ${files.length} 个可发送文件`, 'success'); } catch (error) { notify(`扫描失败：${error.message ?? error}`, 'error'); } finally { button.disabled = false; button.textContent = '开始扫描'; } });
  ['send-subject','send-body','send-signature','send-cc','send-test-recipient','send-batch-name'].forEach((id) => document.querySelector(`#${id}`)?.addEventListener('input', () => { sendTestConfirmed = false; renderSendWorkbench(); }));
  document.querySelector('#save-default-signature')?.addEventListener('click', async () => { try { await invokeCommand('mail_signature_save', { signature: document.querySelector('#send-signature')?.value ?? '' }); notify('默认邮件签名已保存。', 'success'); } catch (error) { notify(`保存签名失败：${error.message ?? error}`, 'error'); } });
  document.querySelector('#send-match-filter')?.addEventListener('change', renderSendMatchList);
  document.querySelector('#send-run-check')?.addEventListener('click', () => { const result = validateSendBatch(sendBatch.items, collectSendValues()); renderSendPreflight(result.errors[0] || (result.warnings[0] ?? '检查通过，可以先发送测试邮件。')); notify(result.errors[0] || '检查完成', result.errors[0] ? 'error' : 'success'); });
  document.querySelector('#send-test')?.addEventListener('click', () => void runSend('test'));
  document.querySelector('#send-start')?.addEventListener('click', () => void runSend('formal'));
  document.querySelector('#send-mailbox-link')?.addEventListener('click', () => showView('mailboxes'));
  document.querySelector('#send-subject').value = '材料收集通知 - {单位名称}'; document.querySelector('#send-body').value = '您好，{单位名称}：\n\n请查收材料并按要求反馈。';
  renderSendWorkbench(); void loadSendHistory();
}

function renderTaskCompanyPicker() {
  const list = document.querySelector('#task-company-list');
  const count = document.querySelector('#task-company-count');
  const hint = document.querySelector('#task-company-hint');
  if (!list) return;
  const query = document.querySelector('#task-company-search')?.value ?? '';
  const filtered = filterCompanyOptions(companyOptions, query);
  const selected = new Set(selectedCompanyIds);
  if (count) count.textContent = `已选 ${selected.size} / 共 ${companyOptions.length} 家`;
  if (hint) hint.textContent = companyOptions.length ? '至少选择一家单位；只会将本任务匹配到所选单位。' : '请先在“通讯录”导入单位清单。';
  list.replaceChildren();
  if (!companyOptions.length) {
    list.innerHTML = '<div class="task-company-empty">暂无单位，请先导入单位清单。</div>';
    return;
  }
  if (!filtered.length) {
    list.innerHTML = '<div class="task-company-empty">没有找到匹配的单位。</div>';
    return;
  }
  filtered.forEach((option) => {
    const label = document.createElement('label');
    label.className = 'task-company-option';
    label.dataset.selected = String(selected.has(option.id));
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox'; checkbox.checked = selected.has(option.id); checkbox.dataset.companyId = option.id;
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) selectedCompanyIds = [...new Set([...selectedCompanyIds, option.id])];
      else selectedCompanyIds = selectedCompanyIds.filter((id) => id !== option.id);
      renderTaskCompanyPicker();
    });
    const content = document.createElement('span');
    const name = document.createElement('strong'); name.textContent = option.name;
    const detail = document.createElement('small');
    const meta = formatCompanyOptionMeta(option);
    detail.textContent = `${meta.contactLabel} · ${meta.emailLabel}`;
    const selectedLabel = document.createElement('em'); selectedLabel.textContent = '已选';
    content.append(name, detail); label.append(checkbox, content, selectedLabel); list.append(label);
  });
}

function initTaskCompanyPicker() {
  document.querySelector('#task-company-search')?.addEventListener('input', renderTaskCompanyPicker);
  document.querySelector('#task-company-select-all')?.addEventListener('click', () => {
    selectedCompanyIds = toggleAllCompanyIds(companyOptions, selectedCompanyIds);
    renderTaskCompanyPicker();
  });
  document.querySelector('#task-company-clear')?.addEventListener('click', () => {
    selectedCompanyIds = [];
    renderTaskCompanyPicker();
  });
  renderTaskCompanyPicker();
}

function flattenCompanyDetails(companies = []) {
  return companies.flatMap((company) => (company.contacts ?? []).map((contact) => ({
    companyId: company.id, contactId: contact.id, name: company.name, contactName: contact.contactName ?? contact.contact_name ?? '',
    emails: [contact.email], phone: contact.phone ?? '', aliases: company.aliases ?? [],
  })));
}

async function loadCompanyRows() {
  const companies = await invokeCommand('company_list', {}, () => []);
  companyRows = flattenCompanyDetails(Array.isArray(companies) ? companies : []);
  renderCompanyRows();
  await loadCompanyOptions();
}

function renderCompanyRows() {
  const panel = document.querySelector('#company-list-panel');
  if (!panel) return;
  panel.replaceChildren();
  if (!companyRows.length) {
    panel.className = 'panel placeholder-panel company-table-panel';
    panel.innerHTML = '<span>▦</span><h3>暂无单位清单</h3><p>导入 Excel 或 CSV 后，可在任务中选择单位并匹配反馈邮箱。</p>';
    return;
  }
  panel.className = 'panel company-table-panel';
  const heading = document.createElement('div');
  heading.className = 'company-table-heading';
  heading.innerHTML = '<div><p class="eyebrow">已导入清单</p><h3></h3></div><span class="company-table-tip">修改单行后点击保存</span>';
  heading.querySelector('h3').textContent = `${new Set(companyRows.map((row) => row.companyId || row.name)).size} 家单位 / ${companyRows.length} 位联系人`;
  panel.append(heading);
  const table = document.createElement('table');
  table.className = 'company-table';
  table.innerHTML = '<thead><tr><th>单位名称</th><th>姓名</th><th>邮箱</th><th>电话</th><th>单位别名</th><th>操作</th></tr></thead>';
  const body = document.createElement('tbody');
  companyRows.forEach((row, index) => {
    const tr = document.createElement('tr');
    tr.dataset.index = String(index);
    const name = document.createElement('input'); name.className = 'table-input'; name.value = row.name ?? ''; name.dataset.field = 'name';
    const contact = document.createElement('input'); contact.className = 'table-input'; contact.value = row.contactName ?? ''; contact.dataset.field = 'contactName'; contact.placeholder = '未填写';
    const emails = document.createElement('input'); emails.className = 'table-input'; emails.value = (row.emails ?? []).join('; '); emails.dataset.field = 'emails';
    const phone = document.createElement('input'); phone.className = 'table-input'; phone.value = row.phone ?? ''; phone.dataset.field = 'phone'; phone.placeholder = '可选';
    const aliases = document.createElement('input'); aliases.className = 'table-input'; aliases.value = (row.aliases ?? []).join('; '); aliases.dataset.field = 'aliases'; aliases.placeholder = '多个别名用分号分隔';
    const action = document.createElement('button'); action.className = 'ghost-button table-save'; action.type = 'button'; action.textContent = '保存'; action.addEventListener('click', () => saveCompanyRow(index, tr));
    const remove = document.createElement('button'); remove.className = 'ghost-button table-delete'; remove.type = 'button'; remove.textContent = row.draft ? '取消' : '删除'; remove.addEventListener('click', () => row.draft ? cancelCompanyRow(index) : deleteCompanyRow(index));
    [name, contact, emails, phone, aliases].forEach((input) => { const cell = document.createElement('td'); cell.append(input); tr.append(cell); });
    const actionCell = document.createElement('td'); actionCell.className = 'company-row-actions'; actionCell.append(action, remove); tr.append(actionCell);
    body.append(tr);
  });
  table.append(body); panel.append(table);
}

async function saveCompanyRow(index, rowElement) {
  const values = Object.fromEntries([...rowElement.querySelectorAll('[data-field]')].map((input) => [input.dataset.field, input.value.trim()]));
  const emails = String(values.emails ?? '').split(/[;,，；\s]+/).map((email) => email.trim()).filter(Boolean);
  if (!values.name) { notify('单位名称不能为空。', 'error'); return; }
  if (emails.length !== 1) { notify('每位联系人请填写一个邮箱。', 'error'); return; }
  const previous = companyRows[index];
  const aliases = String(values.aliases ?? '').split(/[;,，；、]+/).map((alias) => alias.trim()).filter(Boolean);
  const updated = { ...previous, name: values.name, contactName: values.contactName ?? '', emails, phone: values.phone ?? '', aliases };
  try {
    const input = { id: previous.contactId ?? '', companyId: previous.companyId ?? '', companyName: updated.name, contactName: updated.contactName, email: emails[0], phone: updated.phone, aliases };
    await invokeCommand(previous.draft ? 'company_contact_create' : 'company_contact_update', { input });
    await loadCompanyRows();
    notify(`已保存“${updated.name}”这一行。`);
  } catch (error) {
    notify(`保存失败：${error.message ?? error}`, 'error');
  }
}

function cancelCompanyRow(index) { companyRows.splice(index, 1); renderCompanyRows(); }

async function deleteCompanyRow(index) {
  const row = companyRows[index];
  const siblings = companyRows.filter((item) => item.companyId === row.companyId);
  const warning = siblings.length <= 1 ? `这是“${row.name}”最后一位联系人，删除后将同时删除该单位并从相关收集任务中移除。确定继续吗？` : `确定删除“${row.name}”的联系人“${row.contactName || row.emails?.[0]}”吗？`;
  if (!window.confirm(warning)) return;
  try {
    const result = await invokeCommand('company_contact_delete', { contactId: row.contactId });
    await loadCompanyRows();
    notify(result?.deletedCompany ? `已删除单位“${row.name}”，并影响 ${result.affectedTasks ?? 0} 个任务。` : '联系人已删除。');
  } catch (error) { notify(`删除失败：${error.message ?? error}`, 'error'); }
}

function initCompanyImport() {
  const fileInput = document.querySelector('#company-file');
  void loadCompanyRows().catch((error) => notify(`读取通讯录失败：${error.message ?? error}`, 'error'));
  document.querySelector('#add-company-contact')?.addEventListener('click', () => { companyRows.unshift({ draft: true, companyId: '', contactId: '', name: '', contactName: '', emails: [], phone: '', aliases: [] }); renderCompanyRows(); document.querySelector('.company-table tbody tr input')?.focus(); });
  document.querySelector('#import-companies')?.addEventListener('click', () => fileInput?.click());
  document.querySelector('#download-company-template')?.addEventListener('click', () => {
    const workbook = XLSX.utils.book_new();
    const worksheet = XLSX.utils.aoa_to_sheet([['单位名称', '联系人', '邮箱', '电话', '单位别名'], ['示例单位', '张三', 'mail@example.com', '010-12345678', '示例;单位']]);
    XLSX.utils.book_append_sheet(workbook, worksheet, '单位清单');
    downloadBlob('UniGather-单位导入模板.xlsx', XLSX.write(workbook, { bookType: 'xlsx', type: 'array' }), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  });
  fileInput?.addEventListener('change', async (event) => {
    const file = event.currentTarget.files?.[0]; if (!file) return;
    try {
      const lowerName = file.name.toLowerCase();
      let rows;
      if (lowerName.endsWith('.csv')) {
        rows = parseCompanyRows(decodeCsvBuffer(await file.arrayBuffer()));
      } else if (lowerName.endsWith('.xlsx') || lowerName.endsWith('.xls')) {
        const workbook = XLSX.read(await file.arrayBuffer(), { type: 'array' });
        const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
        rows = parseCompanyMatrix(XLSX.utils.sheet_to_json(firstSheet, { header: 1, defval: '' }));
      } else {
        throw new Error('请选择 .xlsx、.xls 或 .csv 文件');
      }
      if (!rows.length) throw new Error('导入文件没有可用的单位数据');
      try { await invokeCommand('company_import', { rows: companyRowsForImport(rows) }, () => rows.length); } catch (error) { notify(`本地已导入，但数据库保存失败：${error.message ?? error}`, 'error'); return; }
      await loadCompanyRows();
      notify(`已导入 ${rows.length} 行单位联系人。`);
    } catch (error) {
      notify(`导入失败：${error.message ?? error}`, 'error');
    } finally {
      event.currentTarget.value = '';
    }
  });
}

function readLocalInbox() {
  try {
    const stored = JSON.parse(localStorage.getItem('unigather.inbox.v1') ?? '[]');
    return Array.isArray(stored) ? stored : [];
  } catch { return []; }
}

function formatMailDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value || '未记录时间';
  return date.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function renderInboxDetail() {
  const detail = document.querySelector('#inbox-detail');
  const message = inboxMessages.find((item) => item.id === selectedMessageId);
  if (!detail) return;
  if (!message) {
    detail.innerHTML = '<div class="inbox-empty-detail"><span>✉</span><h3>选择一封邮件</h3><p>左侧列表会显示已同步的收件箱邮件。</p></div>';
    return;
  }
  detail.innerHTML = '<article class="mail-detail"><header class="mail-detail-header"><h3 class="mail-detail-subject"></h3><div class="mail-detail-meta"><span class="mail-avatar"></span><div><strong class="mail-sender"></strong><small class="mail-receiver"></small></div><time class="mail-detail-time"></time></div><div class="mail-detail-recipients"></div></header><div class="mail-detail-body"></div><section class="mail-attachments" hidden><h4>附件</h4><div class="mail-attachment-list"></div></section></article>';
  detail.querySelector('.mail-detail-subject').textContent = message.subject;
  detail.querySelector('.mail-avatar').textContent = (message.sender || '来').slice(0, 1);
  detail.querySelector('.mail-sender').textContent = message.sender || '未知发件人';
  detail.querySelector('.mail-receiver').textContent = message.recipients.length ? `收件人：${message.recipients.join('、')}` : '收件人信息未记录';
  detail.querySelector('.mail-detail-time').textContent = formatMailDate(message.receivedAt);
  detail.querySelector('.mail-detail-recipients').textContent = message.cc.length ? `抄送：${message.cc.join('、')}` : '抄送：无';
  detail.querySelector('.mail-detail-body').textContent = message.body || '（邮件正文为空）';
  if (message.attachments.length) {
    const section = detail.querySelector('.mail-attachments'); section.hidden = false;
    const list = detail.querySelector('.mail-attachment-list');
    message.attachments.forEach((attachment) => {
      const item = document.createElement('div'); item.className = `mail-attachment${attachment.savedPath ? ' mail-attachment-openable' : ''}`;
      const icon = document.createElement('span'); icon.textContent = attachment.name.toLowerCase().endsWith('xlsx') ? '▣' : '▤';
      const name = document.createElement('span'); name.textContent = attachment.name || '未命名附件';
      const status = document.createElement('small'); status.textContent = attachment.savedPath ? '已归档到本地' : '附件尚未归档到本地';
      item.append(icon, name, status, createAttachmentActions(attachment)); list.append(item);
    });
  }
}

function renderInboxList() {
  const list = document.querySelector('#inbox-list');
  const count = document.querySelector('#inbox-count');
  if (!list) return;
  const visibleMessages = filterInboxMessages(inboxMessages, inboxQuery);
  if (count) count.textContent = inboxQuery ? `${visibleMessages.length} / ${inboxMessages.length} 封邮件` : `${inboxMessages.length} 封邮件`;
  list.replaceChildren();
  if (!visibleMessages.length) {
    list.innerHTML = inboxQuery ? '<div class="inbox-empty-list"><span>⌕</span><h3>没有匹配邮件</h3><p>请换一个发件人、主题或正文关键词。</p></div>' : '<div class="inbox-empty-list"><span>✉</span><h3>收件箱为空</h3><p>配置邮箱并点击“立即收件”后，邮件会显示在这里。</p></div>';
    renderInboxDetail();
    return;
  }
  visibleMessages.forEach((message) => {
    const row = document.createElement('article'); row.className = `inbox-row${message.id === selectedMessageId ? ' selected' : ''}`; row.dataset.messageId = message.id;
    const dot = document.createElement('i'); dot.className = 'inbox-row-dot';
    const main = document.createElement('div'); main.className = 'inbox-row-main';
    const sender = document.createElement('strong'); sender.className = 'inbox-row-sender'; sender.textContent = message.sender || '未知发件人';
    const subject = document.createElement('div'); subject.className = 'inbox-row-subject'; subject.textContent = message.subject;
    const preview = document.createElement('div'); preview.className = 'inbox-row-preview'; preview.textContent = message.body.replace(/\s+/g, ' ').slice(0, 80);
    main.append(sender, subject, preview);
    const meta = document.createElement('div'); meta.className = 'inbox-row-meta'; meta.textContent = formatMailDate(message.receivedAt);
    if (message.attachments.length) { const mark = document.createElement('span'); mark.className = 'inbox-attachment-mark'; mark.textContent = '⌕'; meta.append(mark); }
    row.append(dot, main, meta); row.addEventListener('click', () => { selectedMessageId = message.id; renderInboxList(); renderInboxDetail(); });
    list.append(row);
  });
  renderInboxDetail();
}

async function loadInbox({ quiet = false } = {}) {
  try {
    const result = await invokeCommand('mail_list', {}, () => readLocalInbox());
    inboxMessages = sortInboxMessages(Array.isArray(result) ? result : []);
  } catch (error) {
    inboxMessages = sortInboxMessages(readLocalInbox());
    if (!quiet) notify(`读取收件箱失败：${error.message ?? error}`, 'error');
  }
  if (!inboxMessages.some((message) => message.id === selectedMessageId)) selectedMessageId = inboxMessages[0]?.id ?? '';
  renderInboxList();
}

function initInbox() {
  const sinceInput = document.querySelector('#inbox-since');
  if (sinceInput) sinceInput.value = normalizeInboxStartTime('');
  document.querySelector('#inbox-search')?.addEventListener('input', (event) => { inboxQuery = event.currentTarget.value; renderInboxList(); });
  document.querySelector('#inbox-sort')?.addEventListener('change', (event) => {
    const newest = event.currentTarget.value !== 'oldest';
    inboxMessages.sort((left, right) => (newest ? 1 : -1) * ((Date.parse(right.receivedAt) || 0) - (Date.parse(left.receivedAt) || 0)));
    renderInboxList();
  });
  document.querySelector('#sync-inbox')?.addEventListener('click', runInboxSync);
  void loadInbox();
}

async function runInboxSync() {
  const values = collectMailboxValues();
  const errors = validateMailboxForSync(values);
  if (Object.keys(errors).length) {
    notify(`请先完成邮箱配置：${Object.values(errors)[0]}`, 'error');
    showView('mailboxes');
    return;
  }
  if (activeSyncRunId) return;
  const button = document.querySelector('#sync-inbox');
  const since = normalizeInboxStartTime(document.querySelector('#inbox-since')?.value);
  const progressPanel = document.querySelector('#inbox-sync-progress');
  const progressBar = document.querySelector('#inbox-sync-progress-bar');
  const progressText = document.querySelector('#inbox-sync-progress-text');
  const progressCount = document.querySelector('#inbox-sync-progress-count');
  if (button) { button.disabled = true; button.textContent = '收件中…'; }
  if (progressPanel) progressPanel.hidden = false;
  if (progressBar) progressBar.style.width = '5%';
  if (progressText) progressText.textContent = '正在准备收件…';
  if (progressCount) progressCount.textContent = '已处理 0 封';
  try {
    const mailbox = { ...buildMailboxPayload(values), password: values.password ?? '', proxy_username: values.proxyUsername ?? '', proxy_password: values.proxyPassword ?? '' };
    const initial = await invokeCommand('sync_start', { taskId: '', mailbox, since, until: normalizeSyncEnd('') }, (error) => { throw new Error(`当前不是可用的 Tauri 桌面运行环境：${error?.message ?? error}`); });
    activeSyncRunId = initial?.runId ?? initial?.run_id ?? '';
    activeSyncTaskId = '';
    if (!activeSyncRunId) throw new Error('收件任务未返回运行编号');
    await pollInboxSync({ button, progressPanel, progressBar, progressText, progressCount });
  } catch (error) {
    notify(`收件失败：${error.message ?? error}`, 'error');
    activeSyncRunId = '';
    activeSyncTaskId = '';
    if (progressPanel) progressPanel.hidden = true;
    if (button) { button.disabled = false; button.textContent = '立即收件'; }
  }
}

async function pollInboxSync(elements) {
  const { button, progressPanel, progressBar, progressText, progressCount } = elements;
  while (activeSyncRunId) {
    const progress = await invokeCommand('sync_status', { runId: activeSyncRunId });
    if (!progress) throw new Error('收件任务状态已丢失');
    const percent = syncProgressPercent(progress);
    if (progressBar) progressBar.style.width = `${percent}%`;
    if (progressText) progressText.textContent = syncProgressLabel(progress);
    if (progressCount) progressCount.textContent = progress.total ? `已处理 ${progress.processed ?? 0} / ${progress.total} 封 · 新增 ${progress.received ?? 0}` : `已处理 ${progress.processed ?? 0} 封 · 新增 ${progress.received ?? 0}`;
    await loadInbox({ quiet: true });
    if (progress.status === 'completed' || progress.status === 'failed') {
      activeSyncRunId = '';
      activeSyncTaskId = '';
      if (progress.status === 'failed') notify(`收件失败：${progress.errors?.[0] ?? progress.message}`, 'error');
      else if (progress.errors?.length) notify(`收件完成：新增 ${progress.received ?? 0} 封，重复 ${progress.duplicates ?? 0} 封；${progress.errors[0]}`, 'error');
      else notify(`收件完成：新增 ${progress.received ?? 0} 封，重复 ${progress.duplicates ?? 0} 封。`);
      if (progressPanel) progressPanel.hidden = false;
      if (button) { button.disabled = false; button.textContent = '立即收件'; }
      return;
    }
    await new Promise((resolve) => { syncPollTimer = window.setTimeout(resolve, 450); });
  }
}

function readTaskSyncTimes() {
  try {
    const value = JSON.parse(localStorage.getItem(TASK_SYNC_STORAGE_KEY) ?? '{}');
    return value && typeof value === 'object' ? value : {};
  } catch { return {}; }
}

function writeTaskSyncTime(taskId, timestamp = Date.now()) {
  const values = readTaskSyncTimes();
  values[taskId] = timestamp;
  localStorage.setItem(TASK_SYNC_STORAGE_KEY, JSON.stringify(values));
}

function setTaskSyncUi(task, progress = null) {
  const modal = document.querySelector('#task-detail-modal');
  if (!modal || detailTaskId !== task.id) return;
  const panel = modal.querySelector('#task-detail-sync-panel');
  const text = modal.querySelector('#task-detail-sync-text');
  const count = modal.querySelector('#task-detail-sync-count');
  const bar = modal.querySelector('#task-detail-sync-bar');
  const button = modal.querySelector('#refresh-task-detail');
  if (panel) panel.hidden = !progress;
  if (button) { button.disabled = Boolean(progress); button.textContent = progress ? '收件中…' : '↻ 立即刷新'; }
  if (!progress) return;
  const percent = syncProgressPercent(progress);
  if (text) text.textContent = syncProgressLabel(progress);
  if (count) count.textContent = `已处理 ${progress.processed ?? 0} 封 · 匹配 ${progress.matched ?? 0} 封`;
  if (bar) bar.style.width = `${percent}%`;
}

async function runTaskSync(task, { manual = true } = {}) {
  if (!task || activeSyncRunId) return false;
  const values = collectMailboxValues();
  const errors = validateMailboxForSync(values);
  if (Object.keys(errors).length) {
    if (manual) { notify(`请先完成邮箱配置：${Object.values(errors)[0]}`, 'error'); showView('mailboxes'); }
    return false;
  }
  activeSyncTaskId = task.id;
  const since = task.start_time || normalizeInboxStartTime('');
  const until = normalizeSyncEnd(task.deadline || '');
  setTaskSyncUi(task, { status: 'running', processed: 0, total: 0, received: 0, matched: 0, message: '正在准备任务刷新…' });
  try {
    const mailbox = { ...buildMailboxPayload(values), password: values.password ?? '', proxy_username: values.proxyUsername ?? '', proxy_password: values.proxyPassword ?? '' };
    const initial = await invokeCommand('sync_start', { taskId: task.id, mailbox, since, until }, (error) => { throw new Error(`当前不是可用的 Tauri 桌面运行环境：${error?.message ?? error}`); });
    activeSyncRunId = initial?.runId ?? initial?.run_id ?? '';
    if (!activeSyncRunId) throw new Error('任务刷新未返回运行编号');
    writeTaskSyncTime(task.id);
    while (activeSyncRunId === (initial?.runId ?? initial?.run_id ?? activeSyncRunId)) {
      const progress = await invokeCommand('sync_status', { runId: activeSyncRunId });
      if (!progress) throw new Error('任务刷新状态已丢失');
      setTaskSyncUi(task, progress);
      if (progress.status === 'completed' || progress.status === 'failed') {
        activeSyncRunId = '';
        activeSyncTaskId = '';
        if (progress.status === 'completed') writeTaskLastReceiveTime(task.id);
        await loadTasks();
        const refreshed = tasks.find((item) => item.id === task.id) ?? task;
        if (detailTaskId === task.id) { openTaskDetail(refreshed); setTaskSyncUi(refreshed, null); }
        if (manual) {
          if (progress.status === 'failed') notify(`任务刷新失败：${progress.errors?.[0] ?? progress.message}`, 'error');
          else notify(`任务刷新完成：新增 ${progress.received ?? 0} 封，匹配 ${progress.matched ?? 0} 封。`);
        }
        return progress.status === 'completed';
      }
      await new Promise((resolve) => { syncPollTimer = window.setTimeout(resolve, 500); });
    }
  } catch (error) {
    activeSyncRunId = '';
    activeSyncTaskId = '';
    setTaskSyncUi(task, null);
    if (manual) notify(`任务刷新失败：${error.message ?? error}`, 'error');
    return false;
  }
  return false;
}

function startTaskPolling() {
  window.clearInterval(taskPollingTimer);
  taskPollingTimer = window.setInterval(() => {
    refreshTaskScheduleDisplays();
    if (activeSyncRunId) return;
    const mailboxErrors = validateMailboxForSync(collectMailboxValues());
    if (Object.keys(mailboxErrors).length) return;
    const now = Date.now();
    const times = readTaskSyncTimes();
    const receiveTimes = readTaskLastReceiveTimes();
    const due = tasks.find((task) => {
      const deadline = Date.parse(task.deadline ?? '');
      return shouldRunInitialTaskSync(task, receiveTimes[task.id], now) || (task.status === 'active'
        && (Number.isNaN(deadline) || deadline > now)
        && now - Number(times[task.id] ?? now) >= (Number(task.poll_minutes) || 30) * 60 * 1000);
    });
    if (due) void runTaskSync(due, { manual: false });
  }, 30000);
}

function readMaterialPath() {
  try { return normalizeMaterialPath(localStorage.getItem(MATERIAL_PATH_STORAGE_KEY) ?? DEFAULT_MATERIAL_PATH); } catch { return DEFAULT_MATERIAL_PATH; }
}

async function loadMaterialPath() {
  const input = document.querySelector('#material-save-path');
  if (!input) return;
  input.value = readMaterialPath();
  try {
    const stored = await invokeCommand('settings_get', { key: 'material_save_path' }, () => null);
    if (stored) { input.value = normalizeMaterialPath(stored); localStorage.setItem(MATERIAL_PATH_STORAGE_KEY, input.value); }
  } catch { /* localStorage fallback remains available */ }
}

async function saveMaterialPath() {
  const input = document.querySelector('#material-save-path');
  const value = normalizeMaterialPath(input?.value);
  if (input) input.value = value;
  localStorage.setItem(MATERIAL_PATH_STORAGE_KEY, value);
  try { await invokeCommand('settings_update', { key: 'material_save_path', value }, () => null); notify('材料保存路径已保存。'); }
  catch (error) { notify(`路径已保存到本机，但数据库保存失败：${error.message ?? error}`, 'error'); }
}

async function chooseMaterialPath() {
  const input = document.querySelector('#material-save-path');
  try {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const selected = await open({ directory: true, multiple: false, title: '选择材料保存目录' });
    if (typeof selected === 'string' && input) input.value = selected;
  } catch (error) {
    if (typeof window.showDirectoryPicker === 'function') {
      try {
        const handle = await window.showDirectoryPicker({ mode: 'readwrite' });
        if (input) input.value = handle.name;
        notify('已选择目录名称，请在 Windows 桌面版中使用原生目录选择器获取完整路径。');
        return;
      } catch (pickerError) {
        if (pickerError?.name === 'AbortError') return;
      }
    }
    notify(`无法打开目录选择器：${error.message ?? error}`, 'error');
  }
}

function readLocalAiConfig() {
  try { return normalizeAiConfig(JSON.parse(localStorage.getItem(AI_CONFIG_STORAGE_KEY) ?? '{}')); } catch { return normalizeAiConfig({}); }
}

async function loadAiConfig() {
  const local = readLocalAiConfig();
  const enabled = document.querySelector('#ai-enabled');
  const endpoint = document.querySelector('#ai-endpoint');
  const model = document.querySelector('#ai-model');
  if (enabled) enabled.checked = local.enabled;
  if (endpoint) endpoint.value = local.endpoint;
  if (model) model.value = local.model;
  try {
    const stored = await invokeCommand('ai_config_get', {}, () => ({ enabled: local.enabled, endpoint: local.endpoint, model: local.model, api_key_present: Boolean(local.apiKey) }));
    if (enabled) enabled.checked = Boolean(stored?.enabled);
    if (endpoint) endpoint.value = stored?.endpoint ?? local.endpoint;
    if (model) model.value = stored?.model ?? local.model;
    const status = document.querySelector('#ai-key-status');
    if (status) status.textContent = stored?.api_key_present ? 'API Key 已配置（不会回显）' : '尚未配置 API Key';
  } catch { /* local preview fallback remains available */ }
}

async function saveAiConfig() {
  const values = { enabled: document.querySelector('#ai-enabled')?.checked, endpoint: document.querySelector('#ai-endpoint')?.value, model: document.querySelector('#ai-model')?.value, apiKey: document.querySelector('#ai-api-key')?.value };
  const errors = validateAiConfig(values);
  if (Object.keys(errors).length) { notify(Object.values(errors)[0], 'error'); return; }
  const config = normalizeAiConfig(values);
  try {
    await invokeCommand('ai_config_save', { config }, () => { localStorage.setItem(AI_CONFIG_STORAGE_KEY, JSON.stringify(config)); });
    localStorage.setItem(AI_CONFIG_STORAGE_KEY, JSON.stringify({ enabled: config.enabled, endpoint: config.endpoint, model: config.model }));
    const status = document.querySelector('#ai-key-status');
    if (status) status.textContent = config.apiKey ? 'API Key 已配置（不会回显）' : '尚未配置 API Key';
    const key = document.querySelector('#ai-api-key'); if (key) key.value = '';
    notify('AI 配置已保存。');
  } catch (error) { notify(`AI 配置保存失败：${error.message ?? error}`, 'error'); }
}

function initMaterialsAndSettings() {
  document.querySelector('#export-materials')?.addEventListener('click', async () => { const active = tasks[0]; try { await invokeCommand('report_export', { taskId: active?.id ?? '', status: 'pending' }, () => null); } catch { /* local export still works */ } downloadText('UniGather-材料清单.csv', '任务名称,状态,截止时间\n' + tasks.map((task) => `${task.name},${taskStatusLabel(task.status)},${formatDeadline(task.deadline)}`).join('\n'), 'text/csv;charset=utf-8'); notify('材料清单已导出。'); });
  document.querySelector('#save-material-path')?.addEventListener('click', saveMaterialPath);
  document.querySelector('#choose-material-path')?.addEventListener('click', chooseMaterialPath);
  document.querySelector('#open-material-directory')?.addEventListener('click', async () => { const path = readMaterialPath(); try { await invokeCommand('material_open', { path }, () => path); notify(`已请求打开归档目录：${path}`); } catch (error) { notify(`无法打开目录：${error.message ?? error}`, 'error'); } });
  document.querySelector('#feedback-filter')?.addEventListener('click', () => notify('暂无反馈数据，导入单位并创建任务后可筛选状态。'));
  document.querySelectorAll('.app-setting').forEach((input) => input.addEventListener('change', async (event) => { const key = event.currentTarget.dataset.setting; const value = String(event.currentTarget.checked); localStorage.setItem(`unigather.setting.${key}`, value); try { await invokeCommand('settings_update', { key, value }, () => null); } catch { /* local preference is still saved */ } notify('设置已保存。'); }));
  document.querySelector('#check-updates')?.addEventListener('click', checkForUpdates);
  document.querySelector('#save-ai-config')?.addEventListener('click', saveAiConfig);
  void loadMaterialPath();
  void loadAiConfig();
}

async function checkForUpdates() {
  const button = document.querySelector('#check-updates');
  const panel = document.querySelector('#update-panel');
  if (!button || !panel) return;
  button.disabled = true; button.textContent = '检查中…'; panel.hidden = true;
  try {
    const response = await fetch(RELEASES_ENDPOINT, { headers: { Accept: 'application/vnd.github+json' } });
    if (!response.ok) throw new Error(`GitHub 返回 ${response.status}`);
    const release = await response.json();
    const latest = release.tag_name ?? release.name ?? '';
    const installer = pickInstallerAsset(release.assets ?? []);
    if (!isNewerVersion(latest, APP_VERSION)) {
      notify(`当前已是最新版本 v${APP_VERSION}。`);
      return;
    }
    const releaseUrl = safeGitHubUrl(release.html_url);
    const installerUrl = safeGitHubUrl(installer?.browser_download_url);
    panel.innerHTML = `<strong>发现新版本 ${escapeHtml(latest)}</strong><span>${escapeHtml(release.name ?? 'UniGather 新版本')}${release.published_at ? ` · ${new Date(release.published_at).toLocaleDateString('zh-CN')}` : ''}</span><p>${escapeHtml(String(release.body ?? '请查看 GitHub Release 说明。').slice(0, 260))}</p><div class="update-panel-actions"><button class="primary-button update-download" id="download-update" type="button"${installerUrl ? '' : ' disabled'}>${installerUrl ? '下载并安装更新' : '暂无安装包'}</button><a class="link-button" href="${releaseUrl ?? '#'}" target="_blank" rel="noreferrer">查看 Release</a></div><div class="update-download-progress" id="update-download-progress" hidden><div class="update-progress-head"><strong id="update-progress-label">准备下载…</strong><span id="update-progress-value">0%</span></div><div class="update-progress-track"><i id="update-progress-bar"></i></div><small id="update-progress-hint">下载完成后，请退出当前软件并运行安装包。</small></div>`;
    panel.querySelector('#download-update')?.addEventListener('click', () => void downloadInstaller(installerUrl, installer?.name));
    panel.hidden = false; notify(`发现新版本 ${latest}，可下载更新。`);
  } catch (error) {
    notify(`检查更新失败：${error.message ?? error}`, 'error');
  } finally {
    button.disabled = false; button.textContent = '检查更新';
  }
}

async function downloadInstaller(url, fileName = 'UniGather-update.exe') {
  const button = document.querySelector('#download-update');
  const panel = document.querySelector('#update-download-progress');
  const label = document.querySelector('#update-progress-label');
  const value = document.querySelector('#update-progress-value');
  const bar = document.querySelector('#update-progress-bar');
  const hint = document.querySelector('#update-progress-hint');
  if (!url || !button || !panel) return;
  button.disabled = true;
  button.textContent = '连接下载…';
  panel.hidden = false;
  if (label) label.textContent = '正在连接 GitHub…';
  if (value) value.textContent = '0%';
  if (bar) bar.style.width = '3%';
  try {
    const response = await fetch(url, { redirect: 'follow' });
    if (!response.ok) throw new Error(`下载服务器返回 ${response.status}`);
    const total = Number(response.headers.get('content-length')) || 0;
    const reader = response.body?.getReader();
    const chunks = [];
    let loaded = 0;
    if (reader) {
      while (true) {
        const result = await reader.read();
        if (result.done) break;
        chunks.push(result.value);
        loaded += result.value.byteLength;
        const progress = formatDownloadProgress(loaded, total);
        if (label) label.textContent = total ? '正在下载安装包…' : '正在下载安装包（大小未知）…';
        if (value) value.textContent = progress;
        if (bar) bar.style.width = total ? progress : '55%';
      }
    } else {
      chunks.push(new Uint8Array(await response.arrayBuffer()));
      loaded = chunks[0].byteLength;
    }
    const blob = new Blob(chunks, { type: response.headers.get('content-type') || 'application/octet-stream' });
    const objectUrl = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = objectUrl;
    link.download = fileName || 'UniGather-update.exe';
    link.style.display = 'none';
    document.body.append(link);
    link.click();
    window.setTimeout(() => { URL.revokeObjectURL(objectUrl); link.remove(); }, 1000);
    if (label) label.textContent = '安装包下载完成';
    if (value) value.textContent = formatDownloadProgress(loaded, total);
    if (bar) bar.style.width = '100%';
    if (hint) hint.textContent = '安装包已保存到 Windows“下载”文件夹，请退出当前软件后双击安装。';
    button.disabled = false;
    button.textContent = '重新下载';
    notify('安装包下载完成，请退出软件后运行安装包。');
  } catch (error) {
    try {
      await invokeCommand('open_external_url', { url });
      if (label) label.textContent = '已打开浏览器下载';
      if (value) value.textContent = '外部下载';
      if (bar) bar.style.width = '100%';
      if (hint) hint.textContent = '当前网络不允许应用内下载，已打开浏览器下载页面；下载完成后请退出软件并运行安装包。';
      button.disabled = false;
      button.textContent = '重新下载';
      notify('已打开浏览器下载页面，请完成下载后安装。');
      return;
    } catch { /* show the original error below */ }
    if (label) label.textContent = '下载失败';
    if (value) value.textContent = '失败';
    if (bar) bar.style.width = '0%';
    if (hint) hint.textContent = `原因：${error.message ?? error}。可点击“查看 Release”手动下载。`;
    button.disabled = false;
    button.textContent = '重试下载';
    notify(`更新下载失败：${error.message ?? error}`, 'error');
  }
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
}

function safeGitHubUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && (url.hostname === 'github.com' || url.hostname.endsWith('.githubusercontent.com')) ? url.href : null;
  } catch { return null; }
}

navItems.forEach((item) => item.addEventListener('click', () => showView(item.dataset.view)));
document.querySelectorAll('[data-view]').forEach((item) => item.addEventListener('click', () => showView(item.dataset.view)));
document.querySelector('#new-task-2')?.addEventListener('click', () => openTaskModal());
document.querySelectorAll('[data-open-task]').forEach((button) => button.addEventListener('click', () => openTaskModal()));
document.querySelectorAll('[data-close-modal]').forEach((button) => button.addEventListener('click', closeModal));
document.querySelectorAll('[data-close-task-detail]').forEach((button) => button.addEventListener('click', closeTaskDetail));
document.querySelectorAll('[data-close-task-management]').forEach((button) => button.addEventListener('click', closeTaskManagement));
document.querySelectorAll('[data-close-task-delete-confirm]').forEach((button) => button.addEventListener('click', closeTaskDeleteConfirm));
document.querySelector('#confirm-task-delete')?.addEventListener('click', () => void confirmTaskDelete());
document.querySelector('#task-delete-confirm-modal')?.addEventListener('click', (event) => { if (event.target.id === 'task-delete-confirm-modal') closeTaskDeleteConfirm(); });
document.querySelectorAll('[data-task-management-filter]').forEach((button) => button.addEventListener('click', () => openTaskManagement(button.dataset.taskManagementFilter)));
document.querySelector('#task-management-filter')?.addEventListener('change', (event) => { taskManagementFilter = event.currentTarget.value; renderTaskManagement(); });
document.querySelectorAll('[data-close-task-feedback-drilldown]').forEach((button) => button.addEventListener('click', closeTaskFeedbackDrilldown));
document.querySelector('#task-match-filter')?.addEventListener('change', () => { taskMatchPage = 1; if (detailTaskId) void loadTaskMatchDetail(detailTaskId); });
document.querySelector('#task-match-page-size')?.addEventListener('change', (event) => { taskMatchPageSize = Number(event.currentTarget.value); taskMatchPage = 1; if (detailTaskId) void loadTaskMatchDetail(detailTaskId); });
document.querySelector('#task-feedback-select')?.addEventListener('change', (event) => { selectedTaskSummaryId = event.currentTarget.value; renderTasks(); });
document.querySelectorAll('[data-close-send-history]').forEach((button) => button.addEventListener('click', () => { const modal = document.querySelector('#send-history-detail-modal'); modal?.classList.remove('open'); modal?.setAttribute('aria-hidden', 'true'); }));
document.querySelector('#refresh-task-detail')?.addEventListener('click', () => {
  const task = tasks.find((item) => item.id === detailTaskId);
  if (task) void runTaskSync(task, { manual: true });
});
document.querySelector('#edit-task-detail')?.addEventListener('click', () => {
  const task = tasks.find((item) => item.id === detailTaskId);
  closeTaskDetail();
  if (task) openTaskModal(task);
});
taskForm?.addEventListener('submit', saveTask);
document.querySelector('#add-mailbox')?.addEventListener('click', () => { showView('mailboxes'); document.querySelector('#mailbox-name')?.focus(); });

initMailbox();
initCompanyImport();
initTaskCompanyPicker();
initTaskTimeRange();
initTaskMaterialName();
initInbox();
initSendModule();
initMaterialsAndSettings();
void loadTasks().then(startTaskPolling);
