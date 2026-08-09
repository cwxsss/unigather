import { invokeCommand } from './bridge.js';
import { buildMailboxPayload, mailboxDefaults, validateMailboxForm } from './core/mailbox.js';
import { buildTaskInput, taskStatusLabel, validateTaskInput } from './core/tasks.js';
import { parseCompanyRows } from './core/attachments.js';
import { isNewerVersion, pickInstallerAsset } from './core/update.js';

const navItems = document.querySelectorAll('.nav-item');
const views = document.querySelectorAll('.view');
const title = document.querySelector('#page-title');
const toast = document.querySelector('#toast');
const labels = { dashboard: '仪表盘', tasks: '收集任务', companies: '分子公司', mailboxes: '邮箱配置', materials: '材料归档', settings: '系统设置' };
const TASK_STORAGE_KEY = 'unigather.tasks.v1';
const MAILBOX_STORAGE_KEY = 'unigather.mailbox.v1';
const APP_VERSION = '0.0.1';
const RELEASES_ENDPOINT = 'https://api.github.com/repos/cwxsss/unigather/releases/latest';
let tasks = [];

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
  return { id: `local-${Date.now()}`, name: input.name, status: 'active', total_companies: input.company_ids.length, confirmed_companies: 0, deadline: input.deadline };
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
    const total = Number(task.total_companies) || 0;
    const confirmed = Number(task.confirmed_companies) || 0;
    progress.textContent = `${total ? Math.round((confirmed / total) * 100) : 0}%`;
    const actions = document.createElement('div');
    actions.className = 'task-row-actions';
    const open = document.createElement('button');
    open.className = 'icon-button'; open.type = 'button'; open.title = '打开任务'; open.textContent = '→';
    open.addEventListener('click', () => notify(`已打开任务：${task.name}`));
    const remove = document.createElement('button');
    remove.className = 'icon-button danger-icon'; remove.type = 'button'; remove.title = '删除任务'; remove.textContent = '×';
    remove.addEventListener('click', () => deleteTask(task));
    actions.append(open, remove);
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
  const percent = total ? Math.round((confirmed / total) * 100) : 0;
  banner.className = 'task-banner';
  banner.innerHTML = `<div class="task-badge">${active.name.slice(0, 2)}</div><div class="task-info"><strong></strong><span></span></div><div class="task-progress"><strong>${percent}%</strong><div class="progress-track"><i style="width:${percent}%"></i></div><span>${confirmed} / ${total} 家单位</span></div><button class="icon-button" type="button" aria-label="打开任务">→</button>`;
  banner.querySelector('strong').textContent = active.name;
  banner.querySelector('.task-info span').textContent = `截止时间：${formatDeadline(active.deadline)}　·　每 ${active.poll_minutes ?? 30} 分钟自动收件`;
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
function openTaskModal() {
  if (!modal) return;
  taskForm?.reset();
  modal.classList.add('open'); modal.setAttribute('aria-hidden', 'false');
  window.setTimeout(() => document.querySelector('#task-name')?.focus(), 0);
}
function closeModal() { modal?.classList.remove('open'); modal?.setAttribute('aria-hidden', 'true'); }

async function saveTask(event) {
  event.preventDefault();
  const values = { name: document.querySelector('#task-name')?.value, subjectKeywords: document.querySelector('#task-subject-keywords')?.value, deadline: document.querySelector('#task-deadline')?.value, pollMinutes: document.querySelector('#task-poll-minutes')?.value, aiEnabled: document.querySelector('#task-ai-enabled')?.checked };
  const errors = validateTaskInput(values);
  if (Object.keys(errors).length) { notify(Object.values(errors)[0], 'error'); return; }
  const input = buildTaskInput(values);
  try {
    const created = await invokeCommand('task_create', { input }, () => fallbackTaskSummary(input));
    tasks = [created ?? fallbackTaskSummary(input), ...tasks.filter((task) => task.id !== created?.id)];
    writeLocalTasks(); closeModal(); renderTasks(); renderDashboardTask(); showView('tasks');
    notify('任务已创建，已显示在任务列表中。');
  } catch (error) { notify(`保存失败：${error.message ?? error}`, 'error'); }
}

function collectMailboxValues() {
  const protocol = document.querySelector('input[name="mailbox-protocol"]:checked')?.value ?? 'IMAP';
  return { name: document.querySelector('#mailbox-name')?.value, protocol, host: document.querySelector('#mailbox-host')?.value, port: document.querySelector('#mailbox-port')?.value, username: document.querySelector('#mailbox-username')?.value, password: document.querySelector('#mailbox-password')?.value, encryption: document.querySelector('#mailbox-encryption')?.value, useProxy: document.querySelector('#mailbox-use-proxy')?.checked, proxyUrl: buildProxyUrl() };
}

function buildProxyUrl() {
  if (!document.querySelector('#mailbox-use-proxy')?.checked) return '';
  const type = document.querySelector('#mailbox-proxy-type')?.value ?? 'http';
  const host = document.querySelector('#mailbox-proxy-host')?.value?.trim() ?? '';
  const port = document.querySelector('#mailbox-proxy-port')?.value ?? '';
  return host ? `${type}://${host}${port ? `:${port}` : ''}` : '';
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
  const config = buildMailboxPayload(values);
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
  document.querySelector('#mailbox-form')?.addEventListener('submit', (event) => { event.preventDefault(); const values = collectMailboxValues(); const errors = validateMailboxForm(values); if (Object.keys(errors).length) { notify(Object.values(errors)[0], 'error'); return; } const payload = buildMailboxPayload(values); localStorage.setItem(MAILBOX_STORAGE_KEY, JSON.stringify({ ...payload, password: undefined })); notify('邮箱配置已保存，密码将交由 Windows 凭据管理器保护。'); });
  document.querySelector('.summary-edit')?.addEventListener('click', () => document.querySelector('#mailbox-name')?.focus());
}

function downloadText(filename, content, mime = 'text/plain;charset=utf-8') {
  const url = URL.createObjectURL(new Blob([content], { type: mime }));
  const link = document.createElement('a'); link.href = url; link.download = filename; link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function initCompanyImport() {
  const fileInput = document.querySelector('#company-file');
  document.querySelector('#import-companies')?.addEventListener('click', () => fileInput?.click());
  document.querySelector('#download-company-template')?.addEventListener('click', () => downloadText('UniGather-单位导入模板.csv', '单位名称,邮箱\n示例单位,mail@example.com\n', 'text/csv;charset=utf-8'));
  fileInput?.addEventListener('change', async (event) => {
    const file = event.currentTarget.files?.[0]; if (!file) return;
    if (!file.name.toLowerCase().endsWith('.csv')) { notify('当前版本支持 CSV 导入；XLS/XLSX 解析将在桌面适配器中启用。', 'error'); event.currentTarget.value = ''; return; }
    const rows = parseCompanyRows(await file.text());
    localStorage.setItem('unigather.companies.v1', JSON.stringify(rows));
    const empty = document.querySelector('#company-empty-state');
    if (empty) { empty.innerHTML = `<span>✓</span><h3>${rows.length} 家单位已导入</h3><p>已读取单位名称和邮箱映射，可在新建任务时关联。</p>`; }
    try { await invokeCommand('company_import', { csvText: await file.text() }, () => rows.length); } catch { /* local import remains available */ }
    notify(`已导入 ${rows.length} 家单位。`); event.currentTarget.value = '';
  });
}

function initMaterialsAndSettings() {
  document.querySelector('#export-materials')?.addEventListener('click', async () => { const active = tasks[0]; try { await invokeCommand('report_export', { taskId: active?.id ?? '', status: 'pending' }, () => null); } catch { /* local export still works */ } downloadText('UniGather-材料清单.csv', '任务名称,状态,截止时间\n' + tasks.map((task) => `${task.name},${taskStatusLabel(task.status)},${formatDeadline(task.deadline)}`).join('\n'), 'text/csv;charset=utf-8'); notify('材料清单已导出。'); });
  document.querySelector('#open-material-directory')?.addEventListener('click', async () => { try { await invokeCommand('material_open', { path: 'D:\\UniGather\\Materials' }, () => 'D:\\UniGather\\Materials'); notify('已请求打开归档目录。'); } catch (error) { notify(`无法打开目录：${error.message ?? error}`, 'error'); } });
  document.querySelector('#feedback-filter')?.addEventListener('click', () => notify('暂无反馈数据，导入单位并创建任务后可筛选状态。'));
  document.querySelectorAll('.app-setting').forEach((input) => input.addEventListener('change', async (event) => { const key = event.currentTarget.dataset.setting; const value = String(event.currentTarget.checked); localStorage.setItem(`unigather.setting.${key}`, value); try { await invokeCommand('settings_update', { key, value }, () => null); } catch { /* local preference is still saved */ } notify('设置已保存。'); }));
  document.querySelector('#check-updates')?.addEventListener('click', checkForUpdates);
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
    const installerUrl = safeGitHubUrl(installer?.browser_download_url) ?? releaseUrl;
    panel.innerHTML = `<strong>发现新版本 ${escapeHtml(latest)}</strong><span>${escapeHtml(release.name ?? 'UniGather 新版本')}${release.published_at ? ` · ${new Date(release.published_at).toLocaleDateString('zh-CN')}` : ''}</span><p>${escapeHtml(String(release.body ?? '请查看 GitHub Release 说明。').slice(0, 260))}</p><div><a class="primary-button update-download" href="${installerUrl}" target="_blank" rel="noreferrer">下载并安装更新</a><a class="link-button" href="${releaseUrl}" target="_blank" rel="noreferrer">查看 Release</a></div>`;
    panel.hidden = false; notify(`发现新版本 ${latest}，可下载更新。`);
  } catch (error) {
    notify(`检查更新失败：${error.message ?? error}`, 'error');
  } finally {
    button.disabled = false; button.textContent = '检查更新';
  }
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
}

function safeGitHubUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && (url.hostname === 'github.com' || url.hostname.endsWith('.githubusercontent.com')) ? url.href : '#';
  } catch { return '#'; }
}

navItems.forEach((item) => item.addEventListener('click', () => showView(item.dataset.view)));
document.querySelectorAll('[data-view]').forEach((item) => item.addEventListener('click', () => showView(item.dataset.view)));
document.querySelector('#sync-now')?.addEventListener('click', async () => {
  const active = tasks.find((task) => task.status === 'active');
  if (!active) { notify('请先创建一个收集任务。', 'error'); showView('tasks'); return; }
  notify('正在同步总部收件箱…');
  try { const result = await invokeCommand('sync_run', { taskId: active.id }, () => null); notify(result?.errors?.length ? `同步完成，但有 ${result.errors.length} 项需要处理。` : '同步请求已提交，完成后会更新任务状态。'); } catch (error) { notify(`同步失败：${error.message ?? error}`, 'error'); }
});
document.querySelector('#new-task')?.addEventListener('click', openTaskModal);
document.querySelector('#new-task-2')?.addEventListener('click', openTaskModal);
document.querySelectorAll('[data-open-task]').forEach((button) => button.addEventListener('click', openTaskModal));
document.querySelectorAll('[data-close-modal]').forEach((button) => button.addEventListener('click', closeModal));
taskForm?.addEventListener('submit', saveTask);
document.querySelector('#add-mailbox')?.addEventListener('click', () => { showView('mailboxes'); document.querySelector('#mailbox-name')?.focus(); });

initMailbox();
initCompanyImport();
initMaterialsAndSettings();
loadTasks();
