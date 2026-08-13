function asTimestamp(value) {
  const timestamp = Number(value);
  return Number.isFinite(timestamp) && timestamp > 0 ? timestamp : null;
}

export function getTaskSchedule(task = {}, lastSyncTimestamp = null, now = Date.now(), nextAnchorTimestamp = null) {
  const lastSyncAt = asTimestamp(lastSyncTimestamp);
  const createdAt = Date.parse(task.created_at ?? task.createdAt ?? '');
  const nextAnchor = asTimestamp(nextAnchorTimestamp);
  const anchor = nextAnchor ?? lastSyncAt ?? (Number.isNaN(createdAt) ? now : createdAt);
  const pollMinutes = Math.max(1, Number(task.poll_minutes ?? task.pollMinutes) || 30);
  const nextSyncAt = anchor + pollMinutes * 60 * 1000;
  const deadline = Date.parse(task.deadline ?? '');
  const initialPending = shouldRunInitialTaskSync(task, lastSyncAt, now);
  const stopped = ['paused', 'completed'].includes(task.status)
    || (!initialPending && !Number.isNaN(deadline) && deadline <= now);

  return { lastSyncAt, nextSyncAt: stopped ? null : (initialPending && deadline <= now ? now : nextSyncAt), stopped };
}

export function formatTaskScheduleTime(timestamp) {
  if (!asTimestamp(timestamp)) return '尚未收件';
  return new Date(timestamp).toLocaleString('zh-CN', {
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

export function formatTaskScheduleCountdown(nextTimestamp, now = Date.now()) {
  if (!asTimestamp(nextTimestamp)) return '已停止';
  const remaining = nextTimestamp - now;
  if (remaining <= 60 * 1000) return '现在';
  const minutes = Math.ceil(remaining / (60 * 1000));
  if (minutes < 60) return `约 ${minutes} 分钟后`;
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  return restMinutes ? `约 ${hours} 小时 ${restMinutes} 分钟后` : `约 ${hours} 小时后`;
}

export function shouldRunInitialTaskSync(task = {}, lastReceiveTimestamp = null) {
  if (task.status !== 'active' || asTimestamp(lastReceiveTimestamp)) return false;
  const start = Date.parse(task.start_time ?? task.startTime ?? '');
  const end = Date.parse(task.deadline ?? '');
  return !Number.isNaN(start) && !Number.isNaN(end) && start <= end;
}
