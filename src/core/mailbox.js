export function mailboxDefaults(protocol = 'IMAP') {
  return protocol === 'POP3'
    ? { port: 995, encryption: 'SSL/TLS' }
    : { port: 993, encryption: 'SSL/TLS' };
}

export function validateMailboxForm(values) {
  const errors = {};
  const protocol = String(values.protocol ?? '').toUpperCase();
  const host = String(values.host ?? '').trim();
  const username = String(values.username ?? '').trim();
  const password = String(values.password ?? '');
  const port = Number(values.port);

  if (!['IMAP', 'POP3'].includes(protocol)) errors.protocol = '请选择收件协议';
  if (!host) errors.host = '请输入收件服务器地址';
  if (!username) errors.username = '请输入收件账号';
  if (!password) errors.password = '请输入账号密码';
  if (!Number.isInteger(port) || port < 1 || port > 65535) errors.port = '请输入 1-65535 的端口';
  return errors;
}

export function validateMailboxSave(values, credentialPresent = false) {
  const errors = validateMailboxForm(values);
  if (credentialPresent && !String(values.password ?? '').trim()) delete errors.password;
  return errors;
}

export function buildMailboxPayload(values) {
  return {
    name: String(values.name ?? '').trim() || '总部收件箱',
    protocol: String(values.protocol ?? 'IMAP').toUpperCase(),
    host: String(values.host ?? '').trim(),
    port: Number(values.port),
    username: String(values.username ?? '').trim(),
    password_key: String(values.username ?? '').trim(),
    encryption: String(values.encryption ?? 'SSL/TLS'),
    smtp_host: String(values.smtpHost ?? '').trim(),
    smtp_port: Number(values.smtpPort) || 465,
    smtp_encryption: String(values.smtpEncryption ?? 'SSL/TLS'),
    smtp_sender_name: String(values.smtpSenderName ?? '').trim(),
    proxy_url: values.useProxy ? String(values.proxyUrl ?? '').trim() : '',
    enabled: true,
  };
}

export function buildMailboxStorage(values) {
  const payload = buildMailboxPayload(values);
  const { proxy_url: proxyUrl, ...storagePayload } = payload;
  return {
    ...storagePayload,
    proxyUrl,
    useProxy: Boolean(values.useProxy),
    proxyType: String(values.proxyType ?? 'http'),
    proxyHost: String(values.proxyHost ?? '').trim(),
    proxyPort: Number(values.proxyPort) || 0,
    proxyUsername: String(values.proxyUsername ?? '').trim(),
    smtpHost: payload.smtp_host,
    smtpPort: payload.smtp_port,
    smtpEncryption: payload.smtp_encryption,
    smtpSenderName: payload.smtp_sender_name,
  };
}
