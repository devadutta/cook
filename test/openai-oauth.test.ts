import { describe, expect, it } from 'bun:test';
import {
  mkdtemp,
  readFile,
  stat,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  createOpenAIAuthorizationFlow,
  createOpenAICodexFetch,
  getOpenAIAuthFilePath,
  getOpenAICodexCredentials,
  getOpenAICodexLoginStatus,
  loginOpenAICodex,
  logoutOpenAICodex,
  saveOpenAICodexCredentials,
} from '../src/openai-oauth.ts';

function jwt(payload: Record<string, unknown>): string {
  return [
    Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url'),
    Buffer.from(JSON.stringify(payload)).toString('base64url'),
    '',
  ].join('.');
}

function mockFetch(
  implementation: (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) => Promise<Response>,
): typeof fetch {
  return implementation as typeof fetch;
}

async function tempHome(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), 'cook-openai-oauth-test-'));
}

describe('OpenAI OAuth', () => {
  it('builds the official PKCE authorization request for Cook', () => {
    const redirectUri = 'http://localhost:1455/auth/callback';
    const flow = createOpenAIAuthorizationFlow(redirectUri);
    const url = new URL(flow.url);

    expect(url.origin).toBe('https://auth.openai.com');
    expect(url.pathname).toBe('/oauth/authorize');
    expect(url.searchParams.get('client_id')).toBe(
      'app_EMoamEEZ73f0CkXaXp7hrann',
    );
    expect(url.searchParams.get('redirect_uri')).toBe(redirectUri);
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('originator')).toBe('cook');
    expect(url.searchParams.get('state')).toBe(flow.state);
    expect(flow.verifier.length).toBeGreaterThan(40);
    expect(url.searchParams.get('code_challenge')).not.toBe(flow.verifier);
    expect(url.searchParams.get('scope')).toContain('offline_access');
  });

  it('stores login credentials with owner-only permissions', async () => {
    const home = await tempHome();
    await saveOpenAICodexCredentials({
      type: 'oauth',
      access_token: 'access-token',
      refresh_token: 'refresh-token',
      expires_at: Date.now() + 60_000,
      account_id: 'account-1',
    }, home);

    const filePath = getOpenAIAuthFilePath(home);
    const contents = JSON.parse(await readFile(filePath, 'utf8')) as {
      openai: { access_token: string };
    };
    const mode = (await stat(filePath)).mode & 0o777;

    expect(contents.openai.access_token).toBe('access-token');
    expect(mode).toBe(0o600);
    expect((await getOpenAICodexLoginStatus(home)).signedIn).toBe(true);
  });

  it('completes the browser callback and exchanges the authorization code', async () => {
    const home = await tempHome();
    let resolveAuthorizeUrl!: (url: string) => void;
    const authorizeUrlPromise = new Promise<string>(resolve => {
      resolveAuthorizeUrl = resolve;
    });
    let exchangeBody: URLSearchParams | undefined;
    const fetchFn = mockFetch(async (input, init) => {
      expect(String(input)).toBe('https://auth.openai.com/oauth/token');
      exchangeBody = new URLSearchParams(String(init?.body));
      return Response.json({
        access_token: jwt({
          'https://api.openai.com/auth': {
            chatgpt_account_id: 'browser-account',
          },
          exp: Math.floor(Date.now() / 1000) + 3600,
        }),
        refresh_token: 'browser-refresh',
      });
    });

    const loginPromise = loginOpenAICodex({
      homeDir: home,
      browser: false,
      fetch: fetchFn,
      emit(message) {
        if (message.startsWith('https://auth.openai.com/oauth/authorize')) {
          resolveAuthorizeUrl(message);
        }
      },
    });
    const authorizeUrl = new URL(await authorizeUrlPromise);
    const redirect = new URL(
      authorizeUrl.searchParams.get('redirect_uri') ?? '',
    );
    redirect.hostname = '127.0.0.1';
    redirect.searchParams.set('code', 'authorization-code');
    redirect.searchParams.set(
      'state',
      authorizeUrl.searchParams.get('state') ?? '',
    );

    const callbackResponse = await fetch(redirect);
    const credentials = await loginPromise;

    expect(callbackResponse.status).toBe(200);
    expect(exchangeBody?.get('grant_type')).toBe('authorization_code');
    expect(exchangeBody?.get('code')).toBe('authorization-code');
    expect(exchangeBody?.get('redirect_uri')).toBe(
      authorizeUrl.searchParams.get('redirect_uri'),
    );
    expect(exchangeBody?.get('code_verifier')).toBeTruthy();
    expect(credentials.account_id).toBe('browser-account');
  });

  it('completes the headless device-code flow', async () => {
    const home = await tempHome();
    const emitted: string[] = [];
    const requestedUrls: string[] = [];
    const fetchFn = mockFetch(async (input, init) => {
      const url = String(input);
      requestedUrls.push(url);

      if (url.endsWith('/api/accounts/deviceauth/usercode')) {
        expect(JSON.parse(String(init?.body))).toEqual({
          client_id: 'app_EMoamEEZ73f0CkXaXp7hrann',
        });
        return Response.json({
          device_auth_id: 'device-auth-id',
          user_code: 'ABCD-EFGH',
          interval: 0,
        });
      }
      if (url.endsWith('/api/accounts/deviceauth/token')) {
        return Response.json({
          authorization_code: 'device-authorization-code',
          code_verifier: 'device-code-verifier',
        });
      }

      const body = new URLSearchParams(String(init?.body));
      expect(body.get('redirect_uri')).toBe(
        'https://auth.openai.com/deviceauth/callback',
      );
      expect(body.get('code')).toBe('device-authorization-code');
      expect(body.get('code_verifier')).toBe('device-code-verifier');
      return Response.json({
        access_token: jwt({
          chatgpt_account_id: 'device-account',
          exp: Math.floor(Date.now() / 1000) + 3600,
        }),
        refresh_token: 'device-refresh',
      });
    });

    const credentials = await loginOpenAICodex({
      homeDir: home,
      deviceCode: true,
      fetch: fetchFn,
      emit: message => emitted.push(message),
    });

    expect(requestedUrls).toEqual([
      'https://auth.openai.com/api/accounts/deviceauth/usercode',
      'https://auth.openai.com/api/accounts/deviceauth/token',
      'https://auth.openai.com/oauth/token',
    ]);
    expect(emitted).toContain('Open https://auth.openai.com/codex/device');
    expect(emitted).toContain('Enter code: ABCD-EFGH');
    expect(credentials.account_id).toBe('device-account');
  });

  it('refreshes expired credentials and persists rotated tokens', async () => {
    const home = await tempHome();
    await saveOpenAICodexCredentials({
      type: 'oauth',
      access_token: 'expired-access',
      refresh_token: 'old-refresh',
      expires_at: Date.now() - 1,
      account_id: 'account-1',
    }, home);

    let refreshBody: Record<string, unknown> | undefined;
    const fetchFn = mockFetch(async (input, init) => {
      expect(String(input)).toBe('https://auth.openai.com/oauth/token');
      expect(new Headers(init?.headers).get('Content-Type')).toBe(
        'application/json',
      );
      refreshBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return Response.json({
        access_token: jwt({
          'https://api.openai.com/auth': {
            chatgpt_account_id: 'account-2',
          },
        }),
        refresh_token: 'new-refresh',
        expires_in: 3600,
      });
    });

    const credentials = await getOpenAICodexCredentials({
      homeDir: home,
      fetch: fetchFn,
    });
    const saved = JSON.parse(
      await readFile(getOpenAIAuthFilePath(home), 'utf8'),
    ) as { openai: { refresh_token: string } };

    expect(refreshBody).toEqual({
      client_id: 'app_EMoamEEZ73f0CkXaXp7hrann',
      grant_type: 'refresh_token',
      refresh_token: 'old-refresh',
    });
    expect(credentials.refresh_token).toBe('new-refresh');
    expect(credentials.account_id).toBe('account-2');
    expect(credentials.expires_at).toBeGreaterThan(Date.now());
    expect(saved.openai.refresh_token).toBe('new-refresh');
  });

  it('authenticates Codex responses requests and retries once after a 401', async () => {
    const home = await tempHome();
    await saveOpenAICodexCredentials({
      type: 'oauth',
      access_token: 'old-access',
      refresh_token: 'old-refresh',
      expires_at: Date.now() + 60 * 60 * 1000,
      account_id: 'account-1',
    }, home);

    const requestHeaders: Headers[] = [];
    let responseCalls = 0;
    const fetchFn = mockFetch(async (input, init) => {
      if (String(input) === 'https://auth.openai.com/oauth/token') {
        return Response.json({
          access_token: jwt({
            chatgpt_account_id: 'account-2',
          }),
          refresh_token: 'new-refresh',
          expires_in: 3600,
        });
      }

      responseCalls += 1;
      requestHeaders.push(new Headers(init?.headers));
      return new Response(responseCalls === 1 ? 'unauthorized' : 'ok', {
        status: responseCalls === 1 ? 401 : 200,
      });
    });

    const authenticatedFetch = createOpenAICodexFetch({
      homeDir: home,
      fetch: fetchFn,
    });
    const response = await authenticatedFetch(
      'https://chatgpt.com/backend-api/codex/responses',
      { method: 'POST', body: '{}' },
    );

    expect(response.status).toBe(200);
    expect(responseCalls).toBe(2);
    expect(requestHeaders[0]?.get('Authorization')).toBe('Bearer old-access');
    expect(requestHeaders[0]?.get('ChatGPT-Account-Id')).toBe('account-1');
    expect(requestHeaders[0]?.get('originator')).toBe('cook');
    expect(requestHeaders[0]?.get('OpenAI-Beta')).toBe(
      'responses=experimental',
    );
    expect(requestHeaders[1]?.get('Authorization')).toContain('Bearer ey');
    expect(requestHeaders[1]?.get('ChatGPT-Account-Id')).toBe('account-2');
  });

  it('removes the saved login on logout', async () => {
    const home = await tempHome();
    await saveOpenAICodexCredentials({
      type: 'oauth',
      access_token: 'access-token',
      refresh_token: 'refresh-token',
      expires_at: Date.now() + 60_000,
      account_id: 'account-1',
    }, home);

    expect(await logoutOpenAICodex(home)).toBe(true);
    expect(await logoutOpenAICodex(home)).toBe(false);
    expect((await getOpenAICodexLoginStatus(home)).signedIn).toBe(false);
  });
});
