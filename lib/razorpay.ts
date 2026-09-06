import Razorpay from "razorpay";

/**
 * Server-only Razorpay SDK client, built from the platform credentials in the
 * environment. Per-merchant credentials live encrypted on `merchants` and are
 * not what this client uses.
 */

let cached: Razorpay | null = null;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export function getRazorpay(): Razorpay {
  if (cached) return cached;

  cached = new Razorpay({
    key_id: requireEnv("RAZORPAY_KEY_ID"),
    key_secret: requireEnv("RAZORPAY_KEY_SECRET"),
  });

  return cached;
}

/**
 * Verifies an `X-Razorpay-Signature` header against the raw request body, using
 * the SDK's own HMAC-SHA256 check (hex digest of the raw body keyed by the
 * webhook secret).
 *
 * `body` must be the exact bytes Razorpay signed — re-serialising the parsed
 * JSON will not reproduce the same digest.
 */
export function verifyWebhookSignature(body: string, signature: string): boolean {
  const secret = requireEnv("RAZORPAY_WEBHOOK_SECRET");

  try {
    return Razorpay.validateWebhookSignature(body, signature, secret);
  } catch {
    // The SDK throws on missing/undefined parameters rather than returning false.
    return false;
  }
}
