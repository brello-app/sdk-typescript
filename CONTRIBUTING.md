# Contributing

This package wraps supported OpenAI and Anthropic client calls, extracts usage metadata, and delivers events to Brello. Start at [src/index.ts](src/index.ts) for the public API or [src/client.ts](src/client.ts) to follow a wrapped call.

## Find the code you need

| Area | Start here | Responsibility |
| --- | --- | --- |
| Public client | [src/client.ts](src/client.ts) | Resolve options, check the project key's environment, scope async context, and create the delivery queue. |
| Authentication | [src/auth/api-key.ts](src/auth/api-key.ts) | Recognize current and legacy project keys and derive the bearer key sent to Ingest. |
| Provider instrumentation | [src/instrumentation/wrap-client.ts](src/instrumentation/wrap-client.ts) | Select supported methods and start an observation for each invocation. |
| Promises and streams | [src/instrumentation/promise.ts](src/instrumentation/promise.ts), [src/instrumentation/stream.ts](src/instrumentation/stream.ts) | Preserve provider return values and follow the result or stream path the application uses. |
| Usage normalization | [src/instrumentation/observation.ts](src/instrumentation/observation.ts), [src/instrumentation/provider-usage.ts](src/instrumentation/provider-usage.ts) | Combine metadata, translate provider token counts, and emit an event once. |
| Events and context | [src/telemetry/event.ts](src/telemetry/event.ts), [src/telemetry/metadata.ts](src/telemetry/metadata.ts) | Define the wire types and validate application metadata. |
| Background delivery | [src/delivery/transport.ts](src/delivery/transport.ts), [src/delivery/http-response.ts](src/delivery/http-response.ts) | Apply collection settings, enforce buffer limits, send batches, and manage failures and response bodies. |

## Follow a wrapped call

1. The application makes a provider call through `brello.wrap(client)`. The wrapper snapshots the active context and calls the provider method with its original receiver.
2. A parsed response, final stream event, cancellation, or provider error finishes the observation. Add token mappings in `provider-usage.ts` and keep unknown counts as `null`.
3. The event enters the local queue. Before sending an Ingest batch, the delivery worker checks collection settings, omits disabled fields, and hashes user IDs if configured. Retries preserve the event UUID.

## What to preserve

- Preserve provider method signatures, response helpers, stream consumption, and error identity. Test the original result or error alongside the emitted event.
- Keep provider request bodies, response content, and credentials out of event fields and diagnostics. Use fake keys and synthetic metadata in fixtures.
- Keep network work off the provider call path. A delivery failure should affect telemetry without interfering with the provider call.
- Keep Node.js 18+ and edge runtime compatibility in mind. Pass platform-specific values through initialization options.
- Check the Ingest API contract before changing event fields or token semantics. The Python SDK uses the same wire format.

## Local checks

Use Node.js 22.18+ for the development toolchain and pnpm 12.18.0.

~~~sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm lint
pnpm test
pnpm build
node scripts/smoke-dist.mjs
~~~

Start with [tests/wrap.test.ts](tests/wrap.test.ts) for provider calls, [tests/transport.test.ts](tests/transport.test.ts) for delivery, and [tests/api-key.test.ts](tests/api-key.test.ts) for key validation.

## Pull requests

Describe the user-visible change and any compatibility impact. Update the README or changelog when public behavior changes. Maintainers handle npm publishing separately from CI checks.

## Releasing to npm

Use this directory as the root of the TypeScript SDK repository. The workflow in [publish.yml](.github/workflows/publish.yml) runs when a maintainer publishes a GitHub Release.

### Set up npm Trusted Publishing

1. Make sure `@brello/sdk` exists and you can manage it on npm. For a new package, publish its first version with an npm maintainer account that can publish to the `@brello` scope. Use another version for the first automated release.
2. In the npm package settings, configure a GitHub Actions Trusted Publisher. Enter the owner and name of the TypeScript SDK repository, workflow filename `publish.yml`, and GitHub environment `npm`. Enable direct `npm publish` for this configuration.

For a first release under the `beta` tag, run `pnpm login --registry=https://registry.npmjs.org` if needed, then run the following from the SDK repository root. Remove `--dry-run` to publish.

~~~sh
pnpm publish --access public --tag beta --dry-run --registry=https://registry.npmjs.org
~~~

The workflow also publishes through pnpm, using OIDC without an npm token. The packed manifest gets its repository URL from GitHub Actions.

### Publish a release

Update the version in `package.json` and publish a GitHub Release with the matching tag, such as `v0.0.2`. Mark it as a GitHub pre-release or use a prerelease version such as `0.0.2-beta.1` to publish to the npm `beta` channel. Other releases publish to `latest`.

The workflow runs the SDK checks and builds the tarball. It checks the packed ESM and CommonJS entry points on Node.js 18 before publishing that same tarball.
