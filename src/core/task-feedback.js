const statusOf = (item) => String(item?.status ?? item?.feedbackStatus ?? item?.feedback_status ?? '');

export function summarizeMaterialFeedback(messages = []) {
  const groups = new Map();
  for (const message of messages) {
    if (message.status !== 'confirmed' || !message.companyName) continue;
    const key = message.companyId || message.companyName;
    if (!groups.has(key)) groups.set(key, { companyId: message.companyId, companyName: message.companyName, feedbackStatus: 'confirmed', latestReceivedAt: '', ids: new Set(), files: new Map(), messages: [] });
    const group = groups.get(key);
    group.ids.add(message.messageId || message.id);
    group.messages.push(message);
    if (!group.latestReceivedAt || Date.parse(message.receivedAt) > Date.parse(group.latestReceivedAt)) group.latestReceivedAt = message.receivedAt;
    for (const attachment of message.attachments ?? []) {
      if (attachment.isCurrent) group.files.set(attachment.id, attachment);
    }
  }
  return [...groups.values()].map(({ ids, files, ...group }) => ({ ...group, feedbackCount: ids.size, updateCount: Math.max(0, ids.size - 1), attachments: [...files.values()] }));
}

export function paginateTaskMatches(items = [], requestedPage = 1, requestedPageSize = 20) {
  const source = Array.isArray(items) ? items : [];
  const pageSize = [10, 20, 31, 40, 50].includes(Number(requestedPageSize)) ? Number(requestedPageSize) : 20;
  const total = source.length;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(Math.max(1, Number(requestedPage) || 1), pageCount);
  const start = (page - 1) * pageSize;
  return { items: source.slice(start, start + pageSize), page, pageSize, total, pageCount };
}

export function drilldownItems(kind, messages = [], companies = []) {
  const messageRows = Array.isArray(messages) ? messages : [];
  const companyRows = Array.isArray(companies) ? companies : [];
  if (kind === 'confirmed') return companyRows.filter((item) => statusOf(item) === 'confirmed');
  if (kind === 'pending') return companyRows.filter((item) => statusOf(item) !== 'confirmed');
  if (kind === 'needs_review' || kind === 'unmatched') return messageRows.filter((item) => statusOf(item) === kind);
  return [];
}
