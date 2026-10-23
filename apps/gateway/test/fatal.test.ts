/**
 * Configuration errors must not crash the daemon: Vercel would restart it in a
 * loop, logging in to Discord with a bad token or intents every time.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { WebSocketServer } from 'ws';

async function startDaemon({ gatewayBotStatus, closeCode }: { gatewayBotStatus: 200 | 401; closeCode?: number }) {
  const gateway = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await once(gateway, 'listening');
  gateway.on('connection', (socket) => {
    socket.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 30_000 } }));
    socket.on('message', () => socket.close(closeCode));
  });

  const server = createServer((req, res) => {
    if (req.url === '/api/gateway') {
      return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ v: 2, intents: 1, events: '*' }));
    }
    if (gatewayBotStatus === 401) {
      return res.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ message: '401: Unauthorized', code: 0 }));
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end(
      JSON.stringify({
        url: `ws://127.0.0.1:${(gateway.address() as AddressInfo).port}`,
        shards: 1,
        session_start_limit: { total: 1000, remaining: 1000, reset_after: 0, max_concurrency: 1 },
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  let logs = '';
  const daemon = spawn(process.execPath, ['src/index.ts'], {
    cwd: new URL('..', import.meta.url),
    env: {
      PATH: process.env.PATH,
      DISCORD_TOKEN: 'bad-token',
      DISCORD_API_URL: `http://127.0.0.1:${port}/api`,
      DISCORD_RELAY_URL: `http://127.0.0.1:${port}/api/gateway`,
    },
  });
  daemon.stdout!.on('data', (chunk) => (logs += chunk));
  daemon.stderr!.on('data', (chunk) => (logs += chunk));
  // The relay endpoint in this test doesn't check signatures; the point is what happens next.
  return {
    daemon,
    logs: () => logs,
    close: () => {
      gateway.close();
      server.close();
    },
  };
}

async function assertStaysIdleUntilSigterm(run: Awaited<ReturnType<typeof startDaemon>>, expected: RegExp) {
  try {
    for (let i = 0; i < 300 && !expected.test(run.logs()); i++) await sleep(10);
    assert.match(run.logs(), expected);
    await sleep(500);
    assert.equal(run.daemon.exitCode, null, `daemon exited early:\n${run.logs()}`);
    run.daemon.kill('SIGTERM');
    const [code] = await once(run.daemon, 'exit');
    assert.equal(code, 0);
  } finally {
    run.daemon.kill('SIGKILL');
    run.close();
  }
}

test('stays idle when Discord rejects the token', async () => {
  const run = await startDaemon({ gatewayBotStatus: 401 });
  await assertStaysIdleUntilSigterm(run, /Discord rejected DISCORD_TOKEN/);
});

test('stays idle on fatal close codes such as disallowed intents', async () => {
  const run = await startDaemon({ gatewayBotStatus: 200, closeCode: 4014 });
  await assertStaysIdleUntilSigterm(run, /closed with 4014\. Disallowed intents/);
});
