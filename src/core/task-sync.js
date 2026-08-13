const text = (value) => String(value ?? '').trim();
const normalize = (value) => text(value).toLocaleLowerCase();

function parseDate(value) {
  const timestamp = Date.parse(value ?? '');
  return Number.isNaN(timestamp) ? null : timestamp;
}

function senderEmail(value) {
  const match = text(value).match(/<([^>]+)>/);
  return normalize(match?.[1] ?? value).replace(/^mailto:/, '');
}

function includesAny(value, keywords = []) {
  const normalized = normalize(value);
  return !keywords.length || keywords.some((keyword) => normalized.includes(normalize(keyword)));
}

export function normalizeSyncEnd(value, now = new Date()) {
  const current = now instanceof Date ? now : new Date(now);
  const requested = parseDate(value);
  if (requested == null || requested > current.getTime()) return current.toISOString();
  return new Date(requested).toISOString();
}

export function isWithinSyncWindow(receivedAt, start, end) {
  const received = parseDate(receivedAt);
  const since = parseDate(start);
  const until = parseDate(end);
  if (received == null || since == null || until == null) return false;
  return received >= since && received <= until;
}

export function matchMessageToCompanyTask(message = {}, task = {}) {
  const sender = senderEmail(message.sender);
  const candidates = (task.companies ?? []).filter((company) => (company.emails ?? []).some((email) => senderEmail(email) === sender));
  const subjectMatches = includesAny(message.subject, task.subjectKeywords);
  const bodyMatches = includesAny(message.body, task.bodyKeywords);
  if (!candidates.length || !subjectMatches || !bodyMatches) return { status: 'unmatched' };
  if (candidates.length > 1) return { status: 'needs_review', companyIds: candidates.map((company) => company.id) };
  return {
    status: 'confirmed',
    companyId: candidates[0].id,
    reason: subjectMatches && sender ? 'sender_and_subject' : 'rule_match',
  };
}
