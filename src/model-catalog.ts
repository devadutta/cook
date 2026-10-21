import { PORTABLE_DEFAULT_PRECEDENCE } from './portable-default.ts';
import type { AgentProvider } from './types.ts';

export interface ModelOption {
  id: string;
  description?: string;
}

export interface ProviderInfo {
  provider: AgentProvider;
  label: string;
  default_model: string;
  credential_env?: string;
}

type FetchFunction = (input: string, init?: RequestInit) => Promise<Response>;

export interface FetchModelsOptions {
  apiKey?: string;
  fetch?: FetchFunction;
  signal?: AbortSignal;
}

const PROVIDER_LABELS: Record<AgentProvider, string> = {
  gateway: 'Vercel AI Gateway',
  openai: 'OpenAI API',
  'openai-codex': 'OpenAI ChatGPT login',
  anthropic: 'Anthropic',
  google: 'Google',
  groq: 'Groq',
};

export const PROVIDERS: ProviderInfo[] = PORTABLE_DEFAULT_PRECEDENCE.map(candidate => ({
  provider: candidate.provider,
  label: PROVIDER_LABELS[candidate.provider],
  default_model: candidate.model,
  credential_env: candidate.credential_env,
}));

export function getProviderInfo(provider: AgentProvider): ProviderInfo {
  const info = PROVIDERS.find(item => item.provider === provider);
  if (!info) {
    throw new Error(`Unknown provider "${provider}"`);
  }
  return info;
}

const GATEWAY_MODELS_URL = 'https://ai-gateway.vercel.sh/v1/models';

function formatTokens(count: number): string {
  if (count >= 1_000_000) {
    return `${Number((count / 1_000_000).toFixed(1))}M`;
  }
  return `${Math.round(count / 1_000)}K`;
}

function formatPerMillion(perToken: string | undefined): string | undefined {
  const value = Number(perToken);
  if (perToken === undefined || !Number.isFinite(value)) {
    return undefined;
  }
  return `$${Number((value * 1_000_000).toFixed(2))}`;
}

function joinDescription(parts: Array<string | undefined>): string | undefined {
  const present = parts.filter((part): part is string => Boolean(part));
  return present.length > 0 ? present.join(' · ') : undefined;
}

function asRecordArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
    : [];
}

function stringField(item: Record<string, unknown>, key: string): string | undefined {
  const value = item[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function numberField(item: Record<string, unknown>, key: string): number | undefined {
  const value = item[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function parseGatewayModels(body: unknown): ModelOption[] {
  const data = asRecordArray((body as { data?: unknown } | null)?.data);

  return data
    .filter(item => item.type === 'language')
    // cook drives everything through tools, so skip models that cannot call them.
    .filter(item => !Array.isArray(item.tags) || item.tags.includes('tool-use'))
    .flatMap(item => {
      const id = stringField(item, 'id');
      if (!id) {
        return [];
      }

      const contextWindow = numberField(item, 'context_window');
      const pricing = (item.pricing ?? {}) as Record<string, string | undefined>;
      const input = formatPerMillion(pricing.input);
      const output = formatPerMillion(pricing.output);

      return [{
        id,
        description: joinDescription([
          contextWindow ? `${formatTokens(contextWindow)} ctx` : undefined,
          input && output ? `${input}/${output} per 1M` : undefined,
        ]),
      }];
    });
}

const OPENAI_CHAT_MODEL = /^(gpt-|o\d|chatgpt-|codex-)/;
const OPENAI_NON_CHAT_MODEL = /(embedding|tts|whisper|dall-e|transcribe|audio|realtime|image|search|moderation)/;

export function parseOpenAIModels(body: unknown): ModelOption[] {
  return asRecordArray((body as { data?: unknown } | null)?.data)
    .filter(item => {
      const id = stringField(item, 'id') ?? '';
      return OPENAI_CHAT_MODEL.test(id) && !OPENAI_NON_CHAT_MODEL.test(id);
    })
    .sort((left, right) => (numberField(right, 'created') ?? 0) - (numberField(left, 'created') ?? 0))
    .map(item => ({ id: String(item.id) }));
}

export function parseAnthropicModels(body: unknown): ModelOption[] {
  return asRecordArray((body as { data?: unknown } | null)?.data).flatMap(item => {
    const id = stringField(item, 'id');
    return id ? [{ id, description: stringField(item, 'display_name') }] : [];
  });
}

const GOOGLE_NON_CHAT_MODEL = /(embedding|image|tts|aqa)/;

export function parseGoogleModels(body: unknown): ModelOption[] {
  return asRecordArray((body as { models?: unknown } | null)?.models)
    .filter(item => {
      const methods = item.supportedGenerationMethods;
      return Array.isArray(methods) && methods.includes('generateContent');
    })
    .flatMap(item => {
      const id = stringField(item, 'name')?.replace(/^models\//, '');
      if (!id || GOOGLE_NON_CHAT_MODEL.test(id)) {
        return [];
      }

      const contextWindow = numberField(item, 'inputTokenLimit');
      return [{
        id,
        description: joinDescription([
          contextWindow ? `${formatTokens(contextWindow)} ctx` : undefined,
          stringField(item, 'displayName'),
        ]),
      }];
    });
}

const GROQ_NON_CHAT_MODEL = /(whisper|tts|guard|playai)/;

export function parseGroqModels(body: unknown): ModelOption[] {
  return asRecordArray((body as { data?: unknown } | null)?.data)
    .filter(item => item.active !== false && !GROQ_NON_CHAT_MODEL.test(stringField(item, 'id') ?? ''))
    .flatMap(item => {
      const id = stringField(item, 'id');
      if (!id) {
        return [];
      }

      const contextWindow = numberField(item, 'context_window');
      return [{
        id,
        description: joinDescription([
          contextWindow ? `${formatTokens(contextWindow)} ctx` : undefined,
          stringField(item, 'owned_by'),
        ]),
      }];
    });
}

async function getJson(
  url: string,
  headers: Record<string, string>,
  options: FetchModelsOptions,
): Promise<unknown> {
  const fetchFn = options.fetch ?? fetch;
  const response = await fetchFn(url, { headers, signal: options.signal });
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`Model list request failed (HTTP ${response.status})`);
  }
  return response.json();
}

function requireApiKey(info: ProviderInfo, apiKey: string | undefined): string {
  if (!apiKey) {
    throw new Error(`Set ${info.credential_env} to list ${info.label} models`);
  }
  return apiKey;
}

export async function fetchProviderModels(
  provider: AgentProvider,
  options: FetchModelsOptions = {},
): Promise<ModelOption[]> {
  const info = getProviderInfo(provider);

  switch (provider) {
    case 'gateway':
      return parseGatewayModels(await getJson(GATEWAY_MODELS_URL, {}, options));
    case 'openai':
      return parseOpenAIModels(await getJson(
        'https://api.openai.com/v1/models',
        { authorization: `Bearer ${requireApiKey(info, options.apiKey)}` },
        options,
      ));
    case 'anthropic':
      return parseAnthropicModels(await getJson(
        'https://api.anthropic.com/v1/models?limit=1000',
        {
          'x-api-key': requireApiKey(info, options.apiKey),
          'anthropic-version': '2023-06-01',
        },
        options,
      ));
    case 'google':
      return parseGoogleModels(await getJson(
        'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000',
        { 'x-goog-api-key': requireApiKey(info, options.apiKey) },
        options,
      ));
    case 'groq':
      return parseGroqModels(await getJson(
        'https://api.groq.com/openai/v1/models',
        { authorization: `Bearer ${requireApiKey(info, options.apiKey)}` },
        options,
      ));
    case 'openai-codex':
      // The ChatGPT backend has no public model listing; fall back to the default.
      return [];
  }
}
