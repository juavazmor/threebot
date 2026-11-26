import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, test } from 'node:test';
import { WebSocket } from 'ws';
import { exposureConfig, landingPath } from './exposure.mts';

const freePort = async () => {
  const socket = net.createServer();
  socket.listen(0, '127.0.0.1');
  await once(socket, 'listening');
  const { port } = socket.address() as net.AddressInfo;
  await new Promise((resolve) => socket.close(resolve));
  return port;
};

const PASSWORD = 'fixture-only-password';

// Fixture directories and an unreachable T3 only. Nothing real is read or changed.
async function startGateway(env: Record<string, string>) {
  const root = await mkdtemp(path.join(tmpdir(), 'exposure-'));
  await mkdir(path.join(root, 'bots'), { recursive: true });
  await mkdir(path.join(root, 'dist/welcome/img'), { recursive: true });
  await writeFile(path.join(root, 'dist/index.html'), 'APP SHELL');
  await writeFile(path.join(root, 'dist/welcome/index.html'), 'LANDING');
  await writeFile(path.join(root, 'dist/welcome/img/ball.webp'), 'BALL');
  const port = await freePort(), tailnet = await freePort();
  const child = spawn(process.execPath, [fileURLToPath(new URL('./gateway.mts', import.meta.url))], {
    env: {
      PATH: process.env.PATH, HOME: root, CODEX_HOME: path.join(root, 'codex'), HOST: '127.0.0.1', PORT: String(port),
      BOTS_ROOT: path.join(root, 'bots'), STATIC_DIR: path.join(root, 'dist'), T3_URL: 'http://127.0.0.1:1', T3_TOKEN: 'fixture-only',
      BOT_MCP_TOKEN: 'fixture-only', BOT_PASSWORD: PASSWORD, VAULT_FILE: path.join(root, 'vault.enc'), VAULT_KEY_FILE: path.join(root, 'vault-key'),
      CF_ACCESS_TEAM_DOMAIN: 'fixture.invalid', CF_ACCESS_AUD: 'fixture', CF_ACCESS_EMAILS: 'me@example.com',
      TAILNET_PORT: String(tailnet), TAILNET_USERS: 'me@example.com', ...env,
    }, stdio: ['ignore', 'pipe', 'ignore'],
  });
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('fixture gateway did not start')), 8000);
    let seen = '';
    child.stdout.on('data', (data) => { seen += data; if (seen.includes('bot gateway on') && seen.includes('tailnet listener')) { clearTimeout(timeout); resolve(); } });
    child.once('exit', (code) => reject(new Error(`gateway exited ${code}`)));
  });
  return { port, tailnet, stop: async () => { child.removeAllListeners('exit'); child.kill(); await once(child, 'exit').catch(() => {}); await rm(root, { recursive: true, force: true }); } };
}
const get = (port: number, url: string, headers: Record<string, string> = {}, method = 'GET') => fetch(`http://127.0.0.1:${port}${url}`, { headers, method, redirect: 'manual' });
const you = { 'tailscale-user-login': 'me@example.com' };
const socketStatus = (port: number, headers: Record<string, string>) => new Promise((resolve) => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/t3/ws`, { headers });
  ws.on('unexpected-response', (_req, res) => { resolve(res.statusCode); ws.terminate(); });
  ws.on('open', () => { resolve('open'); ws.terminate(); });
  ws.on('error', () => resolve('error'));
});
const login = (port: number, password: string, headers: Record<string, string> = {}) => fetch(`http://127.0.0.1:${port}/api/login`, {
  method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ password }),
});
/** The session cookie a correct password gives, as a request header. */
async function signIn(port: number, headers: Record<string, string> = {}) {
  const response = await login(port, PASSWORD, headers);
  assert.equal(response.status, 200);
  return { cookie: response.headers.get('set-cookie')!.split(';')[0] };
}
// Everything that acts as the user: reading Bots and the Vault, T3 through the gateway, approving a handoff.
const USER_ROUTES: [string, string][] = [
  ['GET', '/api/bots'], ['GET', '/api/vault'], ['GET', '/api/vault/export.csv'], ['GET', '/api/settings'], ['GET', '/t3/api/projects'],
  ['POST', '/api/bots'], ['POST', '/api/bots/alpha/handoffs/4d6f8a10-2b3c-4d5e-8f90-a1b2c3d4e5f6/approve'],
];

describe('landing-only mode', () => {
  let gateway: Awaited<ReturnType<typeof startGateway>>;
  before(async () => { gateway = await startGateway({ PUBLIC_LANDING_ONLY: 'true' }); });
  after(() => gateway.stop());

  test('the public port shows the landing page and nothing else', async () => {
    assert.equal(await (await get(gateway.port, '/')).text(), 'LANDING');
    assert.equal(await (await get(gateway.port, '/welcome/')).text(), 'LANDING');
    assert.equal(await (await get(gateway.port, '/welcome/img/ball.webp')).text(), 'BALL');
    for (const url of ['/index.html', '/sw.js', '/login', '/assets/index.js', '/api/session', '/api/bots', '/t3/ws', '/t3/api/anything']) {
      assert.equal((await get(gateway.port, url)).status, 404, url);
    }
    assert.equal((await get(gateway.port, '/api/bots', you)).status, 404, 'a Tailscale header means nothing on the public port');
    assert.equal((await get(gateway.port, '/', {}, 'POST')).status, 404);
    // Not even a real session opens the app there, and nobody can try passwords on it.
    const session = await signIn(gateway.tailnet, you);
    assert.equal((await get(gateway.port, '/api/bots', { ...you, ...session })).status, 404);
    assert.equal((await login(gateway.port, PASSWORD)).status, 404);
    assert.equal((await get(gateway.port, '/api/health')).status, 200);
  });

  test('sockets on the public port are refused outright', async () => {
    assert.equal(await socketStatus(gateway.port, you), 404);
  });

  test("the Bots' local tool server stays reachable locally and never through Cloudflare", async () => {
    assert.notEqual((await get(gateway.port, '/mcp/bot', { authorization: 'Bearer fixture-only' }, 'POST')).status, 404);
    assert.equal((await get(gateway.port, '/mcp/bot', { 'cf-ray': 'x', authorization: 'Bearer fixture-only' }, 'POST')).status, 404);
  });

  test('a Tailscale login that any local client can send is not enough on the tailnet port', async () => {
    assert.equal(await (await get(gateway.tailnet, '/')).text(), 'APP SHELL');
    const json = { 'content-type': 'application/json' };
    for (const [method, url] of USER_ROUTES) {
      assert.equal((await get(gateway.tailnet, url, { ...you, ...json }, method)).status, 401, `${method} ${url} with a forged login`);
      assert.equal((await get(gateway.tailnet, url, json, method)).status, 401, `${method} ${url} with nothing`);
    }
    assert.equal(await socketStatus(gateway.tailnet, you), 401);
    assert.equal(await socketStatus(gateway.tailnet, {}), 401);
    const state = await (await get(gateway.tailnet, '/api/session', you)).json();
    assert.equal(state.authenticated, false);
    assert.equal(state.passwordRequired, true);
  });

  test('the tailnet port serves the app to you, signed in, and only you', async () => {
    assert.equal((await login(gateway.tailnet, 'not the password', you)).status, 401);
    const session = await signIn(gateway.tailnet, you);
    assert.equal((await get(gateway.tailnet, '/api/bots', { ...you, ...session })).status, 200);
    assert.equal((await get(gateway.tailnet, '/api/bots', { 'tailscale-user-login': 'ME@example.com ', ...session })).status, 200);
    assert.equal(await socketStatus(gateway.tailnet, { ...you, ...session }), 'open');
    // The session without the Tailscale login, or with someone else's, is refused there.
    assert.equal((await get(gateway.tailnet, '/api/bots', session)).status, 401);
    assert.equal((await get(gateway.tailnet, '/api/bots', { 'tailscale-user-login': 'guest@example.com', ...session })).status, 401);
    assert.equal((await get(gateway.tailnet, '/api/bots', { 'cf-access-jwt-assertion': 'a.b.c', ...you })).status, 401);
    assert.equal(await socketStatus(gateway.tailnet, { ...you, ...session, origin: 'https://example.com' }), 403);
  });

  test('signing out on the tailnet stays on the tailnet', async () => {
    const config = await (await get(gateway.tailnet, '/api/config', { ...you, ...(await signIn(gateway.tailnet, you)) })).json();
    assert.equal(config.accessLogout, false);
  });
});

test('with the switch off, the public port asks for the session too', async () => {
  const gateway = await startGateway({});
  try {
    assert.equal(await (await get(gateway.port, '/')).text(), 'APP SHELL');
    for (const [method, url] of USER_ROUTES) assert.equal((await get(gateway.port, url, { 'content-type': 'application/json' }, method)).status, 401, `${method} ${url}`);
    assert.equal((await get(gateway.port, '/api/bots', you)).status, 401, 'a Tailscale header means nothing on the public port');
    assert.equal(await socketStatus(gateway.port, you), 401);
    const session = await signIn(gateway.port);
    assert.equal((await get(gateway.port, '/api/bots', session)).status, 200);
    assert.equal(await socketStatus(gateway.port, session), 'open');
    // Another page on this machine carries the same cookie (cookies ignore the port) but is another site.
    const elsewhere = { ...session, origin: 'http://127.0.0.1:5173' };
    assert.equal(await socketStatus(gateway.port, elsewhere), 403);
    assert.equal((await get(gateway.port, '/api/bots', { ...elsewhere, 'content-type': 'application/json' }, 'POST')).status, 403);
    assert.equal(await socketStatus(gateway.port, { ...session, origin: `http://127.0.0.1:${gateway.port}` }), 'open');
  } finally { await gateway.stop(); }
});

test('guessing the password gets slower, never locks the user out, and a burst does not get through', async () => {
  const gateway = await startGateway({});
  try {
    // A made-up forwarding header on the public port changes nothing: the caller is the socket.
    const started = Date.now();
    for (let i = 0; i < 3; i++) assert.equal((await login(gateway.port, `guess ${i}`, { 'x-forwarded-for': `10.0.0.${i}`, 'cf-ray': `ray-${i}` })).status, 401);
    assert.ok(Date.now() - started >= 700, 'the second and third guesses waited');
    // Twenty at once from one caller: one is checked (after its wait), the rest are told to try again.
    const burst = await Promise.all(Array.from({ length: 20 }, (_, i) => login(gateway.port, `burst ${i}`).then((response) => response.status)));
    assert.equal(burst.filter((status) => status === 401).length, 1);
    assert.equal(burst.filter((status) => status === 429).length, 19);
    // The right password still gets in, after the wait its caller earned.
    assert.equal((await login(gateway.port, PASSWORD)).status, 200);
  } finally { await gateway.stop(); }
});

const NO_ACCESS = { CF_ACCESS_TEAM_DOMAIN: '', CF_ACCESS_AUD: '', CF_ACCESS_EMAILS: '' };

test('a server with no password answers nobody, and says what is missing', async () => {
  const gateway = await startGateway({ BOT_PASSWORD: '', ...NO_ACCESS });
  try {
    for (const port of [gateway.port, gateway.tailnet]) {
      for (const [method, url] of USER_ROUTES) assert.equal((await get(port, url, { ...you, 'content-type': 'application/json' }, method)).status, 401, `${method} ${url} on ${port === gateway.port ? 'the public port' : 'the tailnet port'}`);
      assert.equal(await socketStatus(port, you), 401);
      const signIn = await login(port, '', you);
      assert.equal(signIn.status, 409);
      assert.equal(signIn.headers.get('set-cookie'), null);
      assert.match((await signIn.json()).error, /threebot password/);
      assert.deepEqual(await (await get(port, '/api/session', you)).json(), { authenticated: false, passwordRequired: true, accessLogin: false });
    }
    // What local callers legitimately need still answers.
    assert.equal((await get(gateway.port, '/api/health')).status, 200);
    assert.notEqual((await get(gateway.port, '/mcp/bot', { authorization: 'Bearer fixture-only' }, 'POST')).status, 401);
  } finally { await gateway.stop(); }
});

test('trusting every local process is a switch for development, off unless set', async () => {
  const gateway = await startGateway({ BOT_PASSWORD: '', ...NO_ACCESS, THREEBOT_TRUST_LOCAL: 'true' });
  try {
    assert.equal((await get(gateway.port, '/api/bots')).status, 200);
    assert.equal((await get(gateway.tailnet, '/api/bots', you)).status, 200);
    assert.equal((await get(gateway.tailnet, '/api/bots')).status, 401);
    assert.deepEqual(await (await get(gateway.port, '/api/session')).json(), { authenticated: true, passwordRequired: false, accessLogin: false });
  } finally { await gateway.stop(); }
});

test('configuration is explicit', () => {
  assert.deepEqual(exposureConfig({}), { tailnetPort: 0, tailnetUsers: new Set(), landingOnly: false });
  assert.deepEqual([...exposureConfig({ TAILNET_USERS: ' A@b.com, c@d.com ' }).tailnetUsers], ['a@b.com', 'c@d.com']);
  assert.equal(exposureConfig({ PUBLIC_LANDING_ONLY: '1' }).landingOnly, false);
  for (const url of ['/', '/welcome/', '/welcome/img/x.webp']) assert.equal(landingPath(url), true, url);
  for (const url of ['/welcome/../api/bots', '/welcome/img/../../sw.js', '/welcome/img/.env', '/index.html']) assert.equal(landingPath(url), false, url);
});
