import { createHash, randomBytes } from 'node:crypto';
import {
  chmod,
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { createServer } from 'node:http';
import type { Server, ServerResponse } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { COOK_VERSION } from './version.ts';

export const OPENAI_CODEX_BASE_URL = 'https://chatgpt.com/backend-api/codex';
export const OPENAI_CODEX_DEFAULT_MODEL = 'gpt-5.6-sol';

const OPENAI_OAUTH_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const OPENAI_AUTH_BASE_URL = 'https://auth.openai.com';
const OPENAI_AUTHORIZE_URL = `${OPENAI_AUTH_BASE_URL}/oauth/authorize`;
const OPENAI_TOKEN_URL = `${OPENAI_AUTH_BASE_URL}/oauth/token`;
const OPENAI_DEVICE_USER_CODE_URL =
  `${OPENAI_AUTH_BASE_URL}/api/accounts/deviceauth/usercode`;
const OPENAI_DEVICE_TOKEN_URL =
  `${OPENAI_AUTH_BASE_URL}/api/accounts/deviceauth/token`;
const OPENAI_DEVICE_VERIFICATION_URL = `${OPENAI_AUTH_BASE_URL}/codex/device`;
const OPENAI_DEVICE_REDIRECT_URI = `${OPENAI_AUTH_BASE_URL}/deviceauth/callback`;
const OPENAI_OAUTH_SCOPE = 'openid profile email offline_access';
const CALLBACK_PORTS = [1455, 1457] as const;
const AUTH_FILE_VERSION = 1;
const REFRESH_EARLY_MS = 60_000;
const LOGIN_TIMEOUT_MS = 15 * 60 * 1000;
const ACCOUNT_CLAIM_NAMESPACE = 'https://api.openai.com/auth';

type FetchFunction = typeof fetch;

export interface OpenAICodexCredentials {
  type: 'oauth';
  access_token: string;
  refresh_token: string;
  expires_at: number;
  account_id: string;
}

interface AuthDocument {
  version: number;
  openai?: OpenAICodexCredentials;
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  id_token?: string;
}

export interface OpenAICodexLoginStatus {
  signedIn: boolean;
  expiresAt?: number;
}

export interface OpenAICodexLoginOptions {
  deviceCode?: boolean;
  browser?: boolean;
  homeDir?: string;
  fetch?: FetchFunction;
  emit?: (message: string) => void;
  openBrowser?: (url: string) => Promise<boolean>;
}

export interface OpenAICodexCredentialOptions {
  homeDir?: string;
  fetch?: FetchFunction;
  forceRefresh?: boolean;
}

interface AuthorizationFlow {
  verifier: string;
  state: string;
  url: string;
}

interface CallbackServer {
  redirectUri: string;
  waitForCode: Promise<string>;
  close: () => Promise<void>;
}

interface DeviceAuthInfo {
  deviceAuthId: string;
  userCode: string;
  intervalSeconds: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isErrnoException(error: unknown, code: string): boolean {
  return error instanceof Error &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === code;
}

function isCredentials(value: unknown): value is OpenAICodexCredentials {
  if (!isRecord(value)) {
    return false;
  }

  return value.type === 'oauth' &&
    typeof value.access_token === 'string' &&
    value.access_token.length > 0 &&
    typeof value.refresh_token === 'string' &&
    value.refresh_token.length > 0 &&
    typeof value.expires_at === 'number' &&
    Number.isFinite(value.expires_at) &&
    typeof value.account_id === 'string' &&
    value.account_id.length > 0;
}

export function getOpenAIAuthFilePath(homeDir = os.homedir()): string {
  return path.join(homeDir, '.cook', 'auth.json');
}

async function readAuthDocument(homeDir = os.homedir()): Promise<AuthDocument | null> {
  const filePath = getOpenAIAuthFilePath(homeDir);
  let text: string;

  try {
    text = await readFile(filePath, 'utf8');
  } catch (error) {
    if (isErrnoException(error, 'ENOENT')) {
      return null;
    }
    throw error;
  }

  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(
      `Invalid OpenAI login data at ${filePath}. Run \`cook logout\`, then \`cook login\`.`,
    );
  }

  if (!isRecord(value) || value.version !== AUTH_FILE_VERSION) {
    throw new Error(
      `Unsupported OpenAI login data at ${filePath}. Run \`cook logout\`, then \`cook login\`.`,
    );
  }
  if (value.openai !== undefined && !isCredentials(value.openai)) {
    throw new Error(
      `Invalid OpenAI login data at ${filePath}. Run \`cook logout\`, then \`cook login\`.`,
    );
  }

  return {
    version: AUTH_FILE_VERSION,
    ...(value.openai ? { openai: value.openai } : {}),
  };
}

async function writeAuthDocument(
  document: AuthDocument,
  homeDir = os.homedir(),
): Promise<void> {
  const filePath = getOpenAIAuthFilePath(homeDir);
  const directory = path.dirname(filePath);
  const temporaryPath = `${filePath}.tmp-${process.pid}-${randomBytes(8).toString('hex')}`;

  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);

  try {
    await writeFile(
      temporaryPath,
      `${JSON.stringify(document, null, 2)}\n`,
      { encoding: 'utf8', mode: 0o600 },
    );
    await chmod(temporaryPath, 0o600);
    await rename(temporaryPath, filePath);
    await chmod(filePath, 0o600);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

export async function saveOpenAICodexCredentials(
  credentials: OpenAICodexCredentials,
  homeDir = os.homedir(),
): Promise<void> {
  await writeAuthDocument({
    version: AUTH_FILE_VERSION,
    openai: credentials,
  }, homeDir);
}

export async function hasOpenAICodexCredentials(
  homeDir = os.homedir(),
): Promise<boolean> {
  try {
    const document = await readAuthDocument(homeDir);
    return Boolean(document?.openai);
  } catch {
    // A stale/corrupt OAuth cache must not prevent API-key providers from
    // starting. Explicit openai-codex use still reports the detailed error.
    return false;
  }
}

export async function getOpenAICodexLoginStatus(
  homeDir = os.homedir(),
): Promise<OpenAICodexLoginStatus> {
  const document = await readAuthDocument(homeDir);
  if (!document?.openai) {
    return { signedIn: false };
  }

  return {
    signedIn: true,
    expiresAt: document.openai.expires_at,
  };
}

export async function logoutOpenAICodex(
  homeDir = os.homedir(),
): Promise<boolean> {
  const filePath = getOpenAIAuthFilePath(homeDir);
  try {
    await unlink(filePath);
    return true;
  } catch (error) {
    if (isErrnoException(error, 'ENOENT')) {
      return false;
    }
    throw error;
  }
}

function base64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split('.');
  const payload = parts[1];
  if (parts.length !== 3 || !payload) {
    return null;
  }

  try {
    const value = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as unknown;
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

function getAccountIdFromToken(token: string | undefined): string | null {
  if (!token) {
    return null;
  }

  const payload = decodeJwtPayload(token);
  if (!payload) {
    return null;
  }

  if (typeof payload.chatgpt_account_id === 'string') {
    return payload.chatgpt_account_id;
  }

  const namespaced = payload[ACCOUNT_CLAIM_NAMESPACE];
  if (isRecord(namespaced) && typeof namespaced.chatgpt_account_id === 'string') {
    return namespaced.chatgpt_account_id;
  }

  return null;
}

function getExpiresAt(token: string, expiresIn: number | undefined): number {
  if (
    typeof expiresIn === 'number' &&
    Number.isFinite(expiresIn) &&
    expiresIn > 0
  ) {
    return Date.now() + expiresIn * 1000;
  }

  const exp = decodeJwtPayload(token)?.exp;
  if (typeof exp === 'number' && Number.isFinite(exp)) {
    return exp * 1000;
  }

  return Date.now() + 60 * 60 * 1000;
}

function parseTokenResponse(value: unknown, operation: 'exchange' | 'refresh'): TokenResponse {
  if (
    !isRecord(value) ||
    typeof value.access_token !== 'string' ||
    value.access_token.length === 0
  ) {
    throw new Error(`OpenAI OAuth token ${operation} returned an invalid response.`);
  }

  if (
    value.refresh_token !== undefined &&
    typeof value.refresh_token !== 'string'
  ) {
    throw new Error(`OpenAI OAuth token ${operation} returned an invalid refresh token.`);
  }
  if (value.expires_in !== undefined && typeof value.expires_in !== 'number') {
    throw new Error(`OpenAI OAuth token ${operation} returned an invalid expiry.`);
  }
  if (value.id_token !== undefined && typeof value.id_token !== 'string') {
    throw new Error(`OpenAI OAuth token ${operation} returned an invalid ID token.`);
  }

  return {
    access_token: value.access_token,
    ...(value.refresh_token ? { refresh_token: value.refresh_token } : {}),
    ...(typeof value.expires_in === 'number' ? { expires_in: value.expires_in } : {}),
    ...(value.id_token ? { id_token: value.id_token } : {}),
  };
}

async function readTokenEndpointResponse(
  response: Response,
  operation: 'exchange' | 'refresh',
): Promise<TokenResponse> {
  if (!response.ok) {
    let errorCode = '';
    try {
      const body = await response.json() as unknown;
      if (isRecord(body)) {
        if (typeof body.error === 'string') {
          errorCode = ` (${body.error})`;
        } else if (isRecord(body.error) && typeof body.error.code === 'string') {
          errorCode = ` (${body.error.code})`;
        }
      }
    } catch {
      // The status is sufficient and avoids echoing a potentially sensitive body.
    }
    throw new Error(
      `OpenAI OAuth token ${operation} failed with status ${response.status}${errorCode}.`,
    );
  }

  return parseTokenResponse(await response.json(), operation);
}

async function exchangeAuthorizationCode(
  code: string,
  verifier: string,
  redirectUri: string,
  fetchFn: FetchFunction,
): Promise<TokenResponse> {
  const response = await fetchFn(OPENAI_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: OPENAI_OAUTH_CLIENT_ID,
      code_verifier: verifier,
    }),
  });

  return readTokenEndpointResponse(response, 'exchange');
}

async function refreshOpenAIToken(
  refreshToken: string,
  fetchFn: FetchFunction,
): Promise<TokenResponse> {
  const response = await fetchFn(OPENAI_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: OPENAI_OAUTH_CLIENT_ID,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    }),
  });

  return readTokenEndpointResponse(response, 'refresh');
}

function credentialsFromTokenResponse(
  response: TokenResponse,
  previous?: OpenAICodexCredentials,
): OpenAICodexCredentials {
  const refreshToken = response.refresh_token ?? previous?.refresh_token;
  if (!refreshToken) {
    throw new Error('OpenAI OAuth did not return a refresh token.');
  }

  const accountId =
    getAccountIdFromToken(response.access_token) ??
    getAccountIdFromToken(response.id_token) ??
    previous?.account_id;
  if (!accountId) {
    throw new Error('OpenAI OAuth token is missing the ChatGPT account identifier.');
  }

  return {
    type: 'oauth',
    access_token: response.access_token,
    refresh_token: refreshToken,
    expires_at: getExpiresAt(response.access_token, response.expires_in),
    account_id: accountId,
  };
}

export async function getOpenAICodexCredentials(
  options: OpenAICodexCredentialOptions = {},
): Promise<OpenAICodexCredentials> {
  const homeDir = options.homeDir ?? os.homedir();
  const document = await readAuthDocument(homeDir);
  const current = document?.openai;
  if (!current) {
    throw new Error(
      'Not signed in to OpenAI with ChatGPT. Run `cook login` first.',
    );
  }

  const shouldRefresh =
    Boolean(options.forceRefresh) ||
    current.expires_at <= Date.now() + REFRESH_EARLY_MS;
  if (!shouldRefresh) {
    return current;
  }

  let tokenResponse: TokenResponse;
  try {
    tokenResponse = await refreshOpenAIToken(
      current.refresh_token,
      options.fetch ?? fetch,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `OpenAI login refresh failed: ${message} Run \`cook login\` to sign in again.`,
    );
  }

  const refreshed = credentialsFromTokenResponse(tokenResponse, current);
  await saveOpenAICodexCredentials(refreshed, homeDir);
  return refreshed;
}

function withOpenAIHeaders(
  init: RequestInit | undefined,
  credentials: OpenAICodexCredentials,
): RequestInit {
  const headers = new Headers(init?.headers);
  headers.set('Authorization', `Bearer ${credentials.access_token}`);
  headers.set('ChatGPT-Account-Id', credentials.account_id);
  headers.set('originator', 'cook');
  headers.set('User-Agent', `cook/${COOK_VERSION}`);
  headers.set('OpenAI-Beta', 'responses=experimental');
  headers.set('Accept', 'text/event-stream');

  return {
    ...init,
    headers,
  };
}

export function createOpenAICodexFetch(options: {
  homeDir?: string;
  fetch?: FetchFunction;
  logDebug?: (message: string) => void;
} = {}): FetchFunction {
  const fetchFn = options.fetch ?? fetch;

  const authenticatedFetch = async (input: Parameters<FetchFunction>[0], init?: Parameters<FetchFunction>[1]) => {
    let credentials = await getOpenAICodexCredentials({
      homeDir: options.homeDir,
      fetch: fetchFn,
    });
    let response = await fetchFn(input, withOpenAIHeaders(init, credentials));

    if (response.status !== 401) {
      return response;
    }

    await response.body?.cancel().catch(() => undefined);
    options.logDebug?.('OpenAI returned 401; refreshing login and retrying once');
    credentials = await getOpenAICodexCredentials({
      homeDir: options.homeDir,
      fetch: fetchFn,
      forceRefresh: true,
    });
    response = await fetchFn(input, withOpenAIHeaders(init, credentials));
    return response;
  };

  return authenticatedFetch as FetchFunction;
}

export function createOpenAIAuthorizationFlow(
  redirectUri: string,
): AuthorizationFlow {
  const verifier = base64Url(randomBytes(64));
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const state = base64Url(randomBytes(32));
  const url = new URL(OPENAI_AUTHORIZE_URL);

  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', OPENAI_OAUTH_CLIENT_ID);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('scope', OPENAI_OAUTH_SCOPE);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('state', state);
  url.searchParams.set('id_token_add_organizations', 'true');
  url.searchParams.set('codex_cli_simplified_flow', 'true');
  url.searchParams.set('originator', 'cook');

  return {
    verifier,
    state,
    url: url.toString(),
  };
}

function successHtml(): string {
  return [
    '<!doctype html>',
    '<html><head><meta charset="utf-8"><title>Cook login complete</title></head>',
    '<body><h1>Cook is signed in</h1><p>You can close this window and return to your terminal.</p></body></html>',
  ].join('');
}

function errorHtml(message: string): string {
  const escaped = message
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
  return [
    '<!doctype html>',
    '<html><head><meta charset="utf-8"><title>Cook login failed</title></head>',
    `<body><h1>Cook login failed</h1><p>${escaped}</p></body></html>`,
  ].join('');
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) {
    return;
  }
  await new Promise<void>(resolve => server.close(() => resolve()));
}

async function startCallbackServer(
  port: number,
  state: string,
): Promise<CallbackServer> {
  let resolveCode!: (code: string) => void;
  let rejectCode!: (error: Error) => void;
  let settled = false;
  let timeout: ReturnType<typeof setTimeout> | undefined;

  const waitForCode = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });

  const finish = (
    response: ServerResponse,
    status: number,
    html: string,
  ): void => {
    response.writeHead(status, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'close',
    });
    response.end(html);
  };

  const server = createServer((request, response) => {
    const requestUrl = new URL(
      request.url ?? '/',
      `http://localhost:${port}`,
    );
    if (requestUrl.pathname !== '/auth/callback') {
      finish(response, 404, errorHtml('Unknown callback path.'));
      return;
    }
    if (settled) {
      finish(response, 409, errorHtml('This login request has already completed.'));
      return;
    }

    const returnedState = requestUrl.searchParams.get('state');
    const oauthError = requestUrl.searchParams.get('error');
    const code = requestUrl.searchParams.get('code');

    if (oauthError) {
      settled = true;
      const description =
        requestUrl.searchParams.get('error_description') ?? oauthError;
      finish(response, 400, errorHtml(description));
      rejectCode(new Error(`OpenAI authorization failed: ${description}`));
      return;
    }
    if (returnedState !== state) {
      settled = true;
      finish(response, 400, errorHtml('OAuth state did not match.'));
      rejectCode(new Error('OpenAI authorization failed: OAuth state did not match.'));
      return;
    }
    if (!code) {
      settled = true;
      finish(response, 400, errorHtml('Authorization code was missing.'));
      rejectCode(new Error('OpenAI authorization failed: authorization code was missing.'));
      return;
    }

    settled = true;
    finish(response, 200, successHtml());
    resolveCode(code);
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, '127.0.0.1');
  });

  timeout = setTimeout(() => {
    if (!settled) {
      settled = true;
      rejectCode(new Error('OpenAI login timed out after 15 minutes.'));
    }
  }, LOGIN_TIMEOUT_MS);

  return {
    redirectUri: `http://localhost:${port}/auth/callback`,
    waitForCode,
    close: async () => {
      if (timeout) {
        clearTimeout(timeout);
      }
      await closeServer(server);
    },
  };
}

async function findCallbackServer(): Promise<{
  server: CallbackServer;
  flow: AuthorizationFlow;
}> {
  let lastError: unknown;
  for (const port of CALLBACK_PORTS) {
    const redirectUri = `http://localhost:${port}/auth/callback`;
    const flow = createOpenAIAuthorizationFlow(redirectUri);
    try {
      return {
        server: await startCallbackServer(port, flow.state),
        flow,
      };
    } catch (error) {
      lastError = error;
      if (!isErrnoException(error, 'EADDRINUSE')) {
        throw error;
      }
    }
  }

  const detail = lastError instanceof Error ? `: ${lastError.message}` : '';
  throw new Error(`Could not start the OpenAI login callback server${detail}`);
}

export async function openUrlInBrowser(url: string): Promise<boolean> {
  const command = process.platform === 'darwin'
    ? { executable: 'open', args: [url] }
    : process.platform === 'win32'
      ? {
          executable: 'rundll32',
          args: ['url.dll,FileProtocolHandler', url],
        }
      : { executable: 'xdg-open', args: [url] };

  return new Promise(resolve => {
    const child = spawn(command.executable, command.args, {
      detached: true,
      stdio: 'ignore',
    });
    child.once('error', () => resolve(false));
    child.once('spawn', () => {
      child.unref();
      resolve(true);
    });
  });
}

async function loginWithBrowser(
  options: Required<Pick<OpenAICodexLoginOptions, 'browser' | 'fetch' | 'emit' | 'openBrowser'>>,
): Promise<TokenResponse> {
  const { server, flow } = await findCallbackServer();

  try {
    options.emit('Sign in with your ChatGPT account:');
    options.emit(flow.url);
    if (options.browser) {
      const opened = await options.openBrowser(flow.url);
      options.emit(
        opened
          ? 'Waiting for OpenAI authorization in your browser...'
          : 'Could not open a browser automatically. Open the URL above to continue.',
      );
    } else {
      options.emit('Open the URL above in a browser to continue.');
    }

    const code = await server.waitForCode;
    return await exchangeAuthorizationCode(
      code,
      flow.verifier,
      server.redirectUri,
      options.fetch,
    );
  } finally {
    await server.close();
  }
}

async function startDeviceAuth(fetchFn: FetchFunction): Promise<DeviceAuthInfo> {
  const response = await fetchFn(OPENAI_DEVICE_USER_CODE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: OPENAI_OAUTH_CLIENT_ID }),
  });
  if (!response.ok) {
    throw new Error(
      response.status === 404
        ? 'OpenAI device-code login is unavailable. Try `cook login` without `--device-code`.'
        : `OpenAI device-code login failed with status ${response.status}.`,
    );
  }

  const value = await response.json() as unknown;
  if (!isRecord(value)) {
    throw new Error('OpenAI device-code login returned an invalid response.');
  }
  const interval = typeof value.interval === 'string'
    ? Number(value.interval)
    : value.interval;
  if (
    typeof value.device_auth_id !== 'string' ||
    typeof value.user_code !== 'string' ||
    typeof interval !== 'number' ||
    !Number.isFinite(interval) ||
    interval < 0
  ) {
    throw new Error('OpenAI device-code login returned an invalid response.');
  }

  return {
    deviceAuthId: value.device_auth_id,
    userCode: value.user_code,
    intervalSeconds: interval,
  };
}

function wait(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function pollDeviceAuth(
  device: DeviceAuthInfo,
  fetchFn: FetchFunction,
): Promise<{ authorizationCode: string; codeVerifier: string }> {
  const deadline = Date.now() + LOGIN_TIMEOUT_MS;
  let intervalMs = Math.max(device.intervalSeconds * 1000, 1_000);

  while (Date.now() < deadline) {
    await wait(intervalMs);
    const response = await fetchFn(OPENAI_DEVICE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        device_auth_id: device.deviceAuthId,
        user_code: device.userCode,
      }),
    });

    if (response.ok) {
      const value = await response.json() as unknown;
      if (
        isRecord(value) &&
        typeof value.authorization_code === 'string' &&
        typeof value.code_verifier === 'string'
      ) {
        return {
          authorizationCode: value.authorization_code,
          codeVerifier: value.code_verifier,
        };
      }
      throw new Error('OpenAI device authorization returned an invalid response.');
    }

    if (response.status === 403 || response.status === 404) {
      continue;
    }

    let errorCode: string | undefined;
    try {
      const value = await response.json() as unknown;
      if (isRecord(value)) {
        if (typeof value.error === 'string') {
          errorCode = value.error;
        } else if (isRecord(value.error) && typeof value.error.code === 'string') {
          errorCode = value.error.code;
        }
      }
    } catch {
      // Fall through to the status-only error.
    }

    if (errorCode === 'deviceauth_authorization_pending') {
      continue;
    }
    if (errorCode === 'slow_down') {
      intervalMs += 5_000;
      continue;
    }

    throw new Error(
      `OpenAI device authorization failed with status ${response.status}` +
      (errorCode ? ` (${errorCode})` : '') +
      '.',
    );
  }

  throw new Error('OpenAI device-code login timed out after 15 minutes.');
}

async function loginWithDeviceCode(
  fetchFn: FetchFunction,
  emit: (message: string) => void,
): Promise<TokenResponse> {
  const device = await startDeviceAuth(fetchFn);
  emit(`Open ${OPENAI_DEVICE_VERIFICATION_URL}`);
  emit(`Enter code: ${device.userCode}`);
  emit('Waiting for OpenAI authorization...');

  const authorization = await pollDeviceAuth(device, fetchFn);
  return exchangeAuthorizationCode(
    authorization.authorizationCode,
    authorization.codeVerifier,
    OPENAI_DEVICE_REDIRECT_URI,
    fetchFn,
  );
}

export async function loginOpenAICodex(
  options: OpenAICodexLoginOptions = {},
): Promise<OpenAICodexCredentials> {
  const fetchFn = options.fetch ?? fetch;
  const emit = options.emit ?? (() => undefined);
  const tokenResponse = options.deviceCode
    ? await loginWithDeviceCode(fetchFn, emit)
    : await loginWithBrowser({
        browser: options.browser ?? true,
        fetch: fetchFn,
        emit,
        openBrowser: options.openBrowser ?? openUrlInBrowser,
      });
  const credentials = credentialsFromTokenResponse(tokenResponse);
  await saveOpenAICodexCredentials(
    credentials,
    options.homeDir ?? os.homedir(),
  );
  return credentials;
}
