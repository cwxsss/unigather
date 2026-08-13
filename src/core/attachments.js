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

export function decodeCsvBuffer(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const hasUtf8Bom = bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF;
  if (hasUtf8Bom) return new TextDecoder('utf-8').decode(bytes);
  const utf8 = new TextDecoder('utf-8').decode(bytes);
  return utf8.includes('\uFFFD') ? new TextDecoder('gb18030').decode(bytes) : utf8;
}

function parseCompanyMatrixRows(header, rows) {
  const nameIndex = header.findIndex((cell) => /单位|公司|名称/i.test(cell));
  const contactNameIndex = header.findIndex((cell) => /姓名|联系人/i.test(cell));
  const emailIndex = header.findIndex((cell) => /邮箱|email/i.test(cell));
  const phoneIndex = header.findIndex((cell) => /电话|手机|phone|tel/i.test(cell));
  const aliasIndex = header.findIndex((cell) => /别名|简称|alias/i.test(cell));
  if (nameIndex < 0 || emailIndex < 0) throw new Error('导入文件必须包含单位名称和邮箱列');
  return rows.filter((row) => row.some((cell) => String(cell ?? '').trim())).map((row) => {
    const cells = row.map((cell) => String(cell ?? '').trim());
    const emails = cells[emailIndex].split(/[;；\s]+/).map((email) => email.trim()).filter(Boolean);
    if (!cells[nameIndex] || emails.length === 0) throw new Error('存在缺少单位名称或邮箱的行');
    return { name: cells[nameIndex], contactName: contactNameIndex >= 0 ? cells[contactNameIndex] : '', emails, phone: phoneIndex >= 0 ? cells[phoneIndex] : '', aliases: aliasIndex >= 0 ? cells[aliasIndex].split(/[;,，；、]+/).map((alias) => alias.trim()).filter(Boolean) : [] };
  });
}

export function parseCompanyMatrix(matrix) {
  const rows = Array.isArray(matrix) ? matrix : [];
  if (rows.length === 0) return [];
  const header = (Array.isArray(rows[0]) ? rows[0] : []).map((cell) => String(cell ?? '').trim());
  return parseCompanyMatrixRows(header, rows.slice(1));
}

function parseCsvLine(line) {
  const cells = [];
  let cell = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"' && line[index + 1] === '"' && quoted) { cell += '"'; index += 1; continue; }
    if (char === '"') { quoted = !quoted; continue; }
    if (char === ',' && !quoted) { cells.push(cell.trim()); cell = ''; continue; }
    cell += char;
  }
  cells.push(cell.trim());
  return cells;
}

export function parseCompanyRows(csv) {
  const lines = String(csv ?? '').replace(/^\uFEFF/, '').split(/\r?\n/).filter((line) => line.trim());
  if (lines.length === 0) return [];
  return parseCompanyMatrixRows(parseCsvLine(lines.shift()), lines.map(parseCsvLine));
}
