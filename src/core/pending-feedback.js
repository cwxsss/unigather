const text = (value) => String(value ?? '').trim();

export function normalizePendingFeedbackCompanies(rows = []) {
  if (!Array.isArray(rows)) return [];
  return rows
    .filter((row) => text(row?.companyName ?? row?.company_name) && text(row?.feedbackStatus ?? row?.feedback_status) !== 'confirmed')
    .map((row) => ({
      ...row,
      companyName: text(row.companyName ?? row.company_name),
      feedbackStatus: text(row.feedbackStatus ?? row.feedback_status) || 'pending',
      contacts: Array.isArray(row.contacts) ? row.contacts : [],
    }));
}

export function pendingFeedbackStatusLabel(status) {
  return { confirmed: '已反馈', needs_review: '待确认', pending: '待反馈' }[text(status)] ?? '待反馈';
}

export function buildPendingFeedbackExportRows(task = {}, rows = []) {
  return normalizePendingFeedbackCompanies(rows).map((company, index) => ({
    序号: index + 1,
    任务名称: text(task.name),
    单位名称: company.companyName,
    反馈状态: pendingFeedbackStatusLabel(company.feedbackStatus),
    联系人: company.contacts.map((contact) => text(contact.contactName ?? contact.contact_name)).filter(Boolean).join('、'),
    邮箱: company.contacts.map((contact) => text(contact.email)).filter(Boolean).join('；'),
    电话: company.contacts.map((contact) => text(contact.phone)).filter(Boolean).join('、'),
    截止时间: text(task.deadline),
  }));
}
