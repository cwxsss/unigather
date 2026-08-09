export const DEFAULT_MATERIAL_PATH = 'D:\\UniGather\\Materials';

export function normalizeMaterialPath(value) {
  const path = String(value ?? '').trim();
  return path || DEFAULT_MATERIAL_PATH;
}
