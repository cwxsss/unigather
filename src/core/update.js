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
