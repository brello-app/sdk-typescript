import type { BrelloContext, EventContext, TelemetryEvent } from './event.js';

export function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : {};
}

export function text(value: unknown, max: number): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= max ? value : undefined;
}

export function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/**
 * Copy only recognized context fields with ingestion-compatible bounds. The
 * project config is checked again just before delivery, when the transport knows
 * whether user data and attributes are enabled.
 */
export function safeContext(context: BrelloContext): EventContext {
  const feature = text(context.feature, 64);
  const source = object(context.endUser);
  const id = text(source.id, 256);
  const name = typeof source.name === 'string' ? text(source.name.trim(), 200) : undefined;
  const endUser = {
    ...(id?.trim() && !id.includes('\0') ? { id } : {}),
    ...(name && !name.includes('\0') ? { name } : {}),
  };
  const attributes = Object.fromEntries(Object.entries(object(context.attributes))
    .filter(([key, value]) => /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(key) &&
      ((typeof value === 'string' && value.length <= 256) ||
        (typeof value === 'number' && Number.isFinite(value)) || typeof value === 'boolean'))
    .slice(0, 32)) as TelemetryEvent['attributes'];
  return {
    ...(feature ? { feature } : {}),
    ...(Object.keys(endUser).length ? { endUser } : {}),
    ...(attributes && Object.keys(attributes).length ? { attributes } : {}),
  };
}
