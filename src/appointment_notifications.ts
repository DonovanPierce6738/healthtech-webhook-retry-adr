import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { infrai } from './infrai.js';

export const appointmentNotificationSchema = z.object({
  delivery_id: z.string().min(1),
  attempt: z.number().int().nonnegative(),
  occurred_at: z.string().min(1),
  appointment: z.object({
    appointment_id: z.string().min(1),
    patient_id: z.string().min(1),
    clinic_id: z.string().min(1),
    scheduled_for: z.string().min(1),
    status: z.enum(['scheduled', 'rescheduled', 'cancelled'])
  }),
  destination: z.object({
    endpoint: z.string().url(),
    care_team: z.string().min(1)
  })
});

export type AppointmentNotification = z.infer<typeof appointmentNotificationSchema>;

export function queueNameForClinic(clinicId: string): string {
  return `appt-notify-${clinicId}`;
}

export function shouldPageOps(note: AppointmentNotification): boolean {
  return note.appointment.status === 'cancelled' && note.attempt >= 2;
}

export function patientSafeSummary(note: AppointmentNotification): string {
  const when = note.appointment.scheduled_for;
  if (note.appointment.status === 'cancelled') {
    return `Appointment ${note.appointment.appointment_id} cancelled for ${when}. Notify ${note.destination.care_team}.`;
  }
  if (note.appointment.status === 'rescheduled') {
    return `Appointment ${note.appointment.appointment_id} rescheduled to ${when}. Notify ${note.destination.care_team}.`;
  }
  return `Appointment ${note.appointment.appointment_id} scheduled for ${when}. Notify ${note.destination.care_team}.`;
}

export async function ensureClinicQueue(clinicId: string): Promise<string> {
  const queue = queueNameForClinic(clinicId);
  await infrai.queue.create({ name: queue });
  return queue;
}

export async function enqueueAppointmentNotification(noteInput: unknown): Promise<{ queue: string; summary: string }> {
  const note = appointmentNotificationSchema.parse(noteInput);
  const queue = await ensureClinicQueue(note.appointment.clinic_id);
  await infrai.queue.publish({
    queue,
    payload: note
  });
  return {
    queue,
    summary: patientSafeSummary(note)
  };
}

export async function processDeliveryAttempt(
  queue: string,
  deliver: (note: AppointmentNotification) => Promise<{ delivered: boolean }>
): Promise<Array<{ delivery_id: string; action: 'ack' | 'retry' | 'page'; summary: string }>> {
  const consumed = await infrai.queue.consume({
    queue,
    max_messages: 10,
    visibility_timeout: 30
  });

  const messages = consumed.items ?? [];
  const outcomes: Array<{ delivery_id: string; action: 'ack' | 'retry' | 'page'; summary: string }> = [];

  for (const message of messages) {
    const note = appointmentNotificationSchema.parse(message.payload);
    const delivery = await deliver(note);
    const summary = patientSafeSummary(note);

    if (delivery.delivered) {
      await infrai.queue.ack({ queue, message_id: message.message_id });
      outcomes.push({ delivery_id: note.delivery_id, action: 'ack', summary });
      continue;
    }

    await infrai.queue.nack({ queue, message_id: message.message_id, requeue: true });
    outcomes.push({
      delivery_id: note.delivery_id,
      action: shouldPageOps(note) ? 'page' : 'retry',
      summary
    });
  }

  return outcomes;
}

export function computeWebhookSignature(rawBody: string, secret: string): string {
  return createHmac('sha256', secret).update(rawBody).digest('hex');
}

export function verifyInboundWebhook(rawBody: string, signature: string, secret: string): boolean {
  const expected = Buffer.from(computeWebhookSignature(rawBody, secret), 'utf8');
  const actual = Buffer.from(signature, 'utf8');
  if (expected.length !== actual.length) {
    return false;
  }
  return timingSafeEqual(expected, actual);
}

export async function registerOperationalWebhook(url: string, secret: string): Promise<string> {
  const result = await infrai.account.webhooks.register({
    url,
    events: ['queue.dlq'],
    description: 'Appointment delivery operational feed',
    secret,
    headers: {
      'x-service': 'appointment-notifications'
    }
  });
  if (!result.webhook_id) throw new Error('Webhook registration returned no webhook_id.');
  return result.webhook_id;
}

export async function readWebhookDeliveryHistory(webhookId: string): Promise<Array<Record<string, unknown>>> {
  const result = await infrai.account.webhooks.deliveries(webhookId);
  return result.items ?? [];
}
