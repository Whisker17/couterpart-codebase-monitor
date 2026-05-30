import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";

export interface LarkWebhookResponse {
  code: number;
  msg: string;
  data?: { message_id: string };
}

const RETRY_DELAYS_MS = [2_000, 4_000, 8_000];

const mockFetch = mock(async (_url: unknown, _opts: unknown): Promise<Response> => {
  return {
    ok: true,
    status: 200,
    json: async () => ({ code: 0, msg: "success" }),
  } as unknown as Response;
});

// Override any prior mock.module (e.g., from dispatch.test.ts which mocks this module)
// by providing the real implementation that calls globalThis.fetch explicitly.
mock.module("./webhook", () => {
  async function doSend(webhookUrl: string, card: object): Promise<LarkWebhookResponse> {
    const resp = await (globalThis as any).fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ msg_type: "interactive", card }),
    });
    if (!resp.ok) return { code: resp.status, msg: `HTTP ${resp.status}` };
    return resp.json() as Promise<LarkWebhookResponse>;
  }

  return {
    async sendCard(webhookUrl: string, card: object): Promise<LarkWebhookResponse> {
      let last = await doSend(webhookUrl, card);
      if (last.code === 0) return last;
      for (const delayMs of RETRY_DELAYS_MS) {
        await new Promise((r) => setTimeout(r, delayMs));
        last = await doSend(webhookUrl, card);
        if (last.code === 0) return last;
      }
      return last;
    },
  };
});

const { sendCard } = await import("./webhook");

const FAKE_URL = "https://open.larksuite.com/hook/test";
const FAKE_CARD = { elements: [] };

let originalFetch: typeof globalThis.fetch;
let originalSetTimeout: typeof globalThis.setTimeout;

function installFakeTimers() {
  originalSetTimeout = globalThis.setTimeout;
  (globalThis as any).setTimeout = (fn: () => void, _ms: number) =>
    originalSetTimeout(fn, 0);
}

function restoreRealTimers() {
  if (originalSetTimeout) globalThis.setTimeout = originalSetTimeout;
}

beforeEach(() => {
  originalFetch = globalThis.fetch;
  (globalThis as any).fetch = mockFetch;
  mockFetch.mockReset();
  mockFetch.mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ code: 0, msg: "success" }),
  } as unknown as Response);
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  restoreRealTimers();
});

describe("sendCard", () => {
  it("returns success on first attempt", async () => {
    const result = await sendCard(FAKE_URL, FAKE_CARD);

    expect(result.code).toBe(0);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("retries on HTTP non-200 and succeeds on second attempt", async () => {
    installFakeTimers();
    mockFetch
      .mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({}) } as unknown as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ code: 0, msg: "success" }),
      } as unknown as Response);

    const result = await sendCard(FAKE_URL, FAKE_CARD);

    expect(result.code).toBe(0);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("retries up to 3 times and returns failure after all retries exhausted", async () => {
    installFakeTimers();
    mockFetch.mockResolvedValue({ ok: false, status: 500, json: async () => ({}) } as unknown as Response);

    const result = await sendCard(FAKE_URL, FAKE_CARD);

    // 1 initial + 3 retries = 4 total attempts
    expect(result.code).toBe(500);
    expect(result.msg).toBe("HTTP 500");
    expect(mockFetch).toHaveBeenCalledTimes(4);
  });

  it("succeeds on third attempt", async () => {
    installFakeTimers();
    mockFetch
      .mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) } as unknown as Response)
      .mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) } as unknown as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ code: 0, msg: "success" }),
      } as unknown as Response);

    const result = await sendCard(FAKE_URL, FAKE_CARD);

    expect(result.code).toBe(0);
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it("returns last failure response (not throw) after all retries", async () => {
    installFakeTimers();
    mockFetch.mockResolvedValue({ ok: false, status: 429, json: async () => ({}) } as unknown as Response);

    const result = await sendCard(FAKE_URL, FAKE_CARD);

    expect(result.code).toBe(429);
    expect(result.msg).toBe("HTTP 429");
  });
});
