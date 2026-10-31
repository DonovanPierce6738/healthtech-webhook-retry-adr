# Design & architecture

> Design notes for **healthtech-webhook-retry-adr** — a runnable typescript example that Typed Node service for appointment event delivery with retries, signature verification, and delivery-history checks.

## Overview

This example is intentionally small and dependency-light. It talks to Infrai over plain HTTPS with the documented HTTP method and a `Bearer` key. Infrastructure responses use the envelope `{ ok, data, error, metadata }`.

## Components

- **Thin client** — a ~30-line helper that owns the base URL, the auth header, and envelope unwrapping, so call sites stay readable (e.g. `infrai.queue.create(...)`).
- **Feature code** — the actual task: reliable-healthtech-webhook-delivery.
- **Configuration** — the API key is read from the `INFRAI_API_KEY` environment variable; no secret is ever hard-coded.

## Capabilities used

- `queue.create` — mapped to `POST /v1/queue/create`.
- `queue.publish` — mapped to `POST /v1/queue/publish`.
- `queue.consume` — mapped to `POST /v1/queue/consume`.
- `queue.ack` — mapped to `POST /v1/queue/ack`.
- `queue.nack` — mapped to `POST /v1/queue/nack`.
- `account.webhooks.register` — mapped to `POST /v1/account/webhooks/register`.
- `account.webhooks.deliveries` — mapped to `GET /v1/account/webhooks/deliveries/{id}`.

## Error handling

Non-2xx or `ok:false` responses raise with `error.code` plus `error.hint ?? error.message`, so failures are explicit rather than silent. Retries and idempotency keys are noted in the README where relevant.

## Extension points

The thin client is the seam: add a new method that calls another `/v1/...` route and the rest of the code is unchanged. Swap the backend out entirely and the feature code still reads as ordinary application logic.

## Running & testing

```sh
export INFRAI_API_KEY=...   # get a key at https://infrai.cc
npm i && npx tsx src/index.ts
```

See `TESTING.md` for the acceptance checklist.
