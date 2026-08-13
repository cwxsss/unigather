const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

function splitEmails(value) {
  const values = Array.isArray(value) ? value : String(value ?? '').split(/[;,]/);
  return [...new Set(values.map((email) => String(email).trim().toLowerCase()).filter(Boolean))];
}

export function normalizeSendTargets(options = [], selectedIds = []) {
  const selected = new Set(selectedIds.map(String));
  return options
    .filter((option) => selected.has(String(option.id)))
    .map((option) => ({
      companyId: String(option.id),
      companyName: String(option.name ?? '').trim(),
      recipients: splitEmails(option.emails ?? option.email ?? []),
    }));
}

export function validateSendForm(values = {}, targets = [], mode = 'formal') {
  const errors = {};
  const warnings = [];
  const host = String(values.smtpHost ?? '').trim();
  const username = String(values.username ?? '').trim();
  const subject = String(values.subject ?? '').trim();
  const body = String(values.body ?? '').trim();
  const port = Number(values.smtpPort);

  if (!String(values.taskId ?? '').trim()) errors.taskId = '请选择关联收集任务';
  if (!host) errors.smtpHost = '请输入 SMTP 服务器地址';
  if (!Number.isInteger(port) || port < 1 || port > 65535) errors.smtpPort = '请输入 1-65535 的 SMTP 端口';
  if (!['SSL/TLS', 'STARTTLS'].includes(String(values.encryption ?? ''))) errors.encryption = '请选择 SMTP 加密方式';
  if (!username || !EMAIL_RE.test(username)) errors.username = '请输入有效的发件邮箱账号';
  if (!subject) errors.subject = '请输入邮件主题';
  if (!body) errors.body = '请输入邮件正文';
  if (!targets.length) errors.targets = '请至少选择一家发送单位';
  if (mode === 'test' && (!EMAIL_RE.test(String(values.testRecipient ?? '').trim()))) errors.testRecipient = '请输入有效的内部测试邮箱';
  if (mode === 'formal' && values.testConfirmed !== true) errors.testConfirmed = '请先完成测试发送并确认结果';

  const owners = new Map();
  for (const target of targets) {
    if (!target.companyName) errors.targets = '发送单位名称不能为空';
    if (!target.recipients.length) {
      errors.targets = `单位“${target.companyName || target.companyId}”没有有效收件邮箱`;
      continue;
    }
    for (const email of target.recipients) {
      if (!EMAIL_RE.test(email)) errors.targets = `单位“${target.companyName}”存在无效收件邮箱`;
      const previous = owners.get(email);
      if (previous && previous !== target.companyName) warnings.push({ code: 'duplicate_recipient', message: `邮箱 ${email} 同时属于“${previous}”和“${target.companyName}”` });
      owners.set(email, target.companyName);
    }
  }
  return { errors, warnings };
}

export function buildSendPayload(values = {}, targets = []) {
  return {
    taskId: String(values.taskId ?? ''),
    smtpHost: String(values.smtpHost ?? '').trim(),
    smtpPort: Number(values.smtpPort),
    encryption: String(values.encryption ?? 'SSL/TLS'),
    username: String(values.username ?? '').trim(),
    senderName: String(values.senderName ?? '').trim(),
    subject: String(values.subject ?? '').trim(),
    body: String(values.body ?? ''),
    includeAttachments: Boolean(values.includeAttachments),
    companyIds: targets.map((target) => target.companyId),
  };
}

export function formatSendProgress(progress = {}) {
  const processed = Number(progress.processed ?? 0);
  const total = Number(progress.total ?? 0);
  const success = Number(progress.success ?? progress.successCount ?? 0);
  const failure = Number(progress.failure ?? progress.failureCount ?? 0);
  const current = String(progress.currentCompany ?? '').trim();
  return `已发送 ${processed} / ${total} 封 · 成功 ${success} · 失败 ${failure}${current ? ` · 当前：${current}` : ''}`;
}
