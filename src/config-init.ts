import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { Command } from 'commander';
import { getConfigPaths } from './config.ts';
import { DEFAULT_CONFIG, EXIT_CODES } from './defaults.ts';
import { printStderr } from './output.ts';

interface ConfigInitFlags {
  global?: boolean;
  local?: boolean;
  force?: boolean;
}

interface InitConfigFilesOptions {
  cwd: string;
  homeDir?: string;
  writeLocal: boolean;
  writeGlobal: boolean;
  force: boolean;
}

interface InitConfigFilesResult {
  written: string[];
  skipped: string[];
}

function templateConfig() {
  return {
    ...DEFAULT_CONFIG,
    default_agent: 'default',
    ai_gateway_api_key: 'YOUR_AI_GATEWAY_API_KEY',
    provider_api_keys: {
      OPENAI_API_KEY: 'YOUR_OPENAI_API_KEY',
      ANTHROPIC_API_KEY: 'YOUR_ANTHROPIC_API_KEY',
      GOOGLE_GENERATIVE_AI_API_KEY: 'YOUR_GOOGLE_GENERATIVE_AI_API_KEY',
      GROQ_API_KEY: 'YOUR_GROQ_API_KEY',
    },
  };
}

async function writeTemplateFile(
  filePath: string,
  force: boolean,
): Promise<'written' | 'skipped'> {
  const file = Bun.file(filePath);
  if ((await file.exists()) && !force) {
    return 'skipped';
  }

  await mkdir(path.dirname(filePath), { recursive: true });
  const content = `${JSON.stringify(templateConfig(), null, 2)}\n`;
  await Bun.write(filePath, content);
  return 'written';
}

export async function initConfigFiles(
  options: InitConfigFilesOptions,
): Promise<InitConfigFilesResult> {
  const { cwd, homeDir, writeLocal, writeGlobal, force } = options;
  const { global_path, local_path } = getConfigPaths(cwd, homeDir);

  const targets: string[] = [];
  if (writeGlobal) {
    targets.push(global_path);
  }
  if (writeLocal) {
    targets.push(local_path);
  }

  const written: string[] = [];
  const skipped: string[] = [];

  for (const target of targets) {
    const result = await writeTemplateFile(target, force);
    if (result === 'written') {
      written.push(target);
    } else {
      skipped.push(target);
    }
  }

  return { written, skipped };
}

function parseConfigInitCli(argv: string[]): ConfigInitFlags {
  const program = new Command();

  program
    .name('cook config init')
    .description('Initialize cook config template files')
    .option('--global', 'Initialize global config at ~/.cook/config.json')
    .option('--local', 'Initialize local config at ./.cook/config.json')
    .option('-f, --force', 'Overwrite existing config file(s)')
    .showHelpAfterError();

  program.parse(['bun', 'cook config init', ...argv]);
  return program.opts<ConfigInitFlags>();
}

export async function runConfigInitCommand(argv: string[]): Promise<number> {
  const flags = parseConfigInitCli(argv);
  const writeGlobal = Boolean(flags.global);
  const writeLocal = Boolean(flags.local) || (!flags.local && !flags.global);

  const result = await initConfigFiles({
    cwd: process.cwd(),
    writeLocal,
    writeGlobal,
    force: Boolean(flags.force),
  });

  for (const filePath of result.written) {
    printStderr(`Wrote config template: ${filePath}`);
  }

  for (const filePath of result.skipped) {
    printStderr(`Skipped existing config: ${filePath} (use --force to overwrite)`);
  }

  if (result.written.length === 0 && result.skipped.length === 0) {
    printStderr('No config target selected. Use --local and/or --global.');
    return EXIT_CODES.FAILURE;
  }

  return EXIT_CODES.SUCCESS;
}
