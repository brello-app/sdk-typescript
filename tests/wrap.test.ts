import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { describe, it } from 'vitest';
import { Brello } from '../src/index.js';

const apiKey = 'brl_test_' + 'A'.repeat(43);
const path = 'https://brello.example/v1';

class ApiPromise<T> implements PromiseLike<T> {
  constructor(private readonly load: () => T, private readonly raw: Response) {}

  then<A = T, B = never>(
    resolve?: ((value: T) => A | PromiseLike<A>) | null,
    reject?: ((error: unknown) => B | PromiseLike<B>) | null,
  ): Promise<A | B> {
    return Promise.resolve().then(this.load).then(resolve, reject);
  }

  async withResponse() {
    return { data: this.load(), response: this.raw, request_id: 'req_example' };
  }

  async asResponse() {
    return this.raw;
  }
}

function setup(statuses: number[] = [], hashEndUserId = false) {
  const delivered: Record<string, unknown>[][] = [];
  const brello = new Brello({
    apiKey,
    options: {
      environment: 'staging',
      apiBaseUrl: path,
      hashEndUserId,
      fetch: async (input, init) => {
        assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer ' + apiKey);
        if (String(input) === path + '/config') return Response.json({
          data: {
            collection: { eventsEnabled: true, attributesEnabled: true, endUserIdEnabled: true },
            identity: { endUser: {
              algorithm: 'hmac-sha256', secretEncoding: 'base64url', keyVersion: '1',
              secret: 'B'.repeat(43), domain: 'brello:end-user:v1',
            } },
            refreshAfterSeconds: 60,
          },
        });
        assert.equal(String(input), path + '/events');
        const { schemaVersion, events } = JSON.parse(String(init?.body));
        assert.equal(schemaVersion, '1');
        delivered.push(events);
        return Response.json({ data: { rejectedCount: 0 } }, { status: statuses.shift() ?? 202 });
      },
    },
  });
  return { brello, delivered };
}

describe('Brello wrapping', () => {
  it('routes hosted traffic by default and honors self-hosted URL overrides', async () => {
    const previous = process.env.BRELLO_API_BASE_URL;
    try {
      for (const [envUrl, optionUrl, expected] of [
        [undefined, undefined, 'https://api.brello.app/v1'],
        ['', undefined, 'https://api.brello.app/v1'],
        ['https://self-hosted.example', undefined, 'https://self-hosted.example/v1'],
        ['https://self-hosted.example', 'http://localhost:8000/v1/', 'http://localhost:8000/v1'],
        ['invalid-self-hosted-url', undefined, undefined],
      ]) {
        if (envUrl === undefined) delete process.env.BRELLO_API_BASE_URL;
        else process.env.BRELLO_API_BASE_URL = envUrl;

        const urls: string[] = [];
        const brello = new Brello({
          apiKey,
          options: {
            apiBaseUrl: optionUrl,
            environment: 'test',
            enabled: true,
            fetch: async (input, init) => {
              urls.push(String(input));
              return Response.json({ data: {} }, { status: init?.method === 'GET' ? 200 : 202 });
            },
          },
        });
        const client = brello.wrap({ responses: {
          async create(params: { model: string }) { return { model: params.model }; },
        } });
        assert.deepEqual(await client.responses.create({ model: 'example' }), { model: 'example' });
        await brello.flush();
        assert.deepEqual(urls, expected ? [expected + '/config', expected + '/events'] : []);
      }
    } finally {
      if (previous === undefined) delete process.env.BRELLO_API_BASE_URL;
      else process.env.BRELLO_API_BASE_URL = previous;
    }
  });

  it('preserves API promises and untouched raw bodies while sending only event metadata', async () => {
    const { brello, delivered } = setup();
    const raw = new Response('raw-body', { headers: { 'x-request-id': 'req_openai' } });
    let reads = 0;
    const client = brello.wrap({
      responses: {
        model: 'gpt-resolved',
        create(params: { model: string; input: string }) {
          assert.equal(params.model, 'gpt');
          return new ApiPromise(() => {
            reads++;
            return {
              model: this.model,
              status: 'completed',
              get output() { throw new Error('The SDK must not inspect output'); },
              usage: {
                input_tokens: 10, output_tokens: 5, input_tokens_details: { cached_tokens: 4 },
                output_tokens_details: { reasoning_tokens: 2 },
              },
            };
          }, raw);
        },
      },
    });

    const rawCall = client.responses.create({ model: 'gpt', input: 'private prompt' });
    assert.ok(rawCall instanceof ApiPromise);
    assert.equal(await rawCall.asResponse(), raw);
    assert.equal(reads, 0);
    assert.equal(raw.bodyUsed, false);
    const result = await brello.withContext({ feature: 'summary', endUser: { id: 'u1' } }, () =>
      client.responses.create({ model: 'gpt', input: 'private prompt' }).withResponse());
    assert.equal(result.data.model, 'gpt-resolved');
    await brello.flush();
    assert.equal(delivered.flat().length, 2);
    assert.equal(delivered[0][0].usage, null);
    assert.deepEqual(delivered[0][1].usage, { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 4 });
    assert.deepEqual(delivered[0][1].endUser, { id: 'u1' });
    assert.equal(delivered[0][1].providerRequestId, 'req_openai');
    assert.equal(JSON.stringify(delivered).includes('private prompt'), false);
  });

  it('combines Anthropic cumulative usage, preserves the stream helper and reports exactly once', async () => {
    const { brello, delivered } = setup([], true);
    const usage = {
      input_tokens: 15,
      output_tokens: 6,
      cache_read_input_tokens: 20,
      cache_creation_input_tokens: 5,
      cache_creation: { ephemeral_5m_input_tokens: 3, ephemeral_1h_input_tokens: 2 },
    };
    const chunks = [
      { type: 'message_start', message: { model: 'claude-example', usage: { ...usage, output_tokens: 1 } } },
      { type: 'message_delta', usage: { output_tokens: 4 } },
      { type: 'message_delta', usage: { output_tokens: 6 } },
      { type: 'message_stop' },
    ];
    class MessageStream extends EventEmitter {
      async *[Symbol.asyncIterator]() {
        for (const chunk of chunks) {
          this.emit('streamEvent', chunk);
          yield chunk;
        }
        this.emit('end');
      }

      async finalMessage() { return { model: 'claude-example', usage }; }
    }
    const client = brello.wrap({ messages: { stream(params: { model: string }) {
      assert.equal(params.model, 'claude-example');
      return new MessageStream();
    } } });
    const stream = brello.withContext({ endUser: { id: 'jane', name: 'Staff' } }, () =>
      client.messages.stream({ model: 'claude-example' }));
    assert.ok(stream instanceof MessageStream);
    assert.equal(stream.on('other', () => {}), stream);
    const received = [];
    for await (const chunk of stream) received.push(chunk);
    assert.deepEqual(received, chunks);
    assert.equal((await stream.finalMessage()).usage.output_tokens, 6);
    await brello.flush();
    const [event] = delivered.flat();
    assert.equal(delivered.flat().length, 1);
    assert.deepEqual(event.usage, {
      inputTokens: 40, outputTokens: 6, cacheReadInputTokens: 20,
      cacheCreationInputTokens: { fiveMinutes: 3, oneHour: 2 },
    });
    assert.match(String((event.endUser as { idHash: string }).idHash), /^[a-f0-9]{64}$/);
    assert.equal(JSON.stringify(delivered).includes('jane'), false);
  });

  it('preserves errors and stream cancellation, and reuses UUIDs after a delivery failure', async () => {
    const { brello, delivered } = setup([429, 202]);
    const failure = Object.assign(new Error('private provider error text'), { status: 503, code: 'unavailable' });
    let closed = false;
    const client = brello.wrap({
      chat: {
        completions: {
          async create(params: { model: string; fail?: boolean }) {
            if (params.fail) throw failure;
            return (async function* () {
              try {
                yield { id: 'completion', model: 'gpt', choices: [] };
                yield { id: 'completion', model: 'gpt', choices: [] };
              } finally {
                closed = true;
              }
            })();
          },
        },
      },
    });
    await assert.rejects(client.chat.completions.create({ model: 'gpt', fail: true }),
      (error: unknown) => error === failure);
    for await (const chunk of await client.chat.completions.create({ model: 'gpt' })) {
      assert.equal(chunk.id, 'completion');
      break;
    }
    assert.equal(closed, true);
    await brello.flush(3_000);
    assert.deepEqual(delivered[0], delivered[1]);
    assert.deepEqual(delivered[0].map((e) => e.status), ['error', 'cancelled']);
    assert.deepEqual(delivered[0][0].error, { code: 'unavailable', httpStatus: 503 });
    assert.equal(JSON.stringify(delivered).includes('private provider error text'), false);
  });
});

