export function normalizeVersion(version) {
  return String(version ?? '').trim().replace(/^v/i, '').split('-')[0].split('.').map((part) => Number.parseInt(part, 10) || 0).slice(0, 3);
}

export function isNewerVersion(latest, current) {
  const a = normalizeVersion(latest);
  const b = normalizeVersion(current);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] > b[index];
  }
  return false;
}

export function pickInstallerAsset(assets = []) {
  return assets.find((asset) => /UniGather.*(setup\.exe|\.msi)$/i.test(asset?.name ?? '')) ?? null;
}

export function formatDownloadProgress(loaded = 0, total = 0) {
  const current = Math.max(0, Number(loaded) || 0);
  const size = Number(total) || 0;
  if (size > 0) return `${Math.max(0, Math.min(100, Math.round((current / size) * 100)))}%`;
  if (current < 1024) return `${current} B`;
  if (current < 1024 * 1024) return `${(current / 1024).toFixed(1)} KB`;
  return `${(current / (1024 * 1024)).toFixed(1)} MB`;
}
