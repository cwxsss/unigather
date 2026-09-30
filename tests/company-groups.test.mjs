import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCompanyGroups, companyGroupState, applyCompanyGroup, resolveGroupEmails, saveCompanyGroup } from '../src/core/company-groups.js';
import { readFileSync } from 'node:fs';

const options = [{ id: 'hq1', emails: ['HQ1@example.com'] }, { id: 'hq2', emails: ['hq2@example.com'] }, { id: 'province', emails: ['p@example.com'] }];
const group = { id: 'hq', name: '总部部门', companyIds: ['hq1', 'hq2', 'removed'] };

test('groups select all available members and preserve unrelated unit choices', () => {
  const selected = applyCompanyGroup(group, options, ['province'], true);
  assert.deepEqual(selected, ['province', 'hq1', 'hq2']);
  assert.equal(companyGroupState(group, options, selected).checked, true);
  assert.deepEqual(applyCompanyGroup(group, options, selected, false), ['province']);
  const partial = companyGroupState(group, options, ['hq1']);
  assert.equal(partial.partial, true);
  assert.equal(partial.missingCount, 1);
});

test('pasted emails resolve against the address book and report unknown members', () => {
  assert.deepEqual(resolveGroupEmails('hq1@example.com，HQ2@example.com;hq1@example.com\nmissing@example.com', options), { companyIds: ['hq1', 'hq2'], unknown: ['missing@example.com'] });
});

test('groups survive serialization and edits do not mutate saved task membership', () => {
  const savedTask = ['hq1'];
  const created = saveCompanyGroup([], { id: 'hq', name: ' 总部部门 ', companyIds: ['hq1', 'hq1'] });
  const restored = normalizeCompanyGroups(JSON.parse(JSON.stringify(created)));
  assert.deepEqual(restored, [{ id: 'hq', name: '总部部门', companyIds: ['hq1'] }]);
  assert.deepEqual(saveCompanyGroup(restored, { id: 'hq', name: '总部', companyIds: ['hq2'] })[0].companyIds, ['hq2']);
  assert.deepEqual(savedTask, ['hq1']);
  assert.throws(() => saveCompanyGroup(restored, { id: 'other', name: '总部部门', companyIds: ['hq2'] }), /已存在/);
  assert.throws(() => saveCompanyGroup([], { id: 'empty', name: '总部', companyIds: [] }), /请选择|请先选择/);
});

test('task form includes group manager and independent directory controls', () => {
  const html = readFileSync(new URL('../src/index.html', import.meta.url), 'utf8');
  for (const id of ['task-company-groups', 'task-company-group-name', 'task-company-group-emails', 'save-company-group', 'delete-company-group', 'task-save-directory', 'choose-task-save-directory', 'task-detail-material-versions']) assert.ok(html.includes(`id="${id}"`), id);
});
