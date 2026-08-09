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

export function buildMailboxPayload(values) {
  return {
    name: String(values.name ?? '').trim() || '总部收件箱',
    protocol: String(values.protocol ?? 'IMAP').toUpperCase(),
    host: String(values.host ?? '').trim(),
    port: Number(values.port),
    username: String(values.username ?? '').trim(),
    password_key: String(values.username ?? '').trim(),
    encryption: String(values.encryption ?? 'SSL/TLS'),
    proxy_url: values.useProxy ? String(values.proxyUrl ?? '').trim() : '',
    enabled: true,
  };
}
