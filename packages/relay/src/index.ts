import { gunzipSync } from 'node:zlib';
import {
  deriveRelayKey,
  ENCODING_HEADER,
  PROTOCOL_VERSION,
  type RelayBatch,
  verifyRelayRequest,
} from '@discord-on-vercel/gateway/protocol';
import { waitUntil as vercelWaitUntil } from '@vercel/functions';
import type { Client } from 'discord.js';
import { RelayRuntime, type RuntimeOptions } from './runtime.ts';

export { forwardedDispatches } from './events.ts';
export { RelayRuntime, type RuntimeOptions } from './runtime.ts';

export interface RelayHandlerOptions extends RuntimeOptions {
  /** Bot token. Defaults to `DISCORD_TOKEN`. */
  token?: string;
  /** Secret the gateway signs requests with. Defaults to `DISCORD_RELAY_SECRET`, then the bot token. */
  secret?: string;
  /** Keeps the function alive until listeners finish. Defaults to `waitUntil` from `@vercel/functions`. */
  waitUntil?: (promise: Promise<unknown>) => void;
}

/**
 * Creates the Web `Request` handler the gateway daemon talks to. Mount it on
 * one route for both `GET` and `POST`:
 *
 * - `GET` returns the client's intents, presence and the events it listens to.
 *   The gateway asks once when it starts.
 * - `POST` receives a batch of dispatches and replays them into `client` in
 *   order. It responds `202` as soon as the listeners have started, and keeps
 *   the function alive until they finish. If the instance doesn't have a
 *   guild the batch refers to, it responds `409` with the snapshots it needs
 *   and the gateway resends the batch with them.
 */
export function createRelayHandler(
  client: Client,
  options: RelayHandlerOptions = {},
): (request: Request) => Promise<Response> {
  const runtime = new RelayRuntime(client, options);
  const waitUntil = options.waitUntil ?? vercelWaitUntil;
  let relayKey: Buffer | undefined;

  // Read the token on the first request, not at import time, so builds don't need it.
  function authenticate(): Buffer {
    if (relayKey) return relayKey;
    const token = (options.token ?? process.env.DISCORD_TOKEN)?.replace(/^Bot\s+/i, '');
    if (!token) throw new Error('DISCORD_TOKEN is not set on the bot service');
    runtime.setToken(token);
    relayKey = deriveRelayKey(options.secret ?? (process.env.DISCORD_RELAY_SECRET || token));
    return relayKey;
  }

  return async function relay(request: Request): Promise<Response> {
    if (request.method !== 'GET' && request.method !== 'POST') {
      return Response.json({ error: 'method not allowed' }, { status: 405, headers: { allow: 'GET, POST' } });
    }

    let key: Buffer;
    try {
      key = authenticate();
    } catch (error) {
      console.error('[relay]', error);
      return Response.json({ error: (error as Error).message }, { status: 500 });
    }

    const body = new Uint8Array(await request.arrayBuffer());
    if (!verifyRelayRequest(key, request.headers, body)) {
      return Response.json({ error: 'invalid signature' }, { status: 401 });
    }

    if (request.method === 'GET') return Response.json(runtime.config());

    let batch: RelayBatch;
    try {
      const json = request.headers.get(ENCODING_HEADER) === 'gzip' ? gunzipSync(body) : body;
      batch = JSON.parse(new TextDecoder().decode(json));
    } catch {
      return Response.json({ error: 'malformed batch' }, { status: 400 });
    }
    if (batch.v !== PROTOCOL_VERSION || !Array.isArray(batch.events)) {
      return Response.json({ error: `expected protocol v${PROTOCOL_VERSION}, got v${batch.v}` }, { status: 400 });
    }

    // Checking and replaying happen without awaiting in between, so nothing
    // else on this instance can unload a guild after it was checked.
    const missing = runtime.missingSnapshots(batch);
    if (missing.length > 0) return Response.json({ missing }, { status: 409 });
    waitUntil(runtime.dispatch(batch));
    return new Response(null, { status: 202 });
  };
}
