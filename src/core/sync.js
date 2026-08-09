function toDateTimeLocal(date) {
  const value = new Date(date);
  if (Number.isNaN(value.getTime())) return '';
  value.setMinutes(value.getMinutes() - value.getTimezoneOffset());
  return value.toISOString().slice(0, 16);
}

export function defaultInboxStartTime(now = new Date()) {
  const date = new Date(now);
  date.setDate(date.getDate() - 7);
  return toDateTimeLocal(date);
}

export function normalizeInboxStartTime(value, now = new Date()) {
  const text = String(value ?? '').trim();
  return text || defaultInboxStartTime(now);
}
