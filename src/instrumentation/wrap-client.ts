import type { EventContext, GoogleProvider, Provider } from '../telemetry/event.js';
import { object, text } from '../telemetry/metadata.js';
import { Observation, type ObservedEndpoint, type RecordEvent } from './observation.js';
import type { Endpoint } from './provider-usage.js';
import { observe, proxy } from './proxy.js';
import { watchPromise } from './promise.js';
import { watchHelper } from './stream.js';

type Context = () => EventContext;

function observedEndpoint(resource: Endpoint | 'google-models', method: PropertyKey): ObservedEndpoint | undefined {
  if (resource === 'google-models') {
    if (method === 'generateContent' || method === 'generateContentStream') return 'google-generate';
    if (method === 'embedContent') return 'google-embedding';
    return undefined;
  }
  return method === 'create' || method === 'stream' ? resource : undefined;
}

/**
 * Start one observation per supported call. Bind the original receiver because
 * provider resource methods may depend on private fields. Provider exceptions
 * are recorded on a best-effort basis, then rethrown unchanged.
 */
function wrapResource<T extends object>(
  resource: T, name: Endpoint | 'google-models', provider: Provider, context: Context, record: RecordEvent,
): T {
  return proxy(resource, (key, value) => {
    if (typeof value !== 'function') return value;
    const endpoint = observedEndpoint(name, key);
    if (!endpoint) return value.bind(resource);
    return function (...args: unknown[]) {
      const observation = observe(() => {
        const model = text(object(args[0]).model, 256);
        return model ? new Observation(endpoint, provider, model, context(), record) : undefined;
      }, undefined);
      let result: unknown;
      try {
        result = Reflect.apply(value, resource, args);
      } catch (error) {
        if (observation) observe(() => observation.failed(error), undefined);
        throw error;
      }
      if (!observation || !result || typeof result !== 'object') return result;
      return observe(() => key === 'stream' ? watchHelper(result, observation) : watchPromise(result, observation), result);
    };
  });
}

/**
 * The resource allowlist defines the SDK surface we observe. Other client
 * methods are delegated to the provider without creating events.
 */
export function wrapClient<T extends object>(client: T, context: Context, record: RecordEvent, googleProvider?: GoogleProvider): T {
  return proxy(client, (key, value) => {
    if (googleProvider === 'google_ai_studio' || googleProvider === 'google_vertex_ai') {
      if (key === 'models' && value && typeof value === 'object')
        return wrapResource(value, 'google-models', googleProvider, context, record);
      return typeof value === 'function' ? value.bind(client) : value;
    }
    if (key === 'chat' && value && typeof value === 'object') {
      return proxy(value, (resource, completions) =>
        resource === 'completions' && completions && typeof completions === 'object'
          ? wrapResource(completions, 'chat', 'openai', context, record) : completions);
    }
    if (value && typeof value === 'object') {
      if (key === 'responses' || key === 'embeddings') return wrapResource(value, key, 'openai', context, record);
      if (key === 'messages') return wrapResource(value, 'messages', 'anthropic', context, record);
    }
    return typeof value === 'function' ? value.bind(client) : value;
  });
}
