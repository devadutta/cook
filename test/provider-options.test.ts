import { describe, expect, it } from 'bun:test';
import { describeThinking, providerOptionsFor } from '../src/provider-options.ts';

describe('providerOptionsFor', () => {
  it('sends nothing extra by default', () => {
    expect(providerOptionsFor({ provider: 'anthropic', model: 'claude-opus-5-5' })).toBeUndefined();
    expect(providerOptionsFor({ provider: 'openai-codex', model: 'gpt-6-astra' })).toEqual({
      openai: { store: false },
    });
  });

  it('maps thinking levels and fast mode for OpenAI', () => {
    expect(providerOptionsFor({ provider: 'openai', model: 'gpt-6.1-sol', thinking: 'xhigh', fast: true })).toEqual({
      openai: { reasoningEffort: 'xhigh', serviceTier: 'priority' },
    });
    expect(providerOptionsFor({ provider: 'openai-codex', model: 'gpt-6-astra', thinking: 'off', fast: true })).toEqual({
      openai: { store: false, reasoningEffort: 'none', serviceTier: 'priority' },
    });
  });

  it('uses adaptive thinking with effort for Anthropic', () => {
    expect(providerOptionsFor({ provider: 'anthropic', model: 'claude-opus-5-5', thinking: 'minimal', fast: true })).toEqual({
      anthropic: { thinking: { type: 'adaptive' }, effort: 'low', speed: 'fast' },
    });
    expect(providerOptionsFor({ provider: 'anthropic', model: 'claude-opus-4-8', thinking: 'off' })).toEqual({
      anthropic: { thinking: { type: 'disabled' } },
    });
  });

  it('uses levels for Gemini 3 and token budgets for Gemini 2', () => {
    expect(providerOptionsFor({ provider: 'google', model: 'gemini-3-flash-preview', thinking: 'max' })).toEqual({
      google: { thinkingConfig: { thinkingLevel: 'high' } },
    });
    expect(providerOptionsFor({ provider: 'google', model: 'gemini-2.5-flash', thinking: 'off' })).toEqual({
      google: { thinkingConfig: { thinkingBudget: 0 } },
    });
  });

  it('clamps Groq levels to what it accepts', () => {
    expect(providerOptionsFor({ provider: 'groq', model: 'openai/gpt-oss-120b', thinking: 'xhigh' })).toEqual({
      groq: { reasoningEffort: 'high' },
    });
  });

  it('passes thinking through the gateway to the model creator', () => {
    expect(providerOptionsFor({ provider: 'gateway', model: 'anthropic/claude-haiku-5.5', thinking: 'high' })).toEqual({
      anthropic: { thinking: { type: 'adaptive' }, effort: 'high' },
    });
    expect(providerOptionsFor({ provider: 'gateway', model: 'google/gemini-3-flash', thinking: 'low' })).toEqual({
      google: { thinkingConfig: { thinkingLevel: 'low' } },
      vertex: { thinkingConfig: { thinkingLevel: 'low' } },
    });
    expect(providerOptionsFor({ provider: 'gateway', model: 'xai/grok-4', thinking: 'high' })).toBeUndefined();
  });

  it('ignores fast mode where the provider has none', () => {
    expect(providerOptionsFor({ provider: 'groq', model: 'openai/gpt-oss-120b', fast: true })).toBeUndefined();
    expect(providerOptionsFor({ provider: 'gateway', model: 'anthropic/claude-opus-5.5', fast: true })).toBeUndefined();
  });
});

describe('describeThinking', () => {
  it('names what each provider receives', () => {
    expect(describeThinking('openai-codex', 'gpt-6-astra', 'max')).toBe('reasoning effort max');
    expect(describeThinking('anthropic', 'claude-opus-5-5', 'off')).toBe('thinking disabled');
    expect(describeThinking('google', 'gemini-2.5-pro', 'medium')).toBe('thinking budget 8192 tokens');
    expect(describeThinking('gateway', 'xai/grok-4', 'high')).toBeUndefined();
  });
});
