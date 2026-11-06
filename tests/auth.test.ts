import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { AuthManager } from '../src/auth.js';

// Never let a developer's real credentials enter fixture assertions or requests.
const isolatedVariables = ['FIGMA_TOKEN', 'FIGMA_TOKEN_FILE', 'FIGMA_CLIENT_ID', 'FIGMA_CLIENT_SECRET', 'FIGMA_REDIRECT_URI'] as const;
const originalEnvironment = new Map(isolatedVariables.map(name => [name, process.env[name]]));
for (const name of isolatedVariables) delete process.env[name];
after(() => { for (const [name, value] of originalEnvironment) { if (value === undefined) delete process.env[name]; else process.env[name] = value; } });

async function fixture(options: Record<string, unknown> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'figma-auth-'));
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const manager = new AuthManager({ root, port: 0, openBrowser: async () => {}, fetch: async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify({ access_token: 'private-access', refresh_token: 'private-refresh', expires_in: 3600, user_id_string: 'user-1' }), { status: 200 });
  }, ...options });
  return { root, manager, calls };
}
async function requestWithHost(url: URL, method: string, body = '', origin?: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(url, { method, headers: { Host: 'evil.example', ...(origin ? { Origin: origin } : {}), 'Content-Type': 'application/x-www-form-urlencoded' } }, response => { response.resume(); response.on('end', () => resolve(response.statusCode!)); });
    request.on('error', reject); request.end(body);
  });
}
async function authorize(manager: AuthManager) {
  await manager.configure({ clientId: 'test-client', clientSecret: 'test-secret' });
  const result = await manager.connect({ openBrowser: false });
  const auth = new URL(result.authorizationUrl!);
  const callback = new URL(result.redirectUri!);
  callback.searchParams.set('state', auth.searchParams.get('state')!);
  callback.searchParams.set('code', 'one-time-code');
  return { result, auth, callback };
}

test('connect without credentials returns a local setup page and never asks for a password', async t => {
  const { manager } = await fixture(); t.after(() => manager.close());
  const result = await manager.connect({ openBrowser: false });
  assert.equal(result.status, 'setup_required');
  assert.match(result.setupUrl!, /^http:\/\/127\.0\.0\.1:\d+\/setup\?session=/);
  const page = await fetch(result.setupUrl!);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /figma\.com\/developers\/apps/);
  assert.match(html, /clientSecret/);
  assert.doesNotMatch(html, /name="password"/);
  assert.equal((await manager.status()).authenticated, false);
});

test('OAuth uses state, PKCE S256 and exact callback; successful exchange is private and persistent', async t => {
  const { manager, root, calls } = await fixture(); t.after(() => manager.close());
  const { result, auth, callback } = await authorize(manager);
  assert.equal(auth.origin, 'https://www.figma.com');
  assert.equal(auth.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(auth.searchParams.get('response_type'), 'code');
  assert.ok(auth.searchParams.get('state')!.length >= 32);
  assert.ok(auth.searchParams.get('code_challenge')!.length >= 40);
  assert.equal(auth.searchParams.get('redirect_uri'), result.redirectUri);
  assert.equal((await fetch(callback)).status, 200);
  assert.equal(await manager.getAccessToken(), 'private-access');
  const status = await manager.status();
  assert.equal(status.authenticated, true);
  assert.equal(status.pending, false);
  assert.doesNotMatch(JSON.stringify(status), /private-access|private-refresh|test-secret/);
  assert.equal(calls.length, 1);
  assert.equal(new Headers(calls[0]!.init?.headers).get('authorization'), 'Basic ' + Buffer.from('test-client:test-secret').toString('base64'));
  const body = new URLSearchParams(String(calls[0]!.init?.body));
  assert.equal(body.get('grant_type'), 'authorization_code');
  assert.equal(body.get('code'), 'one-time-code');
  assert.ok(body.get('code_verifier')!.length >= 43);
  for (const name of ['credentials.json', 'tokens.json']) {
    assert.equal((await stat(join(root, 'auth', name))).mode & 0o777, 0o600);
  }
  const other = new AuthManager({ root }); t.after(() => other.close());
  assert.equal(await other.getAccessToken(), 'private-access');
  assert.equal((await manager.connect()).status, 'authenticated');
});

test('invalid and missing state do not consume the pending authorization; successful state is single-use', async t => {
  const { manager, calls } = await fixture(); t.after(() => manager.close());
  const { callback } = await authorize(manager);
  const missing = new URL(callback); missing.searchParams.delete('state');
  assert.equal((await fetch(missing)).status, 400);
  const invalid = new URL(callback); invalid.searchParams.set('state', 'wrong');
  assert.equal((await fetch(invalid)).status, 400);
  assert.equal(calls.length, 0);
  assert.equal((await fetch(callback)).status, 200);
  assert.equal((await fetch(callback)).status, 400);
  assert.equal(calls.length, 1);
});

test('setup rejects cross-origin, wrong host and invalid CSRF before writing credentials', async t => {
  const { manager } = await fixture(); t.after(() => manager.close());
  const result = await manager.connect({ openBrowser: false });
  const url = new URL(result.setupUrl!);
  const token = url.searchParams.get('session')!;
  const endpoint = new URL('/setup', url);
  const body = new URLSearchParams({ csrf: token, clientId: 'test-client', clientSecret: 'test-secret' });
  assert.equal((await fetch(endpoint, { method: 'POST', headers: { Origin: 'https://evil.example' }, body })).status, 403);
  assert.equal((await fetch(endpoint, { method: 'POST', headers: { Origin: 'null' }, body })).status, 403);
  assert.equal(await requestWithHost(endpoint, 'POST', body.toString(), url.origin), 403);
  const bad = new URLSearchParams(body); bad.set('csrf', 'bad');
  assert.equal((await fetch(endpoint, { method: 'POST', headers: { Origin: url.origin }, body: bad })).status, 403);
  assert.equal((await manager.status()).configured, false);
  const response = await fetch(endpoint, { method: 'POST', headers: { Origin: url.origin }, body, redirect: 'manual' });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('location'), null);
  const savedPage = await response.text();
  assert.match(savedPage, /href="https:\/\/www\.figma\.com\/oauth\?/);
  assert.match(savedPage, />Autorizar en Figma(?:<span|<\/a>)/);
  assert.doesNotMatch(savedPage, /test-secret/);
  assert.equal((await manager.status()).configured, true);
});

test('callback rejects duplicate state/code parameters and unexpected host', async t => {
  const { manager, calls } = await fixture(); t.after(() => manager.close());
  const { callback } = await authorize(manager);
  const duplicate = new URL(callback); duplicate.searchParams.append('state', 'other');
  assert.equal((await fetch(duplicate)).status, 400);
  assert.equal(await requestWithHost(callback, 'GET'), 403);
  assert.equal(calls.length, 0);
});

test('denial ends pending authorization and does not exchange tokens', async t => {
  const { manager, calls } = await fixture(); t.after(() => manager.close());
  const { callback } = await authorize(manager);
  callback.searchParams.delete('code'); callback.searchParams.set('error', 'access_denied');
  assert.equal((await fetch(callback)).status, 400);
  assert.equal((await manager.status()).pending, false);
  assert.equal(calls.length, 0);
});

test('token errors do not leak provider body or credentials', async t => {
  const { manager } = await fixture({ fetch: async () => new Response('private-access test-secret private-refresh', { status: 400 }) });
  t.after(() => manager.close());
  const { callback } = await authorize(manager);
  const response = await fetch(callback);
  assert.equal(response.status, 502);
  assert.doesNotMatch(await response.text(), /private-access|test-secret|private-refresh/);
  assert.equal((await manager.status()).authenticated, false);
});

test('refresh is serialized across instances and keeps refresh token when provider omits it', async t => {
  let refreshCount = 0;
  const { manager, root } = await fixture(); t.after(() => manager.close());
  const { callback } = await authorize(manager); await fetch(callback);
  const path = join(root, 'auth', 'tokens.json');
  const tokens = JSON.parse(await readFile(path, 'utf8')); tokens.expiresAt = Date.now() - 100;
  await writeFile(path, JSON.stringify(tokens), { mode: 0o600 });
  const refreshFetch: typeof fetch = async (_url, init) => {
    refreshCount += 1;
    assert.equal(new URLSearchParams(String(init?.body)).get('refresh_token'), 'private-refresh');
    await new Promise(resolve => setTimeout(resolve, 30));
    return new Response(JSON.stringify({ access_token: 'new-access', expires_in: 3600 }), { status: 200 });
  };
  const first = new AuthManager({ root, fetch: refreshFetch });
  const second = new AuthManager({ root, fetch: refreshFetch });
  t.after(() => first.close()); t.after(() => second.close());
  assert.deepEqual(await Promise.all([first.getAccessToken(), second.getAccessToken()]), ['new-access', 'new-access']);
  assert.equal(refreshCount, 1);
  assert.equal(JSON.parse(await readFile(path, 'utf8')).refreshToken, 'private-refresh');
});

test('disconnect clears tokens and pending state while retaining app configuration', async t => {
  const { manager } = await fixture(); t.after(() => manager.close());
  const { callback } = await authorize(manager); await fetch(callback);
  await manager.disconnect();
  const status = await manager.status();
  assert.equal(status.configured, true); assert.equal(status.authenticated, false); assert.equal(status.pending, false);
  await assert.rejects(manager.getAccessToken(), /Conectar|connect|auth/i);
});

test('connect reuses pending session and reports browser-open failure without losing URL', async t => {
  let opens = 0;
  const { manager } = await fixture({ openBrowser: async () => { opens++; throw new Error('browser failed'); } });
  t.after(() => manager.close());
  await manager.configure({ clientId: 'test-client', clientSecret: 'test-secret' });
  const first = await manager.connect();
  const second = await manager.connect({ openBrowser: false });
  assert.equal(first.authorizationUrl, second.authorizationUrl);
  assert.match(first.warning!, /navegador|browser/i);
  assert.equal(opens, 1);
});

test('rejects remote or malformed redirect URIs and invalid credentials', async t => {
  const { manager } = await fixture(); t.after(() => manager.close());
  for (const redirectUri of ['https://evil.example/oauth/callback', 'http://127.0.0.1:3847/bad', 'http://user:pass@127.0.0.1:3847/oauth/callback']) {
    await assert.rejects(manager.configure({ clientId: 'test-client', clientSecret: 'test-secret', redirectUri }));
  }
  await assert.rejects(manager.configure({ clientId: '', clientSecret: 'secret' }));
  await assert.rejects(manager.configure({ clientId: 'client', clientSecret: 'bad\nsecret' }));
});

test('personal token works without an OAuth application and never uses Bearer', async t => {
  const { manager, root, calls } = await fixture(); t.after(() => manager.close());
  assert.equal((await manager.status()).mode, 'none');
  await manager.setPersonalToken(' figd_personal-private ');
  assert.equal(await manager.getAccessToken(), 'figd_personal-private');
  assert.deepEqual(await manager.getRequestHeaders(), { 'X-Figma-Token': 'figd_personal-private' });
  const status = await manager.status();
  assert.equal(status.mode, 'personal-token'); assert.equal(status.authenticated, true); assert.equal(status.configured, true);
  assert.equal(status.verified, false);
  assert.doesNotMatch(JSON.stringify(status), /figd_personal-private/);
  assert.equal((await manager.connect()).status, 'authenticated');
  assert.equal(calls.length, 0);
  assert.equal((await stat(join(root, 'auth', 'personal-token.json'))).mode & 0o777, 0o600);
  const other = new AuthManager({ root }); t.after(() => other.close());
  assert.deepEqual(await other.getRequestHeaders(), { 'X-Figma-Token': 'figd_personal-private' });
  await manager.disconnect();
  assert.equal((await manager.status()).mode, 'none');
  await assert.rejects(manager.getAccessToken(), /conectado/i);
});

test('OAuth header remains explicit for tokens whose value resembles a PAT', async t => {
  const { manager } = await fixture({ fetch: async () => new Response(JSON.stringify({ access_token: 'figd_oauth-value', refresh_token: 'refresh', expires_in: 3600 }), { status: 200 }) });
  t.after(() => manager.close());
  const { callback } = await authorize(manager); await fetch(callback);
  assert.equal((await manager.status()).mode, 'oauth');
  assert.deepEqual(await manager.getRequestHeaders(), { Authorization: 'Bearer figd_oauth-value' });
});

test('token setup form is protected against cross-origin and missing CSRF; successful POST returns no secret', async t => {
  const { manager } = await fixture(); t.after(() => manager.close());
  const result = await manager.connect({ openBrowser: false });
  const setup = new URL(result.setupUrl!);
  const html = await (await fetch(setup)).text();
  assert.match(html, /action="\/personal-token"/);
  assert.match(html, /name="personalToken" type="password"/);
  const endpoint = new URL('/personal-token', setup);
  const body = new URLSearchParams({ csrf: setup.searchParams.get('session')!, personalToken: 'private-token' });
  assert.equal((await fetch(endpoint, { method: 'POST', headers: { Origin: 'https://evil.example' }, body })).status, 403);
  assert.equal(await requestWithHost(endpoint, 'POST', body.toString(), setup.origin), 403);
  const bad = new URLSearchParams(body); bad.delete('csrf');
  assert.equal((await fetch(endpoint, { method: 'POST', headers: { Origin: setup.origin }, body: bad })).status, 403);
  assert.equal((await manager.status()).authenticated, false);
  const response = await fetch(endpoint, { method: 'POST', headers: { Origin: setup.origin }, body });
  assert.equal(response.status, 200);
  assert.doesNotMatch(await response.text(), /private-token/);
  assert.deepEqual(await manager.getRequestHeaders(), { 'X-Figma-Token': 'private-token' });
});

test('personal token validation rejects empty, multiline and oversized input without changing authentication', async t => {
  const { manager } = await fixture(); t.after(() => manager.close());
  for (const token of ['', '   ', 'figd_one\nfigd_two', 'a'.repeat(4097)]) await assert.rejects(manager.setPersonalToken(token), /token/i);
  assert.equal((await manager.status()).authenticated, false);
});

test('FIGMA_TOKEN takes precedence and disconnect explains environment credentials remain configured', async t => {
  const prior = process.env.FIGMA_TOKEN;
  t.after(() => { if (prior === undefined) delete process.env.FIGMA_TOKEN; else process.env.FIGMA_TOKEN = prior; });
  const { manager } = await fixture(); t.after(() => manager.close());
  await manager.setPersonalToken('stored-token');
  process.env.FIGMA_TOKEN = 'environment-token';
  assert.deepEqual(await manager.getRequestHeaders(), { 'X-Figma-Token': 'environment-token' });
  await manager.disconnect();
  const status = await manager.status();
  assert.equal(status.authenticated, true);
  assert.match(status.instructions!, /FIGMA_TOKEN/);
  assert.doesNotMatch(JSON.stringify(status), /environment-token|stored-token/);
});

test('FIGMA_TOKEN_FILE reads a private file and rejects publicly readable or symbolic-link files', async t => {
  const { chmod, symlink } = await import('node:fs/promises');
  const prior = process.env.FIGMA_TOKEN_FILE;
  t.after(() => { if (prior === undefined) delete process.env.FIGMA_TOKEN_FILE; else process.env.FIGMA_TOKEN_FILE = prior; });
  const { manager, root } = await fixture(); t.after(() => manager.close());
  const path = join(root, 'token-input');
  await writeFile(path, ' file-private-token\n', { mode: 0o600 });
  process.env.FIGMA_TOKEN_FILE = path;
  assert.deepEqual(await manager.getRequestHeaders(), { 'X-Figma-Token': 'file-private-token' });
  await chmod(path, 0o644);
  await assert.rejects(manager.getRequestHeaders(), /privad|permis|token/i);
  await chmod(path, 0o600);
  const link = join(root, 'token-link'); await symlink(path, link); process.env.FIGMA_TOKEN_FILE = link;
  await assert.rejects(manager.getRequestHeaders(), /privad|enlace|token/i);
});

test('disconnect from another process invalidates an outstanding OAuth callback', async t => {
  const { manager, root, calls } = await fixture(); t.after(() => manager.close());
  const { callback } = await authorize(manager);
  const other = new AuthManager({ root }); t.after(() => other.close());
  await other.disconnect();
  assert.equal((await fetch(callback)).status, 400);
  assert.equal(calls.length, 0);
  assert.equal((await manager.status()).authenticated, false);
});

test('choosing a personal token invalidates an outstanding OAuth callback in another process', async t => {
  const { manager, root, calls } = await fixture(); t.after(() => manager.close());
  const { callback } = await authorize(manager);
  const other = new AuthManager({ root }); t.after(() => other.close());
  await other.setPersonalToken('selected-pat');
  assert.equal((await fetch(callback)).status, 400);
  assert.equal(calls.length, 0);
  assert.deepEqual(await manager.getRequestHeaders(), { 'X-Figma-Token': 'selected-pat' });
});
