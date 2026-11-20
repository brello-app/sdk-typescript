import { AsyncLocalStorage } from 'node:async_hooks';
import { parseApiKey, readNodeEnvironment, type BrelloKeyMode } from './auth/api-key.js';
import { Transport } from './delivery/transport.js';
import { wrapClient } from './instrumentation/wrap-client.js';
import type { BrelloContext } from './telemetry/event.js';
import { safeContext, text } from './telemetry/metadata.js';

const DEFAULT_API_BASE_URL = 'https://api.brello.app/v1';

export interface BrelloOptions extends Record<string, unknown> {
  /** Override the hosted ingestion URL for a self-hosted or local deployment. */
  apiBaseUrl?: string;
  /** Check that the project key matches the application environment. */
  environment?: 'prod' | 'staging' | 'live' | 'test';
  /** Add a default serviceName attribute when the project permits attributes. */
  serviceName?: string;
  /** Set false to return provider clients without instrumentation. */
  enabled?: boolean;
  /** Enable SDK diagnostics. Context values are masked by default. */
  debug?: boolean;
  /** Include user and attribute values in diagnostics. Use only with test data. */
  debugIncludeContext?: boolean;
  /** Send a project-scoped HMAC for the user ID when the server supplies an identity key. */
  hashEndUserId?: boolean;
  /** Override Brello's HTTP implementation. It must respect the supplied AbortSignal. */
  fetch?: typeof fetch;
}

export interface BrelloConfig {
  apiKey?: string;
  options?: BrelloOptions;
}

export type BrelloApiKeyErrorCode = 'API_KEY_MISSING' | 'API_KEY_INVALID';
export type BrelloApiKeyStatus = 'valid' | 'missing' | 'invalid';

export interface BrelloErrorInfo {
  readonly code: BrelloApiKeyErrorCode;
  readonly message: string;
}

function baseUrl(value: string): URL | undefined {
  try {
    const url = new URL(value);
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (!(url.protocol === 'https:' || (url.protocol === 'http:' && local)) ||
      url.username || url.password || url.search || url.hash) return undefined;
    // Relative requests such as "events" must append to the full deployment path.
    url.pathname = url.pathname.replace(/\/+$/, '') || '/v1';
    url.pathname += '/';
    return url;
  } catch {
    return undefined;
  }
}

function warn(message: string): void {
  try { console.warn('[Brello] ' + message); } catch { /* Logging is best-effort. */ }
}

/** Owns the per-instance delivery queue and the async context for wrapped provider calls. */
export class Brello {
  readonly apiKeyStatus: BrelloApiKeyStatus;
  readonly mode: BrelloKeyMode | null;
  readonly error: BrelloErrorInfo | null;
  readonly options: BrelloOptions;
  private readonly context = new AsyncLocalStorage<BrelloContext>();
  private readonly transport?: Transport;

  constructor(config: BrelloConfig = {}) {
    const candidate = config.apiKey ?? readNodeEnvironment('BRELLO_API_KEY');
    this.options = config.options ?? {};
    const key = parseApiKey(candidate);
    this.mode = key.valid ? key.mode : null;
    const missing = candidate === undefined || candidate === '';
    this.apiKeyStatus = key.valid ? 'valid' : missing ? 'missing' : 'invalid';
    this.error = key.valid ? null : missing
      ? { code: 'API_KEY_MISSING', message: 'Set BRELLO_API_KEY or pass apiKey.' }
      : { code: 'API_KEY_INVALID', message: 'Use a Brello project ingestion key.' };

    // Keep local key diagnostics available even when delivery is turned off.
    if (this.options.enabled === false ||
      (this.options.enabled === undefined && /^(false|0)$/i.test(readNodeEnvironment('BRELLO_ENABLED') ?? ''))) return;
    if (!key.valid) {
      if (!missing) warn('The project key format is invalid. Event delivery is disabled.');
      return;
    }

    const environment = this.options.environment ?? readNodeEnvironment('BRELLO_ENV');
    const expectedMode = environment === 'prod' ? 'live' : environment === 'staging' ? 'test' : environment;
    if (expectedMode !== undefined && expectedMode !== key.mode) {
      warn('BRELLO_ENV does not match the project key. Event delivery is disabled.');
      return;
    }

    const environmentUrl = readNodeEnvironment('BRELLO_API_BASE_URL')?.trim();
    const url = baseUrl(this.options.apiBaseUrl ?? (environmentUrl || DEFAULT_API_BASE_URL));
    if (!url) {
      // A malformed self-hosted override must never send events to the hosted endpoint.
      warn('The custom Brello API base URL is invalid. Event delivery is disabled.');
      return;
    }
    const fetcher = this.options.fetch ?? globalThis.fetch;
    if (typeof fetcher !== 'function') {
      warn('Fetch is unavailable. Event delivery is disabled.');
      return;
    }

    this.transport = new Transport({
      key: key.bearerKey,
      baseUrl: url,
      fetch: fetcher,
      debug: this.options.debug ?? /^(true|1)$/i.test(readNodeEnvironment('BRELLO_DEBUG') ?? ''),
      debugIncludeContext: this.options.debugIncludeContext ?? false,
      hashEndUserId: this.options.hashEndUserId ?? false,
    });
  }

  /**
   * Observe supported provider methods while preserving the original client type.
   * Multiple clients wrapped by this instance share a delivery queue. Defaults are
   * shallowly overridden by context from the current async execution.
   */
  wrap<T extends object>(client: T, defaults: BrelloContext = {}): T {
    const transport = this.transport;
    if (!transport) return client;
    const serviceName = text(this.options.serviceName ?? readNodeEnvironment('BRELLO_SERVICE_NAME'), 64);
    return wrapClient(client, () => {
      const context = { ...defaults, ...this.context.getStore() };
      if (serviceName && context.attributes !== false) {
        context.attributes = { serviceName, ...context.attributes };
      }
      return safeContext(context);
    }, (event) => transport.enqueue(event));
  }

  /**
   * Apply metadata to calls started inside the callback and its async work.
   * Nested calls inherit outer fields unless they supply their own value.
   */
  withContext<T>(context: BrelloContext, callback: () => T): T {
    if (!this.transport) return callback();
    return this.context.run({ ...this.context.getStore(), ...context }, callback);
  }

  /**
   * Wait for eligible buffered events during shutdown or in a background task.
   * Resolves at the deadline or sooner if delivery is paused beyond it. It does
   * not confirm that Brello has accepted every event or cancel in-flight work.
   */
  async flush(timeoutMs = 5_000): Promise<void> {
    if (Number.isFinite(timeoutMs) && timeoutMs > 0)
      await this.transport?.flush(Math.min(timeoutMs, 60_000));
  }
}

