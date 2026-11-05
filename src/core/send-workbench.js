const SUPPORTED = new Set(['pdf', 'doc', 'docx', 'xls', 'xlsx', 'csv', 'txt', 'png', 'jpg', 'jpeg', 'bmp', 'tif', 'tiff', 'zip']);

export function isSupportedSendFile(name = '') {
  const extension = String(name).toLocaleLowerCase().split('.').pop() ?? '';
  return SUPPORTED.has(extension);
}

const COMMON_PREFIXES = [
  '中国联合网络通信有限公司',
  '中国联合网络通信',
  '中国联通集团',
  '中国联通',
  '联通集团',
  '联通',
];

const COMMON_SUFFIXES = [
  '有限责任公司',
  '股份有限公司',
  '责任有限公司',
  '咨询设计院有限公司',
  '信息科技有限公司',
  '网络技术有限公司',
  '科技有限公司',
  '通信有限公司',
  '有限公司',
  '分公司',
  '子公司',
  '总公司',
  '公司',
  '中心',
  '本部',
  '学院',
  '省分',
  '市分',
  '省分公司',
  '市分公司',
];

const UNICOM_DOMAIN_ALIASES = {
  '软件研究': ['软研院', '软研', '软件院', '软件研究', '软件研究院', '联通软研'],
  '数字科技': ['数科', '联通数科', '数字科技', '数科公司'],
  '智网科技': ['智网', '联通智网', '智网科技', '智网公司'],
  '在线信息科技': ['在线', '在线科技', '在线信息', '联通在线', '在线公司'],
  '在线信息': ['在线', '在线科技', '在线信息', '联通在线', '在线公司'],
  '在线科技': ['在线', '在线科技', '在线信息', '联通在线', '在线公司'],
  '数据智能': ['数智', '数智公司', '数据智能', '联通数智'],
  '财务': ['财务公司', '联通财务', '财务'],
  '支付': ['支付公司', '联通支付', '支付'],
  '国际': ['国际公司', '联通国际', '国际'],
  '华盛通信': ['华盛', '华盛通信', '华盛公司', '联通华盛'],
  '华盛': ['华盛', '华盛通信', '华盛公司', '联通华盛'],
  '中讯': ['中讯邮电', '中讯设计院', '中讯院', '中讯', '中讯咨询'],
  '融资租赁': ['融资租赁', '租赁公司', '联通租赁', '租赁'],
  '党校': ['党校', '联通党校'],
  '人才发展': ['人才发展', '人才发展中心', '人才中心', '联通人才中心'],
  '研究院': ['联通研究院', '研究院', '联通院'],
};

export function normalizeMatchText(value = '') {
  return String(value ?? '')
    .toLocaleLowerCase()
    .replace(/\.[a-z0-9]{1,5}$/i, '')
    .replace(/[\s_\-—(),，。:：/\\【】\[\]（）]+/g, '');
}

export function extractCompanyLabels(name = '') {
  const raw = String(name ?? '').trim();
  if (!raw) return [];
  const labels = [];
  const parenRegex = /[（\(]([^）\)]+)[）\)]/g;
  let match;
  while ((match = parenRegex.exec(raw)) !== null) {
    const inside = match[1].trim();
    if (inside) labels.push(inside);
  }
  const outside = raw.replace(/[（\(][^）\)]+[）\)]/g, '').trim();
  if (outside) labels.push(outside);
  if (!labels.length) labels.push(raw);
  return labels;
}

export function expandCompanyTerms(option = {}) {
  const name = option.name ?? '';
  const aliases = Array.isArray(option.aliases) ? option.aliases : [];
  const baseLabels = [];
  for (const item of [name, ...aliases]) {
    baseLabels.push(...extractCompanyLabels(item));
  }

  const termMap = new Map();
  const addTerm = (term, method, priority) => {
    const clean = normalizeMatchText(term);
    if (!clean || clean.length < 2) return;
    const existing = termMap.get(clean);
    if (!existing || existing.priority < priority) {
      termMap.set(clean, { method, priority });
    }
  };

  for (const label of baseLabels) {
    const clean = normalizeMatchText(label);
    if (!clean) continue;
    const isDirectName = normalizeMatchText(name) === clean;
    addTerm(clean, isDirectName ? 'name_exact' : 'alias_exact', isDirectName ? 100 : 90);

    // Strip suffix
    let strippedSuffix = clean;
    for (const suffix of COMMON_SUFFIXES) {
      if (strippedSuffix.endsWith(suffix) && strippedSuffix.length > suffix.length) {
        strippedSuffix = strippedSuffix.slice(0, -suffix.length);
        addTerm(strippedSuffix, isDirectName ? 'name_exact' : 'core_exact', isDirectName ? 95 : 85);
        break;
      }
    }

    // Strip prefix
    let core = strippedSuffix;
    for (const prefix of COMMON_PREFIXES) {
      if (core.startsWith(prefix) && core.length > prefix.length) {
        core = core.slice(prefix.length);
        addTerm(core, 'core_exact', 85);
        break;
      }
    }

    // Also strip prefix from clean directly (e.g. 中国联通研究院 -> 研究院)
    for (const prefix of COMMON_PREFIXES) {
      if (clean.startsWith(prefix) && clean.length > prefix.length) {
        const withoutPrefix = clean.slice(prefix.length);
        addTerm(withoutPrefix, 'core_exact', 86);
        break;
      }
    }

    if (core.length >= 2) {
      addTerm(core, 'core_exact', 85);
      if (!core.endsWith('公司')) {
        addTerm(`${core}公司`, 'core_exact', 86);
      }
      if (!core.startsWith('联通')) {
        addTerm(`联通${core}`, 'core_exact', 87);
      }
    }

    // Check domain abbreviations
    for (const [key, abbrs] of Object.entries(UNICOM_DOMAIN_ALIASES)) {
      if (key === '研究院' && clean.includes('软件')) continue;
      if (clean.includes(key)) {
        for (const abbr of abbrs) {
          addTerm(abbr, 'abbr_exact', 88);
        }
      }
    }
  }

  return [...termMap.entries()].map(([term, meta]) => ({ term, ...meta }));
}

function emails(option) {
  return [...new Set((Array.isArray(option?.emails) ? option.emails : [option?.email])
    .map((value) => String(value ?? '').trim().toLowerCase())
    .filter(Boolean))];
}

export function scoreFile(fileName, option) {
  const cleanFile = normalizeMatchText(fileName);
  if (!cleanFile) return null;
  const terms = expandCompanyTerms(option);
  let best = null;

  for (const item of terms) {
    const { term, method, priority } = item;
    let score = 0;
    let matchMethod = method;
    let isFull = false;

    if (cleanFile === term) {
      score = 0.98 + (priority >= 100 ? 0.01 : 0);
      isFull = true;
    } else if (cleanFile.startsWith(term) || cleanFile.endsWith(term)) {
      score = 0.88 + Math.min((term.length / cleanFile.length) * 0.06, 0.06);
    } else if (cleanFile.includes(term)) {
      score = 0.86 + Math.min((term.length / cleanFile.length) * 0.06, 0.06);
    } else if (term.includes(cleanFile) && cleanFile.length >= 2) {
      score = 0.84 + Math.min((cleanFile.length / term.length) * 0.06, 0.06);
      matchMethod = 'core_exact';
    }

    if (score > 0 && (!best || score > best.score || (Math.abs(score - best.score) < 0.001 && term.length > best.term.length))) {
      best = { score, method: matchMethod, term, label: option.name, isFull };
    }
  }

  if (best && best.score >= 0.8) return best;

  // Fuzzy character overlap fallback
  const fileChars = new Set([...cleanFile]);
  let bestFuzzy = null;
  for (const item of terms) {
    const { term } = item;
    if (term.length < 2) continue;
    const termChars = new Set([...term]);
    const overlap = [...termChars].filter((c) => fileChars.has(c)).length;
    const ratio = overlap / termChars.size;
    if (ratio >= 0.75) {
      const fuzzyScore = 0.70 + Math.min(ratio - 0.75, 0.10);
      if (!bestFuzzy || fuzzyScore > bestFuzzy.score) {
        bestFuzzy = { score: fuzzyScore, method: 'fuzzy', term, label: option.name, isFull: false };
      }
    }
  }

  return bestFuzzy;
}

export function extractFolderNames(file = {}) {
  const rel = String(file.relativePath ?? file.relative_path ?? '').replace(/\\/g, '/');
  const parts = rel.split('/').filter(Boolean);
  const folders = [];
  if (parts.length > 1) {
    folders.push(...parts.slice(0, -1));
  }
  const full = String(file.filePath ?? file.path ?? '').replace(/\\/g, '/');
  const fullParts = full.split('/').filter(Boolean);
  if (fullParts.length > 1) {
    const parent = fullParts[fullParts.length - 2];
    if (parent && !folders.includes(parent)) {
      folders.push(parent);
    }
  }
  return folders;
}

export function matchAttachment(file, options = []) {
  const folderNames = extractFolderNames(file);
  const candidates = options.map((option) => {
    const fileResult = scoreFile(file.name, option);
    if (fileResult && fileResult.score >= 0.8) {
      return { option, ...fileResult };
    }
    for (const folder of folderNames) {
      const folderResult = scoreFile(folder, option);
      if (folderResult) {
        const method = folderResult.method.startsWith('folder_') ? folderResult.method : `folder_${folderResult.method}`;
        return { option, ...folderResult, method, matchedFromFolder: folder };
      }
    }
    return fileResult ? { option, ...fileResult } : null;
  }).filter(Boolean).sort((left, right) => right.score - left.score);
  if (!candidates.length) return { id: file.id, fileName: file.name, filePath: file.path, companyId: '', companyName: '', recipients: [], matchMethod: '', confidence: 0, status: 'unmatched', error: '未找到对应单位' };
  const best = candidates[0];
  const tied = candidates.filter((candidate) => {
    if (best.isFull && !candidate.isFull) return false;
    return Math.abs(candidate.score - best.score) < 0.03;
  });
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
