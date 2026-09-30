export const DEFAULT_MATERIAL_PATH = 'D:\\UniGather\\Materials';

export function buildMaterialExportCsv(materials = []) {
  const cell = (value) => {
    const text = String(value ?? '');
    const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
    return `"${safe.replaceAll('"', '""')}"`;
  };
  const rows = [['任务名称', '单位', '附件名称', '来源邮件时间', '当前材料路径', '历史版本路径']];
  for (const material of materials.filter((item) => item.isCurrent)) rows.push([material.taskName, material.companyName, material.name, material.receivedAt, material.savedPath, material.historyPath]);
  return rows.map((row) => row.map(cell).join(',')).join('\r\n');
}

export function normalizeMaterialPath(value) {
  const path = String(value ?? '').trim();
  return path || DEFAULT_MATERIAL_PATH;
}
