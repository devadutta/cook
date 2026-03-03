import type { CookConfig } from './types.ts';

export const DEFAULT_CONFIG: CookConfig = {
  max_steps: 12,
  bash_timeout_ms: 30_000,
  bash_output_limit_bytes: 1_048_576,
  stdin_inline_max_bytes: 65_536,
  require_confirm_mutations: true,
  allow_outside_cwd: false,
  quiet: false,
  debug: false,
  session_logs: false,
  agents: {
    default: {
      provider: 'gateway',
      model: 'google/gemini-3-flash-preview',
      raw_bash_output: false,
      prompt_files: {
        system_append: [],
      },
      ignore_agents_md: false,
    },
  },
};

export const EXIT_CODES = {
  SUCCESS: 0,
  FAILURE: 1,
  DECLINED: 2,
  NON_TTY_CONFIRMATION_REQUIRED: 3,
  POLICY_VIOLATION: 4,
} as const;
