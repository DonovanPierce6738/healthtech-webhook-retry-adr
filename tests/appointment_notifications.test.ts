import test from 'node:test';
import assert from 'node:assert/strict';
import {
  appointmentNotificationSchema,
  patientSafeSummary,
  shouldPageOps,
  processDeliveryAttempt,
  verifyInboundWebhook,
  computeWebhookSignature
} from '../src/appointment_notifications.js';
import { infrai } from '../src/infrai.js';

test('cancelled appointment after second failed attempt pages ops with a patient-safe summary', () => {
  const note = appointmentNotificationSchema.parse({
    delivery_id: 'del-2002',
    attempt: 2,
    occurred_at: '2026-10-23T10:00:00Z',
    appointment: {
      appointment_id: 'apt-77',
      patient_id: 'pt-12',
      clinic_id: 'clinic-west',
      scheduled_for: '2026-10-25T16:30:00Z',
      status: 'cancelled'
    },
    destination: {
      endpoint: 'https://ehr.example.com/webhooks/appointments',
      care_team: 'cardiology-front-desk'
    }
  });

  assert.equal(shouldPageOps(note), true);
  assert.equal(
    patientSafeSummary(note),
    'Appointment apt-77 cancelled for 2026-10-25T16:30:00Z. Notify cardiology-front-desk.'
  );
});

test('inbound webhook signature is verified before the event is trusted', () => {
  const rawBody = JSON.stringify({ event: 'queue.dlq', webhook_id: 'wh_123' });
  const secret = 'ops-secret';
  const signature = computeWebhookSignature(rawBody, secret);

  assert.equal(verifyInboundWebhook(rawBody, signature, secret), true);
  assert.equal(verifyInboundWebhook(rawBody, signature, 'wrong-secret'), false);
});

test('worker consumes the live items envelope and requests a retry', async () => {
  const originalConsume = infrai.queue.consume;
  const originalNack = infrai.queue.nack;
  let nackBody: { queue: string; message_id: string; requeue: boolean } | undefined;
  try {
    infrai.queue.consume = async () => ({ items: [{
      message_id: 'msg-1',
      payload: {
        delivery_id: 'del-1', attempt: 0, occurred_at: '2026-10-23T10:00:00Z',
        appointment: {
          appointment_id: 'apt-1', patient_id: 'pt-1', clinic_id: 'clinic-1',
          scheduled_for: '2026-10-24T14:00:00Z', status: 'scheduled'
        },
        destination: { endpoint: 'https://example.com/hook', care_team: 'clinic-desk' }
      }
    }] });
    infrai.queue.nack = async (body) => { nackBody = body; return { requeued: true }; };
    const outcomes = await processDeliveryAttempt('queue-1', async () => ({ delivered: false }));
    assert.equal(outcomes[0]?.action, 'retry');
    assert.deepEqual(nackBody, { queue: 'queue-1', message_id: 'msg-1', requeue: true });
  } finally {
    infrai.queue.consume = originalConsume;
    infrai.queue.nack = originalNack;
  }
});
