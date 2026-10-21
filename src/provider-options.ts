import type { JSONValue } from 'ai';
import type { AgentConfig, AgentProvider } from './types.ts';

export const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export const FAST_MODE_PROVIDERS: AgentProvider[] = ['openai', 'openai-codex', 'anthropic'];

type ProviderOptions = Record<string, Record<string, JSONValue>>;
type ThinkingFamily = 'openai' | 'anthropic' | 'google' | 'groq';

// Gemini 2.x takes a token budget; Gemini 3 replaced it with named levels.
const GEMINI_2_BUDGETS: Record<ThinkingLevel, number> = {
  off: 0,
  minimal: 512,
  low: 1_024,
  medium: 8_192,
  high: 16_384,
  xhigh: 24_576,
  max: 24_576,
};

export function isThinkingLevel(value: string): value is ThinkingLevel {
  return (THINKING_LEVELS as readonly string[]).includes(value);
}

export function supportsFastMode(provider: AgentProvider): boolean {
  return FAST_MODE_PROVIDERS.includes(provider);
}

/** Which provider's options apply; gateway models pass them on to their creator. */
function thinkingTarget(
  provider: AgentProvider,
  model: string,
): { family: ThinkingFamily; model: string } | undefined {
  if (provider === 'gateway') {
    const slash = model.indexOf('/');
    const creator = model.slice(0, slash);
    return creator === 'openai' || creator === 'anthropic' || creator === 'google'
      ? { family: creator, model: model.slice(slash + 1) }
      : undefined;
  }
  return { family: provider === 'openai-codex' ? 'openai' : provider, model };
}

/** The provider's own value for a level, clamped to the range it accepts. */
function nativeLevel(family: ThinkingFamily, model: string, level: ThinkingLevel): string | number {
  const capped = level === 'xhigh' || level === 'max' ? 'high' : level;
  switch (family) {
    case 'openai':
      return level === 'off' ? 'none' : level;
    case 'anthropic':
      return level === 'off' ? 'disabled' : level === 'minimal' ? 'low' : level;
    case 'google':
      if (/^gemini-2[.-]/.test(model)) {
        return GEMINI_2_BUDGETS[level];
      }
      return level === 'off' ? 'minimal' : capped;
    case 'groq':
      return level === 'off' ? 'none' : level === 'minimal' ? 'low' : capped;
  }
}

function thinkingOptions(family: ThinkingFamily, native: string | number): Record<string, JSONValue> {
  switch (family) {
    case 'openai':
    case 'groq':
      return { reasoningEffort: native };
    case 'anthropic':
      return native === 'disabled'
        ? { thinking: { type: 'disabled' } }
        : { thinking: { type: 'adaptive' }, effort: native };
    case 'google':
      return {
        thinkingConfig: typeof native === 'number' ? { thinkingBudget: native } : { thinkingLevel: native },
      };
  }
}

/** What a level turns into for this provider, or undefined when cook cannot set it. */
export function describeThinking(
  provider: AgentProvider,
  model: string,
  level: ThinkingLevel,
): string | undefined {
  const target = thinkingTarget(provider, model);
  if (!target) {
    return undefined;
  }

  const native = nativeLevel(target.family, target.model, level);
  switch (target.family) {
    case 'openai':
    case 'groq':
      return `reasoning effort ${native}`;
    case 'anthropic':
      return native === 'disabled' ? 'thinking disabled' : `adaptive thinking, effort ${native}`;
    case 'google':
      return typeof native === 'number' ? `thinking budget ${native} tokens` : `thinking level ${native}`;
  }
}

export function providerOptionsFor(
  agent: Pick<AgentConfig, 'provider' | 'model' | 'thinking' | 'fast'>,
): ProviderOptions | undefined {
  const options: ProviderOptions = {};
  const add = (key: string, values: Record<string, JSONValue>) => {
    options[key] = { ...options[key], ...values };
  };

  if (agent.provider === 'openai-codex') {
    add('openai', { store: false });
  }

  const target = agent.thinking ? thinkingTarget(agent.provider, agent.model) : undefined;
  if (agent.thinking && target) {
    const values = thinkingOptions(target.family, nativeLevel(target.family, target.model, agent.thinking));
    add(target.family, values);
    if (agent.provider === 'gateway' && target.family === 'google') {
      // The gateway can serve Gemini through Vertex AI, which reads its own key.
      add('vertex', values);
    }
  }

  if (agent.fast) {
    if (agent.provider === 'openai' || agent.provider === 'openai-codex') {
      add('openai', { serviceTier: 'priority' });
    } else if (agent.provider === 'anthropic') {
      add('anthropic', { speed: 'fast' });
    }
  }

  return Object.keys(options).length > 0 ? options : undefined;
}
