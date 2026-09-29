const normalize = (value) => String(value ?? '').trim().toLocaleLowerCase();

const matchKeywords = (value, keywords = []) => {
  const normalized = normalize(value);
  const positive = [];
  const negative = [];
  keywords.forEach((value) => {
    const keyword = normalize(value);
    if (!keyword) return;
    if (keyword.startsWith('-')) negative.push(keyword.slice(1));
    else positive.push(keyword.startsWith('+') ? keyword.slice(1) : keyword);
  });
  return {
    positiveConfigured: positive.length > 0,
    positiveMatches: positive.some((keyword) => keyword && normalized.includes(keyword)),
    excluded: negative.some((keyword) => keyword && normalized.includes(keyword)),
  };
};

const matchesTask = (message, task) => {
  const senderMatches = task.companyEmails.some((email) => normalize(email) === normalize(message.sender));
  const subjectRule = matchKeywords(message.subject, task.subjectKeywords);
  const bodyRule = matchKeywords(message.body, task.bodyKeywords);
  const positiveConfigured = subjectRule.positiveConfigured || bodyRule.positiveConfigured;
  const positiveMatches = !positiveConfigured
    || (subjectRule.positiveConfigured && subjectRule.positiveMatches)
    || (bodyRule.positiveConfigured && bodyRule.positiveMatches);
  const excluded = subjectRule.excluded || bodyRule.excluded;
  return {
    senderMatches,
    subjectMatches: subjectRule.positiveMatches,
    bodyMatches: bodyRule.positiveMatches,
    matched: senderMatches && positiveMatches && !excluded,
  };
};

export function matchMessageToTask(message, taskOrTasks) {
  const tasks = Array.isArray(taskOrTasks) ? taskOrTasks : [taskOrTasks];
  const matches = tasks.filter((task) => matchesTask(message, task).matched);

  if (matches.length === 0) return { status: 'unmatched', taskIds: [] };
  if (matches.length > 1) return { status: 'needs_review', taskIds: matches.map((task) => task.id) };

  const task = matches[0];
  const details = matchesTask(message, task);
  const result = {
    status: 'confirmed',
    reason: details.senderMatches && details.subjectMatches
      ? 'sender_and_subject'
      : details.senderMatches && details.bodyMatches
        ? 'sender_and_body'
        : 'rule_match',
  };
  if (task.id) result.taskId = task.id;
  return result;
}
