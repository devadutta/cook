import { describe, expect, it } from 'bun:test';
import {
  PROVIDERS,
  fetchProviderModels,
  parseAnthropicModels,
  parseGatewayModels,
  parseGoogleModels,
  parseGroqModels,
  parseOpenAICodexModels,
  parseOpenAIModels,
} from '../src/model-catalog.ts';
import { PORTABLE_DEFAULT_PRECEDENCE } from '../src/portable-default.ts';

describe('model catalog', () => {
  it('lists every provider with its portable default model', () => {
    expect(PROVIDERS.map(info => [info.provider, info.default_model])).toEqual(
      PORTABLE_DEFAULT_PRECEDENCE.map(candidate => [candidate.provider, candidate.model]),
    );
  });

  it('keeps tool-capable gateway language models and describes them', () => {
    const models = parseGatewayModels({
      data: [
        {
          id: 'anthropic/claude-sonnet-4.6',
          type: 'language',
          tags: ['tool-use', 'reasoning'],
          context_window: 1_000_000,
          pricing: { input: '0.000003', output: '0.000015' },
        },
        { id: 'google/gemini-3-pro-image', type: 'language', tags: ['vision'] },
        { id: 'openai/text-embedding-3-small', type: 'embedding', tags: [] },
        { id: 'alibaba/qwen-3-14b', type: 'language', tags: ['tool-use'], context_window: 40_960 },
      ],
    });

    expect(models).toEqual([
      { id: 'anthropic/claude-sonnet-4.6', description: '1M ctx · $3/$15 per 1M' },
      { id: 'alibaba/qwen-3-14b', description: '41K ctx' },
    ]);
  });

  it('keeps OpenAI chat models, newest first', () => {
    const models = parseOpenAIModels({
      data: [
        { id: 'gpt-5.1', created: 10 },
        { id: 'text-embedding-3-large', created: 30 },
        { id: 'gpt-5.2', created: 20 },
        { id: 'gpt-realtime', created: 40 },
        { id: 'o4-mini', created: 5 },
        { id: 'whisper-1', created: 50 },
      ],
    });
    expect(models.map(model => model.id)).toEqual(['gpt-5.2', 'gpt-5.1', 'o4-mini']);
  });

  it('parses Anthropic, Google, and Groq model lists', () => {
    expect(parseAnthropicModels({
      data: [{ id: 'claude-sonnet-4-6', display_name: 'Claude Sonnet 4.6' }],
    })).toEqual([{ id: 'claude-sonnet-4-6', description: 'Claude Sonnet 4.6' }]);

    expect(parseGoogleModels({
      models: [
        {
          name: 'models/gemini-3-flash-preview',
          displayName: 'Gemini 3 Flash',
          inputTokenLimit: 1_048_576,
          supportedGenerationMethods: ['generateContent', 'countTokens'],
        },
        { name: 'models/text-embedding-004', supportedGenerationMethods: ['embedContent'] },
        { name: 'models/gemini-3-pro-image', supportedGenerationMethods: ['generateContent'] },
      ],
    })).toEqual([{ id: 'gemini-3-flash-preview', description: '1M ctx · Gemini 3 Flash' }]);

    expect(parseGroqModels({
      data: [
        { id: 'moonshotai/kimi-k2-instruct-0905', owned_by: 'Moonshot AI', context_window: 262_144 },
        { id: 'whisper-large-v3', owned_by: 'OpenAI' },
        { id: 'retired-model', active: false },
      ],
    })).toEqual([{ id: 'moonshotai/kimi-k2-instruct-0905', description: '262K ctx · Moonshot AI' }]);
  });

  it('keeps the ChatGPT models Codex lists, in its order', () => {
    expect(parseOpenAICodexModels({
      models: [
        { slug: 'gpt-5.6-sol', visibility: 'list', priority: 6, context_window: 272_000, description: 'Older generation workhorse model.' },
        { slug: 'codex-auto-review', visibility: 'hide', priority: 43 },
        { slug: 'gpt-6.1-sol', visibility: 'list', priority: 1, context_window: 500_000, description: 'Latest workhorse model.' },
        { slug: 'gpt-unranked', visibility: 'list' },
      ],
    })).toEqual([
      { id: 'gpt-6.1-sol', description: '500K ctx · Latest workhorse model' },
      { id: 'gpt-5.6-sol', description: '272K ctx · Older generation workhorse model' },
      { id: 'gpt-unranked', description: undefined },
    ]);
  });

  it('tolerates unexpected response shapes', () => {
    expect(parseGatewayModels(null)).toEqual([]);
    expect(parseOpenAIModels({ data: 'nope' })).toEqual([]);
    expect(parseGoogleModels({})).toEqual([]);
  });

  it('asks for a key before calling keyed providers', async () => {
    let called = false;
    const fetch = async () => {
      called = true;
      return new Response('{}');
    };
    await expect(fetchProviderModels('openai', { fetch })).rejects.toThrow(
      'Set OPENAI_API_KEY to list OpenAI API models',
    );
    expect(called).toBe(false);
  });

  it('sends provider auth headers and reports HTTP failures', async () => {
    const requests: Array<{ url: string; headers: Headers }> = [];
    const fetch = async (url: string, init?: RequestInit) => {
      requests.push({ url, headers: new Headers(init?.headers) });
      return url.includes('anthropic')
        ? new Response('{"data":[{"id":"claude-x"}]}')
        : new Response('unauthorized', { status: 401 });
    };

    expect(await fetchProviderModels('anthropic', { apiKey: 'ant-key', fetch })).toEqual([
      { id: 'claude-x', description: undefined },
    ]);
    expect(requests[0]?.headers.get('x-api-key')).toBe('ant-key');
    expect(requests[0]?.headers.get('anthropic-version')).toBe('2023-06-01');

    await expect(fetchProviderModels('groq', { apiKey: 'groq-key', fetch })).rejects.toThrow(
      'The API key was rejected (HTTP 401)',
    );
    expect(requests[1]?.headers.get('authorization')).toBe('Bearer groq-key');
  });

  it('lists gateway models without a key', async () => {
    const fetch = async (url: string) => {
      expect(url).toBe('https://ai-gateway.vercel.sh/v1/models');
      return new Response('{"data":[{"id":"openai/gpt-5","type":"language"}]}');
    };
    expect(await fetchProviderModels('gateway', { fetch })).toEqual([
      { id: 'openai/gpt-5', description: undefined },
    ]);
  });

  it('lists ChatGPT models for every client version through the login fetch', async () => {
    const urls: string[] = [];
    const fetch = async (url: string) => {
      urls.push(url);
      return urls.length === 1
        ? new Response('{"models":[{"slug":"gpt-6.1-sol","visibility":"list"}]}')
        : new Response('expired', { status: 401 });
    };
    expect(await fetchProviderModels('openai-codex', { fetch })).toEqual([
      { id: 'gpt-6.1-sol', description: undefined },
    ]);
    expect(new URL(urls[0]!).searchParams.get('client_version')).toBe('9999.0.0');
    await expect(fetchProviderModels('openai-codex', { fetch })).rejects.toThrow(
      'The ChatGPT login was rejected (HTTP 401)',
    );
  });
});
