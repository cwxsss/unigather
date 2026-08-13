function localInputValue(date) {
  const offset = date.getTimezoneOffset();
  const local = new Date(date.getTime() - offset * 60 * 1000);
  const iso = local.toISOString();
  return `${iso.slice(0, 10)}T${iso.slice(11, 16)}`;
}

export function formatCompanyOptionMeta(option = {}) {
  const contacts = (option.contacts ?? []).filter(Boolean);
  const count = Number(option.emailCount ?? option.emails?.length ?? 0);
  return {
    contactLabel: contacts.length ? contacts.join('、') : '未填写联系人',
    emailLabel: `${Number.isFinite(count) ? count : 0} 个邮箱`,
  };
}

export function buildTimePresetRange(preset, now = new Date()) {
  const end = new Date(now);
  const start = new Date(now);
  if (preset === 'last7days') start.setDate(start.getDate() - 7);
  if (preset === 'today') {
    start.setHours(0, 0, 0, 0);
  }
  if (preset === 'now') return { start: localInputValue(start), end: localInputValue(end) };
  return { start: localInputValue(start), end: localInputValue(end) };
}

export function validateTimeRange(start, end) {
  const errors = {};
  if (!String(start ?? '').trim()) errors.startTime = '请选择查收起始时间';
  if (!String(end ?? '').trim()) errors.deadline = '请选择截止时间';
  if (!errors.startTime && !errors.deadline) {
    const startValue = Date.parse(start);
    const endValue = Date.parse(end);
    if (!Number.isNaN(startValue) && !Number.isNaN(endValue) && startValue > endValue) errors.startTime = '起始时间不能晚于截止时间';
  }
  return errors;
}
