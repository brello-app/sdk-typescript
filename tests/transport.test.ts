import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { it } from 'vitest';
import { Transport } from '../src/delivery/transport.js';
import { Brello } from '../src/index.js';
import type { TelemetryEvent } from '../src/telemetry/event.js';

function transport(fetch: typeof globalThis.fetch) {
  return new Transport({
    key: 'brl_test_' + 'A'.repeat(43),
    baseUrl: new URL('https://brello.example/v1/'),
    debug: false,
    debugIncludeContext: false,
    hashEndUserId: false,
    fetch,
  });
}

function event(model: string): TelemetryEvent {
  return {
    id: randomUUID(),
    model,
    provider: 'openai',
    type: 'llm.request',
    occurredAt: new Date().toISOString(),
    durationMs: 1,
    status: 'success',
    usage: null,
  };
}

it('cancels error bodies and opens the circuit after three failed ingests', async () => {
  const cancellations: number[] = [];
  const ingests: TelemetryEvent[][] = [];
  let down = true;
  const error = (status: number) => new Response(new ReadableStream({
    cancel() { cancellations.push(status); },
  }), { status });
  const sdk = transport(async (_input, init) => {
    if (init?.method === 'GET') return error(502);
    const { events } = JSON.parse(String(init?.body));
    ingests.push(events);
    return down ? error(504) : new Response(null, { status: 202 });
  });
  const originalNow = Date.now;
  const first = event('first');
  try {
    sdk.enqueue(first);
    await sdk.flush(3_000);
    assert.deepEqual(cancellations, [502, 504, 504, 504]);
    assert.equal(ingests.length, 3);
    assert.ok(ingests.every(([entry]) => entry.id === first.id));

    sdk.enqueue(event('second'));
    await sdk.flush(50);
    assert.equal(ingests.length, 3);

    down = false;
    Date.now = () => originalNow() + 31_000;
    await sdk.flush(1000);
    assert.equal(ingests.length, 4);
    assert.deepEqual(ingests[3].map(({ model }) => model), ['first', 'second']);
    assert.equal(ingests[3][0].id, first.id);
  } finally {
    Date.now = originalNow;
  }
});

it('separates Retry-After from the failure circuit and discards expired entries', async () => {
  const sent: TelemetryEvent[][] = [];
  let cancelled = false;
  const sdk = transport(async (_input, init) => {
    if (init?.method === 'GET') return Response.json({ data: {} });
    sent.push(JSON.parse(String(init?.body)).events);
    if (sent.length > 1) return new Response(null, { status: 202 });
    return new Response(new ReadableStream({ cancel() { cancelled = true; } }), {
      status: 429, headers: { 'Retry-After': '90' },
    });
  });
  const originalNow = Date.now;
  try {
    sdk.enqueue(event('expired'));
    await sdk.flush(100);
    assert.equal(sent.length, 1);
    assert.equal(cancelled, true);

    Date.now = () => originalNow() + 61_000;
    sdk.enqueue(event('fresh'));
    await sdk.flush(100);
    assert.equal(sent.length, 1);

    Date.now = () => originalNow() + 91_000;
    await sdk.flush(1000);
    assert.equal(sent.length, 2);
    assert.deepEqual(sent[1].map(({ model }) => model), ['fresh']);
  } finally {
    Date.now = originalNow;
  }
});

it('keeps flush and provider calls responsive when a custom fetch never settles', async () => {
  let requests = 0;
  let finish!: (response: Response) => void;
  const hung = new Promise<Response>((resolve) => { finish = resolve; });
  const brello = new Brello({
    apiKey: 'brl_test_' + 'A'.repeat(43),
    options: {
      enabled: true,
      environment: 'test',
      apiBaseUrl: 'https://brello.example/v1',
      fetch: async (_input, init) => {
        if (init?.method === 'GET') return Response.json({ data: {} });
        requests++;
        return requests === 1 ? hung : new Response(null, { status: 202 });
      },
    },
  });
  const client = brello.wrap({ responses: {
    async create({ model }: { model: string }) { return { model }; },
  } });
  assert.deepEqual(await client.responses.create({ model: 'first' }), { model: 'first' });
  await brello.flush(20);
  assert.equal(requests, 1);
  assert.deepEqual(await client.responses.create({ model: 'second' }), { model: 'second' });
  await Promise.all([brello.flush(20), brello.flush(25), brello.flush(30)]);
  assert.equal(requests, 1);
  finish(new Response(null, { status: 202 }));
  await brello.flush(1000);
  assert.equal(requests, 2);
});

it('bounds configuration JSON and keeps sending events when its body is too large', async () => {
  let cancelled = false;
  let sent = false;
  const sdk = transport(async (_input, init) => {
    if (init?.method === 'GET') return new Response(new ReadableStream({
      start(stream) { stream.enqueue(new Uint8Array(64_001)); },
      cancel() { cancelled = true; },
    }));
    sent = true;
    return new Response(null, { status: 202 });
  });
  sdk.enqueue(event('example'));
  await sdk.flush(1000);
  assert.equal(cancelled, true);
  assert.equal(sent, true);
});

it('evicts the oldest pending events while a batch is in flight', async () => {
  const sent: string[] = [];
  let finish!: (response: Response) => void;
  const first = new Promise<Response>((resolve) => { finish = resolve; });
  const sdk = transport(async (_input, init) => {
    if (init?.method === 'GET') return Response.json({ data: {} });
    const batch: TelemetryEvent[] = JSON.parse(String(init?.body)).events;
    sent.push(...batch.map(({ model }) => model));
    return sent.length === 1 ? first : new Response(null, { status: 202 });
  });
  sdk.enqueue(event('in-flight'));
  await sdk.flush(20);
  for (let i = 0; i < 510; i++) sdk.enqueue(event(String(i)));
  finish(new Response(null, { status: 202 }));
  await sdk.flush(1000);
  assert.equal(sent.length, 500);
  assert.deepEqual(sent.slice(0, 2), ['in-flight', '11']);
  assert.equal(sent.at(-1), '509');
});
