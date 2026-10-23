import { randomUUID } from 'node:crypto';
import {
  enqueueAppointmentNotification,
  processDeliveryAttempt,
  registerOperationalWebhook,
  readWebhookDeliveryHistory,
  verifyInboundWebhook,
  computeWebhookSignature
} from './appointment_notifications.js';
import { infrai } from './infrai.js';

async function main(): Promise<void> {
  const runId = randomUUID().slice(0, 8);
  const inboundWebhookUrl = new URL(process.env.OPS_WEBHOOK_URL ?? 'https://example.com/hooks/ops');
  inboundWebhookUrl.searchParams.set('run', runId);
  const inboundWebhookSecret = process.env.OPS_WEBHOOK_SECRET ?? 'demo-secret';
  let webhookId: string | undefined;
  let queue: string | undefined;

  try {
    webhookId = await registerOperationalWebhook(inboundWebhookUrl.toString(), inboundWebhookSecret);
    console.log('registered webhook', webhookId);

    const queued = await enqueueAppointmentNotification({
      delivery_id: `del-${runId}`,
      attempt: 0,
      occurred_at: new Date().toISOString(),
      appointment: {
        appointment_id: `apt-${runId}`,
        patient_id: 'pt-900',
        clinic_id: `clinic-east-${runId}`,
        scheduled_for: '2026-10-24T14:00:00Z',
        status: 'cancelled'
      },
      destination: {
        endpoint: 'https://ehr.example.com/webhooks/appointments',
        care_team: 'oncology-desk'
      }
    });
    queue = queued.queue;
    console.log('queued in', queue);
    console.log('summary', queued.summary);

    const outcomes = await processDeliveryAttempt(queue, async () => ({ delivered: false }));
    if (outcomes.length === 0) throw new Error('No queue delivery was consumed.');
    console.log('worker outcome', outcomes[0]);

    const sampleBody = JSON.stringify({ event: 'queue.dlq', webhook_id: webhookId });
    const signature = computeWebhookSignature(sampleBody, inboundWebhookSecret);
    console.log('signature valid', verifyInboundWebhook(sampleBody, signature, inboundWebhookSecret));

    const history = await readWebhookDeliveryHistory(webhookId);
    console.log('delivery history entries', history.length);
  } finally {
    const cleanup = await Promise.allSettled([
      ...(queue ? [infrai.queue.delete(queue)] : []),
      ...(webhookId ? [infrai.account.webhooks.delete(webhookId)] : [])
    ]);
    const failed = cleanup.filter((result) => result.status === 'rejected');
    if (failed.length) throw new AggregateError(failed.map((result) => result.reason), 'Demo cleanup failed.');
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
