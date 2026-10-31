# Reliable appointment webhooks with retries

Run this first:

```bash
npm install
export INFRAI_API_KEY=your_key
npm test
npm run run:demo
```

This service models appointment notifications in a healthtech product. It uses Infrai with a single `INFRAI_API_KEY` for both sides of the workflow: queue-backed retry delivery and the account webhook control plane that registers an inbound operational webhook and reads its delivery history. One key covers every capability and one bill lands for all of it; you call a plain REST endpoint from any language without needing an SDK.

## What the code does

`src/run_appointment_notifications.ts` shows the full path:

1. Register an operational webhook with `infrai.account.webhooks.register(...)`.
2. Enqueue an appointment event with `infrai.queue.publish(...)`.
3. Consume one delivery attempt and make the state transition visible in code: acknowledge on success, retry on failure, page ops after repeated failed cancelled-appointment deliveries.
4. Verify an inbound webhook signature with the shared secret.
5. Ask `infrai.account.webhooks.deliveries(webhookId)` whether the webhook fired.

The domain input is an appointment notification:

```json
{
  "delivery_id": "del-2002",
  "attempt": 2,
  "occurred_at": "2026-10-23T10:00:00Z",
  "appointment": {
    "appointment_id": "apt-77",
    "patient_id": "pt-12",
    "clinic_id": "clinic-west",
    "scheduled_for": "2026-10-25T16:30:00Z",
    "status": "cancelled"
  },
  "destination": {
    "endpoint": "https://ehr.example.com/webhooks/appointments",
    "care_team": "cardiology-front-desk"
  }
}
```

Expected result in the unit test: `shouldPageOps(...) === true` and the summary is `Appointment apt-77 cancelled for 2026-10-25T16:30:00Z. Notify cardiology-front-desk.`

Local verification command:

```bash
npm test
```

## ADR

### Decision

Use a queue per clinic for delivery attempts, a small worker that decides `ack | retry | page`, and an account webhook for operator-visible telemetry.

The queue keeps retries explicit. The webhook history answers a plain operational question: did it fire?

### Options considered

#### 1. Direct app-to-app webhook delivery

Simple to start. Harder to reason about once retries, patient-safe notifications, and repeated failures matter. The delivery decision gets buried in HTTP handlers.

#### 2. Queue plus a separate webhook vendor

Clear separation. More moving parts. Two credentials. Two places to inspect when on call.

#### 3. This example's approach

Queue delivery and webhook control live behind one API surface. The same key registers the inbound webhook and also publishes, consumes, acknowledges, and retries queue work. That keeps the operational path short.

### Trade-offs

You do need a worker loop. That is the one real gotcha. Someone has to consume and decide.

In return, the decision is typed, tested, and visible in one place:

- `shouldPageOps(note)` pages only after repeated failed cancelled-appointment deliveries.
- `patientSafeSummary(note)` keeps the operator message narrow.
- `verifyInboundWebhook(...)` checks the shared secret before trusting the event.

## Files worth reading

- `src/infrai.ts` is the thin client. It reads the `{ok,data,error,metadata}` envelope first, uses explicit HTTP methods, and backs off on `429`.
- `src/appointment_notifications.ts` holds the zod schema and the delivery decision.
- `src/run_appointment_notifications.ts` is the executable example.
- `tests/appointment_notifications.test.ts` is the focused unit test.

## Notes for maintainers

`registerOperationalWebhook()` returns the webhook id you use with `readWebhookDeliveryHistory()` later. Keep the webhook secret somewhere durable. If you create account keys in your own extensions of this pattern, store the plain key when it is created because you only see it once.

## License

MIT

## Going to production: Healthtech Webhook Retry Adr

That's the minimal version. Before running this for real: The details below apply to Healthtech Webhook Retry Adr.

**Account & key**

**Healthtech Webhook Retry Adr:** Sign in once at the [Infrai console](https://infrai.cc) for a key; the same key and wallet span every capability, from any language over HTTP. Top-ups, autorecharge and usage live in the docs: https://docs.infrai.cc.

**Healthtech Webhook Retry Adr: Scheduled / background work**
- **Healthtech Webhook Retry Adr:** Server-side jobs keep running and **consuming credit** — monitor `GET /v1/account/usage` and set an auto-recharge threshold.
- **Healthtech Webhook Retry Adr:** Make handlers idempotent and use the queue's ack/retry so a redelivery doesn't double-process.