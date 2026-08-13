function count(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
}

export function normalizeDashboardSummary(value = {}) {
  return {
    collectionTaskCount: count(value.collectionTaskCount ?? value.collection_task_count),
    activeCollectionTasks: count(value.activeCollectionTasks ?? value.active_collection_tasks),
    sendBatchCount: count(value.sendBatchCount ?? value.send_batch_count),
    todayReceived: count(value.todayReceived ?? value.today_received),
    todaySentSuccess: count(value.todaySentSuccess ?? value.today_sent_success),
    todaySentFailure: count(value.todaySentFailure ?? value.today_sent_failure),
    latestReceiveStatus: String(value.latestReceiveStatus ?? value.latest_receive_status ?? '').trim() || '暂无收件记录',
    recentEvents: Array.isArray(value.recentEvents ?? value.recent_events) ? (value.recentEvents ?? value.recent_events) : [],
  };
}

export function dashboardEventLabel(event = {}) {
  if (event.status === 'failed') return '执行失败';
  if (event.kind === 'send') return '邮件发送';
  if (event.kind === 'receive') return '任务收件';
  return '系统动态';
}
