const DEFAULT_DIRECTORY = 'D:\\UniGather\\Materials';

export function splitKeywords(value) {
  const source = String(value ?? '');
  const keywords = [];
  let marker = '+';
  let buffer = '';
  const flush = () => {
    const keyword = buffer.trim();
    if (keyword) keywords.push(`${marker}${keyword}`);
    buffer = '';
  };

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (character === '\\' && index + 1 < source.length && '+-\\'.includes(source[index + 1])) {
      buffer += source[index + 1];
      index += 1;
    } else if (character === '+' || character === '-') {
      flush();
      marker = character;
    } else if (character === ',' || character === '，' || character === '\n') {
      flush();
    } else {
      buffer += character;
    }
  }
  flush();
  return keywords;
}

export function formatKeywords(keywords) {
  return (Array.isArray(keywords) ? keywords : [])
    .map((value) => {
      const keyword = String(value ?? '').trim();
      if (!keyword) return '';
      const hasMarker = keyword[0] === '+' || keyword[0] === '-';
      const marker = hasMarker ? keyword[0] : '+';
      const term = hasMarker ? keyword.slice(1) : keyword;
      if (!term) return '';
      const escaped = term.replace(/\\/g, '\\\\').replace(/[+-]/g, '\\$&');
      return `${marker}${escaped}`;
    })
    .filter(Boolean)
    .join('');
}

export function validateTaskInput(values) {
  const errors = {};
  if (!String(values.name ?? '').trim()) errors.name = '请输入任务名称';
  if (!String(values.deadline ?? '').trim()) errors.deadline = '请选择截止时间';
  if (String(values.startTime ?? '').trim() && String(values.deadline ?? '').trim()) {
    const start = Date.parse(values.startTime);
    const deadline = Date.parse(values.deadline);
    if (!Number.isNaN(start) && !Number.isNaN(deadline) && start > deadline) errors.startTime = '起始时间不能晚于截止时间';
  }
  return errors;
}

export function buildTaskInput(values) {
  return {
    name: String(values.name ?? '').trim(),
    material_name: String(values.materialName ?? '').trim() || String(values.name ?? '').trim(),
    company_ids: Array.isArray(values.companyIds) ? values.companyIds : [],
    subject_keywords: splitKeywords(values.subjectKeywords),
    body_keywords: splitKeywords(values.bodyKeywords),
    deadline: String(values.deadline ?? ''),
    start_time: String(values.startTime ?? '').trim(),
    poll_minutes: Number(values.pollMinutes) || 30,
    save_directory: String(values.saveDirectory ?? '').trim() || DEFAULT_DIRECTORY,
    filename_template: String(values.filenameTemplate ?? '{task}_{company}_{filename}').trim(),
    ai_enabled: Boolean(values.aiEnabled),
  };
}

export function taskStatusLabel(status) {
  return { active: '进行中', paused: '已中断', completed: '已完成', deleted: '已删除' }[status] ?? '未开始';
}

export function taskProgressPercent(task = {}) {
  const total = Number(task.total_companies) || 0;
  const confirmed = Math.max(0, Number(task.confirmed_companies) || 0);
  return total ? Math.min(100, Math.round((confirmed / total) * 100)) : 0;
}

export function normalizeFeedbackPage({ page, pageSize, total } = {}) {
  const normalizedPageSize = [10, 20, 31, 40, 50].includes(Number(pageSize)) ? Number(pageSize) : 20;
  const normalizedTotal = Math.max(0, Number(total) || 0);
  const pageCount = Math.max(1, Math.ceil(normalizedTotal / normalizedPageSize));
  return { page: Math.min(Math.max(1, Number(page) || 1), pageCount), pageSize: normalizedPageSize, pageCount };
}

export function nextFeedbackPage({ page, pageCount } = {}, action) {
  const current = Math.max(1, Number(page) || 1);
  const maximum = Math.max(1, Number(pageCount) || 1);
  if (action === 'filter-change' || action === 'page-size-change') return 1;
  if (action === 'next') return Math.min(maximum, current + 1);
  if (action === 'previous') return Math.max(1, current - 1);
  return current;
}
