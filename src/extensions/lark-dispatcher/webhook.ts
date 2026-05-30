export interface LarkWebhookResponse {
  code: number;
  msg: string;
  data?: { message_id: string };
}

const RETRY_DELAY_MS = 2000;

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
  const first = await doSend(webhookUrl, card);
  if (first.code === 0) return first;

  await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
  return doSend(webhookUrl, card);
}
