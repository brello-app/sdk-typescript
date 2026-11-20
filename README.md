# @brello/sdk

Wrap an existing OpenAI or Anthropic TypeScript client to send usage metadata to Brello. The SDK forwards the original provider results, errors, and streams.

## Set up

Install the Brello package from your distribution source and use your existing provider SDK. Set these server-side environment variables:

~~~sh
export BRELLO_API_KEY="YOUR_BRELLO_PROJECT_KEY"
~~~

The SDK sends events to `https://api.brello.app/v1` by default. For a self-hosted Brello deployment, set `BRELLO_API_BASE_URL` or `options.apiBaseUrl` to your deployment's API URL. Loopback HTTP is supported for local development.

~~~ts
import { Brello } from '@brello/sdk';
import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';

const brello = new Brello();
const openai = brello.wrap(new OpenAI());
const claude = brello.wrap(new Anthropic());
~~~

The Brello key authenticates ingestion. Your provider clients keep their existing API keys. Use a Brello test key when trying the integration in staging.

## Supported calls

| Provider | Methods |
| --- | --- |
| OpenAI | responses.create, responses.stream, chat.completions.create, chat.completions.stream, embeddings.create |
| Anthropic | messages.create, messages.stream |

Calls with tool definitions are supported through these methods. The SDK reads fields such as model, token counts, and request ID. It never reads prompts, output text, tool arguments or results, or embedding vectors. The server estimates cost from observed usage. If the provider omits final counts or reports cache-write categories Brello cannot represent, the event records usage as unknown.

The SDK preserves the provider's request options. To receive token counts from OpenAI Chat Completions streams, set stream_options.include_usage in your request. When using the raw asResponse helper, the SDK leaves the response body unread and records usage as unknown. Stream tracking covers provider stream helpers and their async iterators. Custom conversions such as tee() or toReadableStream() may bypass observation on raw streams.

## Add context

~~~ts
await brello.withContext(
  { endUser: { id: 'user_123' }, feature: 'summary', attributes: { plan: 'pro' } },
  () => openai.responses.create({ model: 'gpt-4o-mini', input: 'Summarize this text' }),
);
~~~

Use withContext around one call or a block of async calls. Pass defaults as the second argument to wrap. End-user identifiers and attributes are sent when the Brello project enables their collection. Set either field to false in the context to omit it. To send a project-scoped HMAC instead of a plain user ID, set options.hashEndUserId to true. The SDK omits the user until `GET /v1/config` supplies the project's hashing settings.

| Option | Environment variable | Behavior |
| --- | --- | --- |
| apiKey | BRELLO_API_KEY | Project ingestion key |
| options.apiBaseUrl | BRELLO_API_BASE_URL | Optional self-hosted API URL. Defaults to `https://api.brello.app/v1` |
| options.environment | BRELLO_ENV | prod or live for a live key, staging or test for a test key |
| options.serviceName | BRELLO_SERVICE_NAME | Adds the serviceName event attribute when attributes are enabled |
| options.enabled | BRELLO_ENABLED | Set to false or 0 to disable event delivery |
| options.debug | BRELLO_DEBUG | Set to true or 1 to inspect event metadata and delivery outcomes |

Explicit options take precedence. The SDK masks user identifiers and custom attributes in its debug output. Set `options.debugIncludeContext: true` with debug enabled to see the event context that will be sent. Use this only with local test data.

## Delivery and shutdown

The SDK batches events after 20 entries or approximately 2 seconds and buffers up to 500 entries or 2 MiB of serialized events, including the batch in flight. It evicts older pending events when the buffer fills and expires events after 60 seconds. Retries reuse event IDs and honor `Retry-After`. After three consecutive ingestion failures from network errors, timeouts, or HTTP 5xx responses, delivery pauses for 30 seconds. The next batch tests recovery. If that request fails, the pause increases with jitter up to five minutes. Provider calls continue during the pause.

Call `await brello.flush()` during graceful shutdown or before a short-lived Node.js process exits. The default wait is five seconds. A flush can return earlier when delivery is paused beyond its deadline. On Cloudflare Workers with Node.js compatibility enabled, pass secret bindings through explicit options and register `ctx.waitUntil(brello.flush())` after the provider call or stream completes. On other serverless hosts, use the host's background-task hook or await the flush before returning.

In project settings, Connected reflects events saved by the Brello worker.

## Development

In a source checkout, see [CONTRIBUTING.md](CONTRIBUTING.md) for the source layout and event flow.

Run `pnpm typecheck`, `pnpm lint`, `pnpm test`, and `pnpm build` from this directory. The package targets Node.js 18 or newer. The build emits ESM and CommonJS with TypeScript declarations. Provider client packages are installed by the application.

In a source checkout, see [Releasing to npm](CONTRIBUTING.md#releasing-to-npm) for the GitHub Actions release process.

## Contact

- [Brello](mailto:hello@brello.app)
- [Dan](mailto:gyeon@brello.app)
