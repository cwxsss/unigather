import { invokeCommand } from './bridge.js';
import { buildMailboxPayload, buildMailboxStorage, mailboxDefaults, validateMailboxForm } from './core/mailbox.js';
import { buildTaskInput, taskProgressPercent, taskStatusLabel, validateTaskInput } from './core/tasks.js';
import { decodeCsvBuffer, parseCompanyMatrix, parseCompanyRows } from './core/attachments.js';
import { DEFAULT_MATERIAL_PATH, normalizeMaterialPath } from './core/materials.js';
import { filterInboxMessages, normalizeInboxMessage, sortInboxMessages } from './core/inbox.js';
import { normalizeInboxStartTime } from './core/sync.js';
import { syncProgressLabel, syncProgressPercent } from './core/sync-progress.js';
import { normalizeAiConfig, validateAiConfig } from './core/ai.js';
import { formatDownloadProgress, isNewerVersion, pickInstallerAsset } from './core/update.js';
import * as XLSX from 'xlsx';

const navItems = document.querySelectorAll('.nav-item');
const views = document.querySelectorAll('.view');
const title = document.querySelector('#page-title');
const toast = document.querySelector('#toast');
const labels = { dashboard: '仪表盘', tasks: '收集任务', inbox: '收件箱', companies: '分子公司', mailboxes: '邮箱配置', materials: '材料归档', settings: '系统设置' };
const TASK_STORAGE_KEY = 'unigather.tasks.v1';
const MAILBOX_STORAGE_KEY = 'unigather.mailbox.v1';
const MATERIAL_PATH_STORAGE_KEY = 'unigather.material-path.v1';
const AI_CONFIG_STORAGE_KEY = 'unigather.ai-config.v1';
const APP_VERSION = '0.0.3';
const RELEASES_ENDPOINT = 'https://api.github.com/repos/cwxsss/unigather/releases/latest';
let tasks = [];
let companyRows = [];
let inboxMessages = [];
let selectedMessageId = '';
let inboxQuery = '';
let editingTaskId = '';
let detailTaskId = '';
let activeSyncRunId = '';
let syncPollTimer = 0;

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
  if (title) title.textContent = labels[name] ?? '仪表盘';
  if (name === 'tasks') renderTasks();
  if (name === 'dashboard') renderDashboardTask();
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

function fallbackTaskSummary(input) {
  return { id: `local-${Date.now()}`, name: input.name, status: 'active', total_companies: input.company_ids.length, confirmed_companies: 0, deadline: input.deadline, start_time: input.start_time, poll_minutes: input.poll_minutes, save_directory: input.save_directory, subject_keywords: input.subject_keywords, body_keywords: input.body_keywords, ai_enabled: input.ai_enabled };
}

async function loadTasks() {
  const localTasks = readLocalTasks();
  const result = await invokeCommand('task_list', {}, () => localTasks);
  tasks = Array.isArray(result) ? result : localTasks;
  // Remove the two old demo records if they were saved by an earlier preview build.
  tasks = tasks.filter((task) => !['task-q3', 'task-audit'].includes(task.id) && !['2026 年第三季度经营材料收集', '审计整改闭环材料'].includes(task.name));
  writeLocalTasks();
  renderTasks();
  renderDashboardTask();
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
  list.replaceChildren();
  if (!tasks.length) {
    list.innerHTML = '<div class="panel empty-state"><span class="empty-state-icon">＋</span><h3>还没有收集任务</h3><p>创建任务后，在这里查看反馈进度、同步记录和待反馈单位。</p><button class="primary-button" type="button" data-open-task>创建第一个任务</button></div>';
    list.querySelector('[data-open-task]')?.addEventListener('click', openTaskModal);
    return;
  }
  tasks.forEach((task, index) => {
    const row = document.createElement('article');
    row.className = 'task-list-row';
    row.dataset.taskId = task.id;
    const badge = document.createElement('div');
    badge.className = `task-badge${index % 2 ? ' purple' : ''}`;
    badge.textContent = task.name.slice(0, 2);
    const detail = document.createElement('div');
    detail.innerHTML = `<strong></strong><small></small>`;
    detail.querySelector('strong').textContent = task.name;
    detail.querySelector('small').textContent = `${task.total_companies ?? 0} 家单位　·　截止 ${formatDeadline(task.deadline)}　·　每 ${task.poll_minutes ?? 30} 分钟`;
    const status = document.createElement('span');
    status.className = `status ${task.status === 'completed' ? 'completed' : task.status === 'paused' ? 'overdue' : 'progress'}`;
    status.textContent = taskStatusLabel(task.status);
    const progress = document.createElement('b');
    progress.textContent = `${taskProgressPercent(task)}%`;
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
    row.append(badge, detail, status, progress, actions);
    list.append(row);
  });
}

function renderDashboardTask() {
  const banner = document.querySelector('#dashboard-task-banner');
  if (!banner) return;
  const active = tasks.find((task) => task.status === 'active');
  if (!active) {
    banner.className = 'task-banner empty-task-banner';
    banner.innerHTML = '<div class="task-badge">＋</div><div class="task-info"><strong>还没有收集任务</strong><span>创建第一个任务后，单位反馈进度会显示在这里。</span></div><button class="ghost-button" data-open-task type="button">创建任务</button>';
    banner.querySelector('[data-open-task]')?.addEventListener('click', openTaskModal);
    return;
  }
  const total = Number(active.total_companies) || 0;
  const confirmed = Number(active.confirmed_companies) || 0;
  const percent = taskProgressPercent(active);
  banner.className = 'task-banner';
  banner.innerHTML = `<div class="task-badge">${active.name.slice(0, 2)}</div><div class="task-info"><strong></strong><span></span></div><div class="task-progress"><strong>${percent}%</strong><div class="progress-track"><i style="width:${percent}%"></i></div><span>${confirmed} / ${total} 家单位</span></div><button class="icon-button" type="button" aria-label="打开任务">→</button>`;
  banner.querySelector('strong').textContent = active.name;
  banner.querySelector('.task-info span').textContent = `截止时间：${formatDeadline(active.deadline)}　·　每 ${active.poll_minutes ?? 30} 分钟自动收件`;
  banner.querySelector('.icon-button')?.addEventListener('click', () => openTaskDetail(active));
}

function openTaskDetail(task) {
  const detailModal = document.querySelector('#task-detail-modal');
  if (!detailModal || !task) return;
  detailTaskId = task.id;
  const percent = taskProgressPercent(task);
  detailModal.querySelector('#task-detail-title').textContent = task.name;
  detailModal.querySelector('#task-detail-percent').textContent = `${percent}%`;
  detailModal.querySelector('#task-detail-progress-label').textContent = `${task.confirmed_companies ?? 0} / ${task.total_companies ?? 0} 家单位已反馈`;
  detailModal.querySelector('#task-detail-progress-bar').style.width = `${percent}%`;
  detailModal.querySelector('#task-detail-status').textContent = taskStatusLabel(task.status);
  detailModal.querySelector('#task-detail-start').textContent = formatDeadline(task.start_time);
  detailModal.querySelector('#task-detail-deadline').textContent = formatDeadline(task.deadline);
  detailModal.querySelector('#task-detail-poll').textContent = `每 ${task.poll_minutes ?? 30} 分钟`;
  detailModal.querySelector('#task-detail-subject').textContent = (task.subject_keywords ?? []).join('、') || '未设置';
  detailModal.querySelector('#task-detail-directory').textContent = task.save_directory || readMaterialPath();
  detailModal.classList.add('open'); detailModal.setAttribute('aria-hidden', 'false');
}

function closeTaskDetail() {
  const detailModal = document.querySelector('#task-detail-modal');
  detailModal?.classList.remove('open'); detailModal?.setAttribute('aria-hidden', 'true');
  detailTaskId = '';
}

async function deleteTask(task) {
  if (!window.confirm(`确定删除任务“${task.name}”？相关匹配记录也会停止关联。`)) return;
  try {
    await invokeCommand('task_delete', { taskId: task.id }, () => null);
    tasks = tasks.filter((item) => item.id !== task.id);
    writeLocalTasks(); renderTasks(); renderDashboardTask();
    notify('任务已删除。');
  } catch (error) { notify(`删除失败：${error.message ?? error}`, 'error'); }
}

const modal = document.querySelector('#task-modal');
const taskForm = document.querySelector('#task-form');
function openTaskModal(task = null) {
  if (!modal) return;
  taskForm?.reset();
  editingTaskId = task?.id ?? '';
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
    document.querySelector('#task-subject-keywords').value = (task.subject_keywords ?? []).join(', ');
    document.querySelector('#task-deadline').value = task.deadline ?? '';
    document.querySelector('#task-poll-minutes').value = String(task.poll_minutes ?? 30);
    document.querySelector('#task-ai-enabled').checked = Boolean(task.ai_enabled);
  }
  modal.classList.add('open'); modal.setAttribute('aria-hidden', 'false');
  window.setTimeout(() => document.querySelector('#task-name')?.focus(), 0);
}
function closeModal() { modal?.classList.remove('open'); modal?.setAttribute('aria-hidden', 'true'); }

function currentDateTimeLocal() {
  const date = new Date();
  date.setMinutes(date.getMinutes() - date.getTimezoneOffset());
  return date.toISOString().slice(0, 16);
}

async function saveTask(event) {
  event.preventDefault();
  const values = { name: document.querySelector('#task-name')?.value, subjectKeywords: document.querySelector('#task-subject-keywords')?.value, startTime: document.querySelector('#task-start-time')?.value, deadline: document.querySelector('#task-deadline')?.value, pollMinutes: document.querySelector('#task-poll-minutes')?.value, saveDirectory: readMaterialPath(), aiEnabled: document.querySelector('#task-ai-enabled')?.checked };
  const errors = validateTaskInput(values);
  if (Object.keys(errors).length) { notify(Object.values(errors)[0], 'error'); return; }
  const input = buildTaskInput(values);
  try {
    const saved = editingTaskId
      ? await invokeCommand('task_update', { taskId: editingTaskId, input }, () => ({ ...fallbackTaskSummary(input), ...tasks.find((task) => task.id === editingTaskId), id: editingTaskId, name: input.name, deadline: input.deadline, start_time: input.start_time, poll_minutes: input.poll_minutes, save_directory: input.save_directory, subject_keywords: input.subject_keywords, body_keywords: input.body_keywords, ai_enabled: input.ai_enabled }))
      : await invokeCommand('task_create', { input }, () => fallbackTaskSummary(input));
    const summary = saved ?? fallbackTaskSummary(input);
    tasks = editingTaskId
      ? tasks.map((task) => task.id === editingTaskId ? summary : task)
      : [summary, ...tasks.filter((task) => task.id !== summary.id)];
    writeLocalTasks(); closeModal(); renderTasks(); renderDashboardTask(); showView('tasks');
    notify(editingTaskId ? '任务已更新。' : '任务已创建，已显示在任务列表中。');
    editingTaskId = '';
  } catch (error) { notify(`保存失败：${error.message ?? error}`, 'error'); }
}

function collectMailboxValues() {
  const protocol = document.querySelector('input[name="mailbox-protocol"]:checked')?.value ?? 'IMAP';
  return { name: document.querySelector('#mailbox-name')?.value, protocol, host: document.querySelector('#mailbox-host')?.value, port: document.querySelector('#mailbox-port')?.value, username: document.querySelector('#mailbox-username')?.value, password: document.querySelector('#mailbox-password')?.value, encryption: document.querySelector('#mailbox-encryption')?.value, useProxy: document.querySelector('#mailbox-use-proxy')?.checked, proxyType: document.querySelector('#mailbox-proxy-type')?.value, proxyHost: document.querySelector('#mailbox-proxy-host')?.value, proxyPort: document.querySelector('#mailbox-proxy-port')?.value, proxyUsername: document.querySelector('#mailbox-proxy-username')?.value, proxyPassword: document.querySelector('#mailbox-proxy-password')?.value, proxyUrl: buildProxyUrl() };
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

function setMailboxStatus(state, titleText, detail) {
  const node = document.querySelector('#mailbox-status');
  if (!node) return;
  node.dataset.state = state; node.querySelector('strong').textContent = titleText; node.querySelector('span').textContent = detail;
}

async function testMailbox() {
  const values = collectMailboxValues();
  const errors = validateMailboxForm(values);
  if (Object.keys(errors).length) { setMailboxStatus('error', '配置还不完整', Object.values(errors)[0]); notify(Object.values(errors)[0], 'error'); return; }
  const config = { ...buildMailboxPayload(values), password: values.password ?? '', proxy_username: values.proxyUsername ?? '', proxy_password: values.proxyPassword ?? '' };
  setMailboxStatus('testing', '正在测试连接…', '正在检查服务器、协议和账号信息，请稍候。');
  try {
    const result = await invokeCommand('mailbox_test', { config }, () => '配置格式检查通过（浏览器预览模式未建立真实连接）');
    setMailboxStatus('success', '连接测试通过', result ?? '服务器配置有效，可以保存。'); notify('邮箱连接测试通过。');
  } catch (error) { setMailboxStatus('error', '连接测试失败', error.message ?? String(error)); notify('邮箱连接测试失败，请检查配置。', 'error'); }
}

function initMailbox() {
  let stored = null;
  try { stored = JSON.parse(localStorage.getItem(MAILBOX_STORAGE_KEY) ?? 'null'); } catch { stored = null; }
  if (stored) {
    ['name', 'host', 'port', 'username', 'encryption'].forEach((key) => { const node = document.querySelector(`#mailbox-${key}`); if (node && stored[key] != null) node.value = stored[key]; });
    const radio = document.querySelector(`input[name="mailbox-protocol"][value="${stored.protocol}"]`); if (radio) radio.checked = true;
    const proxy = stored.proxyUrl ? parseProxyUrl(stored.proxyUrl) : { type: stored.proxyType ?? 'http', host: stored.proxyHost ?? '', port: stored.proxyPort ?? '' };
    const useProxy = Boolean(stored.useProxy || stored.proxyUrl || stored.proxyHost);
    const proxyToggle = document.querySelector('#mailbox-use-proxy'); if (proxyToggle) proxyToggle.checked = useProxy;
    const proxyFields = document.querySelector('#proxy-fields'); if (proxyFields) proxyFields.hidden = !useProxy;
    [['proxy-type', proxy.type], ['proxy-host', proxy.host], ['proxy-port', proxy.port], ['proxy-username', stored.proxyUsername ?? '']].forEach(([key, value]) => { const node = document.querySelector(`#mailbox-${key}`); if (node && value != null) node.value = value; });
  }
  document.querySelectorAll('input[name="mailbox-protocol"]').forEach((radio) => radio.addEventListener('change', () => {
    const defaults = mailboxDefaults(radio.value); const port = document.querySelector('#mailbox-port'); const encryption = document.querySelector('#mailbox-encryption');
    if (port) port.value = defaults.port; if (encryption) encryption.value = defaults.encryption;
    const hint = document.querySelector('#port-hint'); if (hint) hint.textContent = `${radio.value} + SSL/TLS 通常为 ${defaults.port}`;
  }));
  document.querySelector('#toggle-mailbox-password')?.addEventListener('click', (event) => { const input = document.querySelector('#mailbox-password'); const visible = input.type === 'text'; input.type = visible ? 'password' : 'text'; event.currentTarget.textContent = visible ? '显示' : '隐藏'; event.currentTarget.setAttribute('aria-pressed', String(!visible)); });
  document.querySelector('#mailbox-use-proxy')?.addEventListener('change', (event) => { const fields = document.querySelector('#proxy-fields'); if (fields) fields.hidden = !event.currentTarget.checked; });
  document.querySelector('#mailbox-test')?.addEventListener('click', testMailbox);
  document.querySelector('#mailbox-reset')?.addEventListener('click', () => { document.querySelector('#mailbox-form')?.reset(); const fields = document.querySelector('#proxy-fields'); if (fields) fields.hidden = true; setMailboxStatus('idle', '尚未测试连接', '保存前建议先测试一次，确认服务器和账号可以正常访问。'); });
  document.querySelector('#mailbox-form')?.addEventListener('submit', async (event) => { event.preventDefault(); const values = collectMailboxValues(); const errors = validateMailboxForm(values); if (Object.keys(errors).length) { notify(Object.values(errors)[0], 'error'); return; } localStorage.setItem(MAILBOX_STORAGE_KEY, JSON.stringify(buildMailboxStorage(values))); try { await invokeCommand('mailbox_credentials_save', { username: values.username, password: values.password, proxyUsername: values.proxyUsername ?? '', proxyPassword: values.proxyPassword ?? '' }, () => null); } catch (error) { notify(`邮箱配置已保存，但凭据保存失败：${error.message ?? error}`, 'error'); return; } notify('邮箱配置已保存，代理类型、地址、端口和账号会在下次打开时恢复；密码由 Windows 凭据管理器保存。'); });
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
  return rows.flatMap((row) => row.emails.map((email) => ({ company_name: row.name, contact_name: row.contactName ?? '', email })));
}

function readCompanyRows() {
  try {
    const stored = JSON.parse(localStorage.getItem('unigather.companies.v1') ?? '[]');
    return Array.isArray(stored) ? stored : [];
  } catch { return []; }
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
  heading.querySelector('h3').textContent = `${companyRows.length} 行单位联系人`;
  panel.append(heading);
  const table = document.createElement('table');
  table.className = 'company-table';
  table.innerHTML = '<thead><tr><th>单位名称</th><th>姓名</th><th>邮箱</th><th>操作</th></tr></thead>';
  const body = document.createElement('tbody');
  companyRows.forEach((row, index) => {
    const tr = document.createElement('tr');
    tr.dataset.index = String(index);
    const name = document.createElement('input'); name.className = 'table-input'; name.value = row.name ?? ''; name.dataset.field = 'name';
    const contact = document.createElement('input'); contact.className = 'table-input'; contact.value = row.contactName ?? ''; contact.dataset.field = 'contactName'; contact.placeholder = '未填写';
    const emails = document.createElement('input'); emails.className = 'table-input'; emails.value = (row.emails ?? []).join('; '); emails.dataset.field = 'emails';
    const action = document.createElement('button'); action.className = 'ghost-button table-save'; action.type = 'button'; action.textContent = '保存'; action.addEventListener('click', () => saveCompanyRow(index, tr));
    [name, contact, emails].forEach((input) => { const cell = document.createElement('td'); cell.append(input); tr.append(cell); });
    const actionCell = document.createElement('td'); actionCell.append(action); tr.append(actionCell);
    body.append(tr);
  });
  table.append(body); panel.append(table);
}

async function saveCompanyRow(index, rowElement) {
  const values = Object.fromEntries([...rowElement.querySelectorAll('[data-field]')].map((input) => [input.dataset.field, input.value.trim()]));
  const emails = String(values.emails ?? '').split(/[;,，；\s]+/).map((email) => email.trim()).filter(Boolean);
  if (!values.name) { notify('单位名称不能为空。', 'error'); return; }
  if (!emails.length) { notify('至少填写一个邮箱。', 'error'); return; }
  const previous = companyRows[index];
  const updated = { name: values.name, contactName: values.contactName ?? '', emails };
  companyRows[index] = updated;
  localStorage.setItem('unigather.companies.v1', JSON.stringify(companyRows));
  try {
    await invokeCommand('company_import', { rows: companyRowsForImport([updated]) }, () => emails.length);
    renderCompanyRows();
    notify(`已保存“${updated.name}”这一行。`);
  } catch (error) {
    companyRows[index] = previous;
    localStorage.setItem('unigather.companies.v1', JSON.stringify(companyRows));
    notify(`保存失败：${error.message ?? error}`, 'error');
  }
}

function initCompanyImport() {
  const fileInput = document.querySelector('#company-file');
  companyRows = readCompanyRows();
  renderCompanyRows();
  document.querySelector('#import-companies')?.addEventListener('click', () => fileInput?.click());
  document.querySelector('#download-company-template')?.addEventListener('click', () => {
    const workbook = XLSX.utils.book_new();
    const worksheet = XLSX.utils.aoa_to_sheet([['单位名称', '姓名', '邮箱'], ['示例单位', '张三', 'mail@example.com']]);
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
      companyRows = rows;
      localStorage.setItem('unigather.companies.v1', JSON.stringify(rows));
      renderCompanyRows();
      try { await invokeCommand('company_import', { rows: companyRowsForImport(rows) }, () => rows.length); } catch (error) { notify(`本地已导入，但数据库保存失败：${error.message ?? error}`, 'error'); return; }
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
      const item = document.createElement('button'); item.type = 'button'; item.className = `mail-attachment${attachment.savedPath ? ' mail-attachment-openable' : ''}`;
      const icon = document.createElement('span'); icon.textContent = attachment.name.toLowerCase().endsWith('xlsx') ? '▣' : '▤';
      const name = document.createElement('span'); name.textContent = attachment.name || '未命名附件';
      const status = document.createElement('small'); status.textContent = attachment.savedPath ? (attachment.parseStatus === 'archive_only' ? '已归档 · 点击打开' : '点击打开') : '未归档';
      item.append(icon, name, status); list.append(item);
      if (attachment.savedPath) item.addEventListener('click', async () => {
        try { await invokeCommand('material_open', { path: attachment.savedPath }); }
        catch (error) { notify(`无法打开附件：${error.message ?? error}`, 'error'); }
      });
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
  document.querySelector('#refresh-inbox')?.addEventListener('click', () => { void loadInbox(); });
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
  const errors = validateMailboxForm(values);
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
    const active = tasks.find((task) => task.status === 'active');
    const mailbox = { ...buildMailboxPayload(values), password: values.password ?? '', proxy_username: values.proxyUsername ?? '', proxy_password: values.proxyPassword ?? '' };
    const initial = await invokeCommand('sync_start', { taskId: active?.id ?? '', mailbox, since }, (error) => { throw new Error(`当前不是可用的 Tauri 桌面运行环境：${error?.message ?? error}`); });
    activeSyncRunId = initial?.runId ?? initial?.run_id ?? '';
    if (!activeSyncRunId) throw new Error('收件任务未返回运行编号');
    await pollInboxSync({ button, progressPanel, progressBar, progressText, progressCount });
  } catch (error) {
    notify(`收件失败：${error.message ?? error}`, 'error');
    activeSyncRunId = '';
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
document.querySelector('#sync-now')?.addEventListener('click', () => { showView('inbox'); void runInboxSync(); });
document.querySelector('#new-task')?.addEventListener('click', openTaskModal);
document.querySelector('#new-task-2')?.addEventListener('click', openTaskModal);
document.querySelectorAll('[data-open-task]').forEach((button) => button.addEventListener('click', openTaskModal));
document.querySelectorAll('[data-close-modal]').forEach((button) => button.addEventListener('click', closeModal));
document.querySelectorAll('[data-close-task-detail]').forEach((button) => button.addEventListener('click', closeTaskDetail));
document.querySelector('#edit-task-detail')?.addEventListener('click', () => {
  const task = tasks.find((item) => item.id === detailTaskId);
  closeTaskDetail();
  if (task) openTaskModal(task);
});
taskForm?.addEventListener('submit', saveTask);
document.querySelector('#add-mailbox')?.addEventListener('click', () => { showView('mailboxes'); document.querySelector('#mailbox-name')?.focus(); });

initMailbox();
initCompanyImport();
initInbox();
initMaterialsAndSettings();
loadTasks();
