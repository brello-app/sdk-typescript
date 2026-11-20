import { object } from '../telemetry/metadata.js';
import type { Observation } from './observation.js';
import { observe, proxy, type Method } from './proxy.js';

/**
 * Read each step only when the application advances the iterator. Forward
 * return() and throw() so early exit and cancellation still reach the provider.
 */
function watchIterator(source: AsyncIterator<unknown>, observation: Observation): AsyncIterator<unknown> {
  const iterator = proxy(source, (key, value) => {
    if (typeof value !== 'function') return value;
    if (key === Symbol.asyncIterator) return () => iterator;
    if (key !== 'next' && key !== 'return' && key !== 'throw') return value.bind(source);
    return (...args: unknown[]) => {
      if (key === 'return') observe(() => observation.finish('cancelled'), undefined);
      try {
        return Promise.resolve<IteratorResult<unknown>>(Reflect.apply(value, source, args)).then(
          (step) => {
            if (key === 'next') observe(() => {
              if (step.done) observation.completed();
              else observation.chunk(step.value);
            }, undefined);
            return step;
          },
          (error: unknown) => {
            observe(() => observation.failed(error), undefined);
            throw error;
          },
        );
      } catch (error) {
        observe(() => observation.failed(error), undefined);
        throw error;
      }
    };
  });
  return iterator;
}

/** Observe parsed responses immediately and attach a lazy iterator to streamed responses. */
export function watchResult(value: unknown, observation: Observation): unknown {
  if (value && typeof value === 'object' && Symbol.asyncIterator in value) {
    if (observation.endpoint === 'google-generate' && 'next' in value && typeof value.next === 'function')
      return watchIterator(value as AsyncIterator<unknown>, observation);
    return proxy(value, (key, method) => {
      if (typeof method !== 'function') return method;
      if (key === Symbol.asyncIterator) return () => {
        const iterator = Reflect.apply(method, value, []) as AsyncIterator<unknown>;
        return observe(() => watchIterator(iterator, observation), iterator);
      };
      return method.bind(value);
    });
  }
  observation.result(value);
  return value;
}

/**
 * Provider stream helpers expose both an iterator and completion methods.
 * Both surfaces share the same observation, which emits at most one event.
 */
export function watchHelper<T extends object>(stream: T, observation: Observation): T {
  const runner = object(stream);
  if (typeof runner.on !== 'function') return stream;
  const on = runner.on.bind(stream) as Method;
  const endpoint = observation.endpoint;
  on(endpoint === 'responses' ? 'event' : endpoint === 'chat' ? 'chunk' : 'streamEvent',
    (value: unknown) => observe(() => observation.chunk(value), undefined));
  if (endpoint === 'chat')
    on('chatCompletion', (value: unknown) => observe(() => observation.result(value), undefined));
  if (endpoint === 'messages')
    on('finalMessage', (value: unknown) => observe(() => observation.result(value), undefined));
  on('end', () => observe(() => {
    if (runner.aborted === true || object(object(runner.controller).signal).aborted === true)
      observation.finish('cancelled');
    else if (runner.errored === true) observation.finish('error');
    else observation.completed();
  }, undefined));
  // An error listener can suppress the provider SDK's unhandled-error behavior.
  // Observe iterator and helper rejections while leaving that behavior intact.
  const wrapped = proxy(stream, (key, value) => {
    if (typeof value !== 'function') return value;
    return (...args: unknown[]) => {
      const result = Reflect.apply(value as Method, stream, args);
      return observe(() => {
        if (key === 'abort') observation.finish('cancelled');
        if (key === Symbol.asyncIterator) return watchIterator(result as AsyncIterator<unknown>, observation);
        if (key === 'done' || key === 'finalResponse' || key === 'finalChatCompletion' || key === 'finalMessage')
          return Promise.resolve(result).then((response) => {
            if (key !== 'done') observe(() => observation.result(response), undefined);
            return response;
          }, (error: unknown) => {
            observe(() => observation.failed(error), undefined);
            throw error;
          });
        // The runner's on()/once() methods return itself. Keep subsequent calls observable.
        return result === stream ? wrapped : result;
      }, result);
    };
  });
  return wrapped;
}
