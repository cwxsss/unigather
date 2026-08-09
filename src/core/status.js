export function getFeedbackStatus({ confirmed, deadline }, now = new Date()) {
  if (confirmed) return 'confirmed';
  const due = new Date(deadline);
  if (Number.isNaN(due.getTime())) return 'pending';
  const remaining = due.getTime() - now.getTime();
  if (remaining < 0) return 'overdue';
  if (remaining <= 24 * 60 * 60 * 1000) return 'due_soon';
  return 'pending';
}
