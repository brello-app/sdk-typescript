import type { TokenUsage } from '../telemetry/event.js';
import { count, object } from '../telemetry/metadata.js';

export function googleModelId(model: string): string {
  return model.replace(/^(?:(?:projects\/[^/]+\/locations\/[^/]+\/)?publishers\/google\/)?models\/(?=[^/]+$)/, '');
}

export function googleGenerationUsage(value: unknown): TokenUsage | null {
  const usage = object(value);
  const prompt = count(usage.promptTokenCount);
  const candidates = usage.candidatesTokenCount ?? usage.responseTokenCount;
  const output = count(candidates ?? 0);
  const tool = count(usage.toolUsePromptTokenCount ?? 0);
  const thoughts = count(usage.thoughtsTokenCount ?? 0);
  const cached = count(usage.cachedContentTokenCount);
  const total = count(usage.totalTokenCount);
  if (prompt === undefined || output === undefined || tool === undefined || thoughts === undefined ||
      (usage.cachedContentTokenCount !== undefined && cached === undefined) ||
      (candidates == null && total === undefined)) return null;

  const inputTokens = prompt + tool;
  const outputTokens = output + thoughts;
  const combined = inputTokens + outputTokens;
  if (!Number.isSafeInteger(combined) || (cached ?? 0) > inputTokens ||
      (usage.totalTokenCount !== undefined && total !== combined)) return null;
  return {
    inputTokens,
    outputTokens,
    ...(cached !== undefined ? { cacheReadInputTokens: cached } : {}),
  };
}

export function googleEmbeddingUsage(response: Record<string, unknown>): TokenUsage | null {
  const usage = object(response.usageMetadata);
  const reported = count(usage.promptTokenCount ?? usage.totalTokenCount);
  if (reported !== undefined) return { inputTokens: reported, outputTokens: 0 };

  // Some Vertex responses expose a token count for each embedding.
  if (!Array.isArray(response.embeddings) || !response.embeddings.length) return null;
  let inputTokens = 0;
  for (const embedding of response.embeddings) {
    const tokens = count(object(object(embedding).statistics).tokenCount);
    if (tokens === undefined) return null;
    inputTokens += tokens;
  }
  return Number.isSafeInteger(inputTokens) ? { inputTokens, outputTokens: 0 } : null;
}

export function googleServiceTier(value: unknown): string | undefined {
  const { serviceTier, trafficType } = object(value);
  switch (trafficType) {
    case 'ON_DEMAND_FLEX': return 'flex';
    case 'ON_DEMAND_OFFPEAK': return 'offpeak';
    case 'ON_DEMAND_PRIORITY': return 'priority';
    case 'PROVISIONED_THROUGHPUT': return 'provisioned_throughput';
  }
  if (serviceTier === 'standard' || serviceTier === 'flex' || serviceTier === 'priority') return serviceTier;
  if (trafficType === 'ON_DEMAND') return 'standard';
  return undefined;
}
