function text(value) {
  return String(value ?? '').trim();
}

export function normalizeCompanyOptions(rows = []) {
  const grouped = new Map();
  rows.forEach((row) => {
    const id = text(row.id ?? row.company_id ?? row.name);
    const name = text(row.name ?? row.company_name);
    if (!id || !name) return;
    const option = grouped.get(id) ?? { id, name, contacts: [], emails: [], phones: [], aliases: [], emailCount: 0 };
    const structuredContacts = Array.isArray(row.contacts) ? row.contacts.filter((contact) => contact && typeof contact === 'object') : [];
    const contactValues = structuredContacts.length ? structuredContacts.map((contact) => contact.contactName ?? contact.contact_name) : (Array.isArray(row.contacts) ? row.contacts : [row.contactName ?? row.contact_name]);
    contactValues.map(text).filter(Boolean).forEach((contact) => {
      if (!option.contacts.includes(contact)) option.contacts.push(contact);
    });
    const emailValues = structuredContacts.length ? structuredContacts.map((contact) => contact.email) : (Array.isArray(row.emails) ? row.emails : [row.email]);
    const email = emailValues.map(text).filter(Boolean);
    email.forEach((address) => { if (!option.emails.includes(address)) option.emails.push(address); });
    const phoneValues = structuredContacts.length ? structuredContacts.map((contact) => contact.phone) : (Array.isArray(row.phones) ? row.phones : [row.phone]);
    phoneValues.map(text).filter(Boolean).forEach((phone) => { if (!option.phones.includes(phone)) option.phones.push(phone); });
    const aliasValues = Array.isArray(row.aliases) ? row.aliases : String(row.aliases ?? '').split(/[;,，；、]/);
    aliasValues.map(text).filter(Boolean).forEach((alias) => { if (!option.aliases.includes(alias)) option.aliases.push(alias); });
    const count = Number(row.email_count ?? row.emailCount);
    option.emailCount = Math.max(option.emailCount, Number.isFinite(count) && count > 0 ? count : option.emails.length);
    grouped.set(id, option);
  });
  return [...grouped.values()].sort((left, right) => left.name.localeCompare(right.name, 'zh-CN'));
}

export function filterCompanyOptions(options = [], query = '') {
  const keyword = text(query).toLocaleLowerCase();
  if (!keyword) return options;
  return options.filter((option) => [option.name, ...(option.contacts ?? []), ...(option.emails ?? []), ...(option.aliases ?? [])].join('\n').toLocaleLowerCase().includes(keyword));
}

export function toggleAllCompanyIds(options = [], selectedIds = []) {
  const ids = options.map((option) => option.id);
  const selected = new Set(selectedIds);
  return ids.length && ids.every((id) => selected.has(id)) ? [] : ids;
}

export function validateCompanySelection(selectedIds = [], options = []) {
  if (!options.length) return { companyIds: '请先在“通讯录”导入单位清单' };
  if (!selectedIds.length) return { companyIds: '请至少选择一家单位' };
  return {};
}
