import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { matchMessageToTask } from '../src/core/matching.js';
import { buildAttachmentName } from '../src/core/filename.js';
import { getFeedbackStatus } from '../src/core/status.js';
import { classifyAttachment, buildAiPayload, decodeCsvBuffer, parseCompanyRows, parseCompanyMatrix } from '../src/core/attachments.js';
import { mailboxDefaults, validateMailboxForm, validateMailboxSave, buildMailboxPayload, buildMailboxStorage } from '../src/core/mailbox.js';
import { splitKeywords, validateTaskInput, buildTaskInput, taskProgressPercent, taskStatusLabel, normalizeFeedbackPage, nextFeedbackPage } from '../src/core/tasks.js';
import { normalizeVersion, isNewerVersion, pickInstallerAsset, formatDownloadProgress } from '../src/core/update.js';
import { DEFAULT_MATERIAL_PATH, normalizeMaterialPath } from '../src/core/materials.js';
import { filterInboxMessages, normalizeInboxMessage, sortInboxMessages } from '../src/core/inbox.js';
import { defaultInboxStartTime, normalizeInboxStartTime } from '../src/core/sync.js';
import { DEFAULT_AI_ENDPOINT, normalizeAiConfig, validateAiConfig } from '../src/core/ai.js';
import { syncProgressPercent, syncProgressLabel } from '../src/core/sync-progress.js';
import { normalizeCompanyOptions, filterCompanyOptions, toggleAllCompanyIds, validateCompanySelection } from '../src/core/company-selection.js';
import { formatCompanyOptionMeta, buildTimePresetRange, validateTimeRange } from '../src/core/task-form-ui.js';
import { isWithinSyncWindow, matchMessageToCompanyTask, normalizeSyncEnd } from '../src/core/task-sync.js';
import { getTaskSchedule, formatTaskScheduleTime, formatTaskScheduleCountdown, shouldRunInitialTaskSync } from '../src/core/task-schedule.js';
import { buildSendPayload, formatSendProgress, normalizeSendTargets, validateSendForm } from '../src/core/send.js';
import { buildSendBatchItems, composeSendBody, groupSendBatchItems, parseBatchCc, sendItemStatusMeta, validateSendBatch, validateBatchPersistence } from '../src/core/send-workbench.js';
import { normalizeDashboardSummary } from '../src/core/dashboard.js';
import { buildPendingFeedbackExportRows, normalizePendingFeedbackCompanies, pendingFeedbackStatusLabel } from '../src/core/pending-feedback.js';
import { drilldownItems, paginateTaskMatches } from '../src/core/task-feedback.js';

test('matches sender mapping and fuzzy subject rule', () => {
  const result = matchMessageToTask({
    sender: 'finance@northbridge.com',
    subject: '关于2026年度财务报表反馈',
    body: '请查收附件',
  }, {
    subjectKeywords: ['财务报表'],
    bodyKeywords: [],
    companyEmails: ['finance@northbridge.com'],
  });

  assert.deepEqual(result, { status: 'confirmed', reason: 'sender_and_subject' });
});

test('matches configured keywords in the email body', () => {
  const matched = matchMessageToTask({
    sender: 'finance@northbridge.com',
    subject: '关于2026年度材料反馈',
    body: '附件已提交，请查收。',
  }, {
    subjectKeywords: ['材料'],
    bodyKeywords: ['已提交'],
    companyEmails: ['finance@northbridge.com'],
  });
  assert.deepEqual(matched, { status: 'confirmed', reason: 'sender_and_subject' });

  const unmatched = matchMessageToTask({
    sender: 'finance@northbridge.com',
    subject: '关于2026年度材料反馈',
    body: '正在整理中。',
  }, {
    subjectKeywords: ['材料'],
    bodyKeywords: ['已提交'],
    companyEmails: ['finance@northbridge.com'],
  });
  assert.deepEqual(unmatched, { status: 'unmatched', taskIds: [] });
});

test('reports body-only matching when the subject rule is blank', () => {
  assert.deepEqual(matchMessageToTask({ sender: 'unit@example.com', subject: '反馈', body: '已提交材料' }, {
    subjectKeywords: [], bodyKeywords: ['已提交'], companyEmails: ['unit@example.com'],
  }), { status: 'confirmed', reason: 'sender_and_body' });
});

test('routes ambiguous task matches to manual review', () => {
  const result = matchMessageToTask({
    sender: 'unit@example.com',
    subject: '季度材料',
    body: '季度材料已提交',
  }, [
    { id: 'task-a', subjectKeywords: ['季度'], bodyKeywords: [], companyEmails: ['unit@example.com'] },
    { id: 'task-b', subjectKeywords: ['材料'], bodyKeywords: [], companyEmails: ['unit@example.com'] },
  ]);

  assert.equal(result.status, 'needs_review');
  assert.deepEqual(result.taskIds, ['task-a', 'task-b']);
});

test('builds a safe attachment name without overwriting duplicates', () => {
  assert.equal(
    buildAttachmentName('季度收集', '北桥公司', '财务报表.xlsx', new Set()),
    '季度收集_北桥公司_财务报表.xlsx',
  );
  assert.equal(
    buildAttachmentName('季度收集', '北桥公司', '财务报表.xlsx', new Set(['季度收集_北桥公司_财务报表.xlsx'])),
    '季度收集_北桥公司_财务报表_1.xlsx',
  );
});

test('marks due and overdue units from deadline and feedback state', () => {
  const now = new Date('2026-08-09T12:00:00Z');
  assert.equal(getFeedbackStatus({ confirmed: true, deadline: '2026-08-01T00:00:00Z' }, now), 'confirmed');
  assert.equal(getFeedbackStatus({ confirmed: false, deadline: '2026-08-09T10:00:00Z' }, now), 'overdue');
  assert.equal(getFeedbackStatus({ confirmed: false, deadline: '2026-08-09T15:00:00Z' }, now), 'due_soon');
  assert.equal(getFeedbackStatus({ confirmed: false, deadline: '2026-08-20T15:00:00Z' }, now), 'pending');
});

test('classifies supported text attachments and flags scans for manual handling', () => {
  assert.equal(classifyAttachment('经营报告.pdf', 'application/pdf').parseMode, 'text');
  assert.equal(classifyAttachment('经营报告.xlsx').parseMode, 'spreadsheet');
  assert.equal(classifyAttachment('扫描件.png', 'image/png').parseMode, 'archive_only');
});

test('builds an AI payload without attachment contents', () => {
  const payload = buildAiPayload({ subject: '季度材料', body: '请查收', attachments: [{ name: 'a.pdf', text: '机密内容' }] });
  assert.deepEqual(payload, { subject: '季度材料', body: '请查收', attachmentNames: ['a.pdf'] });
  assert.equal('text' in payload, false);
});

test('imports company email mappings from CSV-shaped rows', () => {
  assert.deepEqual(parseCompanyRows('单位名称,姓名,邮箱\n北桥公司,张三,a@example.com; b@example.com\n华东中心,李四,c@example.com'), [
    { name: '北桥公司', contactName: '张三', emails: ['a@example.com', 'b@example.com'], phone: '', aliases: [] },
    { name: '华东中心', contactName: '李四', emails: ['c@example.com'], phone: '', aliases: [] },
  ]);
});

test('imports company names from an Excel-like worksheet matrix', () => {
  assert.deepEqual(parseCompanyMatrix([
    ['单位名称', '姓名', '邮箱'],
    ['北桥公司', '张三', 'a@example.com'],
    ['华东中心', '李四', 'c@example.com'],
  ]), [
    { name: '北桥公司', contactName: '张三', emails: ['a@example.com'], phone: '', aliases: [] },
    { name: '华东中心', contactName: '李四', emails: ['c@example.com'], phone: '', aliases: [] },
  ]);
});

test('decodes legacy GBK CSV files before parsing Chinese headers', () => {
  const bytes = Uint8Array.from([0xB5, 0xA5, 0xCE, 0xBB, 0xC3, 0xFB, 0x2C, 0xD3, 0xCA, 0xCF, 0xE4, 0x0D, 0x0A, 0xB1, 0xB1, 0xC7, 0xC5, 0x2C, 0x61, 0x40, 0x62, 0x2E, 0x63, 0x6F, 0x6D]);
  assert.equal(decodeCsvBuffer(bytes.buffer), '单位名,邮箱\r\n北桥,a@b.com');
});

test('keeps a usable local material path when the setting is blank', () => {
  assert.equal(normalizeMaterialPath('  D:\\Reports\\Materials  '), 'D:\\Reports\\Materials');
  assert.equal(normalizeMaterialPath(''), DEFAULT_MATERIAL_PATH);
});

test('normalizes inbox messages for list and detail views', () => {
  const message = normalizeInboxMessage({ id: 'm-1', sender: '张三 <zhangsan@example.com>', recipients: '["总部"]', cc: '抄送@example.com', subject: '季度材料', body: '请查收附件', received_at: '2026-08-09T09:00:00Z', attachments: [{ original_name: '材料.xlsx', parse_status: 'pending' }] });
  assert.deepEqual(message, {
    id: 'm-1', sender: '张三 <zhangsan@example.com>', subject: '季度材料', body: '请查收附件', receivedAt: '2026-08-09T09:00:00Z', recipients: ['总部'], cc: ['抄送@example.com'], attachments: [{ name: '材料.xlsx', mimeType: '', savedPath: '', parseStatus: 'pending' }],
  });
});

test('sorts inbox messages newest first', () => {
  const sorted = sortInboxMessages([{ id: 'old', received_at: '2026-08-08T09:00:00Z' }, { id: 'new', received_at: '2026-08-09T09:00:00Z' }]);
  assert.deepEqual(sorted.map((message) => message.id), ['new', 'old']);
});

test('filters inbox messages by sender, subject and body text', () => {
  const messages = [
    { id: 'm-1', sender: '张三 <zhangsan@example.com>', subject: '季度材料', body: '请查收附件' },
    { id: 'm-2', sender: '李四 <lisi@example.com>', subject: '审计整改', body: '整改说明见附件' },
  ];
  assert.deepEqual(filterInboxMessages(messages, '张三').map((message) => message.id), ['m-1']);
  assert.deepEqual(filterInboxMessages(messages, '整改').map((message) => message.id), ['m-2']);
});

test('defaults direct inbox sync to the previous seven days and preserves a custom start time', () => {
  const now = new Date('2026-08-09T12:00:00+08:00');
  assert.equal(defaultInboxStartTime(now), '2026-08-02T12:00');
  assert.equal(normalizeInboxStartTime('', now), '2026-08-02T12:00');
  assert.equal(normalizeInboxStartTime('2026-07-01T09:30', now), '2026-07-01T09:30');
});

test('calculates live inbox sync progress from processed messages', () => {
  assert.equal(syncProgressPercent({ status: 'running', total: 4, processed: 1 }), 25);
  assert.equal(syncProgressPercent({ status: 'running', total: 0, processed: 0 }), 5);
  assert.equal(syncProgressPercent({ status: 'completed', total: 4, processed: 4 }), 100);
  assert.equal(syncProgressLabel({ status: 'running', message: '正在保存第 2 封邮件' }), '正在保存第 2 封邮件');
});

test('normalizes and validates AI configuration without requiring an API key for disabled mode', () => {
  assert.equal(DEFAULT_AI_ENDPOINT, 'https://api.openai.com/v1');
  assert.deepEqual(validateAiConfig({ enabled: true, endpoint: '', model: '', apiKey: '' }), {
    endpoint: '请输入 AI API 地址', model: '请输入 AI 模型名称', apiKey: '启用 AI 后请输入 API Key',
  });
  assert.deepEqual(normalizeAiConfig({ enabled: false, endpoint: '', model: '', apiKey: 'secret' }), {
    enabled: false, endpoint: DEFAULT_AI_ENDPOINT, model: 'gpt-4o-mini', apiKey: 'secret',
  });
});

test('uses safe protocol defaults for mailbox connection fields', () => {
  assert.deepEqual(mailboxDefaults('IMAP'), { port: 993, encryption: 'SSL/TLS' });
  assert.deepEqual(mailboxDefaults('POP3'), { port: 995, encryption: 'SSL/TLS' });
});

test('validates mailbox form and keeps password out of the payload', () => {
  assert.deepEqual(validateMailboxForm({ protocol: 'IMAP', host: '', port: 70000, username: '', password: '' }), {
    host: '请输入收件服务器地址',
    username: '请输入收件账号',
    password: '请输入账号密码',
    port: '请输入 1-65535 的端口',
  });
  const payload = buildMailboxPayload({ name: '总部', protocol: 'IMAP', host: 'imap.example.com', port: '993', username: 'admin@example.com', password: 'secret', encryption: 'SSL/TLS', useProxy: false });
  assert.equal(payload.password, undefined);
  assert.equal(payload.password_key, 'admin@example.com');
  assert.equal(payload.proxy_url, '');
  assert.deepEqual(buildMailboxStorage({ name: '总部', protocol: 'IMAP', host: 'imap.example.com', port: '993', username: 'admin@example.com', password: 'secret', encryption: 'SSL/TLS', useProxy: true, proxyType: 'socks5', proxyHost: '127.0.0.1', proxyPort: '7890', proxyUsername: 'proxy-user', proxyPassword: 'proxy-secret', proxyUrl: 'socks5://127.0.0.1:7890' }), {
    name: '总部', protocol: 'IMAP', host: 'imap.example.com', port: 993, username: 'admin@example.com', password_key: 'admin@example.com', encryption: 'SSL/TLS', smtp_host: '', smtp_port: 465, smtp_encryption: 'SSL/TLS', smtp_sender_name: '', useProxy: true, proxyType: 'socks5', proxyHost: '127.0.0.1', proxyPort: 7890, proxyUsername: 'proxy-user', smtpHost: '', smtpPort: 465, smtpEncryption: 'SSL/TLS', smtpSenderName: '', proxyUrl: 'socks5://127.0.0.1:7890', enabled: true,
  });
});

test('builds a normalized task payload from the create form', () => {
  assert.deepEqual(splitKeywords('季度材料，经营分析\n财务'), ['季度材料', '经营分析', '财务']);
  assert.deepEqual(validateTaskInput({ name: '', deadline: '' }), { name: '请输入任务名称', deadline: '请选择截止时间' });
  assert.deepEqual(buildTaskInput({ name: ' Q3 材料 ', subjectKeywords: '季度,材料', bodyKeywords: '已提交，附件', deadline: '2026-08-15T18:00', pollMinutes: '60', aiEnabled: true }), {
    name: 'Q3 材料', material_name: 'Q3 材料', company_ids: [], subject_keywords: ['季度', '材料'], body_keywords: ['已提交', '附件'], deadline: '2026-08-15T18:00', start_time: '', poll_minutes: 60, save_directory: 'D:\\UniGather\\Materials', filename_template: '{task}_{company}_{filename}', ai_enabled: true,
  });
  assert.deepEqual(buildTaskInput({ name: '补查任务', startTime: '2026-08-01T09:00', deadline: '2026-08-15T18:00' }).start_time, '2026-08-01T09:00');
  assert.equal(validateTaskInput({ name: '任务', startTime: '2026-08-16T09:00', deadline: '2026-08-15T18:00' }).startTime, '起始时间不能晚于截止时间');
  assert.equal(taskStatusLabel('paused'), '已中断');
});

test('defaults the task material name to the task name and preserves a custom name', () => {
  assert.equal(buildTaskInput({ name: '2026报名表', deadline: '2026-08-20T18:00' }).material_name, '2026报名表');
  assert.equal(buildTaskInput({ name: '2026报名表', materialName: '数据安全报名表', deadline: '2026-08-20T18:00' }).material_name, '数据安全报名表');
});

test('calculates task progress for the task detail view', () => {
  assert.equal(taskProgressPercent({ total_companies: 10, confirmed_companies: 3 }), 30);
  assert.equal(taskProgressPercent({ total_companies: 0, confirmed_companies: 0 }), 0);
});

test('normalizes feedback paging and resets page on a filter change', () => {
  assert.deepEqual(normalizeFeedbackPage({ page: 0, pageSize: 99, total: 51 }), { page: 1, pageSize: 20, pageCount: 3 });
  assert.equal(nextFeedbackPage({ page: 3, pageCount: 3 }, 'next'), 3);
  assert.equal(nextFeedbackPage({ page: 2, pageCount: 3 }, 'filter-change'), 1);
});

test('builds export rows for every task company that has not confirmed feedback', () => {
  const rows = buildPendingFeedbackExportRows({ name: '报名表', deadline: '2026-08-20T18:00' }, [
    { companyName: '陕西省分公司', feedbackStatus: 'pending', contacts: [{ contactName: '张三', email: 'zhang@example.com', phone: '010-1' }] },
    { companyName: '北京分公司', feedbackStatus: 'needs_review', contacts: [{ contactName: '李四', email: 'li@example.com', phone: '' }] },
    { companyName: '总部', feedbackStatus: 'confirmed', contacts: [{ contactName: '王五', email: 'wang@example.com', phone: '' }] },
  ]);
  assert.deepEqual(normalizePendingFeedbackCompanies([{ companyName: '总部', feedbackStatus: 'confirmed' }, { companyName: '陕西省分公司', feedbackStatus: 'pending' }]).map((item) => item.companyName), ['陕西省分公司']);
  assert.deepEqual(rows, [
    { 序号: 1, 任务名称: '报名表', 单位名称: '陕西省分公司', 反馈状态: '待反馈', 联系人: '张三', 邮箱: 'zhang@example.com', 电话: '010-1', 截止时间: '2026-08-20T18:00' },
    { 序号: 2, 任务名称: '报名表', 单位名称: '北京分公司', 反馈状态: '待确认', 联系人: '李四', 邮箱: 'li@example.com', 电话: '', 截止时间: '2026-08-20T18:00' },
  ]);
});

test('paginates task match mail and filters drilldown views by feedback state', () => {
  const messages = Array.from({ length: 31 }, (_, index) => ({ id: `m-${index + 1}`, status: index < 2 ? 'confirmed' : index < 4 ? 'needs_review' : 'unmatched' }));
  assert.deepEqual(paginateTaskMatches(messages, 3, 20), { items: messages.slice(20), page: 2, pageSize: 20, total: 31, pageCount: 2 });
  assert.deepEqual(drilldownItems('unmatched', messages, []).map((item) => item.id), messages.slice(4).map((item) => item.id));
  assert.deepEqual(drilldownItems('confirmed', messages, [{ companyName: '陕西', feedbackStatus: 'confirmed' }, { companyName: '北京', feedbackStatus: 'pending' }]).map((item) => item.companyName), ['陕西']);
});

test('labels confirmed feedback distinctly from pending feedback', () => {
  assert.equal(pendingFeedbackStatusLabel('confirmed'), '已反馈');
  assert.equal(pendingFeedbackStatusLabel('pending'), '待反馈');
  assert.equal(pendingFeedbackStatusLabel('needs_review'), '待确认');
});

test('normalizes the global dashboard summary without mixing task progress', () => {
  assert.deepEqual(normalizeDashboardSummary({ collectionTaskCount: 4, activeCollectionTasks: 2, sendBatchCount: 3, todayReceived: 11, todaySentSuccess: 8, todaySentFailure: 1 }), {
    collectionTaskCount: 4, activeCollectionTasks: 2, sendBatchCount: 3, todayReceived: 11, todaySentSuccess: 8, todaySentFailure: 1, latestReceiveStatus: '暂无收件记录', recentEvents: [],
  });
});

test('includes global dashboard, task feedback and material naming controls', () => {
  const html = readFileSync(new URL('../src/index.html', import.meta.url), 'utf8');
  const taskOverrides = readFileSync(new URL('../src/task-overrides.css', import.meta.url), 'utf8');
  for (const id of ['dashboard-collection-count', 'dashboard-send-batch-count', 'dashboard-received-today', 'dashboard-sent-today', 'dashboard-workspaces', 'dashboard-activity', 'task-summary-grid', 'task-completed-count', 'task-deleted-count', 'task-management-modal', 'task-management-list', 'task-feedback-select', 'task-feedback-panel', 'task-feedback-drilldown-modal', 'task-material-name']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(html, /id="task-body-keywords"/);
  assert.match(html, /class="task-keyword-grid"/);
  assert.match(taskOverrides, /grid-template-columns:45px minmax\(0,500px\) 112px 70px max-content/);
  assert.match(taskOverrides, /\.task-list-row>\.status\{justify-self:start\}/);
  assert.doesNotMatch(html, /id="dashboard-task-banner"/);
  assert.doesNotMatch(html, /id="export-pending-companies"/);
  const main = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
  assert.match(main, /task-feedback-result-filter/);
  assert.match(main, /openFeedbackMessageInInbox/);
  assert.match(main, /task_set_status/);
  assert.match(main, /task_rename/);
  assert.match(main, /deleteTask\(task, true\)/);
  assert.match(main, /openTaskModal\(task\)/);
  assert.match(main, /bodyKeywords: document\.querySelector\('\#task-body-keywords'\)/);
  assert.match(html, /task-workbench-body/);
  assert.doesNotMatch(html, /task-detail-mail-pane/);
  assert.doesNotMatch(html, /id="task-match-list"/);
  assert.match(html, /id="task-detail-company-list"/);
  assert.match(html, /id="task-detail-body"/);
  assert.match(html, /task-detail-rules-panel/);
  assert.match(main, /#new-task-2'\)\?\.addEventListener\('click', \(\) => openTaskModal\(\)\)/);
});

test('compares release versions and selects a UniGather installer', () => {
  assert.deepEqual(normalizeVersion('v0.2.1'), [0, 2, 1]);
  assert.equal(isNewerVersion('v0.2.0', '0.1.0'), true);
  assert.equal(isNewerVersion('0.1.0', '0.1.0'), false);
  assert.equal(pickInstallerAsset([{ name: 'notes.txt' }, { name: 'UniGather_0.2.0_x64-setup.exe', browser_download_url: 'https://example.com/app.exe' }]).name, 'UniGather_0.2.0_x64-setup.exe');
});

test('formats update download progress for known and unknown file sizes', () => {
  assert.equal(formatDownloadProgress(512, 1024), '50%');
  assert.equal(formatDownloadProgress(1536, 0), '1.5 KB');
});

test('deduplicates contacts into selectable company options', () => {
  assert.deepEqual(normalizeCompanyOptions([
    { id: 'company-a', name: '北桥公司', contact_name: '张三', email: 'a@north.example' },
    { id: 'company-a', name: '北桥公司', contact_name: '李四', email: 'b@north.example' },
    { id: 'company-b', name: '华东中心', contact_name: '王五', email: 'east@example' },
  ]), [
    { id: 'company-a', name: '北桥公司', contacts: ['张三', '李四'], emails: ['a@north.example', 'b@north.example'], phones: [], aliases: [], emailCount: 2 },
    { id: 'company-b', name: '华东中心', contacts: ['王五'], emails: ['east@example'], phones: [], aliases: [], emailCount: 1 },
  ]);
  assert.deepEqual(normalizeCompanyOptions([{ id: 'a', name: '北桥', contacts: ['张三'], email_count: 3 }]), [
    { id: 'a', name: '北桥', contacts: ['张三'], emails: [], phones: [], aliases: [], emailCount: 3 },
  ]);
});

test('filters companies and toggles all selected ids', () => {
  const options = normalizeCompanyOptions([{ id: 'a', name: '北桥', contact_name: '张三', email: 'a@example' }, { id: 'b', name: '华东', contact_name: '李四', email: 'b@example' }]);
  assert.deepEqual(filterCompanyOptions(options, '张三').map((item) => item.id), ['a']);
  assert.deepEqual(toggleAllCompanyIds(options, []), ['a', 'b']);
  assert.deepEqual(toggleAllCompanyIds(options, ['a', 'b']), []);
  assert.deepEqual(validateCompanySelection([], options), { companyIds: '请至少选择一家单位' });
  assert.deepEqual(validateCompanySelection(['a'], options), {});
  assert.deepEqual(validateCompanySelection([], []), { companyIds: '请先在“通讯录”导入单位清单' });
});

test('limits task refresh to its inclusive start and end window', () => {
  assert.equal(isWithinSyncWindow('2026-08-10T09:00:00Z', '2026-08-10T09:00:00Z', '2026-08-10T10:00:00Z'), true);
  assert.equal(isWithinSyncWindow('2026-08-10T10:00:01Z', '2026-08-10T09:00:00Z', '2026-08-10T10:00:00Z'), false);
  assert.equal(normalizeSyncEnd('2026-08-11T09:00:00Z', new Date('2026-08-10T09:00:00Z')), '2026-08-10T09:00:00.000Z');
});

test('matches a task message to one selected company and returns the feedback update', () => {
  assert.deepEqual(matchMessageToCompanyTask({ sender: 'finance@example.com', subject: '报名表反馈', body: '已提交' }, {
    subjectKeywords: ['报名'], bodyKeywords: [], companies: [{ id: 'company-a', emails: ['finance@example.com'] }],
  }), { status: 'confirmed', companyId: 'company-a', reason: 'sender_and_subject' });
  assert.equal(matchMessageToCompanyTask({ sender: 'other@example.com', subject: '报名', body: '' }, {
    subjectKeywords: ['报名'], bodyKeywords: [], companies: [{ id: 'company-a', emails: ['finance@example.com'] }],
  }).status, 'unmatched');
  assert.deepEqual(matchMessageToCompanyTask({ sender: 'finance@example.com', subject: '反馈', body: '已提交材料' }, {
    subjectKeywords: [], bodyKeywords: ['已提交'], companies: [{ id: 'company-a', emails: ['finance@example.com'] }],
  }), { status: 'confirmed', companyId: 'company-a', reason: 'sender_and_body' });
});

test('builds readable company row metadata for the redesigned picker', () => {
  assert.deepEqual(formatCompanyOptionMeta({ contacts: ['张三', '李四'], emails: ['a@example.com', 'b@example.com'], emailCount: 2 }), {
    contactLabel: '张三、李四', emailLabel: '2 个邮箱',
  });
});

test('builds editable time presets and validates the selected range', () => {
  const now = new Date('2026-08-10T10:30:00+08:00');
  assert.deepEqual(buildTimePresetRange('last7days', now), { start: '2026-08-03T10:30', end: '2026-08-10T10:30' });
  assert.deepEqual(validateTimeRange('2026-08-10T11:00', '2026-08-10T10:30'), { startTime: '起始时间不能晚于截止时间' });
  assert.deepEqual(validateTimeRange('2026-08-10T09:00', '2026-08-10T10:30'), {});
});

test('allows a blank password when an existing credential is present', () => {
  const values = { protocol: 'IMAP', host: 'imap.example.com', port: 993, username: 'user@example.com', password: '' };
  assert.deepEqual(validateMailboxSave(values, true), {});
  assert.equal(validateMailboxSave(values, false).password, '请输入账号密码');
});

test('calculates the last and next automatic receive times for an active task', () => {
  const now = Date.parse('2026-08-10T10:00:00+08:00');
  const last = Date.parse('2026-08-10T09:30:00+08:00');
  const schedule = getTaskSchedule({ status: 'active', poll_minutes: 30 }, last, now);

  assert.deepEqual(schedule, {
    lastSyncAt: last,
    nextSyncAt: Date.parse('2026-08-10T10:00:00+08:00'),
    stopped: false,
  });
  assert.equal(formatTaskScheduleTime(schedule.lastSyncAt), '2026/8/10 09:30');
  assert.equal(formatTaskScheduleCountdown(schedule.nextSyncAt, now), '现在');

  const scheduled = getTaskSchedule({ status: 'active', poll_minutes: 30 }, null, now, Date.parse('2026-08-10T09:45:00+08:00'));
  assert.equal(scheduled.lastSyncAt, null);
  assert.equal(scheduled.nextSyncAt, Date.parse('2026-08-10T10:15:00+08:00'));
});

test('uses task creation time when no receive has happened and stops after deadline', () => {
  const now = Date.parse('2026-08-10T10:00:00+08:00');
  const created = '2026-08-10T09:00:00+08:00';
  const pending = getTaskSchedule({ status: 'active', poll_minutes: 60, created_at: created }, null, now);
  assert.equal(pending.lastSyncAt, null);
  assert.equal(pending.nextSyncAt, Date.parse('2026-08-10T10:00:00+08:00'));
  assert.equal(formatTaskScheduleTime(pending.lastSyncAt), '尚未收件');

  const stopped = getTaskSchedule({ status: 'active', poll_minutes: 30, deadline: '2026-08-10T09:59:00+08:00' }, now - 30 * 60 * 1000, now);
  assert.deepEqual(stopped, { lastSyncAt: now - 30 * 60 * 1000, nextSyncAt: null, stopped: true });
  assert.equal(formatTaskScheduleCountdown(stopped.nextSyncAt, now), '已停止');
});

test('runs one initial sync for an active historical task that has never received mail', () => {
  const now = Date.parse('2026-08-13T10:00:00+08:00');
  const task = { status: 'active', start_time: '2026-08-06T10:00', deadline: '2026-08-10T10:00' };
  assert.equal(shouldRunInitialTaskSync(task, null, now), true);
  assert.equal(shouldRunInitialTaskSync(task, Date.parse('2026-08-13T09:50:00+08:00'), now), false);
  assert.equal(shouldRunInitialTaskSync({ ...task, status: 'paused' }, null, now), false);
  assert.deepEqual(getTaskSchedule({ ...task, poll_minutes: 30 }, null, now), { lastSyncAt: null, nextSyncAt: now, stopped: false });
});

test('builds point-to-point send targets without mixing company recipients', () => {
  const targets = normalizeSendTargets([
    { id: 'c1', name: '甲公司', emails: ['a@example.com', 'a@example.com'] },
    { id: 'c2', name: '乙公司', emails: ['b@example.com'] },
  ], ['c2', 'c1']);

  assert.deepEqual(targets, [
    { companyId: 'c1', companyName: '甲公司', recipients: ['a@example.com'] },
    { companyId: 'c2', companyName: '乙公司', recipients: ['b@example.com'] },
  ]);
  assert.equal(formatSendProgress({ processed: 1, total: 2, success: 1, failure: 0, currentCompany: '甲公司' }), '已发送 1 / 2 封 · 成功 1 · 失败 0 · 当前：甲公司');
});

test('validates send configuration and requires formal confirmation after test send', () => {
  const targets = [{ companyId: 'c1', companyName: '甲公司', recipients: ['a@example.com'] }];
  const base = { taskId: 'task-1', smtpHost: 'smtp.example.com', smtpPort: '465', encryption: 'SSL/TLS', username: 'sender@example.com', subject: '通知', body: '正文', testRecipient: 'test@example.com' };
  assert.deepEqual(validateSendForm(base, targets, 'test'), { errors: {}, warnings: [] });
  const formal = validateSendForm({ ...base, testConfirmed: false }, targets, 'formal');
  assert.equal(formal.errors.testConfirmed, '请先完成测试发送并确认结果');
  const duplicate = validateSendForm(base, [{ companyId: 'c1', companyName: '甲公司', recipients: ['same@example.com'] }, { companyId: 'c2', companyName: '乙公司', recipients: ['same@example.com'] }], 'test');
  assert.equal(duplicate.warnings[0].code, 'duplicate_recipient');
  assert.deepEqual(buildSendPayload({ taskId: 'task-1', smtpHost: 'smtp.example.com', smtpPort: '465', encryption: 'SSL/TLS', username: 'sender@example.com', senderName: '总部', subject: '通知', body: '正文', includeAttachments: true }, targets), {
    taskId: 'task-1', smtpHost: 'smtp.example.com', smtpPort: 465, encryption: 'SSL/TLS', username: 'sender@example.com', senderName: '总部', subject: '通知', body: '正文', includeAttachments: true, companyIds: ['c1'],
  });
});

test('matches independent send batch files by unit name and alias', () => {
  const items = buildSendBatchItems([
    { id: 'f1', name: '北桥公司_季度材料.xlsx', path: 'D:/北桥公司_季度材料.xlsx' },
    { id: 'f2', name: 'EastAlias材料.pdf', path: 'D:/EastAlias材料.pdf' },
    { id: 'f3', name: '未知材料.txt', path: 'D:/未知材料.txt' },
  ], [
    { id: 'a', name: '北桥公司', aliases: [], emails: ['a@example.com'] },
    { id: 'b', name: '华东中心', aliases: ['EastAlias'], emails: ['b@example.com'] },
  ]);
  assert.equal(items[0].status, 'matched');
  assert.equal(items[0].matchMethod, 'name_exact');
  assert.equal(items[1].status, 'matched');
  assert.equal(items[1].matchMethod, 'alias_exact');
  assert.equal(items[2].status, 'unmatched');
});

test('groups independent send batch attachments and validates unresolved items', () => {
  const items = [
    { id: '1', fileName: 'a.xlsx', filePath: 'D:/a.xlsx', companyId: 'a', companyName: '北桥', recipients: ['a@example.com'], status: 'matched' },
    { id: '2', fileName: 'b.pdf', filePath: 'D:/b.pdf', companyId: 'a', companyName: '北桥', recipients: ['a@example.com', 'b@example.com'], status: 'matched' },
    { id: '3', fileName: 'c.txt', filePath: 'D:/c.txt', companyId: '', companyName: '', recipients: [], status: 'needs_review' },
  ];
  const grouped = groupSendBatchItems(items);
  assert.equal(grouped.length, 1);
  assert.deepEqual(grouped[0].recipients, ['a@example.com', 'b@example.com']);
  assert.equal(grouped[0].attachments.length, 2);
  assert.equal(validateSendBatch(items, { subject: '通知', body: '正文' }).errors[0], '还有 1 个附件需要人工确认');
  assert.deepEqual(parseBatchCc('a@example.com; b@example.com，a@example.com'), ['a@example.com', 'b@example.com']);
});

test('normalizes structured company contacts into selectable emails and names', () => {
  const options = normalizeCompanyOptions([{ id: 'c1', name: '重庆', contacts: [
    { id: 'p1', contactName: '王珂', email: 'wang@example.com', phone: '10086' },
    { id: 'p2', contactName: '李敏', email: 'li@example.com', phone: '' },
  ], aliases: ['重庆联通'] }]);
  assert.deepEqual(options[0].contacts, ['王珂', '李敏']);
  assert.deepEqual(options[0].emails, ['wang@example.com', 'li@example.com']);
  assert.equal(options[0].emailCount, 2);
});

test('blocks sending when persisted batch item count differs from the page', () => {
  assert.deepEqual(validateBatchPersistence([{ id: 'a' }, { id: 'b' }], { itemCount: 1 }), {
    ok: false,
    message: '批次保存不完整：页面有 2 个附件，数据库仅保存 1 个',
  });
  assert.deepEqual(validateBatchPersistence([{ id: 'a' }, { id: 'b' }], { itemCount: 2 }), {
    ok: true,
    message: '',
  });
});

test('appends the configured signature to the outgoing body exactly once', () => {
  assert.equal(composeSendBody('请查收材料。', '中国联通总部数据安全工作组'), '请查收材料。\n\n中国联通总部数据安全工作组');
  assert.equal(composeSendBody('请查收材料。\n\n中国联通总部数据安全工作组', '中国联通总部数据安全工作组'), '请查收材料。\n\n中国联通总部数据安全工作组');
  assert.equal(composeSendBody('请查收材料。', ''), '请查收材料。');
});

test('provides an explicit label and detail for every send match status', () => {
  assert.deepEqual(sendItemStatusMeta('matched', ''), { label: '已匹配', tone: 'success', detail: '可以发送' });
  assert.equal(sendItemStatusMeta('needs_review', '单位没有有效邮箱').label, '待确认');
  assert.equal(sendItemStatusMeta('unmatched', '').detail, '未找到对应单位');
  assert.equal(sendItemStatusMeta('ignored', '').label, '已忽略');
});

test('includes signature, send history detail and task rules visibility controls in the desktop UI', () => {
  const html = readFileSync(new URL('../src/index.html', import.meta.url), 'utf8');
  ['id="send-signature"', 'id="save-default-signature"', 'id="send-history-detail-modal"', 'id="task-detail-company-list"', 'id="task-detail-body"'].forEach((marker) => assert.ok(html.includes(marker), marker));
  assert.ok(!html.includes('id="task-match-list"'));
});

test('includes deleted task recovery, feedback paging and streamlined inbox controls', () => {
  const html = readFileSync(new URL('../src/index.html', import.meta.url), 'utf8');
  const main = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
  ['task-deleted-count', 'task-delete-confirm-modal', 'confirm-task-delete'].forEach((id) => assert.match(html, new RegExp(`id="${id}"`)));
  ['task-feedback-pagination', 'task-feedback-page-size', 'task_feedback_page'].forEach((marker) => assert.ok(main.includes(marker), marker));
  assert.ok(html.indexOf('data-view="companies"') < html.indexOf('data-view="inbox"'));
  assert.doesNotMatch(html, /id="refresh-inbox"/);
});

test('uses readable and compact task company picker rows', () => {
  const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
  assert.match(css, /\.task-picker-redesigned \.task-company-list\{[^}]*display:flex[^}]*flex-direction:column[^}]*justify-content:flex-start[^}]*gap:0/);
  assert.match(css, /\.task-picker-redesigned \.task-company-option\{[^}]*flex:0 0 40px/);
  assert.match(css, /\.task-picker-redesigned \.task-company-option strong\{[^}]*font-size:16px/);
  assert.match(css, /\.task-picker-redesigned \.task-company-option small\{[^}]*font-size:14px/);
});
