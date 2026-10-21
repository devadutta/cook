import { listCommandAliases } from '../command-instruction.ts';
import {
  getConfigPaths,
  loadConfig,
  readConfigFile,
  updateConfigFile,
} from '../config.ts';
import {
  createOpenAICodexFetch,
  hasOpenAICodexCredentials,
  loginOpenAICodex,
  logoutOpenAICodex,
} from '../openai-oauth.ts';
import { createRuntimeConfig } from '../runtime-config.ts';

/**
 * CLI modules the TUI needs, handed over by cli.ts. The TUI is a separate
 * entrypoint in compiled builds, so importing these directly would embed a
 * second copy of them (and zod) in the binary.
 */
export const tuiHost = {
  createOpenAICodexFetch,
  createRuntimeConfig,
  getConfigPaths,
  hasOpenAICodexCredentials,
  listCommandAliases,
  loadConfig,
  loginOpenAICodex,
  logoutOpenAICodex,
  readConfigFile,
  updateConfigFile,
};

export type TuiHost = typeof tuiHost;
