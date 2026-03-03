import { describe, expect, it } from 'bun:test';
import { rewriteKnownErrorMessage } from '../src/cli.ts';

describe('rewriteKnownErrorMessage', () => {
  it('rewrites AI Gateway unauthenticated errors with provider key guidance', () => {
    const raw = [
      'Unauthenticated request to AI Gateway.',
      '',
      'To authenticate, set the AI_GATEWAY_API_KEY environment variable with your API key.',
      '',
      'Alternatively, you can use a provider module instead of the AI Gateway.',
      '',
      'Learn more: https://ai-sdk.dev/unauthenticated-ai-gateway',
    ].join('\n');

    const message = rewriteKnownErrorMessage(raw);
    expect(message).toContain('Set one of these API keys');
    expect(message).toContain('cook config init');
    expect(message).toContain('AI_GATEWAY_API_KEY');
    expect(message).toContain('OPENAI_API_KEY');
    expect(message).toContain('ANTHROPIC_API_KEY');
    expect(message).toContain('GOOGLE_GENERATIVE_AI_API_KEY');
    expect(message).toContain('GROQ_API_KEY');
    expect(message).not.toContain('provider module');
  });

  it('passes through unknown errors unchanged', () => {
    const raw = 'some other failure';
    expect(rewriteKnownErrorMessage(raw)).toBe(raw);
  });
});
