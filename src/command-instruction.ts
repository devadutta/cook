import { readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CliError } from './errors.ts';

interface ResolveCommandInstructionOptions {
  instruction: string;
  cwd: string;
  homeDir?: string;
}

interface ResolveCommandInstructionResult {
  instruction: string;
  commandName?: string;
  sourcePath?: string;
}

interface CommandRoot {
  provider: 'cook' | 'cursor' | 'claude' | 'codex';
  directory: string;
}

function parseAliasToken(instruction: string): string | undefined {
  const trimmed = instruction.trim();
  if (!trimmed.startsWith('/')) {
    return undefined;
  }

  const tokens = trimmed.split(/\s+/);
  if (tokens.length !== 1) {
    return undefined;
  }

  const alias = tokens[0]?.slice(1).trim();
  if (!alias) {
    throw new CliError('Missing command name after "/". Example: cook /create-pr');
  }

  if (alias.includes('/') || alias.includes('\\')) {
    throw new CliError(`Invalid command alias "/${alias}". Slashes are not allowed.`);
  }

  return alias;
}

function toCommandFileName(alias: string): string {
  return alias.endsWith('.md') ? alias : `${alias}.md`;
}

async function findExactCommandFile(
  directory: string,
  fileName: string,
): Promise<string | undefined> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return undefined;
  }

  const exact = entries.find(entry => entry.isFile() && entry.name === fileName);
  if (!exact) {
    return undefined;
  }

  return path.join(directory, exact.name);
}

function getCommandRoots(cwd: string, homeDir: string): CommandRoot[] {
  return [
    { provider: 'cook', directory: path.join(cwd, '.cook', 'commands') },
    { provider: 'cook', directory: path.join(cwd, '.cook', 'commnds') }, // legacy typo fallback
    { provider: 'cook', directory: path.join(homeDir, '.cook', 'commands') },

    { provider: 'cursor', directory: path.join(cwd, '.cursor', 'commands') },
    { provider: 'cursor', directory: path.join(homeDir, '.cursor', 'commands') },

    { provider: 'claude', directory: path.join(cwd, '.claude', 'commands') },
    { provider: 'claude', directory: path.join(homeDir, '.claude', 'commands') },

    { provider: 'codex', directory: path.join(cwd, '.codex', 'commands') },
    { provider: 'codex', directory: path.join(cwd, '.codex', 'commads') }, // legacy typo fallback
    { provider: 'codex', directory: path.join(homeDir, '.codex', 'commands') },
    { provider: 'codex', directory: path.join(homeDir, '.codex', 'commads') }, // legacy typo fallback
  ];
}

export async function resolveCommandInstruction(
  options: ResolveCommandInstructionOptions,
): Promise<ResolveCommandInstructionResult> {
  const alias = parseAliasToken(options.instruction);
  if (!alias) {
    return { instruction: options.instruction };
  }

  const homeDir = options.homeDir ?? os.homedir();
  const fileName = toCommandFileName(alias);
  const commandRoots = getCommandRoots(options.cwd, homeDir);

  for (const root of commandRoots) {
    const filePath = await findExactCommandFile(root.directory, fileName);
    if (!filePath) {
      continue;
    }

    const content = await Bun.file(filePath).text();
    const instruction = content.trim();
    if (!instruction) {
      throw new CliError(`Command file is empty: ${filePath}`);
    }

    return {
      instruction,
      commandName: alias,
      sourcePath: filePath,
    };
  }

  const searched = commandRoots
    .map(root => root.directory)
    .join(', ');
  throw new CliError(
    `Command "/${alias}" not found. Expected exact file "${fileName}". Searched: ${searched}`,
  );
}
