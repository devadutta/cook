import { createColors } from 'picocolors';
import type { MutationRecord } from './types.ts';

export function printStderr(message: string): void {
  process.stderr.write(`${message}\n`);
}

export function printStdout(message: string): void {
  if (!message.endsWith('\n')) {
    process.stdout.write(`${message}\n`);
    return;
  }

  process.stdout.write(message);
}

function getColors() {
  return createColors(Boolean(process.stderr.isTTY));
}

export function createDebugLogger(
  debug: boolean,
  emit: (message: string) => void = printStderr,
): (message: string) => void {
  return (message: string) => {
    if (!debug) {
      return;
    }

    const c = getColors();
    emit(`${c.dim('[debug]')} ${message}`);
  };
}

export function formatToolCommand(toolName: string, command: string): string {
  const c = getColors();
  return c.dim(`[${toolName.toLowerCase()}] ${command}`);
}

export function createToolCommandLogger(
  debug: boolean,
  emit: (message: string) => void = printStderr,
): (toolName: string, command: string) => void {
  return (toolName: string, command: string) => {
    if (!debug) {
      return;
    }

    emit(formatToolCommand(toolName, command));
  };
}

export function formatMutationPlan(plan: MutationRecord[], title: string): string {
  const c = getColors();
  const lines = [`${c.bold(c.cyan(title))}`];

  for (const [index, entry] of plan.entries()) {
    lines.push(`  ${c.bold(String(index + 1) + '.')} ${entry.tool}: ${entry.summary}`);
  }

  return lines.join('\n');
}

export function printMutationPlan(plan: MutationRecord[], title: string): void {
  printStderr(formatMutationPlan(plan, title));
}

export function formatAgentLoaded(agentName: string): string {
  const c = getColors();
  return `${c.dim('[cook]')} ${agentName}`;
}

export function printAgentLoaded(agentName: string): void {
  printStderr(formatAgentLoaded(agentName));
}
