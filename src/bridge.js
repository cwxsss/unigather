export async function invokeCommand(command, args = {}, fallback = null) {
  try {
    if (!window.__TAURI_INTERNALS__) return fallback ? fallback() : null;
    const { invoke } = await import('@tauri-apps/api/core');
    return await invoke(command, args);
  } catch (error) {
    if (fallback) return fallback(error);
    throw error;
  }
}
