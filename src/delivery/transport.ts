import { createHmac } from 'node:crypto';
import manifest from '../../package.json' with { type: 'json' };
import type { TelemetryEvent } from '../telemetry/event.js';
import { object } from '../telemetry/metadata.js';
import { cancelBody, readJson } from './http-response.js';

const MAX_BATCH_BYTES = 256_000;
const MAX_EVENT_BYTES = 64_000;
// Buffer limits include the batch held by the delivery worker.
const MAX_BUFFER_BYTES = 2 * 1024 * 1024;
const MAX_BUFFER_EVENTS = 500;
const MAX_EVENT_AGE_MS = 60_000;
const MAX_ATTEMPTS = 5;
const REQUEST_TIMEOUT_MS = 3_000;
const FLUSH_INTERVAL_MS = 2_000;
const BATCH_SIZE = 20;
const CIRCUIT_FAILURES = 3;
const CIRCUIT_INITIAL_MS = 30_000;
const CIRCUIT_MAX_MS = 300_000;
const encoder = new TextEncoder();

interface Entry {
  event: TelemetryEvent;
  bytes: number;
  queuedAt: number;
  /** Retry count survives requeueing, including when the circuit opens. */
  failures: number;
}

export interface TransportOptions {
  key: string;
  baseUrl: URL;
  fetch: typeof fetch;
  debug: boolean;
  debugIncludeContext: boolean;
  hashEndUserId: boolean;
}

interface Collection {
  eventsEnabled: boolean;
  attributesEnabled: boolean;
  endUserIdEnabled: boolean;
  secret?: string;
  domain?: string;
}

/**
 * Owns buffering, collection policy, and delivery backoff for one Brello
 * instance. Provider calls enqueue locally. A single drain performs all HTTP
 * work, so concurrent flush calls cannot send the same batch twice.
 */
export class Transport {
  private pending: Entry[] = [];
  private bufferedBytes = 0;
  private inFlightCount = 0;
  private running = false;
  private readonly flushWaiters = new Set<() => void>();
  private timer?: ReturnType<typeof setTimeout>;
  private disabled = false;
  private retryAt = 0;
  private circuitUntil = 0;
  private circuitDelay = 0;
  private consecutiveFailures = 0;
  private nextConfigAt = 0;
  private collection?: Collection;
  private lastDropLogAt = -Infinity;
  private readonly dropped = { buffer_full: 0, expired: 0, attempts_exhausted: 0 };

  constructor(private readonly options: TransportOptions) {}

  /** Admit an event within the count and UTF-8 byte budgets, evicting pending entries first. */
  enqueue(event: TelemetryEvent): void {
    if (this.disabled) return;
    const bytes = encoder.encode(JSON.stringify(event)).length;
    if (bytes > MAX_EVENT_BYTES) {
      this.debug('Dropped an oversized event');
      return;
    }
    let evicted = 0;
    while (this.pending.length &&
      (this.pending.length + this.inFlightCount >= MAX_BUFFER_EVENTS ||
        this.bufferedBytes + bytes > MAX_BUFFER_BYTES)) {
      this.bufferedBytes -= this.pending.shift()!.bytes;
      evicted++;
    }
    if (this.pending.length + this.inFlightCount >= MAX_BUFFER_EVENTS ||
      this.bufferedBytes + bytes > MAX_BUFFER_BYTES) {
      this.recordDrops('buffer_full', evicted + 1);
      return;
    }
    if (evicted) this.recordDrops('buffer_full', evicted);
    this.pending.push({ event, bytes, queuedAt: Date.now(), failures: 0 });
    this.bufferedBytes += bytes;
    this.schedule(this.pending.length >= BATCH_SIZE ? 0 : FLUSH_INTERVAL_MS);
  }

  /** Wait until the buffer drains, the caller's deadline arrives, or delivery cannot resume in time. */
  async flush(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!this.disabled && this.pending.length + this.inFlightCount > 0) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return;
      this.dropExpired();
      if (!this.running && !this.pending.length) return;
      if (!this.running && this.nextSendAt() >= deadline) return;
      if (!this.running && this.nextSendAt() <= Date.now()) this.start();
      const delay = this.running ? remaining :
        Math.min(remaining, this.nextSendAt() - Date.now(), this.nextExpiry());
      await this.waitForProgress(delay);
    }
  }

  private waitForProgress(delay: number): Promise<void> {
    // Remove completed waiters even if a custom fetch hangs, so repeated
    // flush calls do not accumulate handlers on an unresolved promise.
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.flushWaiters.delete(done);
        resolve();
      };
      const timer = setTimeout(done, delay);
      if (this.running) this.flushWaiters.add(done);
    });
  }

  private nextSendAt(): number {
    // A Retry-After or per-batch backoff and an open circuit can overlap.
    return Math.max(this.retryAt, this.circuitUntil);
  }

  private schedule(delay: number): void {
    if (this.disabled || !this.pending.length) return;
    // A running drain already owns delivery. The timer can still expire
    // pending entries while that drain waits for a slow request.
    if (this.running) delay = this.nextExpiry();
    if (this.timer && delay !== 0) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (this.running) {
        this.dropExpired();
        this.schedule(this.nextExpiry());
      } else this.start();
    }, Math.min(Math.max(delay, this.nextSendAt() - Date.now()), this.nextExpiry()));
    // Background work should not keep Node alive. Explicit flush has its own timer.
    (this.timer as { unref?: () => void }).unref?.();
  }

  private start(): void {
    if (this.running) return;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.running = true;
    void this.drain().catch(() => this.debug('Telemetry delivery failed')).finally(() => {
      this.running = false;
      clearTimeout(this.timer);
      this.timer = undefined;
      this.schedule(this.pending.length >= BATCH_SIZE ? 0 : FLUSH_INTERVAL_MS);
      for (const wake of this.flushWaiters) wake();
    });
  }

  private async drain(): Promise<void> {
    this.dropExpired();
    while (!this.disabled && this.pending.length && this.nextSendAt() <= Date.now()) {
      // After the cooldown, only one ingestion request probes recovery.
      if (!this.circuitUntil) await this.refreshCollection();
      if (this.disabled) break;
      this.dropExpired();
      const batch = this.pending.splice(0, BATCH_SIZE);
      if (!batch.length) break;
      this.inFlightCount = batch.length;
      let retry: Entry[] = [];
      try {
        if (this.collection?.eventsEnabled === false) continue;
        retry = await this.send(batch);
      } finally {
        // Keep the in-flight batch charged to the buffer until send completes.
        // Failed entries return ahead of newer events with their UUIDs unchanged.
        this.bufferedBytes -= batch.reduce((total, entry) => total + entry.bytes, 0);
        this.inFlightCount = 0;
        if (!this.disabled && retry.length) {
          this.pending.unshift(...retry);
          this.bufferedBytes += retry.reduce((total, entry) => total + entry.bytes, 0);
        }
        this.dropExpired();
      }
    }
  }

  private nextExpiry(): number {
    return this.pending.length ? Math.max(0, this.pending[0].queuedAt + MAX_EVENT_AGE_MS - Date.now()) : Infinity;
  }

  private dropExpired(): void {
    let expired = 0;
    while (this.pending.length && this.nextExpiry() === 0) {
      this.bufferedBytes -= this.pending.shift()!.bytes;
      expired++;
    }
    if (expired) this.recordDrops('expired', expired);
  }

  private async refreshCollection(): Promise<void> {
    if (Date.now() < this.nextConfigAt) return;
    // Clear old preferences before refreshing so a failed config read cannot
    // authorize stale user data or attributes.
    this.collection = undefined;
    this.nextConfigAt = Date.now() + 60_000;
    try {
      const response = await this.request('config');
      if (!response.ok) {
        cancelBody(response.body);
        if (response.status === 401) this.disable();
        return;
      }
      const data = object(object(await readJson(response)).data);
      const collection = object(data.collection);
      const identity = object(object(data.identity).endUser);
      this.collection = {
        eventsEnabled: collection.eventsEnabled !== false,
        attributesEnabled: collection.attributesEnabled === true,
        endUserIdEnabled: collection.endUserIdEnabled === true,
        ...(identity.algorithm === 'hmac-sha256' && identity.secretEncoding === 'base64url' &&
          identity.keyVersion === '1' && typeof identity.secret === 'string' &&
          /^[A-Za-z0-9_-]{43}$/.test(identity.secret) && typeof identity.domain === 'string'
          ? { secret: identity.secret, domain: identity.domain } : {}),
      };
      if (typeof data.refreshAfterSeconds === 'number' && Number.isFinite(data.refreshAfterSeconds))
        this.nextConfigAt = Date.now() + Math.max(1, data.refreshAfterSeconds) * 1_000;
    } catch {
      this.debug('SDK configuration unavailable');
    }
  }

  private applyCollection(event: TelemetryEvent): TelemetryEvent {
    const { endUser, attributes, ...fields } = event;
    const base: TelemetryEvent = fields;
    const collection = Date.now() < this.nextConfigAt ? this.collection : undefined;
    if (collection?.attributesEnabled && attributes) base.attributes = attributes;
    if (!collection?.endUserIdEnabled || !endUser) return base;
    if (!this.options.hashEndUserId) return { ...base, endUser };
    // In hash mode, omit identity until the server supplies a usable key.
    if (!('id' in endUser) || !endUser.id || !collection.secret) return base;
    const idHash = createHmac('sha256', Buffer.from(collection.secret, 'base64url'))
      .update(collection.domain + '\0' + endUser.id, 'utf8').digest('hex');
    return { ...base, endUser: { idHash, algorithm: 'hmac-sha256', keyVersion: '1' } };
  }

  /** Send eligible entries and return only the ones that should be retried. */
  private async send(batch: Entry[]): Promise<Entry[]> {
    if (this.disabled) return [];
    const expiry = Date.now() - MAX_EVENT_AGE_MS;
    const active = batch.filter(({ queuedAt }) => queuedAt > expiry);
    if (active.length < batch.length) this.recordDrops('expired', batch.length - active.length);
    if (!active.length || this.nextSendAt() > Date.now()) return active;
    const events = active.map(({ event }) => this.applyCollection(event));
    const body = JSON.stringify({
      schemaVersion: '1',
      sdk: { name: '@brello/sdk', version: manifest.version, runtime: 'javascript' },
      events,
    });
    if (encoder.encode(body).length > MAX_BATCH_BYTES) return this.split(active);
    this.debugBatch(events);
    let response: Response;
    try {
      response = await this.request('events', body);
    } catch {
      this.debug('Event request failed');
      return this.defer(active);
    }
    const { status } = response;
    if (status === 202 || status === 422) {
      // Ingest may accept only part of a batch. Rejected entries are terminal
      // here, and retrying the full batch would resend successful entries.
      this.resetCircuit();
      if (!this.options.debug) cancelBody(response.body);
      else {
        try {
          const receipt = object(object(await readJson(response)).data);
          if (typeof receipt.rejectedCount === 'number' && receipt.rejectedCount > 0)
            this.debug('Events rejected', receipt.rejectedCount);
        } catch { /* A receipt body failure must not resend the batch. */ }
      }
      return [];
    }
    cancelBody(response.body);
    if (status === 429 || status >= 500) return this.defer(active, response);
    this.resetCircuit();
    if (status === 401) this.disable();
    else if (status === 413) return this.split(active);
    else this.debug('Batch rejected', status);
    return [];
  }

  private defer(batch: Entry[], response?: Response): Entry[] {
    const now = Date.now();
    const rateLimited = response?.status === 429;
    // Rate limits have their own cooldown. Network and server failures can open
    // the circuit, and a failed recovery probe extends its cooldown.
    if (rateLimited) this.consecutiveFailures = 0;
    else if (++this.consecutiveFailures >= CIRCUIT_FAILURES || this.circuitUntil) {
      const previousDelay = this.circuitDelay;
      this.circuitDelay = previousDelay ? Math.min(previousDelay * 2, CIRCUIT_MAX_MS) : CIRCUIT_INITIAL_MS;
      const delay = previousDelay ? this.circuitDelay * (0.8 + Math.random() * 0.2) : this.circuitDelay;
      this.circuitUntil = now + delay;
      this.debug('circuit_open', { delayMs: Math.round(delay) });
    }
    const header = response?.headers.get('Retry-After')?.trim();
    let retryAfter = 0;
    if (header) {
      if (/^\d+$/.test(header)) retryAfter = Number(header) * 1_000;
      else {
        const timestamp = Date.parse(header);
        if (Number.isFinite(timestamp)) retryAfter = Math.max(0, timestamp - now);
      }
    }
    const backoff = Math.min(500 * 2 ** batch[0].failures, 8_000);
    this.retryAt = now + Math.max(retryAfter, backoff * (0.5 + Math.random() / 2));
    const retry = batch.filter((entry) => ++entry.failures < MAX_ATTEMPTS);
    if (retry.length < batch.length) this.recordDrops('attempts_exhausted', batch.length - retry.length);
    return retry;
  }

  private resetCircuit(): void {
    this.consecutiveFailures = 0;
    this.circuitUntil = 0;
    this.circuitDelay = 0;
    this.retryAt = 0;
  }

  private async split(batch: Entry[]): Promise<Entry[]> {
    if (batch.length === 1) {
      this.debug('Dropped an oversized event');
      return [];
    }
    // Split serially to preserve ordering and the single-drain guarantee.
    const midpoint = Math.ceil(batch.length / 2);
    const left = await this.send(batch.slice(0, midpoint));
    const right = await this.send(batch.slice(midpoint));
    return [...left, ...right];
  }

  private request(path: string, body?: string): Promise<Response> {
    return this.options.fetch(new URL(path, this.options.baseUrl), {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        Authorization: 'Bearer ' + this.options.key,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body,
      // Do not forward the project bearer key to another URL via redirects.
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  }

  private disable(): void {
    this.disabled = true;
    this.bufferedBytes -= this.pending.reduce((total, entry) => total + entry.bytes, 0);
    this.pending = [];
    try {
      console.warn('[Brello] The project key was rejected. Event delivery is paused.');
    } catch { /* Logging is best-effort. */ }
  }

  private recordDrops(reason: keyof Transport['dropped'], count: number): void {
    if (!this.options.debug) return;
    this.dropped[reason] += count;
    const now = Date.now();
    if (now - this.lastDropLogAt < 5_000) return;
    this.debug('Events dropped', { ...this.dropped });
    for (const key of Object.keys(this.dropped) as (keyof Transport['dropped'])[]) this.dropped[key] = 0;
    this.lastDropLogAt = now;
  }

  private debugBatch(events: TelemetryEvent[]): void {
    if (!this.options.debug) return;
    const visibleEvents = this.options.debugIncludeContext ? events :
      events.map(({ endUser, attributes, ...event }) => ({
        ...event,
        ...(endUser ? { endUser: '[masked]' } : {}),
        ...(attributes ? { attributes: '[masked]' } : {}),
      }));
    this.debug('Sending events', visibleEvents);
  }

  private debug(message: string, detail?: unknown): void {
    if (!this.options.debug) return;
    try {
      console.debug('[Brello] ' + message, detail ?? '');
    } catch { /* Debug output is best-effort. */ }
  }
}
