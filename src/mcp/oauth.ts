import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mcpServerError } from '../errors.js';
import { SecretStore, secrets } from '../security/secret-store.js';

/**
 * OAuth 2.1 for remote MCP servers — PKCE + Dynamic Client Registration,
 * FULLY LOCAL (DCR means no pre-registered client secret, so no cloud broker).
 * Tokens live in the SecretStore under `mcp-oauth:<server>`.
 *
 * The `interactive` flag is load-bearing: background paths (boot, heartbeat,
 * cron) pass false and get a clean error instead of a browser popup —
 * stored-token + silent-refresh is the ONLY thing non-interactive paths do.
 * The interactive flow runs solely via scripts/mcp-oauth-setup.ts.
 */

interface OAuthMetadata {
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
}

interface StoredTokens {
  access_token?: string;
  refresh_token?: string;
  expires_at?: number;
  client_id?: string;
  token_endpoint?: string;
}

const EXPIRY_MARGIN_MS = 60_000;

function profileFor(server: string): string {
  return `mcp-oauth:${server}`;
}

/** Non-interactive token access: stored token, silent refresh, or a clean throw. */
export async function getAccessToken(server: string, store: SecretStore = secrets): Promise<string | null> {
  const stored = store.get(profileFor(server)) as StoredTokens | null;
  if (!stored?.access_token) return null; // server may simply not need auth
  if (stored.expires_at && Date.now() > stored.expires_at - EXPIRY_MARGIN_MS) {
    if (!stored.refresh_token || !stored.token_endpoint || !stored.client_id) {
      throw mcpServerError(server, new Error('token expired and no refresh available — re-run mcp-oauth-setup'));
    }
    const refreshed = await tokenRequest(server, stored.token_endpoint, {
      grant_type: 'refresh_token',
      refresh_token: stored.refresh_token,
      client_id: stored.client_id,
    });
    persistTokens(server, stored, refreshed, store);
    return refreshed.access_token;
  }
  return stored.access_token;
}

/** Full interactive authorize flow (discovery → DCR → PKCE → loopback → exchange).
 *  ONLY call from an interactive context — this opens a browser. */
export async function interactiveAuthorize(server: string, serverUrl: string, store: SecretStore = secrets): Promise<void> {
  const meta = await discoverMetadata(server, serverUrl);
  const redirectPort = 40000 + Math.floor(Math.random() * 10000);
  const redirectUri = `http://127.0.0.1:${redirectPort}/callback`;

  // Dynamic Client Registration — public client, PKCE, no secret
  let clientId: string;
  if (meta.registration_endpoint) {
    const reg = await fetch(meta.registration_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_name: 'Invarail',
        redirect_uris: [redirectUri],
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
      }),
    });
    if (!reg.ok) throw mcpServerError(server, new Error(`DCR failed: HTTP ${reg.status}`));
    clientId = ((await reg.json()) as { client_id: string }).client_id;
  } else {
    throw mcpServerError(server, new Error('server offers no registration_endpoint — configure a client id manually in the secret store'));
  }

  // PKCE + state
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const state = randomBytes(16).toString('hex');

  const authorizeUrl = new URL(meta.authorization_endpoint);
  authorizeUrl.searchParams.set('response_type', 'code');
  authorizeUrl.searchParams.set('client_id', clientId);
  authorizeUrl.searchParams.set('redirect_uri', redirectUri);
  authorizeUrl.searchParams.set('code_challenge', challenge);
  authorizeUrl.searchParams.set('code_challenge_method', 'S256');
  authorizeUrl.searchParams.set('state', state);

  const code = await waitForCallback(redirectPort, state, authorizeUrl.toString());

  const tokens = await tokenRequest(server, meta.token_endpoint, {
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: clientId,
    code_verifier: verifier,
  });
  persistTokens(server, { client_id: clientId, token_endpoint: meta.token_endpoint }, tokens, store);
  console.log(`[MCP:${server}] OAuth complete — tokens stored in the secret store`);
}

async function discoverMetadata(server: string, serverUrl: string): Promise<OAuthMetadata> {
  const origin = new URL(serverUrl).origin;
  for (const path of ['/.well-known/oauth-authorization-server', '/.well-known/openid-configuration']) {
    try {
      const res = await fetch(`${origin}${path}`);
      if (res.ok) {
        const meta = (await res.json()) as OAuthMetadata;
        if (meta.authorization_endpoint && meta.token_endpoint) return meta;
      }
    } catch { /* try next */ }
  }
  throw mcpServerError(server, new Error(`no OAuth metadata found at ${origin}/.well-known/*`));
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
}

async function tokenRequest(server: string, endpoint: string, params: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
  });
  if (!res.ok) throw mcpServerError(server, new Error(`token request failed: HTTP ${res.status}`));
  return (await res.json()) as TokenResponse;
}

function persistTokens(server: string, base: StoredTokens, tokens: TokenResponse, store: SecretStore): void {
  store.set(profileFor(server), {
    ...base,
    access_token: tokens.access_token,
    ...(tokens.refresh_token ? { refresh_token: tokens.refresh_token } : {}),
    ...(tokens.expires_in ? { expires_at: Date.now() + tokens.expires_in * 1000 } : {}),
  });
}

/** Loopback callback server — state-gated with constant-time compare so a
 *  stray local request can't consume the pending flow. */
function waitForCallback(port: number, expectedState: string, authorizeUrl: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
      if (url.pathname !== '/callback') {
        res.writeHead(404).end();
        return;
      }
      const state = url.searchParams.get('state') ?? '';
      const stateOk = state.length === expectedState.length
        && timingSafeEqual(Buffer.from(state), Buffer.from(expectedState));
      const code = url.searchParams.get('code');
      if (!stateOk || !code) {
        res.writeHead(400, { 'Content-Type': 'text/plain' }).end('Invalid callback.');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html' }).end('<h3>Invarail authorized — you can close this tab.</h3>');
      clearTimeout(timer);
      server.close();
      resolve(code);
    });
    const timer = setTimeout(() => {
      server.close();
      reject(new Error('OAuth callback timed out after 5 minutes'));
    }, 5 * 60 * 1000);
    server.listen(port, '127.0.0.1', () => {
      console.log(`\nOpen this URL to authorize (waiting up to 5 min):\n${authorizeUrl}\n`);
      if (process.platform === 'darwin') {
        spawn('open', [authorizeUrl], { stdio: 'ignore', detached: true }).unref();
      }
    });
  });
}
