import type { RuntimeConfig } from './types.ts';

export function applyConfiguredApiKeys(
  runtime: RuntimeConfig,
  logDebug: (message: string) => void,
): void {
  if (runtime.ai_gateway_api_key) {
    process.env.AI_GATEWAY_API_KEY = runtime.ai_gateway_api_key;
    logDebug('Loaded AI_GATEWAY_API_KEY from config');
  }

  if (!runtime.provider_api_keys) {
    return;
  }

  for (const [envName, value] of Object.entries(runtime.provider_api_keys)) {
    process.env[envName] = value;
    logDebug(`Loaded ${envName} from config`);
  }
}
