import type { TokenUsage } from '../telemetry/event.js';
import { count, object } from '../telemetry/metadata.js';

export type Endpoint = 'responses' | 'chat' | 'embeddings' | 'messages';

/**
 * Translate provider counts to the ingestion schema. Unknown or unrepresentable
 * values become null so the server does not interpret them as zero-cost usage.
 */
export function readUsage(endpoint: Endpoint, value: unknown): TokenUsage | null {
  const usage = object(value);
  if (endpoint === 'embeddings') {
    const inputTokens = count(usage.prompt_tokens);
    return inputTokens === undefined ? null : { inputTokens, outputTokens: 0 };
  }
  if (endpoint === 'messages') {
    const uncached = count(usage.input_tokens);
    const outputTokens = count(usage.output_tokens);
    if (uncached === undefined || outputTokens === undefined) return null;
    const cacheRead = count(usage.cache_read_input_tokens);
    const cacheWrite = count(usage.cache_creation_input_tokens);
    const creation = object(usage.cache_creation);
    const fiveMinutes = count(creation.ephemeral_5m_input_tokens);
    const oneHour = count(creation.ephemeral_1h_input_tokens);
    const writes = (fiveMinutes ?? 0) + (oneHour ?? 0);
    // An unclassified write cannot be priced as standard input.
    if (cacheWrite !== undefined && cacheWrite !== writes) return null;
    // Anthropic's input_tokens excludes cache reads and cache creation.
    const inputTokens = uncached + (cacheRead ?? 0) + writes;
    if (!Number.isSafeInteger(inputTokens)) return null;
    return {
      inputTokens,
      outputTokens,
      ...(cacheRead !== undefined ? { cacheReadInputTokens: cacheRead } : {}),
      ...(fiveMinutes !== undefined || oneHour !== undefined
        ? { cacheCreationInputTokens: { fiveMinutes, oneHour } } : {}),
    };
  }
  // OpenAI already includes cached input and reasoning output in its totals.
  const responses = endpoint === 'responses';
  const inputTokens = count(responses ? usage.input_tokens : usage.prompt_tokens);
  const outputTokens = count(responses ? usage.output_tokens : usage.completion_tokens);
  const inputDetails = object(responses ? usage.input_tokens_details : usage.prompt_tokens_details);
  const cacheRead = count(inputDetails.cached_tokens);
  if (inputTokens === undefined || outputTokens === undefined || (cacheRead ?? 0) > inputTokens ||
      (count(inputDetails.cache_write_tokens) ?? 0) > 0) return null;
  return {
    inputTokens,
    outputTokens,
    ...(cacheRead !== undefined ? { cacheReadInputTokens: cacheRead } : {}),
  };
}
