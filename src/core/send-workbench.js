const SUPPORTED = new Set(['pdf', 'doc', 'docx', 'xls', 'xlsx', 'csv', 'txt', 'png', 'jpg', 'jpeg', 'bmp', 'tif', 'tiff']);

export function isSupportedSendFile(name = '') {
  const extension = String(name).toLocaleLowerCase().split('.').pop() ?? '';
  return SUPPORTED.has(extension);
}

export function normalizeMatchText(value = '') {
  return String(value ?? '')
    .toLocaleLowerCase()
    .replace(/\.[a-z0-9]{1,5}$/i, '')
    .replace(/[\s_\-—(),，。:：/\\【】\[\]（）]+/g, '')
    .replace(/(省|市|自治区|分公司|有限公司|中心|本部)$/g, '');
}

function emails(option) {
  return [...new Set((Array.isArray(option?.emails) ? option.emails : [option?.email])
    .map((value) => String(value ?? '').trim().toLowerCase())
    .filter(Boolean))];
}

function labels(option) {
  return [option?.name, ...(Array.isArray(option?.aliases) ? option.aliases : [])]
    .map((value) => String(value ?? '').trim())
    .filter(Boolean);
}

function scoreFile(fileName, option) {
  const normalizedFile = normalizeMatchText(fileName);
  const matches = labels(option).map((label) => ({ label, normalized: normalizeMatchText(label) })).filter((item) => item.normalized && normalizedFile.includes(item.normalized));
  if (matches.length) return { score: 0.98, method: matches[0].label === option.name ? 'name_exact' : 'alias_exact', label: matches[0].label };
  const fileChars = new Set([...normalizedFile]);
  const fuzzy = labels(option).map((label) => {
    const normalized = normalizeMatchText(label);
    const overlap = [...new Set([...normalized])].filter((char) => fileChars.has(char)).length;
    return { label, score: normalized.length > 1 ? overlap / new Set([...normalized]).size : 0 };
  }).sort((left, right) => right.score - left.score)[0];
  return fuzzy && fuzzy.score >= 0.68 ? { score: 0.68 + Math.min(fuzzy.score - 0.68, 0.15), method: 'fuzzy', label: fuzzy.label } : null;
}

export function matchAttachment(file, options = []) {
  const candidates = options.map((option) => {
    const result = scoreFile(file.name, option);
    return result ? { option, ...result } : null;
  }).filter(Boolean).sort((left, right) => right.score - left.score);
  if (!candidates.length) return { id: file.id, fileName: file.name, filePath: file.path, companyId: '', companyName: '', recipients: [], matchMethod: '', confidence: 0, status: 'unmatched', error: '未找到对应单位' };
  const best = candidates[0];
  const tied = candidates.filter((candidate) => Math.abs(candidate.score - best.score) < 0.04);
  if (tied.length > 1) return { id: file.id, fileName: file.name, filePath: file.path, companyId: '', companyName: '', recipients: [], matchMethod: 'ambiguous', confidence: best.score, status: 'needs_review', error: `候选单位：${tied.map((candidate) => candidate.option.name).join('、')}` };
  const option = best.option;
  const recipients = emails(option);
  return { id: file.id, fileName: file.name, filePath: file.path, companyId: String(option.id), companyName: String(option.name ?? ''), recipients, matchMethod: best.method, confidence: best.score, status: recipients.length ? 'matched' : 'needs_review', error: recipients.length ? '' : '单位没有有效邮箱' };
}

export function buildSendBatchItems(files = [], options = []) {
  return files.filter((file) => isSupportedSendFile(file.name)).map((file) => matchAttachment(file, options));
}

export function groupSendBatchItems(items = []) {
  const grouped = new Map();
  items.filter((item) => item.status === 'matched' && item.companyId).forEach((item) => {
    const current = grouped.get(item.companyId) ?? { companyId: item.companyId, companyName: item.companyName, recipients: [], attachments: [], statuses: [] };
    current.recipients = [...new Set([...current.recipients, ...(item.recipients ?? [])])];
    current.attachments.push({ name: item.fileName, path: item.filePath, id: item.id });
    current.statuses.push(item.status);
    grouped.set(item.companyId, current);
  });
  return [...grouped.values()].sort((left, right) => left.companyName.localeCompare(right.companyName, 'zh-CN'));
}

export function parseBatchCc(value = '') {
  return [...new Set(String(value ?? '').split(/[;,，；\s]+/).map((email) => email.trim().toLowerCase()).filter(Boolean))];
}

export function composeSendBody(body = '', signature = '') {
  const message = String(body ?? '').trimEnd();
  const footer = String(signature ?? '').trim();
  if (!footer || message.endsWith(footer)) return message;
  return `${message}\n\n${footer}`;
}

export function sendItemStatusMeta(status = '', error = '') {
  const detail = String(error ?? '').trim();
  const values = {
    matched: { label: '已匹配', tone: 'success', detail: '可以发送' },
    needs_review: { label: '待确认', tone: 'warning', detail: detail || '需要人工确认单位或收件人' },
    unmatched: { label: '未匹配', tone: 'danger', detail: detail || '未找到对应单位' },
    ignored: { label: '已忽略', tone: 'muted', detail: detail || '本附件不会发送' },
  };
  return values[status] ?? { label: '未知状态', tone: 'muted', detail: detail || '请检查匹配结果' };
}

export function validateSendBatch(items = [], values = {}) {
  const errors = [];
  const warnings = [];
  if (!String(values.subject ?? '').trim()) errors.push('邮件主题不能为空');
  if (!String(values.body ?? '').trim()) errors.push('邮件正文不能为空');
  if (!items.length) errors.push('请先扫描材料目录');
  const unresolved = items.filter((item) => ['unmatched', 'needs_review'].includes(item.status));
  if (unresolved.length) errors.push(`还有 ${unresolved.length} 个附件需要人工确认`);
  const paths = new Map();
  items.filter((item) => item.status === 'matched').forEach((item) => {
    if (!item.recipients?.length) errors.push(`单位“${item.companyName}”没有有效收件邮箱`);
    const previous = paths.get(item.filePath);
    if (previous && previous !== item.companyId) warnings.push(`附件“${item.fileName}”被多个单位使用`);
    paths.set(item.filePath, item.companyId);
  });
  return { errors: [...new Set(errors)], warnings: [...new Set(warnings)] };
}

export function validateBatchPersistence(items = [], summary = {}) {
  const pageCount = items.length;
  const databaseCount = Number(summary.itemCount ?? summary.item_count ?? 0);
  if (pageCount !== databaseCount) {
    return { ok: false, message: `批次保存不完整：页面有 ${pageCount} 个附件，数据库仅保存 ${databaseCount} 个` };
  }
  return { ok: true, message: '' };
}

export function formatBatchProgress(progress = {}) {
  const processed = Number(progress.processed ?? 0);
  const total = Number(progress.total ?? 0);
  return `已发送 ${processed} / ${total} 个单位 · 成功 ${Number(progress.success ?? 0)} · 失败 ${Number(progress.failure ?? 0)}${progress.currentCompany ? ` · 当前：${progress.currentCompany}` : ''}`;
}
