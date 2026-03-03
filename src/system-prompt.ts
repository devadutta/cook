import { readdir } from 'node:fs/promises';
import path from 'node:path';
import type { AgentPromptFiles } from './types.ts';

interface BuildSystemPromptOptions {
  cwd: string;
  global_system_path: string;
  local_system_path: string;
  prompt_files?: AgentPromptFiles;
  ignore_agents_md?: boolean;
}

async function fileExists(filePath: string): Promise<boolean> {
  return Bun.file(filePath).exists();
}

async function readRequiredFile(filePath: string): Promise<string> {
  const file = Bun.file(filePath);
  if (!(await file.exists())) {
    throw new Error(`Prompt file not found: ${filePath}`);
  }

  return file.text();
}

function resolveFromCwd(cwd: string, filePath: string): string {
  return path.resolve(cwd, filePath);
}

function wrapSection(source: string, content: string): string {
  return [`[${source}]`, content.trim()].join('\n');
}

async function resolveDefaultSystemPrompt(
  options: BuildSystemPromptOptions,
): Promise<{ source: string; content: string } | undefined> {
  if (await fileExists(options.local_system_path)) {
    return {
      source: options.local_system_path,
      content: await readRequiredFile(options.local_system_path),
    };
  }

  if (await fileExists(options.global_system_path)) {
    return {
      source: options.global_system_path,
      content: await readRequiredFile(options.global_system_path),
    };
  }

  return undefined;
}

async function discoverContextFiles(
  cwd: string,
  ignore_agents_md: boolean,
): Promise<Array<{ source: string; path: string }>> {
  const entries = await readdir(cwd, { withFileTypes: true });
  const filesByLowerName = new Map<string, string>();

  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }

    const key = entry.name.toLowerCase();
    if (!filesByLowerName.has(key)) {
      filesByLowerName.set(key, path.join(cwd, entry.name));
    }
  }

  const orderedTargets: Array<{ name: string; source: string }> = [];
  if (!ignore_agents_md) {
    orderedTargets.push(
      { name: 'agents.md', source: 'AGENTS.md' },
      { name: 'claude.md', source: 'CLAUDE.md' },
    );
  }
  orderedTargets.push({ name: 'cook.md', source: 'cook.md' });

  const discovered: Array<{ source: string; path: string }> = [];
  for (const target of orderedTargets) {
    const found = filesByLowerName.get(target.name);
    if (found) {
      discovered.push({ source: target.source, path: found });
    }
  }

  return discovered;
}

export async function buildSystemPrompt(options: BuildSystemPromptOptions): Promise<string> {
  const sections: string[] = [];
  const promptFiles = options.prompt_files;

  if (promptFiles?.system) {
    const systemPath = resolveFromCwd(options.cwd, promptFiles.system);
    const content = await readRequiredFile(systemPath);
    sections.push(wrapSection(`SYSTEM:${systemPath}`, content));
  } else {
    const defaultSystem = await resolveDefaultSystemPrompt(options);
    if (defaultSystem !== undefined) {
      sections.push(wrapSection(`SYSTEM:${defaultSystem.source}`, defaultSystem.content));
    }
  }

  const appendFiles = promptFiles?.system_append ?? [];
  for (const appendFile of appendFiles) {
    const appendPath = resolveFromCwd(options.cwd, appendFile);
    const content = await readRequiredFile(appendPath);
    sections.push(wrapSection(`SYSTEM_APPEND:${appendPath}`, content));
  }

  const contextFiles = await discoverContextFiles(
    options.cwd,
    Boolean(options.ignore_agents_md),
  );
  for (const contextFile of contextFiles) {
    const content = await readRequiredFile(contextFile.path);
    sections.push(wrapSection(`CONTEXT:${contextFile.source}`, content));
  }

  return sections.join('\n\n').trim();
}
