import type { ConfigFile } from '../config.ts';
import type { EditableOption } from '../config-edit.ts';

export interface OptionSpec {
  key: EditableOption;
  label: string;
  description: string;
  kind: 'boolean' | 'number';
}

export const OPTION_SPECS: OptionSpec[] = [
  {
    key: 'require_confirm_mutations',
    label: 'Confirm mutations',
    description: 'Ask before file writes and destructive commands.',
    kind: 'boolean',
  },
  {
    key: 'max_steps',
    label: 'Max steps',
    description: 'Maximum tool-use iterations per run (1–100).',
    kind: 'number',
  },
  {
    key: 'bash_timeout_ms',
    label: 'Bash timeout (ms)',
    description: 'Bash command timeout in ms (100–3,600,000).',
    kind: 'number',
  },
  {
    key: 'bash_output_limit_bytes',
    label: 'Bash output limit (bytes)',
    description: 'Max captured bash output (1,024–20,971,520).',
    kind: 'number',
  },
  {
    key: 'stdin_inline_max_bytes',
    label: 'Stdin inline limit (bytes)',
    description: 'Piped stdin larger than this is handed over as a temp file (1,024–5,242,880).',
    kind: 'number',
  },
  {
    key: 'allow_outside_cwd',
    label: 'Allow outside cwd',
    description: 'Allow file operations outside the working directory.',
    kind: 'boolean',
  },
  {
    key: 'quiet',
    label: 'Quiet',
    description: 'Suppress status/progress output.',
    kind: 'boolean',
  },
  {
    key: 'debug',
    label: 'Debug',
    description: 'Enable detailed debug logs on stderr.',
    kind: 'boolean',
  },
  {
    key: 'session_logs',
    label: 'Session logs',
    description: 'Record session logs to ~/.cook/sessions/.',
    kind: 'boolean',
  },
];

/** Empty input resets the option to its inherited value. */
export function parseIntegerInput(value: string): number | undefined {
  const normalized = value.trim().replace(/[_,]/g, '');
  if (!normalized) {
    return undefined;
  }
  if (!/^\d+$/.test(normalized)) {
    throw new Error(`"${value}" is not a whole number`);
  }
  return Number(normalized);
}

export function parseListInput(value: string): string[] {
  return value.split(',').map(item => item.trim()).filter(Boolean);
}

export type ValueSource = 'local' | 'global' | 'default';

export function optionSource(
  files: { global: ConfigFile; local: ConfigFile },
  key: keyof ConfigFile,
): ValueSource {
  if (files.local[key] !== undefined) {
    return 'local';
  }
  if (files.global[key] !== undefined) {
    return 'global';
  }
  return 'default';
}

export function agentSource(
  files: { global: ConfigFile; local: ConfigFile },
  agentName: string,
): ValueSource {
  if (files.local.agents?.[agentName]) {
    return 'local';
  }
  if (files.global.agents?.[agentName]) {
    return 'global';
  }
  return 'default';
}
