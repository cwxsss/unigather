export function syncProgressPercent(progress = {}) {
  if (progress.status === 'completed') return 100;
  const total = Number(progress.total) || 0;
  const processed = Number(progress.processed) || 0;
  if (!total) return progress.status === 'failed' ? 0 : 5;
  return Math.max(0, Math.min(100, Math.round((processed / total) * 100)));
}

export function syncProgressLabel(progress = {}) {
  if (progress.status === 'completed') return '收件完成';
  if (progress.status === 'failed') return '收件失败';
  if (progress.message) return progress.message;
  return '正在收取邮件…';
}
