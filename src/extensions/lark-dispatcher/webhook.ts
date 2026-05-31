export interface LarkWebhookResponse {
  code: number;
  msg: string;
  data?: { message_id: string };
}

// Delays between retries: 2s → 4s → 8s (3 retries = 4 total attempts)
const RETRY_DELAYS_MS = [2_000, 4_000, 8_000];

// Only retry transient errors: 5xx, 408 (timeout), 429 (rate limit).
// Permanent 4xx (401, 403, 404) will never self-resolve — skip retry.
function isRetryableStatus(code: number): boolean {
  return code >= 500 || code === 408 || code === 429;
}

async function doSend(webhookUrl: string, card: object): Promise<LarkWebhookResponse> {
  const resp = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ msg_type: "interactive", card }),
  });
  if (!resp.ok) {
    return { code: resp.status, msg: `HTTP ${resp.status}` };
  }
  return resp.json() as Promise<LarkWebhookResponse>;
}

export async function sendCard(
  webhookUrl: string,
  card: object
): Promise<LarkWebhookResponse> {
  let last = await doSend(webhookUrl, card);
  if (last.code === 0) return last;
  if (!isRetryableStatus(last.code)) return last;

  for (const delayMs of RETRY_DELAYS_MS) {
    await new Promise((r) => setTimeout(r, delayMs));
    last = await doSend(webhookUrl, card);
    if (last.code === 0) return last;
    if (!isRetryableStatus(last.code)) return last;
  }

  return last;
}
