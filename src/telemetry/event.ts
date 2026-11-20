export type Provider = 'openai' | 'anthropic';
export type Status = 'success' | 'error' | 'cancelled';

/** Application metadata that can be supplied per wrapper or async context. */
export interface BrelloContext {
  endUser?: { id?: string; name?: string } | false;
  feature?: string;
  attributes?: Record<string, string | number | boolean> | false;
}

/** Provider counts normalized to the shared ingestion contract. */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: { fiveMinutes?: number; oneHour?: number };
}

/**
 * Wire format for a single provider invocation. Event IDs survive retries.
 * Keep request bodies, response content, and provider credentials out of it.
 */
export interface TelemetryEvent {
  id: string;
  type: 'llm.request';
  occurredAt: string;
  durationMs: number;
  provider: Provider;
  model: string;
  status: Status;
  usage: TokenUsage | null;
  providerRequestId?: string;
  feature?: string;
  endUser?: Exclude<BrelloContext['endUser'], false> | {
    idHash: string; algorithm: 'hmac-sha256'; keyVersion: '1';
  };
  attributes?: Exclude<BrelloContext['attributes'], false>;
  billing?: { serviceTier: string };
  error?: { code?: string; httpStatus?: number };
}

/** Validated context before the transport applies collection settings and hashing. */
export type EventContext = Pick<TelemetryEvent, 'feature' | 'attributes'> & {
  endUser?: Exclude<BrelloContext['endUser'], false>;
};
