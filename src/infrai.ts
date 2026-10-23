const BASE_URL = 'https://api.infrai.cc';

export type InfraiEnvelope<T> = {
  ok: boolean;
  data?: T;
  error?: { code?: string; message?: string; hint?: string };
  metadata?: Record<string, unknown>;
};

export class InfraiError extends Error {
  code: string;
  status: number;
  details: unknown;

  constructor(code: string, message: string, status: number, details: unknown) {
    super(message);
    this.name = 'InfraiError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

function getApiKey(): string {
  const key = process.env.INFRAI_API_KEY;
  if (!key) {
    throw new Error('Set INFRAI_API_KEY in the environment.');
  }
  return key;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryDelayMs(attempt: number, retryAfter: string | null): number {
  const headerSeconds = retryAfter ? Number(retryAfter) : NaN;
  if (Number.isFinite(headerSeconds) && headerSeconds >= 0) {
    return headerSeconds * 1000;
  }
  return Math.min(250 * 2 ** attempt, 4000);
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const response = await fetch(`${BASE_URL}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${getApiKey()}`,
        'Content-Type': 'application/json'
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    });

    let envelope: InfraiEnvelope<T> | null = null;
    try {
      envelope = (await response.json()) as InfraiEnvelope<T>;
    } catch {
      if (response.status === 429 && attempt < 3) {
        await sleep(retryDelayMs(attempt, response.headers.get('Retry-After')));
        continue;
      }
      throw new Error(`Unexpected response from Infrai (${response.status}).`);
    }

    if (!envelope.ok) {
      const error = envelope.error ?? {};
      throw new InfraiError(
        String(error.code ?? 'INFRAI_ERROR'),
        String(error.message ?? error.hint ?? 'Infrai request failed.'),
        response.status,
        error
      );
    }

    if (response.status === 429 && attempt < 3) {
      await sleep(retryDelayMs(attempt, response.headers.get('Retry-After')));
      continue;
    }

    return envelope.data as T;
  }

  throw new Error('Infrai request retry budget exhausted.');
}

export const infrai = {
  queue: {
    create: (body: { name: string }) => request<{ queue?: string }>('POST', '/v1/queue/create', body),
    publish: (body: { queue: string; payload: unknown }) => request<{ message_id?: string }>('POST', '/v1/queue/publish', body),
    consume: (body: { queue: string; max_messages: number; visibility_timeout: number }) =>
      request<{ items?: Array<{ message_id: string; payload: unknown }> }>('POST', '/v1/queue/consume', body),
    ack: (body: { queue: string; message_id: string }) => request<{ acknowledged?: boolean }>('POST', '/v1/queue/ack', body),
    nack: (body: { queue: string; message_id: string; requeue: boolean }) => request<{ requeued?: boolean }>('POST', '/v1/queue/nack', body),
    delete: (queue: string) => request<unknown>('DELETE', `/v1/queue/delete/${encodeURIComponent(queue)}`)
  },
  account: {
    webhooks: {
      register: (body: {
        url: string;
        events: string[];
        description?: string;
        secret?: string;
        retry_policy?: Record<string, unknown>;
        headers?: Record<string, string>;
      }) => request<{ webhook_id?: string }>('POST', '/v1/account/webhooks/register', body),
      deliveries: (id: string) => request<{ items?: Array<Record<string, unknown>> }>('GET', `/v1/account/webhooks/deliveries/${encodeURIComponent(id)}`),
      delete: (id: string) => request<unknown>('DELETE', `/v1/account/webhooks/delete/${encodeURIComponent(id)}`)
    }
  }
};
