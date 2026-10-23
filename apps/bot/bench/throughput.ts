/**
 * Measures the relay end to end on this machine:
 *
 *   fake Discord (child) → gateway daemon (child) → this bot's Hono app → discord.js
 *
 * and reports throughput, latency, batching, and CPU per event for the
 * gateway and for the function. Run with `pnpm bench`. Tune with
 * EVENTS, RATE (events/s, 0 = as fast as possible) and GUILDS.
 */
import { type ChildProcess, execFileSync, fork, spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { serve } from '@hono/node-server';
import { Events } from 'discord.js';

process.env.DISCORD_TOKEN = 'bench-token';
const { client } = await import('../src/bot');
const { default: app } = await import('../src/index');

const EVENTS = Number(process.env.EVENTS ?? 50_000);
const RATE = Number(process.env.RATE ?? 0);
const WARMUP = 2_000;

// Count what reaches the function, and how.
const requests = { batches: 0, conflicts: 0, events: 0 };
const latencies: number[] = [];
let processed = 0;
client.on(Events.MessageCreate, (message) => {
  processed++;
  const sent = Number(/^sent:(\d+)/.exec(message.content)?.[1]);
  if (sent) latencies.push(Date.now() - sent);
});

const bot = serve({
  port: 0,
  hostname: '127.0.0.1',
  fetch: async (request) => {
    const response = await app.fetch(request);
    if (request.method === 'POST') {
      if (response.status === 409) requests.conflicts++;
      else requests.batches++;
    }
    return response;
  },
});
await once(bot, 'listening');

const discord = fork(new URL('./fake-discord.ts', import.meta.url), { execArgv: ['--import', 'tsx'], env: process.env });
const [{ port: discordPort }] = (await once(discord, 'message')) as [{ port: number }];
client.rest.options.api = `http://127.0.0.1:${discordPort}/api`;

const gateway = spawn(process.execPath, ['src/index.ts'], {
  cwd: new URL('../../gateway/', import.meta.url),
  stdio: ['ignore', 'inherit', 'inherit'],
  env: {
    PATH: process.env.PATH,
    DISCORD_TOKEN: 'bench-token',
    DISCORD_API_URL: `http://127.0.0.1:${discordPort}/api`,
    DISCORD_RELAY_URL: `http://127.0.0.1:${(bot.address() as AddressInfo).port}/api/gateway`,
    GATEWAY_BATCH_SIZE: process.env.GATEWAY_BATCH_SIZE,
    GATEWAY_BATCH_LINGER_MS: process.env.GATEWAY_BATCH_LINGER_MS,
  },
});
await waitForMessage(discord, 'connected');

// Warm up: load every guild into the function and let both sides JIT.
await run(WARMUP, 2_000);
latencies.length = 0;
Object.assign(requests, { batches: 0, conflicts: 0 });

// Idle cost: what both sides burn with the connection open and no traffic.
const idleGatewayBefore = cpuSeconds(gateway);
const idleBotBefore = process.cpuUsage();
await new Promise((resolve) => setTimeout(resolve, 5_000));
const idleGateway = (cpuSeconds(gateway) - idleGatewayBefore) / 5;
const idleBot = cpuTotal(process.cpuUsage(idleBotBefore)) / 5;

const gatewayCpuBefore = cpuSeconds(gateway);
const botCpuBefore = process.cpuUsage();
const start = performance.now();
await run(EVENTS, RATE);
const seconds = (performance.now() - start) / 1000;
const gatewayCpu = cpuSeconds(gateway) - gatewayCpuBefore;
const botCpu = cpuTotal(process.cpuUsage(botCpuBefore));

latencies.sort((a, b) => a - b);
const percentile = (p: number) => latencies[Math.min(latencies.length - 1, Math.floor((latencies.length * p) / 100))];
const perEvent = (cpu: number) => `${((cpu / EVENTS) * 1e6).toFixed(0)}µs`;

console.log(`
${EVENTS.toLocaleString()} MESSAGE_CREATE events across ${process.env.GUILDS ?? 100} guilds, ${RATE ? `${RATE.toLocaleString()}/s` : 'as fast as possible'}
  throughput        ${Math.round(EVENTS / seconds).toLocaleString()} events/s end to end
  latency           p50 ${percentile(50)}ms, p99 ${percentile(99)}ms (Discord → gateway → function → listener)
  batching          ${requests.batches.toLocaleString()} function invocations, ${(EVENTS / requests.batches).toFixed(1)} events each, ${requests.conflicts} snapshot requests
  gateway CPU       ${perEvent(gatewayCpu)} per event (${((gatewayCpu / seconds) * 100).toFixed(0)}% of a core)
  function CPU      ${perEvent(botCpu)} per event, HTTP + discord.js replay + listener
  idle CPU          gateway ${(idleGateway * 100).toFixed(1)}%, function ${(idleBot * 100).toFixed(1)}% of a core
`);

gateway.kill('SIGTERM');
discord.kill();
bot.close();
process.exit(0);

async function run(count: number, rate: number): Promise<void> {
  const target = processed + count;
  discord.send({ count, rate });
  while (processed < target) await new Promise((resolve) => setTimeout(resolve, 5));
}

async function waitForMessage(child: ChildProcess, type: string): Promise<void> {
  for (;;) {
    const [message] = (await once(child, 'message')) as [{ type: string }];
    if (message.type === type) return;
  }
}

function cpuTotal({ user, system }: NodeJS.CpuUsage): number {
  return (user + system) / 1e6;
}

/** Total CPU time a child process has used, in seconds. */
function cpuSeconds(child: ChildProcess): number {
  try {
    // Linux: utime + stime, in clock ticks (100 per second).
    const fields = readFileSync(`/proc/${child.pid}/stat`, 'utf8').split(') ')[1]!.split(' ');
    return (Number(fields[11]) + Number(fields[12])) / 100;
  } catch {
    // macOS: [[hh:]mm:]ss.cc
    const time = execFileSync('ps', ['-o', 'time=', '-p', String(child.pid)], { encoding: 'utf8' }).trim();
    return time.split(':').reduce((total, part) => total * 60 + Number(part), 0);
  }
}
