const statusOf = (item) => String(item?.status ?? item?.feedbackStatus ?? item?.feedback_status ?? '');

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
