/** Pi SDK 0.99.1 业务会话：独立内存历史、显式模型与工具、无开发资源继承。 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgentSession, ModelRuntime, SessionManager, SettingsManager, type ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { ModelConfig } from '../../config/env.ts';
import { ExecutionBudget } from './execution-limits.ts';
import { loadProbeResources, loadEvidenceResources, loadReviewResources } from './skill-loader.ts';
import { createDiagnosticFetch, type TransportDiagnostics } from './transport-diagnostics.ts';
import { createModelTransport } from './model-transport.ts';

type SessionRole = 'probe' | 'evidence' | 'review';

function workspacePrefix(role: SessionRole): string {
  if (role === 'probe') return 'tju-b2-session-';
  if (role === 'evidence') return 'tju-evidence-session-';
  return 'tju-review-session-';
}

export async function createBusinessSession(config: ModelConfig, tool: ToolDefinition, budget: ExecutionBudget, role: SessionRole = 'probe') {
  if (role !== 'probe' && role !== 'evidence' && role !== 'review') throw new Error('invalid_session_role');
  // 显式声明的 thinkingProfile 才改变线行为；未声明时完全保持旧默认。
  const profile = config.thinkingProfile;
  if (profile !== undefined && profile !== 'bailian-off' && profile !== 'bailian-low') {
    throw new Error('unsupported_thinking_profile');
  }
  budget.check();
  const workspace = await mkdtemp(join(tmpdir(), workspacePrefix(role)));
  let session: Awaited<ReturnType<typeof createAgentSession>>['session'] | undefined;
  let modelTransport: ReturnType<typeof createModelTransport> | undefined;
  const transport: TransportDiagnostics = { attempts: 0, httpStatuses: [], failureCodes: [] };
  try {
    modelTransport = createModelTransport();
    const fetch = createDiagnosticFetch(modelTransport.fetch, transport);
    const runtime = await ModelRuntime.create({
      authPath: join(workspace, 'auth.json'), modelsPath: null,
      refreshOnCreate: false, allowModelNetwork: false, signal: budget.signal,
    });
    const explicitProfile = profile !== undefined;
    runtime.registerProvider(config.provider, {
      api: 'openai-completions', baseUrl: config.baseUrl, authHeader: true,
      models: [{
        id: config.modelId, name: config.modelId,
        reasoning: explicitProfile,
        input: ['text'],
        // 本任务的保守执行配置，不声明网关实际最大上下文、视觉能力或价格。
        contextWindow: 16_384, maxTokens: budget.limits.maxOutputTokens,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        ...(explicitProfile
          ? {
              compat: {
                thinkingFormat: 'qwen' as const,
                supportsReasoningEffort: true,
                supportsDeveloperRole: false,
                supportsStore: false,
                ...(config.maxTokensField ? { maxTokensField: config.maxTokensField } : {}),
              },
            }
          : config.maxTokensField ? { compat: { maxTokensField: config.maxTokensField } } : {}),
      }],
    });
    // RuntimeCredentials 的临时覆盖；不把密钥当作可执行配置字符串，也不持久化。
    await runtime.setRuntimeApiKey(config.provider, config.apiKey, { signal: budget.signal });
    const model = runtime.getModel(config.provider, config.modelId);
    if (!model) throw new Error('model_unavailable');
    const settings = SettingsManager.inMemory({
      compaction: { enabled: false }, retry: { enabled: false, maxRetries: 0, provider: { maxRetries: 0 } },
      cacheWarming: 'off', enableAnalytics: false, enableInstallTelemetry: false,
      defaultTools: [], packages: [], extensions: [], skills: [], prompts: [], themes: [],
      enableSkillCommands: false, images: { blockImages: true },
    });
    const loader = role === 'review'
      ? await loadReviewResources(workspace, settings)
      : role === 'evidence'
        ? await loadEvidenceResources(workspace, settings)
        : await loadProbeResources(workspace, settings);
    budget.check();
    const thinkingLevel = profile === 'bailian-low' ? 'low' : 'off';
    ({ session } = await createAgentSession({
      cwd: workspace, agentDir: workspace, modelRuntime: runtime, model, thinkingLevel,
      tools: [tool.name], noTools: 'builtin', customTools: [tool], resourceLoader: loader,
      sessionManager: SessionManager.inMemory(workspace), settingsManager: settings,
    }));
    const stream = session.agent.streamFunction;
    session.agent.streamFunction = (requestModel, context, options) => {
      budget.model(context);
      return stream(requestModel, context, {
        ...options, maxTokens: budget.limits.maxOutputTokens, maxRetries: 0,
        fetch,
        signal: options?.signal ? AbortSignal.any([options.signal, budget.signal]) : budget.signal,
      });
    };
    session.agent.toolExecution = 'sequential';
    const activeSession = session;
    const abort = () => activeSession.agent.abort();
    budget.signal.addEventListener('abort', abort, { once: true });
    if (budget.signal.aborted) abort();
    let disposed = false;
    return {
      session: activeSession, workspace, transport,
      resources: {
        skills: loader.getSkills().skills.length,
        contextFiles: loader.getAgentsFiles().agentsFiles.length,
        extensions: loader.getExtensions().extensions.length,
        prompts: loader.getPrompts().prompts.length,
      },
      async dispose() {
        if (disposed) return;
        disposed = true;
        budget.signal.removeEventListener('abort', abort);
        activeSession.dispose();
        await modelTransport?.dispose();
        await rm(workspace, { recursive: true, force: true });
      },
    };
  } catch {
    session?.dispose();
    await modelTransport?.dispose();
    await rm(workspace, { recursive: true, force: true });
    budget.check();
    throw new Error('session_initialization_failed');
  }
}