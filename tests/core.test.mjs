import test from 'node:test';
import assert from 'node:assert/strict';
import { matchMessageToTask } from '../src/core/matching.js';
import { buildAttachmentName } from '../src/core/filename.js';
import { getFeedbackStatus } from '../src/core/status.js';
import { classifyAttachment, buildAiPayload, decodeCsvBuffer, parseCompanyRows, parseCompanyMatrix } from '../src/core/attachments.js';
import { mailboxDefaults, validateMailboxForm, buildMailboxPayload, buildMailboxStorage } from '../src/core/mailbox.js';
import { splitKeywords, validateTaskInput, buildTaskInput, taskProgressPercent, taskStatusLabel } from '../src/core/tasks.js';
import { normalizeVersion, isNewerVersion, pickInstallerAsset } from '../src/core/update.js';
import { DEFAULT_MATERIAL_PATH, normalizeMaterialPath } from '../src/core/materials.js';
import { filterInboxMessages, normalizeInboxMessage, sortInboxMessages } from '../src/core/inbox.js';
import { defaultInboxStartTime, normalizeInboxStartTime } from '../src/core/sync.js';
import { DEFAULT_AI_ENDPOINT, normalizeAiConfig, validateAiConfig } from '../src/core/ai.js';
import { syncProgressPercent, syncProgressLabel } from '../src/core/sync-progress.js';

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
    { name: '北桥公司', contactName: '张三', emails: ['a@example.com', 'b@example.com'] },
    { name: '华东中心', contactName: '李四', emails: ['c@example.com'] },
  ]);
});

test('imports company names from an Excel-like worksheet matrix', () => {
  assert.deepEqual(parseCompanyMatrix([
    ['单位名称', '姓名', '邮箱'],
    ['北桥公司', '张三', 'a@example.com'],
    ['华东中心', '李四', 'c@example.com'],
  ]), [
    { name: '北桥公司', contactName: '张三', emails: ['a@example.com'] },
    { name: '华东中心', contactName: '李四', emails: ['c@example.com'] },
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
    name: '总部', protocol: 'IMAP', host: 'imap.example.com', port: 993, username: 'admin@example.com', password_key: 'admin@example.com', encryption: 'SSL/TLS', useProxy: true, proxyType: 'socks5', proxyHost: '127.0.0.1', proxyPort: 7890, proxyUsername: 'proxy-user', proxyUrl: 'socks5://127.0.0.1:7890', enabled: true,
  });
});

test('builds a normalized task payload from the create form', () => {
  assert.deepEqual(splitKeywords('季度材料，经营分析\n财务'), ['季度材料', '经营分析', '财务']);
  assert.deepEqual(validateTaskInput({ name: '', deadline: '' }), { name: '请输入任务名称', deadline: '请选择截止时间' });
  assert.deepEqual(buildTaskInput({ name: ' Q3 材料 ', subjectKeywords: '季度,材料', deadline: '2026-08-15T18:00', pollMinutes: '60', aiEnabled: true }), {
    name: 'Q3 材料', company_ids: [], subject_keywords: ['季度', '材料'], body_keywords: [], deadline: '2026-08-15T18:00', start_time: '', poll_minutes: 60, save_directory: 'D:\\UniGather\\Materials', filename_template: '{task}_{company}_{filename}', ai_enabled: true,
  });
  assert.deepEqual(buildTaskInput({ name: '补查任务', startTime: '2026-08-01T09:00', deadline: '2026-08-15T18:00' }).start_time, '2026-08-01T09:00');
  assert.equal(validateTaskInput({ name: '任务', startTime: '2026-08-16T09:00', deadline: '2026-08-15T18:00' }).startTime, '起始时间不能晚于截止时间');
  assert.equal(taskStatusLabel('paused'), '已暂停');
});

test('calculates task progress for the task detail view', () => {
  assert.equal(taskProgressPercent({ total_companies: 10, confirmed_companies: 3 }), 30);
  assert.equal(taskProgressPercent({ total_companies: 0, confirmed_companies: 0 }), 0);
});

test('compares release versions and selects a UniGather installer', () => {
  assert.deepEqual(normalizeVersion('v0.2.1'), [0, 2, 1]);
  assert.equal(isNewerVersion('v0.2.0', '0.1.0'), true);
  assert.equal(isNewerVersion('0.1.0', '0.1.0'), false);
  assert.equal(pickInstallerAsset([{ name: 'notes.txt' }, { name: 'UniGather_0.2.0_x64-setup.exe', browser_download_url: 'https://example.com/app.exe' }]).name, 'UniGather_0.2.0_x64-setup.exe');
});
