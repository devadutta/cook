import {
  isBuiltInDefaultAgent,
  resolvePortableDefaultProvider,
} from './portable-default.ts';
import { CliError } from './errors.ts';
import type {
  CookConfig,
  ResolvedAgentConfig,
  RuntimeConfig,
} from './types.ts';
import type { CliFlags } from './cli-parse.ts';

function resolveAgentName(config: CookConfig, flags: CliFlags): string {
  if (flags.agent) {
    if (!(flags.agent in config.agents)) {
      const available = Object.keys(config.agents).join(', ');
      throw new CliError(`Unknown agent "${flags.agent}". Available agents: ${available}`);
    }

    return flags.agent;
  }

  if (config.default_agent) {
    if (!(config.default_agent in config.agents)) {
      throw new CliError(
        `default_agent "${config.default_agent}" is not defined in agents.`,
      );
    }

    return config.default_agent;
  }

  if ('default' in config.agents) {
    return 'default';
  }

  throw new CliError(
    'No agent selected. Set default_agent in config or pass --agent <name>.',
  );
}

function resolveRuntimeAgent(
  config: CookConfig,
  agentName: string,
  flags: CliFlags,
  availability: { openaiOAuth?: boolean },
): ResolvedAgentConfig {
  const baseAgent = config.agents[agentName];
  if (!baseAgent) {
    throw new CliError(`Resolved agent "${agentName}" is missing from configuration.`);
  }

  let resolvedAgent = baseAgent;
  if (isBuiltInDefaultAgent(agentName, baseAgent)) {
    const portableProvider = resolvePortableDefaultProvider(
      config,
      process.env,
      availability,
    );
    if (portableProvider) {
      resolvedAgent = {
        ...baseAgent,
        provider: portableProvider.provider,
        model: portableProvider.model,
      };
    }
  }

  return {
    ...resolvedAgent,
    raw_bash_output: Boolean(flags.raw || resolvedAgent.raw_bash_output),
    thinking: flags.thinking ?? resolvedAgent.thinking,
    fast: Boolean(flags.fast || resolvedAgent.fast),
  };
}

export function createRuntimeConfig(
  config: CookConfig,
  flags: CliFlags,
  availability: { openaiOAuth?: boolean } = {},
): RuntimeConfig {
  const agent_name = resolveAgentName(config, flags);
  const agent = resolveRuntimeAgent(config, agent_name, flags, availability);

  const {
    agents: _agents,
    default_agent: _default_agent,
    ...base
  } = config;

  return {
    ...base,
    agent_name,
    agent,
    cwd: process.cwd(),
    always_execute: Boolean(flags.yes),
    dry_run: Boolean(flags.dryRun),
  };
}
