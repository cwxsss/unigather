import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeMaterialFeedback } from '../src/core/task-feedback.js';
import { buildMaterialExportCsv } from '../src/core/materials.js';
import { buildTaskInput } from '../src/core/tasks.js';

test('unit overview retains supplements, counts feedback and shows receipt time', () => {
  const rows = [
    { messageId: 'old', status: 'confirmed', companyId: 'c', companyName: '陕西', receivedAt: '2026-09-29T01:00:00Z', attachments: [{ id: 'a', isCurrent: false }, { id: 'b', isCurrent: true }] },
    { messageId: 'new', status: 'confirmed', companyId: 'c', companyName: '陕西', receivedAt: '2026-09-29T10:00:00+08:00', attachments: [{ id: 'c', isCurrent: true }] },
    { messageId: 'ignored', status: 'unmatched', companyId: 'c', companyName: '陕西', receivedAt: '2026-10-01', attachments: [] },
  ];
  const [unit] = summarizeMaterialFeedback(rows);
  assert.equal(unit.feedbackCount, 2);
  assert.equal(unit.updateCount, 1);
  assert.equal(unit.latestReceivedAt, rows[1].receivedAt);
  assert.deepEqual(unit.attachments.map((file) => file.id), ['b', 'c']);
});

test('material export includes only current attachments and safely quotes CSV cells', () => {
  const csv = buildMaterialExportCsv([
    { isCurrent: true, taskName: '目录,收集', companyName: '陕西', name: '=SUM(1)', receivedAt: '2026-09-29', savedPath: 'D:\\当前\\文件.xlsx', historyPath: 'D:\\历史\\文件.xlsx' },
    { isCurrent: false, taskName: 'old', name: '历史附件' },
  ]);
  assert.equal(csv.split('\r\n').length, 2);
  assert.match(csv, /"目录,收集"/);
  assert.match(csv, /"'=SUM\(1\)"/);
  assert.ok(!csv.includes('历史附件'));
  assert.ok(csv.includes('来源邮件时间'));
});

test('task payload preserves its independent attachment directory', () => {
  assert.equal(buildTaskInput({ name: '目录收集', deadline: '2026-10-31', saveDirectory: ' E:\\收集材料\\独立目录 ' }).save_directory, 'E:\\收集材料\\独立目录');
});
