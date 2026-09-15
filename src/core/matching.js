const normalize = (value) => String(value ?? '').trim().toLocaleLowerCase();

const includesAny = (value, keywords = []) => {
  const normalized = normalize(value);
  return keywords.length === 0 || keywords.some((keyword) => normalized.includes(normalize(keyword)));
};

const matchesTask = (message, task) => {
  const senderMatches = task.companyEmails.some((email) => normalize(email) === normalize(message.sender));
  const subjectMatches = includesAny(message.subject, task.subjectKeywords);
  const bodyMatches = includesAny(message.body, task.bodyKeywords);
  return { senderMatches, subjectMatches, bodyMatches, matched: senderMatches && subjectMatches && bodyMatches };
};

export function matchMessageToTask(message, taskOrTasks) {
  const tasks = Array.isArray(taskOrTasks) ? taskOrTasks : [taskOrTasks];
  const matches = tasks.filter((task) => matchesTask(message, task).matched);

  if (matches.length === 0) return { status: 'unmatched', taskIds: [] };
  if (matches.length > 1) return { status: 'needs_review', taskIds: matches.map((task) => task.id) };

  const task = matches[0];
  const details = matchesTask(message, task);
  const subjectKeywords = task.subjectKeywords ?? [];
  const bodyKeywords = task.bodyKeywords ?? [];
  const result = {
    status: 'confirmed',
    reason: details.senderMatches && subjectKeywords.length
      ? 'sender_and_subject'
      : details.senderMatches && bodyKeywords.length
        ? 'sender_and_body'
        : 'rule_match',
  };
  if (task.id) result.taskId = task.id;
  return result;
}
