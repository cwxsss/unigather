import test from 'node:test';
import assert from 'node:assert/strict';
import { matchMessageToTask } from '../src/core/matching.js';
import { buildAttachmentName } from '../src/core/filename.js';
import { getFeedbackStatus } from '../src/core/status.js';
import { classifyAttachment, buildAiPayload, parseCompanyRows } from '../src/core/attachments.js';
import { mailboxDefaults, validateMailboxForm, buildMailboxPayload } from '../src/core/mailbox.js';
import { splitKeywords, validateTaskInput, buildTaskInput, taskStatusLabel } from '../src/core/tasks.js';
import { normalizeVersion, isNewerVersion, pickInstallerAsset } from '../src/core/update.js';

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
  assert.deepEqual(parseCompanyRows('单位名称,邮箱\n北桥公司,a@example.com; b@example.com\n华东中心,c@example.com'), [
    { name: '北桥公司', emails: ['a@example.com', 'b@example.com'] },
    { name: '华东中心', emails: ['c@example.com'] },
  ]);
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
});

test('builds a normalized task payload from the create form', () => {
  assert.deepEqual(splitKeywords('季度材料，经营分析\n财务'), ['季度材料', '经营分析', '财务']);
  assert.deepEqual(validateTaskInput({ name: '', deadline: '' }), { name: '请输入任务名称', deadline: '请选择截止时间' });
  assert.deepEqual(buildTaskInput({ name: ' Q3 材料 ', subjectKeywords: '季度,材料', deadline: '2026-08-15T18:00', pollMinutes: '60', aiEnabled: true }), {
    name: 'Q3 材料', company_ids: [], subject_keywords: ['季度', '材料'], body_keywords: [], deadline: '2026-08-15T18:00', poll_minutes: 60, save_directory: 'D:\\UniGather\\Materials', filename_template: '{task}_{company}_{filename}', ai_enabled: true,
  });
  assert.equal(taskStatusLabel('paused'), '已暂停');
});

test('compares release versions and selects a UniGather installer', () => {
  assert.deepEqual(normalizeVersion('v0.2.1'), [0, 2, 1]);
  assert.equal(isNewerVersion('v0.2.0', '0.1.0'), true);
  assert.equal(isNewerVersion('0.1.0', '0.1.0'), false);
  assert.equal(pickInstallerAsset([{ name: 'notes.txt' }, { name: 'UniGather_0.2.0_x64-setup.exe', browser_download_url: 'https://example.com/app.exe' }]).name, 'UniGather_0.2.0_x64-setup.exe');
});
