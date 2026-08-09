const invalidChars = /[<>:"/\\|?*\u0000-\u001F]/g;

const safePart = (value) => String(value ?? '').replace(invalidChars, '_').replace(/\s+/g, ' ').trim() || '未命名';

export function buildAttachmentName(taskName, companyName, originalName, existingNames) {
  const original = safePart(originalName);
  const extensionIndex = original.lastIndexOf('.');
  const base = extensionIndex > 0 ? original.slice(0, extensionIndex) : original;
  const extension = extensionIndex > 0 ? original.slice(extensionIndex) : '';
  const prefix = `${safePart(taskName)}_${safePart(companyName)}_${base}`;
  let candidate = `${prefix}${extension}`;
  let index = 1;
  while (existingNames.has(candidate)) candidate = `${prefix}_${index++}${extension}`;
  return candidate;
}
