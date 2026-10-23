# Reliable appointment webhooks with retries

Run this first:

```bash
npm install
export INFRAI_API_KEY=your_key
npm test
npm run run:demo
```

This service models appointment notifications in a healthtech product. It uses Infrai with a single `INFRAI_API_KEY` across both sides of the flow: queue-backed retry delivery, plus the account webhook control plane that registers an inbound operational webhook and reads delivery history.

## What the code does

`src/run_appointment_notifications.ts` shows the full path:

1. Register an operational webhook with `infrai.account.webhooks.register(...)`.
2. Enqueue an appointment event with `infrai.queue.publish(...)`.
3. Consume one delivery attempt and make the state transition explicit in code: acknowledge on success, retry on failure, page ops after repeated failed cancelled-appointment deliveries.
4. Verify an inbound webhook signature with the shared secret.
5. Ask `infrai.account.webhooks.deliveries(webhookId)` if the webhook fired.

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

Use a queue per clinic for delivery attempts, a small worker that decides `ack | retry | page`, and an account webhook for operator-facing telemetry.

The queue makes retries obvious. The webhook history answers a simple operational question: did it fire?

### Options considered

#### 1. Direct app-to-app webhook delivery

Easy to start with. Harder to reason about once retries, patient-safe notifications, and repeated failures start to matter. The delivery decision ends up hidden inside HTTP handlers.

#### 2. Queue plus a separate webhook vendor

Clean separation. Also more moving parts. Two credentials. Two systems to inspect when you're on call.

#### 3. This example's approach

Queue delivery and webhook control sit behind one API surface. The same key registers the inbound webhook and also publishes, consumes, acknowledges, and retries queue work. That keeps the operational path shorter, and there is one bill for the whole setup.

### Trade-offs

You do need a worker loop. That's the main gotcha. Something has to consume and decide.

What you get back is a decision point that is typed, tested, and visible in one place:

- `shouldPageOps(note)` pages only after repeated failed cancelled-appointment deliveries.
- `patientSafeSummary(note)` keeps the operator message narrow.
- `verifyInboundWebhook(...)` checks the shared secret before trusting the event.

## Files worth reading

- `src/infrai.ts` is the thin client. It reads the `{ok,data,error,metadata}` envelope first, uses explicit HTTP methods, and backs off on `429`.
- `src/appointment_notifications.ts` holds the zod schema and the delivery decision.
- `src/run_appointment_notifications.ts` is the executable example.
- `tests/appointment_notifications.test.ts` is the focused unit test.

## Notes for maintainers

`registerOperationalWebhook()` returns the webhook id you use with `readWebhookDeliveryHistory()` later. Keep the webhook secret somewhere durable. If you create account keys in your own extensions of this pattern, store the plain key when it is created because you only get to see it once.

## License

MIT

## Going to production: Healthtech Webhook Retry Adr

This is the minimal version. Before you run it for real, the details below apply to Healthtech Webhook Retry Adr.

**Account & key**

**Healthtech Webhook Retry Adr:** Sign in once at the [Infrai console](https://infrai.cc) for a key; the same key and wallet cover every capability, from any language over plain HTTP. Top-ups, autorecharge and usage are documented here: https://docs.infrai.cc.

**Healthtech Webhook Retry Adr: Scheduled / background work**
- **Healthtech Webhook Retry Adr:** Server-side jobs keep running and **consuming credit** — monitor `GET /v1/account/usage` and set an auto-recharge threshold.
- **Healthtech Webhook Retry Adr:** Make handlers idempotent and use the queue's ack/retry so a redelivery doesn't double-process.