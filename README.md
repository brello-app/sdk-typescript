# @brello/sdk

Brello SDK for TypeScript / Node.js.

> [!WARNING]
> **Brello is in beta.** The SDK and its API may change at any time without notice, and backward compatibility is not guaranteed between versions. Features may be added, changed, or removed. Pin an exact version in production and check the changelog before upgrading.

Wrap your OpenAI or Anthropic client once, and Brello tracks your AI API spend by model, feature, and end user. Your provider calls don't change.

- **One-line setup.** Wrap your existing client. Methods and return types stay the same.
- **Metadata only.** Brello never reads prompts, output text, tool arguments or results, or embedding vectors.
- **Not a proxy.** Requests go straight from your server to OpenAI or Anthropic. If Brello is down, your provider calls keep working.
- **Open source.** Read exactly what gets collected.

📖 Docs: https://brello.app/sdk/typescript/quickstart

---

## Requirements

- Node.js 18 or newer (server-side)
- A Brello project ingestion key
- `openai` or `@anthropic-ai/sdk` in your project

## Install

```bash
npm install @brello/sdk --save-exact
```

During the beta, we recommend pinning an exact version (`--save-exact`) so updates don't break your build unexpectedly.

Keep your existing `openai` or `@anthropic-ai/sdk` dependency. Brello wraps it rather than replacing it.

## Quickstart

### 1. Set your project key

```bash
export BRELLO_API_KEY="YOUR_BRELLO_PROJECT_KEY"
```

Set `OPENAI_API_KEY` or `ANTHROPIC_API_KEY` separately, as you already do.

### 2. Wrap your client

Create **one** `Brello` instance per application runtime so all calls share a buffer.

**OpenAI**

```ts
import { Brello } from "@brello/sdk";
import OpenAI from "openai";

const brello = new Brello();
export const openai = brello.wrap(new OpenAI());

const response = await openai.responses.create({
  model: process.env.OPENAI_MODEL!,
  input: "Summarize what this application does.",
});

console.log(response.output_text);
```

**Anthropic**

```ts
import { Brello } from "@brello/sdk";
import Anthropic from "@anthropic-ai/sdk";

const brello = new Brello();
export const anthropic = brello.wrap(new Anthropic());

const message = await anthropic.messages.create({
  model: process.env.ANTHROPIC_MODEL!,
  max_tokens: 256,
  messages: [{ role: "user", content: "Summarize the release notes." }],
});
```

### 3. Verify

Complete a provider call, or finish consuming its stream. Then open your project's **Settings** in Brello and look for **Connected** under SDK activity.

In a short-lived test script, call `await brello.flush()` before it exits.

## Attribute usage to users and features

See cost per end user and per feature, and catch abusive users by their spend pattern.

```ts
const response = await brello.withContext(
  {
    endUser: { id: "user_123" },
    feature: "summarize",
    attributes: { plan: "pro" },
  },
  () =>
    openai.responses.create({
      model: process.env.OPENAI_MODEL!,
      input: "Summarize the release notes.",
    }),
);
```

- `withContext()` covers a single call or a block of async calls.
- Pass defaults with `brello.wrap(client, defaults)`.
- Set `endUser: false` or `attributes: false` to omit those fields.
- User and attribute fields are sent only when your project settings enable them. Use `options.hashEndUserId` to send a project-scoped HMAC instead of the raw ID.

## Supported methods

| Provider                | Methods                                                                         |
| ----------------------- | ------------------------------------------------------------------------------- |
| OpenAI Responses        | `responses.create()` (incl. `stream: true`), `responses.stream()`               |
| OpenAI Chat Completions | `chat.completions.create()` (incl. `stream: true`), `chat.completions.stream()` |
| OpenAI Embeddings       | `embeddings.create()`                                                           |
| Anthropic Messages      | `messages.create()` (incl. `stream: true`), `messages.stream()`                 |

### Streaming notes

- **OpenAI Chat Completions:** add `stream_options: { include_usage: true }` to receive final usage.
- Consume the original SDK iterator or its stream helpers. On raw streams, `tee()` and `toReadableStream()` may bypass Brello.
- If a stream ends before final counts arrive, the event is recorded with `usage: null`.
- Anthropic cache reads and cache creation are included in total input tokens.

## Configuration

Pass options to `new Brello({ apiKey, options })`. Explicit options override environment variables.

| Option                        | Environment variable  | Description                                                                      |
| ----------------------------- | --------------------- | -------------------------------------------------------------------------------- |
| `apiKey`                      | `BRELLO_API_KEY`      | Project ingestion key                                                            |
| `options.apiBaseUrl`          | `BRELLO_API_BASE_URL` | Self-hosted API URL. Default: `https://api.brello.app/v1`                        |
| `options.environment`         | `BRELLO_ENV`          | Key check. `prod`/`live` expects a live key, `staging`/`test` expects a test key |
| `options.serviceName`         | `BRELLO_SERVICE_NAME` | Adds a `serviceName` attribute                                                   |
| `options.enabled`             | `BRELLO_ENABLED`      | Set `false` / `0` to disable delivery                                            |
| `options.debug`               | `BRELLO_DEBUG`        | Set `true` / `1` to log event metadata and delivery outcomes                     |
| `options.hashEndUserId`       |                       | Send a project-scoped HMAC instead of the raw user ID                            |
| `options.debugIncludeContext` |                       | Include real user/attribute fields in debug logs. Local test data only           |

If the environment check fails, delivery is disabled but your provider client keeps serving requests.

### Self-hosted Brello

```bash
export BRELLO_API_BASE_URL="https://brello-api.example.com/v1"
```

Include the `/v1` prefix and use HTTPS. For local development, `http://localhost:8000/v1` works.

## Delivery and flushing

Events are batched and sent in the background, so the SDK never blocks your provider calls.

- A batch is sent after 20 events or about 2 seconds.
- The buffer holds up to 500 events or 2 MiB. Events expire after 60 seconds.
- Failed deliveries are retried with the same event ID, and back off on repeated errors. Provider calls continue during pauses.

Flush on shutdown or before a short-lived script exits:

```ts
await brello.flush(); // waits up to 5s
await brello.flush(10_000); // custom timeout
```

### Cloudflare Workers

Enable Node.js compatibility and pass the secret binding as `apiKey`:

```ts
const brello = new Brello({ apiKey: env.BRELLO_API_KEY });

// After your provider call or stream completes:
ctx.waitUntil(brello.flush());
```

On other serverless platforms, use the runtime's background-task hook, or await the flush before the invocation ends.

## Troubleshooting

**Status stays "Pending"**

1. Check that `BRELLO_API_KEY` is the correct project key.
2. Run with `BRELLO_DEBUG=1` to inspect delivery. User IDs and attributes are masked in debug output by default.
3. In scripts or serverless functions, make sure `brello.flush()` runs before the process exits.

## Links

- Website: https://brello.app
- Docs: https://brello.app/sdk/typescript/quickstart
- Discord support: <!-- TODO -->
- Issues: https://github.com/brello-app/<!-- TODO: repo -->/issues

## License

<!-- TODO -->
