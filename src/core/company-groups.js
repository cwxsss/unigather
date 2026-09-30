export function normalizeCompanyGroups(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  return value.filter((group) => group && typeof group.id === 'string' && typeof group.name === 'string' && group.name.trim() && !seen.has(group.id) && seen.add(group.id))
    .map((group) => ({ id: group.id, name: group.name.trim(), companyIds: [...new Set((Array.isArray(group.companyIds) ? group.companyIds : []).filter((id) => typeof id === 'string' && id))] }));
}

export function companyGroupState(group, options, selectedIds) {
  const available = new Set(options.map((option) => option.id));
  const members = (group.companyIds ?? []).filter((id) => available.has(id));
  const selected = new Set(selectedIds);
  const selectedCount = members.filter((id) => selected.has(id)).length;
  return { members, checked: members.length > 0 && selectedCount === members.length, partial: selectedCount > 0 && selectedCount < members.length, missingCount: group.companyIds.length - members.length };
}

export function applyCompanyGroup(group, options, selectedIds, checked) {
  const members = companyGroupState(group, options, selectedIds).members;
  const selected = new Set(selectedIds);
  for (const id of members) { if (checked) selected.add(id); else selected.delete(id); }
  return [...selected];
}

export function resolveGroupEmails(value, options) {
  const emails = [...new Set(String(value ?? '').split(/[\s,，;；]+/).map((email) => email.trim().toLowerCase()).filter(Boolean))];
  const ids = new Set();
  const unknown = [];
  for (const email of emails) {
    const matches = options.filter((option) => (option.emails ?? []).some((address) => String(address).trim().toLowerCase() === email));
    if (!matches.length) unknown.push(email);
    else matches.forEach((option) => ids.add(option.id));
  }
  return { companyIds: [...ids], unknown };
}

export function saveCompanyGroup(groups, input) {
  const name = String(input.name ?? '').trim();
  if (!name) throw new Error('请输入分组名称，例如“总部部门”。');
  if (name.length > 64) throw new Error('分组名称最多 64 个字符。');
  if (!input.companyIds?.length) throw new Error('请先选择单位或填写通讯录中的邮箱。');
  if (groups.some((group) => group.id !== input.id && group.name.toLowerCase() === name.toLowerCase())) throw new Error('分组名称已存在，请选择该分组进行编辑。');
  const group = { id: input.id, name, companyIds: [...new Set(input.companyIds)] };
  return groups.some((item) => item.id === group.id) ? groups.map((item) => item.id === group.id ? group : item) : [...groups, group];
}
