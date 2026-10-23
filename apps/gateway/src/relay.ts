/**
 * Delivers dispatches to the bot's Vercel Function in signed batches.
 *
 * A batch is sent when it's full or when its oldest event has waited
 * `lingerMs`, with at most `concurrency` batches in flight. Under load this
 * packs many events into each invocation; when it's quiet, an event waits
 * at most `lingerMs`. The function answers 409 when it's missing guild
 * snapshots, and the batch is resent with them attached.
 */
import { setTimeout as sleep } from 'node:timers/promises';
import { gzipSync } from 'node:zlib';
import { errorMessage, log } from './log.ts';
import {
  ENCODING_HEADER,
  type GuildSnapshot,
  type MissingSnapshots,
  PROTOCOL_VERSION,
  type RelayBatch,
  type RelayConfig,
  type RelayEvent,
  signRelayRequest,
} from './protocol.ts';

const ATTEMPTS = 4;
const REQUEST_TIMEOUT_MS = 15_000;
/** Vercel Functions accept request bodies up to 4.5 MB. */
const MAX_BODY_BYTES = 4_000_000;
/** 500 is left out on purpose: the function may have run the events before failing. */
const RETRYABLE_STATUSES = new Set([408, 425, 429, 502, 503, 504]);

export interface RelayOptions {
  url: string;
  key: Buffer;
  /** Batch fields that don't change per event. */
  header: () => Pick<RelayBatch, 'shardCount' | 'bot'>;
  /** Looks up a snapshot the function asked for. */
  snapshot: (key: string) => GuildSnapshot | undefined;
  batchSize?: number;
  lingerMs?: number;
  concurrency?: number;
  /** Maximum queued events before the oldest are dropped. */
  maxQueue?: number;
}

export class Relay {
  readonly url: string;
  readonly stats = { batches: 0, delivered: 0, failed: 0, dropped: 0, snapshots: 0 };

  readonly #options: Required<Omit<RelayOptions, 'url' | 'key'>>;
  readonly #key: Buffer;
  readonly #headers: Record<string, string>;
  #queue: RelayEvent[] = [];
  #inFlight = 0;
  #timer: NodeJS.Timeout | undefined;
  /** Set when the queue's oldest event has waited out the linger. */
  #due = false;
  #onIdle: (() => void) | undefined;
  readonly #lastLogged = new Map<string, number>();

  constructor({ url, key, header, snapshot, batchSize, lingerMs, concurrency, maxQueue }: RelayOptions) {
    this.url = url;
    this.#key = key;
    this.#options = {
      header,
      snapshot,
      batchSize: batchSize ?? 100,
      lingerMs: lingerMs ?? 10,
      concurrency: concurrency ?? 16,
      maxQueue: maxQueue ?? 50_000,
    };
    // Set by Vercel when Protection Bypass for Automation is enabled, so
    // Deployment Protection can't lock the gateway out of the relay route.
    const bypass = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
    this.#headers = bypass ? { 'x-vercel-protection-bypass': bypass } : {};
  }

  get pending(): number {
    return this.#queue.length + this.#inFlight;
  }

  /** Asks the function which intents to identify with and which events it listens to. Retries until it answers. */
  async fetchConfig(signal: AbortSignal): Promise<RelayConfig> {
    for (let attempt = 0; ; attempt++) {
      try {
        const response = await fetch(this.url, {
          headers: { ...this.#headers, ...signRelayRequest(this.#key, new Uint8Array()) },
          signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
        });
        if (response.ok) {
          const config = (await response.json()) as RelayConfig;
          if (config.v === PROTOCOL_VERSION && typeof config.intents === 'number') return config;
          log.error(`relay config from ${this.url} is not protocol v${PROTOCOL_VERSION}: ${JSON.stringify(config)}`);
        } else {
          log.error(`relay config request failed: ${await describe(response)}${hint(response.status)}`);
        }
      } catch (error) {
        if (signal.aborted) throw error;
        log.error(`relay config request to ${this.url} failed: ${errorMessage(error)}`);
      }
      await sleep(Math.min(2_000 * 2 ** attempt, 60_000), undefined, { signal });
    }
  }

  send(event: RelayEvent): void {
    this.#queue.push(event);
    if (this.#queue.length > this.#options.maxQueue) {
      // Drop a batch' worth at once so sustained overload doesn't cost a shift per event.
      this.stats.dropped += this.#queue.splice(0, this.#options.batchSize).length;
      this.#throttledLog('dropped', () => log.warn(`relay queue is full (${this.#options.maxQueue}), dropping oldest events`));
    }
    this.#pump();
  }

  /** Sends everything queued right away and resolves when it's delivered, or after `timeoutMs`. */
  async drain(timeoutMs: number): Promise<void> {
    this.#options.lingerMs = 0;
    this.#due = true;
    this.#pump();
    if (this.pending === 0) return;
    await Promise.race([new Promise<void>((resolve) => (this.#onIdle = resolve)), sleep(timeoutMs)]);
  }

  #pump(): void {
    const { batchSize, concurrency, lingerMs } = this.#options;
    while (this.#inFlight < concurrency && this.#queue.length > 0) {
      const full = this.#queue.length >= batchSize;
      if (!full && !this.#due) break;
      // A partial batch only goes out once per linger, so a trickle of events
      // doesn't turn into one request each.
      if (!full && lingerMs > 0) this.#due = false;
      const events = this.#queue.splice(0, batchSize);
      this.#inFlight++;
      void this.#deliver(events).finally(() => {
        this.#inFlight--;
        this.#pump();
        if (this.pending === 0) this.#onIdle?.();
      });
    }

    if (this.#queue.length === 0) {
      this.#due = false;
      clearTimeout(this.#timer);
      this.#timer = undefined;
    } else if (!this.#due && !this.#timer) {
      this.#timer = setTimeout(() => {
        this.#timer = undefined;
        this.#due = true;
        this.#pump();
      }, lingerMs);
    }
  }

  async #deliver(events: RelayEvent[], snapshots?: Record<string, GuildSnapshot>): Promise<void> {
    const batch: RelayBatch = { v: PROTOCOL_VERSION, ...this.#options.header(), events, snapshots };
    const json = Buffer.from(JSON.stringify(batch));
    // Snapshots are large and compress well; event batches are small and not worth the CPU.
    const gzip = snapshots !== undefined;
    const body = gzip ? gzipSync(json, { level: 1 }) : json;
    if (body.byteLength > MAX_BODY_BYTES && events.length > 1) {
      const half = Math.ceil(events.length / 2);
      await Promise.all([this.#deliver(events.slice(0, half)), this.#deliver(events.slice(half))]);
      return;
    }

    const headers: Record<string, string> = {
      ...this.#headers,
      'content-type': gzip ? 'application/octet-stream' : 'application/json',
      ...(gzip && { [ENCODING_HEADER]: 'gzip' }),
    };
    const label = `batch of ${events.length} (${events[0]!.packet.t}${events.length > 1 ? ', …' : ''})`;

    for (let attempt = 1; ; attempt++) {
      let retryAfterMs: number | undefined;
      let failure: string;
      try {
        const response = await fetch(this.url, {
          method: 'POST',
          headers: { ...headers, ...signRelayRequest(this.#key, body) },
          body,
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        if (response.ok) {
          await response.body?.cancel();
          this.stats.batches++;
          this.stats.delivered += events.length;
          return;
        }
        if (response.status === 409 && !snapshots) {
          const { missing } = (await response.json()) as MissingSnapshots;
          this.stats.snapshots += missing.length;
          return this.#deliver(events, this.#resolveSnapshots(missing));
        }
        failure = await describe(response);
        if (!RETRYABLE_STATUSES.has(response.status)) {
          this.stats.failed += events.length;
          this.#throttledLog(`status:${response.status}`, () =>
            log.error(`relay rejected ${label}: ${failure}${hint(response.status)}`),
          );
          return;
        }
        const retryAfter = Number(response.headers.get('retry-after'));
        if (retryAfter > 0) retryAfterMs = retryAfter * 1000;
      } catch (error) {
        failure = errorMessage(error);
      }

      if (attempt >= ATTEMPTS) {
        this.stats.failed += events.length;
        log.error(`giving up on ${label} after ${attempt} attempts: ${failure}`);
        return;
      }
      await sleep(retryAfterMs ?? 250 * 2 ** attempt + Math.random() * 250);
    }
  }

  #resolveSnapshots(keys: string[]): Record<string, GuildSnapshot> {
    const snapshots: Record<string, GuildSnapshot> = {};
    for (const key of keys) {
      const snapshot = this.#options.snapshot(key);
      if (snapshot) snapshots[key] = snapshot;
    }
    return snapshots;
  }

  /** Logs at most once every 10 seconds per key, so a misconfiguration doesn't flood the logs. */
  #throttledLog(key: string, write: () => void): void {
    const now = Date.now();
    if (now - (this.#lastLogged.get(key) ?? 0) < 10_000) return;
    this.#lastLogged.set(key, now);
    write();
  }
}

async function describe(response: Response): Promise<string> {
  const text = (await response.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 200);
  return `${response.status} ${response.statusText}${text ? ` ${text}` : ''}`;
}

function hint(status: number): string {
  if (status === 401 || status === 403) {
    return ' (the gateway and the function must share DISCORD_TOKEN, or DISCORD_RELAY_SECRET if you set one; if this is an HTML page, Deployment Protection is blocking the relay URL)';
  }
  if (status === 404) return ' (is DISCORD_RELAY_URL pointing at the relay route of the bot service?)';
  return '';
}
