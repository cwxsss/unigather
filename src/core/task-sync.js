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

function matchKeywords(value, keywords = []) {
  const normalized = normalize(value);
  const positive = [];
  const negative = [];
  keywords.forEach((value) => {
    const keyword = normalize(value);
    if (!keyword) return;
    if (keyword.startsWith('-')) negative.push(keyword.slice(1));
    else positive.push(keyword.startsWith('+') ? keyword.slice(1) : keyword);
  });
  return {
    positiveConfigured: positive.length > 0,
    positiveMatches: positive.some((keyword) => keyword && normalized.includes(keyword)),
    excluded: negative.some((keyword) => keyword && normalized.includes(keyword)),
  };
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
  const subjectRule = matchKeywords(message.subject, task.subjectKeywords);
  const bodyRule = matchKeywords(message.body, task.bodyKeywords);
  const positiveConfigured = subjectRule.positiveConfigured || bodyRule.positiveConfigured;
  const positiveMatches = !positiveConfigured
    || (subjectRule.positiveConfigured && subjectRule.positiveMatches)
    || (bodyRule.positiveConfigured && bodyRule.positiveMatches);
  if (!candidates.length || !positiveMatches || subjectRule.excluded || bodyRule.excluded) return { status: 'unmatched' };
  if (candidates.length > 1) return { status: 'needs_review', companyIds: candidates.map((company) => company.id) };
  return {
    status: 'confirmed',
    companyId: candidates[0].id,
    reason: subjectRule.positiveMatches ? 'sender_and_subject' : bodyRule.positiveMatches ? 'sender_and_body' : 'rule_match',
  };
}
