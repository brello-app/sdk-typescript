export type Method = (...args: unknown[]) => unknown;

/** Fail open for telemetry work. Provider calls themselves stay outside this boundary. */
export function observe<T>(callback: () => T, fallback: T): T {
  try { return callback(); } catch { return fallback; }
}

/**
 * Apply lazy wrappers while preserving the target's prototype. Reuse wrappers
 * for unchanged members so repeated reads keep their function identity.
 */
export function proxy<T extends object>(target: T, transform: (key: PropertyKey, value: unknown) => unknown): T {
  const cache = new Map<PropertyKey, { original: unknown; wrapped: unknown }>();
  return new Proxy(target, {
    get(original, key) {
      // Provider getters can use private fields and must receive the original object.
      const value: unknown = Reflect.get(original, key, original);
      const own = Reflect.getOwnPropertyDescriptor(original, key);
      // JavaScript requires exact values for frozen data properties.
      if (own?.configurable === false && 'value' in own && own.writable === false) return value;
      const existing = cache.get(key);
      if (existing && existing.original === value) return existing.wrapped;
      const wrapped = observe(() => transform(key, value), value);
      if (wrapped !== value) cache.set(key, { original: value, wrapped });
      return wrapped;
    },
  });
}
