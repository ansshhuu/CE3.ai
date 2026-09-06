import crypto from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";

const SECRET = "test_webhook_secret";

beforeAll(() => {
  process.env.RAZORPAY_WEBHOOK_SECRET = SECRET;
});

function sign(body: string, secret = SECRET) {
  return crypto.createHmac("sha256", secret).update(body).digest("hex");
}

describe("verifyWebhookSignature", () => {
  it("accepts a signature produced with the webhook secret", async () => {
    const { verifyWebhookSignature } = await import("@/lib/razorpay");
    const body = JSON.stringify({ event: "payment.dispute.created" });
    expect(verifyWebhookSignature(body, sign(body))).toBe(true);
  });

  it("rejects a signature made with the wrong secret", async () => {
    const { verifyWebhookSignature } = await import("@/lib/razorpay");
    const body = JSON.stringify({ event: "payment.dispute.created" });
    expect(verifyWebhookSignature(body, sign(body, "wrong_secret"))).toBe(false);
  });

  it("rejects when the body is altered after signing", async () => {
    const { verifyWebhookSignature } = await import("@/lib/razorpay");
    const signature = sign(JSON.stringify({ amount: 100 }));
    expect(verifyWebhookSignature(JSON.stringify({ amount: 999 }), signature)).toBe(false);
  });

  it("returns false rather than throwing on a garbage signature", async () => {
    const { verifyWebhookSignature } = await import("@/lib/razorpay");
    expect(verifyWebhookSignature("{}", "")).toBe(false);
  });
});
