const extensionOf = (name) => String(name ?? '').toLocaleLowerCase().split('.').pop() ?? '';

export function classifyAttachment(name, mimeType = '') {
  const extension = extensionOf(name);
  if (['pdf', 'doc', 'docx', 'txt', 'csv'].includes(extension)) return { extension, parseMode: 'text' };
  if (['xls', 'xlsx'].includes(extension)) return { extension, parseMode: 'spreadsheet' };
  if (mimeType.startsWith('image/') || ['png', 'jpg', 'jpeg', 'bmp', 'tif', 'tiff'].includes(extension)) return { extension, parseMode: 'archive_only' };
  return { extension, parseMode: 'archive_only' };
}

export function buildAiPayload({ subject = '', body = '', attachments = [] }) {
  return { subject, body, attachmentNames: attachments.map((attachment) => attachment.name) };
}

export function parseCompanyRows(csv) {
  const lines = String(csv ?? '').split(/\r?\n/).filter((line) => line.trim());
  if (lines.length === 0) return [];
  const header = lines.shift().split(',').map((cell) => cell.trim());
  const nameIndex = header.findIndex((cell) => /单位|公司|名称/i.test(cell));
  const emailIndex = header.findIndex((cell) => /邮箱|email/i.test(cell));
  if (nameIndex < 0 || emailIndex < 0) throw new Error('导入文件必须包含单位名称和邮箱列');
  return lines.map((line) => {
    const cells = line.split(',').map((cell) => cell.trim());
    const emails = cells[emailIndex].split(/[;；\s]+/).map((email) => email.trim()).filter(Boolean);
    if (!cells[nameIndex] || emails.length === 0) throw new Error('存在缺少单位名称或邮箱的行');
    return { name: cells[nameIndex], emails };
  });
}
