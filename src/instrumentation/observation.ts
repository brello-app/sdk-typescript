import { randomUUID } from 'node:crypto';
import type { EventContext, Status, TelemetryEvent } from '../telemetry/event.js';
import { count, object, text } from '../telemetry/metadata.js';
import { readUsage, type Endpoint } from './provider-usage.js';

export type RecordEvent = (event: TelemetryEvent) => void;

/**
 * Accumulate metadata for one provider invocation. Promise handlers, stream
 * events, and iterator callbacks can all report completion. The done flag
 * ensures that only the first terminal signal creates a telemetry event.
 */
export class Observation {
  // Elapsed time uses a monotonic clock. The event timestamp uses UTC wall time.
  private readonly start = performance.now();
  private readonly occurredAt = new Date().toISOString();
  private done = false;
  private requestId?: string;
  private usage: unknown;
  private serviceTier?: string;

  constructor(
    readonly endpoint: Endpoint,
    private model: string,
    private readonly context: EventContext,
    private readonly record: RecordEvent,
  ) {}

  headers(value: unknown): void {
    const response = object(value);
    if (response.headers instanceof Headers) {
      this.requestId ??= text(response.headers.get(this.endpoint === 'messages' ? 'request-id' : 'x-request-id'), 256);
    }
  }

  responseId(value: unknown): void {
    this.requestId ??= text(value, 256);
  }

  private metadata(value: Record<string, unknown>): void {
    this.model = text(value.model, 256) ?? this.model;
    this.requestId ??= text(value._request_id, 256);
    this.serviceTier = text(value.service_tier, 64) ?? this.serviceTier;
    if (value.usage != null) this.usage = value.usage;
  }

  result(value: unknown): void {
    const response = object(value);
    this.metadata(response);
    const status = response.status;
    if (status === 'cancelled') this.finish('cancelled', undefined, true);
    else if (status === 'failed' || status === 'incomplete') this.finish('error', response.error, true);
    else this.finish('success', undefined, true);
  }

  chunk(value: unknown): void {
    const chunk = object(value);
    if (this.endpoint === 'responses') {
      switch (chunk.type) {
        case 'response.created':
          this.metadata(object(chunk.response));
          return;
        case 'response.completed':
        case 'response.incomplete':
        case 'response.failed':
          this.result(chunk.response);
          return;
        case 'error':
          this.finish('error', chunk);
      }
    } else if (this.endpoint === 'messages') {
      // Messages exposes initial input and cache counts, then cumulative updates.
      if (chunk.type === 'message_start') this.metadata(object(chunk.message));
      if (chunk.type === 'message_delta') this.updateMessageUsage(chunk.usage);
      if (chunk.type === 'message_stop') this.finish('success', undefined, true);
      if (chunk.type === 'error') this.finish('error', chunk.error);
    } else {
      this.metadata(chunk);
    }
  }

  private updateMessageUsage(value: unknown): void {
    // Delta counts are cumulative. Copy only numeric accounting fields.
    const next = object(value);
    const previous = object(this.usage);
    const usage: Record<string, unknown> = { cache_creation: next.cache_creation ?? previous.cache_creation };
    for (const key of ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens']) {
      const amount = count(next[key]) ?? count(previous[key]);
      if (amount !== undefined) usage[key] = amount;
    }
    this.usage = usage;
  }

  completed(): void {
    // Chat can finish without usage. Responses and Messages are expected to
    // report a terminal event before their iterators finish normally.
    this.finish(this.endpoint === 'chat' ? 'success' : 'error', undefined, this.endpoint === 'chat');
  }

  failed(reason: unknown): void {
    const error = object(reason);
    const cancelled = error.name === 'AbortError' || error.name === 'APIUserAbortError' ||
      error.name === 'APIRequestAbortedError';
    this.finish(cancelled ? 'cancelled' : 'error', reason);
  }

  finish(status: Status, reason?: unknown, useUsage = false): void {
    if (this.done) return;
    this.done = true;
    // Provider errors can contain request or response bodies. Copy only the
    // allowlisted error code, HTTP status, and provider request ID.
    const failure = object(reason);
    const code = text(failure.code ?? failure.type, 128);
    const safeCode = code && /^[A-Za-z0-9_.-]+$/.test(code) ? code : undefined;
    const httpStatus = count(failure.status);
    const validStatus = httpStatus !== undefined && httpStatus >= 100 && httpStatus <= 599;
    const providerRequestId = this.requestId ?? text(failure.request_id, 256);
    this.record({
      ...this.context,
      id: randomUUID(),
      type: 'llm.request',
      provider: this.endpoint === 'messages' ? 'anthropic' : 'openai',
      model: this.model,
      occurredAt: this.occurredAt,
      durationMs: Math.round(Math.max(0, performance.now() - this.start)),
      status,
      usage: useUsage ? readUsage(this.endpoint, this.usage) : null,
      ...(providerRequestId ? { providerRequestId } : {}),
      ...(this.serviceTier ? { billing: { serviceTier: this.serviceTier } } : {}),
      ...(safeCode || validStatus ? { error: {
        ...(safeCode ? { code: safeCode } : {}),
        ...(validStatus ? { httpStatus } : {}),
      } } : {}),
    });
  }
}
