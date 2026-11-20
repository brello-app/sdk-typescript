import { object } from '../telemetry/metadata.js';
import type { Observation } from './observation.js';
import { observe, proxy, type Method } from './proxy.js';
import { watchResult } from './stream.js';

/**
 * Preserve provider response helpers alongside the usual Promise methods.
 * Wrapping the provider call in an async function would hide those helpers.
 */
export function watchPromise<T extends object>(promise: T, observation: Observation): T {
  return proxy(promise, (key, value) => {
    if (typeof value !== 'function') return value;
    const method = value as Method;
    const rejected = (error: unknown): never => {
      observe(() => observation.failed(error), undefined);
      throw error;
    };
    const fulfilled = (result: unknown) => observe(() => watchResult(result, observation), result);
    // A call to then() can trigger body parsing. Defer it until the application
    // chooses a parsed path so asResponse() can still return an untouched body.
    if (key === 'then' || key === 'catch' || key === 'finally') {
      const parsed = () => new Promise<unknown>((resolve, reject) => {
        Reflect.apply(Reflect.get(promise, 'then') as Method, promise, [resolve, reject]);
      }).then(fulfilled, rejected);
      return (...args: unknown[]) => {
        const result = parsed();
        return Reflect.apply(Reflect.get(result, key) as Method, result, args);
      };
    }
    if (key === 'withResponse' || key === 'asResponse') return (...args: unknown[]) => {
      const result = Reflect.apply(method, promise, args) as Promise<unknown>;
      return result.then((response) => observe(() => {
        if (key === 'asResponse') {
          // Raw callers own the body. Record only the outcome and request ID here.
          observation.headers(response);
          observation.finish('success');
          return response;
        }
        const envelope = object(response);
        observation.headers(envelope.response);
        observation.responseId(envelope.request_id);
        const data = fulfilled(envelope.data);
        return data === envelope.data ? response : { ...envelope, data };
      }, response), rejected);
    };
    return method.bind(promise);
  });
}
