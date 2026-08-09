export const DEFAULT_AI_ENDPOINT = 'https://api.openai.com/v1';
export const DEFAULT_AI_MODEL = 'gpt-4o-mini';

export function normalizeAiConfig(values = {}) {
  return {
    enabled: Boolean(values.enabled),
    endpoint: String(values.endpoint ?? '').trim() || DEFAULT_AI_ENDPOINT,
    model: String(values.model ?? '').trim() || DEFAULT_AI_MODEL,
    apiKey: String(values.apiKey ?? ''),
  };
}

export function validateAiConfig(values = {}) {
  const config = normalizeAiConfig(values);
  if (!config.enabled) return {};
  const errors = {};
  if (!String(values.endpoint ?? '').trim()) errors.endpoint = '请输入 AI API 地址';
  if (!String(values.model ?? '').trim()) errors.model = '请输入 AI 模型名称';
  if (!config.apiKey.trim()) errors.apiKey = '启用 AI 后请输入 API Key';
  return errors;
}
