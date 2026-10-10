/** B2 的显式服务配置；不读取 .env、个人 Pi 配置或上传目录。 */
export interface ModelConfig {
  provider: string;
  modelId: string;
  baseUrl: string;
  apiKey: string;
  maxTokensField?: 'max_tokens' | 'max_completion_tokens';
  thinkingProfile?: 'bailian-off' | 'bailian-low';
}

export class ConfigurationError extends Error {
  constructor(field: string) {
    super(`无效或缺少配置：${field}`);
    this.name = 'ConfigurationError';
  }
}

/** 仅测试调用方可以显式允许回环 HTTP；环境变量不能开启此例外。 */
export function readModelConfig(
  env: NodeJS.ProcessEnv = process.env,
  options: { allowLoopbackHttp?: boolean } = {},
): ModelConfig {
  const required = (name: string): string => {
    const value = env[name]?.trim();
    if (!value) throw new ConfigurationError(name);
    return value;
  };
  if (env.APP_MODEL_API && env.APP_MODEL_API !== 'openai-completions') throw new ConfigurationError('APP_MODEL_API');
  const provider = required('APP_MODEL_PROVIDER');
  const modelId = required('APP_MODEL_ID');
  if (!/^[a-z][a-z0-9_-]{0,63}$/.test(provider)) throw new ConfigurationError('APP_MODEL_PROVIDER');
  if (modelId.length > 128 || /[\r\n]/.test(modelId)) throw new ConfigurationError('APP_MODEL_ID');
  let url: URL;
  try { url = new URL(required('APP_MODEL_BASE_URL')); }
  catch { throw new ConfigurationError('APP_MODEL_BASE_URL'); }
  const local = options.allowLoopbackHttp && url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname);
  if ((!local && url.protocol !== 'https:') || url.username || url.password || url.search || url.hash) {
    throw new ConfigurationError('APP_MODEL_BASE_URL');
  }
  const apiKey = required('APP_MODEL_API_KEY');
  if (/[\r\n]/.test(apiKey)) throw new ConfigurationError('APP_MODEL_API_KEY');
  const maxTokensField = env.APP_MODEL_MAX_TOKENS_FIELD;
  if (maxTokensField !== undefined && maxTokensField !== 'max_tokens' && maxTokensField !== 'max_completion_tokens') {
    throw new ConfigurationError('APP_MODEL_MAX_TOKENS_FIELD');
  }
  const thinkingProfile = env.APP_MODEL_THINKING_PROFILE;
  if (thinkingProfile !== undefined && thinkingProfile !== 'bailian-off' && thinkingProfile !== 'bailian-low') {
    throw new ConfigurationError('APP_MODEL_THINKING_PROFILE');
  }
  return { provider, modelId, baseUrl: url.toString().replace(/\/$/, ''), apiKey,
    ...(maxTokensField ? { maxTokensField } : {}),
    ...(thinkingProfile !== undefined ? { thinkingProfile } : {}),
  };
}

/** 显式读取所选模型的端点和已支持兼容项；不读取 apiKey、headers 或执行配置命令。 */
export function readModelConfigFromModels(
  env: NodeJS.ProcessEnv, data: unknown, options: { allowLoopbackHttp?: boolean } = {},
): ModelConfig {
  const object = (v: unknown): Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)
    ? v as Record<string, unknown> : {};
  const provider = object(object(object(data).providers)[env.APP_MODEL_PROVIDER ?? '']);
  const models = provider.models;
  const model = object(Array.isArray(models) ? models.find(m => object(m).id === env.APP_MODEL_ID) : undefined);
  if (!env.APP_MODEL_ID || model.id !== env.APP_MODEL_ID) throw new ConfigurationError('APP_MODEL_SELECTION');
  if ((model.api ?? provider.api) !== 'openai-completions') throw new ConfigurationError('APP_MODEL_API');
  const baseUrl = model.baseUrl ?? provider.baseUrl;
  const maxTokensField = object(model.compat).maxTokensField ?? object(provider.compat).maxTokensField ?? env.APP_MODEL_MAX_TOKENS_FIELD;
  if (maxTokensField !== undefined && maxTokensField !== 'max_tokens' && maxTokensField !== 'max_completion_tokens') {
    throw new ConfigurationError('APP_MODEL_MAX_TOKENS_FIELD');
  }
  return readModelConfig({ ...env, APP_MODEL_API: 'openai-completions',
    APP_MODEL_BASE_URL: typeof baseUrl === 'string' ? baseUrl : undefined,
    APP_MODEL_MAX_TOKENS_FIELD: maxTokensField,
  }, options);
}
