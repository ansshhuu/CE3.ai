import { NextResponse } from "next/server";

import { verifyWebhookSignature } from "@/lib/razorpay";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

// Signature verification needs the raw body, so this route must run on Node.js
// and must never be statically evaluated or cached.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Razorpay dispute entity, as delivered inside a webhook payload. */
interface RazorpayDisputeEntity {
  id: string;
  entity?: string;
  payment_id?: string;
  amount?: number;
  currency?: string;
  amount_deducted?: number;
  reason_code?: string;
  respond_by?: number;
  status?: string;
  phase?: string;
  created_at?: number;
}

interface RazorpayWebhookBody {
  event?: string;
  payload?: {
    dispute?: { entity?: RazorpayDisputeEntity };
    payment?: { entity?: { id?: string; card?: { network?: string } } };
  };
}

/** Verdict written to `disputes.final_verdict`, keyed by terminal event. */
const VERDICT_BY_EVENT: Record<string, string> = {
  "payment.dispute.won": "won",
  "payment.dispute.lost": "lost",
  "payment.dispute.closed": "closed",
};

/** Razorpay sends Unix seconds; the columns are `timestamptz`. */
function toIsoTimestamp(seconds: number | null | undefined): string | null {
  if (typeof seconds !== "number" || !Number.isFinite(seconds)) return null;
  return new Date(seconds * 1000).toISOString();
}

export async function POST(request: Request) {
  const signature = request.headers.get("x-razorpay-signature");
  if (!signature) {
    return NextResponse.json({ error: "Missing signature header" }, { status: 400 });
  }

  // Read the body as raw text — the signature is over these exact bytes.
  const rawBody = await request.text();

  if (!verifyWebhookSignature(rawBody, signature)) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
  }

  let body: RazorpayWebhookBody;
  try {
    body = JSON.parse(rawBody) as RazorpayWebhookBody;
  } catch {
    return NextResponse.json({ error: "Malformed JSON body" }, { status: 400 });
  }

  const event = body.event;
  if (!event) {
    return NextResponse.json({ error: "Missing event type" }, { status: 400 });
  }

  const dispute = body.payload?.dispute?.entity;

  try {
    if (event === "payment.dispute.created") {
      if (!dispute?.id) {
        return NextResponse.json({ error: "Missing dispute entity" }, { status: 400 });
      }
      await upsertDispute(dispute, body.payload?.payment?.entity?.card?.network ?? null);
      return NextResponse.json({ received: true, event, dispute_id: dispute.id });
    }

    const verdict = VERDICT_BY_EVENT[event];
    if (verdict) {
      if (!dispute?.id) {
        return NextResponse.json({ error: "Missing dispute entity" }, { status: 400 });
      }
      await recordVerdict(dispute, verdict);
      return NextResponse.json({ received: true, event, dispute_id: dispute.id });
    }

    // Acknowledge everything else so Razorpay stops retrying events we do not
    // handle yet.
    return NextResponse.json({ received: true, event, handled: false });
  } catch (error) {
    console.error(`[razorpay-webhook] ${event} failed`, error);
    // 500 so Razorpay retries — the signature was good, the write was not.
    return NextResponse.json({ error: "Webhook processing failed" }, { status: 500 });
  }
}

/**
 * Inserts or updates the `disputes` row for a `payment.dispute.created` event.
 *
 * `disputes.merchant_id` is NOT NULL, and the dispute payload carries no
 * merchant of its own, so the tenant is resolved from the `orders` row for the
 * disputed payment. That lookup also supplies `order_id` and the card network
 * when the webhook payload omits the payment entity.
 */
async function upsertDispute(
  dispute: RazorpayDisputeEntity,
  networkFromPayment: string | null,
) {
  const supabase = getSupabaseAdmin();

  if (!dispute.payment_id) {
    throw new Error(`Dispute ${dispute.id} has no payment_id to resolve a merchant from`);
  }

  const { data: order, error: orderError } = await supabase
    .from("orders")
    .select("id, merchant_id, card_network")
    .eq("razorpay_payment_id", dispute.payment_id)
    .maybeSingle();

  if (orderError) throw orderError;
  if (!order) {
    throw new Error(
      `No order found for payment ${dispute.payment_id} (dispute ${dispute.id})`,
    );
  }

  const row = {
    merchant_id: order.merchant_id,
    order_id: order.id,
    razorpay_dispute_id: dispute.id,
    razorpay_payment_id: dispute.payment_id,
    amount_paise: dispute.amount ?? 0,
    amount_deducted_paise: dispute.amount_deducted ?? 0,
    currency: dispute.currency ?? "INR",
    reason_code: dispute.reason_code ?? null,
    network: networkFromPayment ?? order.card_network ?? null,
    phase: dispute.phase ?? null,
    status: dispute.status ?? null,
    respond_by: toIsoTimestamp(dispute.respond_by),
    created_at_rzp: toIsoTimestamp(dispute.created_at),
  };

  // Razorpay retries webhooks, so creation must be idempotent on the dispute id.
  const { error } = await supabase
    .from("disputes")
    .upsert(row, { onConflict: "razorpay_dispute_id" });

  if (error) throw error;

  // Keep the order's disputed flag in step with the dispute we just recorded.
  const { error: flagError } = await supabase
    .from("orders")
    .update({ was_disputed: true })
    .eq("id", order.id);

  if (flagError) throw flagError;
}

/**
 * Records the outcome of a dispute for the won / lost / closed events. Updates
 * only — a verdict for a dispute we never ingested is an error worth retrying,
 * not a row to invent without a merchant.
 */
async function recordVerdict(dispute: RazorpayDisputeEntity, verdict: string) {
  const supabase = getSupabaseAdmin();

  const update: Record<string, unknown> = {
    final_verdict: verdict,
    verdict_at: new Date().toISOString(),
  };

  // The terminal event also carries the dispute's final status and deduction.
  if (dispute.status) update.status = dispute.status;
  if (dispute.phase) update.phase = dispute.phase;
  if (typeof dispute.amount_deducted === "number") {
    update.amount_deducted_paise = dispute.amount_deducted;
  }

  const { data, error } = await supabase
    .from("disputes")
    .update(update)
    .eq("razorpay_dispute_id", dispute.id)
    .select("id");

  if (error) throw error;
  if (!data || data.length === 0) {
    throw new Error(`No dispute row found for ${dispute.id} to record verdict "${verdict}"`);
  }
}
