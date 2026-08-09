export async function invokeCommand(command, args = {}, fallback = null) {
  let invoke;
  try {
    ({ invoke } = await import('@tauri-apps/api/core'));
  } catch (error) {
    if (fallback) return fallback(error);
    throw error;
  }
  return invoke(command, args);
}
