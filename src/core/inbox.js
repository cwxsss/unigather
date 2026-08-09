function listValue(value) {
  if (Array.isArray(value)) return value.filter(Boolean).map((item) => String(item));
  if (value == null || value === '') return [];
  const text = String(value).trim();
  if (text.startsWith('[')) {
    try { const parsed = JSON.parse(text); if (Array.isArray(parsed)) return parsed.filter(Boolean).map((item) => String(item)); } catch { /* fall through to delimiter parsing */ }
  }
  return text.split(/[;,，；]/).map((item) => item.trim()).filter(Boolean);
}

export function normalizeInboxMessage(message = {}) {
  return {
    id: String(message.id ?? ''),
    sender: String(message.sender ?? ''),
    subject: String(message.subject ?? '(无主题)'),
    body: String(message.body ?? ''),
    receivedAt: String(message.receivedAt ?? message.received_at ?? ''),
    recipients: listValue(message.recipients),
    cc: listValue(message.cc),
    attachments: (Array.isArray(message.attachments) ? message.attachments : []).map((attachment) => ({
      name: String(attachment.name ?? attachment.original_name ?? ''),
      mimeType: String(attachment.mimeType ?? attachment.mime_type ?? ''),
      savedPath: String(attachment.savedPath ?? attachment.saved_path ?? ''),
      parseStatus: String(attachment.parseStatus ?? attachment.parse_status ?? 'pending'),
    })),
  };
}

export function sortInboxMessages(messages = []) {
  return messages.map(normalizeInboxMessage).sort((left, right) => {
    const rightTime = Date.parse(right.receivedAt) || 0;
    const leftTime = Date.parse(left.receivedAt) || 0;
    return rightTime - leftTime;
  });
}

export function filterInboxMessages(messages = [], query = '') {
  const keyword = String(query ?? '').trim().toLocaleLowerCase();
  if (!keyword) return messages.map(normalizeInboxMessage);
  return messages.map(normalizeInboxMessage).filter((message) => [message.sender, message.subject, message.body, ...message.recipients, ...message.cc].join('\n').toLocaleLowerCase().includes(keyword));
}
