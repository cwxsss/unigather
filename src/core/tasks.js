const DEFAULT_DIRECTORY = 'D:\\UniGather\\Materials';

export function splitKeywords(value) {
  return String(value ?? '')
    .split(/[,，\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
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
  return { active: '进行中', paused: '已暂停', completed: '已完成' }[status] ?? '未开始';
}

export function taskProgressPercent(task = {}) {
  const total = Number(task.total_companies) || 0;
  const confirmed = Math.max(0, Number(task.confirmed_companies) || 0);
  return total ? Math.min(100, Math.round((confirmed / total) * 100)) : 0;
}
