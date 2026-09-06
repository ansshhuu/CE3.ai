/**
 * Local development seed script.
 *
 * Razorpay test mode will not produce disputes on demand, so the dispute side
 * of the product has nothing to render against a freshly migrated database.
 * This inserts a realistic corpus straight into Supabase with the service-role
 * key, bypassing RLS.
 *
 *   npm run seed              # insert on top of whatever is there
 *   npm run seed -- --reset   # delete previously seeded merchants first
 *
 * Seeded merchants are tagged by a `SEED-` prefix on `razorpay_account_id`, so
 * `--reset` finds and cascade-deletes exactly what this script created and
 * nothing else.
 *
 * Never point this at a production project: it writes with the service-role key
 * and `--reset` deletes rows.
 */

import { createHash, randomUUID } from "node:crypto";

import { faker } from "@faker-js/faker";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { config as loadEnv } from "dotenv";

loadEnv({ path: ".env.local" });

// ---------------------------------------------------------------- parameters

const MERCHANT_COUNT = 5;
const CUSTOMERS_PER_MERCHANT = 50;
const ORDERS_PER_MERCHANT = 200;
const DISPUTES_PER_MERCHANT = 40;

/** Orders span the last 18 months, so CE 3.0 age windows have room to vary. */
const ORDER_HISTORY_MONTHS = 18;

/** Chunk size for inserts — keeps each request payload to a sane size. */
const BATCH_SIZE = 500;

const SEED_ACCOUNT_PREFIX = "SEED-acc_";

/**
 * Reason codes the product cares about, with the network and category each
 * belongs to. 10.4 and 4837 are the fraud codes; 13.1 and 4853 are the
 * non-fraud "goods not received / not as described" family.
 */
const REASON_CODES = [
  { code: "10.4", network: "visa", category: "fraud", weight: 4 },
  { code: "4837", network: "mastercard", category: "fraud", weight: 3 },
  { code: "13.1", network: "visa", category: "goods_not_received", weight: 2 },
  {
    code: "4853",
    network: "mastercard",
    category: "goods_not_as_described",
    weight: 3,
  },
] as const;

type ReasonCode = (typeof REASON_CODES)[number];

const PHASES = ["chargeback", "pre_arbitration"] as const;

const CARD_NETWORKS = ["visa", "mastercard", "rupay", "amex"] as const;
const PREPAID_METHODS = ["card", "upi", "netbanking", "wallet"] as const;

// ------------------------------------------------------------------ helpers

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing required environment variable: ${name}. ` +
        "Copy .env.local.example to .env.local and fill it in.",
    );
  }
  return value;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function fingerprint(): string {
  return faker.string.hexadecimal({ length: 32, casing: "lower", prefix: "" });
}

function address(): string {
  return [
    faker.location.streetAddress(),
    faker.location.city(),
    `${faker.location.state()} ${faker.location.zipCode("######")}`,
  ].join(", ");
}

/** Weighted pick over the reason-code table. */
function pickReasonCode(): ReasonCode {
  return faker.helpers.weightedArrayElement(
    REASON_CODES.map((reason) => ({ value: reason, weight: reason.weight })),
  );
}

function monthsAgo(months: number): Date {
  const d = new Date();
  d.setMonth(d.getMonth() - months);
  return d;
}

function daysFrom(base: Date, days: number): Date {
  return new Date(base.getTime() + days * 24 * 60 * 60 * 1000);
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

/** Inserts in batches, throwing on the first failure so seeding fails loudly. */
async function insertAll(
  db: SupabaseClient,
  table: string,
  rows: Record<string, unknown>[],
): Promise<void> {
  for (const batch of chunk(rows, BATCH_SIZE)) {
    const { error } = await db.from(table).insert(batch);
    if (error) {
      throw new Error(`Insert into ${table} failed: ${error.message}`);
    }
  }
}

// -------------------------------------------------------------- row builders

type MerchantRow = ReturnType<typeof buildMerchant>;

type CustomerRow = {
  id: string;
  merchant_id: string;
  external_user_id: string;
  email_hash: string;
  phone_hash: string;
  first_seen_at: string;
  lifetime_order_count: number;
  lifetime_gmv_paise: number;
  prior_dispute_count: number;
  return_count: number;
};

type OrderRow = {
  id: string;
  merchant_id: string;
  razorpay_order_id: string;
  razorpay_payment_id: string;
  customer_id: string;
  amount_paise: number;
  currency: string;
  payment_method: string;
  card_network: string | null;
  is_cod: boolean;
  ip_address_hash: string;
  device_fingerprint: string;
  shipping_address_hash: string;
  shipping_address_raw: string;
  billing_descriptor_used: string;
  avs_result: string | null;
  cvv_result: string | null;
  three_ds_status: string | null;
  placed_at: string;
  delivered_at: string | null;
  delivery_status: string;
  awb_number: string | null;
  was_disputed: boolean;
};

/**
 * A customer's stable identity signals. Orders from the same customer reuse
 * these most of the time, which is what makes a later dispute CE 3.0-eligible:
 * the disputed transaction shares device fingerprint / IP with prior
 * undisputed ones.
 */
type CustomerIdentity = {
  deviceFingerprint: string;
  ipHash: string;
  shippingRaw: string;
  shippingHash: string;
};

function buildMerchant(index: number) {
  const name = faker.company.name();

  return {
    id: randomUUID(),
    name,
    razorpay_account_id: `${SEED_ACCOUNT_PREFIX}${faker.string.alphanumeric({
      length: 14,
    })}`,
    razorpay_key_id: `rzp_test_${faker.string.alphanumeric({ length: 14 })}`,
    // Credential columns stay null: this script has no encryption key and must
    // not write anything shaped like a real secret.
    razorpay_key_secret_encrypted: null,
    webhook_secret_encrypted: null,
    // Razorpay charges a fixed fee per contested dispute; ops cost is the
    // analyst time burned assembling evidence.
    fight_fee_paise: faker.helpers.arrayElement([50_000, 75_000, 100_000]),
    ops_cost_per_minute_paise: faker.number.int({ min: 800, max: 2_500 }),
    vamp_ratio_current: faker.number.float({
      min: 0.2,
      max: 1.4,
      fractionDigits: 2,
    }),
    risk_threshold: faker.number.float({
      min: 0.45,
      max: 0.7,
      fractionDigits: 2,
    }),
    // The descriptor prefix is what a CE 3.0 check compares across transactions.
    billing_descriptor: name
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, "")
      .slice(0, 12)
      .padEnd(6, "X"),
    created_at: monthsAgo(ORDER_HISTORY_MONTHS + index).toISOString(),
  };
}

function buildCustomer(merchantId: string): CustomerRow {
  return {
    id: randomUUID(),
    merchant_id: merchantId,
    external_user_id: `cust_${faker.string.alphanumeric({ length: 10 })}`,
    email_hash: sha256(faker.internet.email().toLowerCase()),
    phone_hash: sha256(faker.phone.number({ style: "international" })),
    // Overwritten from the earliest order this customer actually places.
    first_seen_at: monthsAgo(ORDER_HISTORY_MONTHS).toISOString(),
    lifetime_order_count: 0,
    lifetime_gmv_paise: 0,
    prior_dispute_count: 0,
    return_count: faker.number.int({ min: 0, max: 3 }),
  };
}

function buildIdentity(): CustomerIdentity {
  const shippingRaw = address();

  return {
    deviceFingerprint: fingerprint(),
    ipHash: sha256(faker.internet.ipv4()),
    shippingRaw,
    shippingHash: sha256(shippingRaw.toLowerCase()),
  };
}

function buildOrder(
  merchant: MerchantRow,
  customer: CustomerRow,
  identity: CustomerIdentity,
  placedAt: Date,
): OrderRow {
  const isCod = faker.datatype.boolean({ probability: 0.35 });

  // COD collects no card data, so AVS/CVV/3DS stay null on those orders.
  const paymentMethod = isCod
    ? "cod"
    : faker.helpers.arrayElement(PREPAID_METHODS);
  const isCard = paymentMethod === "card";

  // Most orders come from the customer's usual device, network and address;
  // the rest simulate a new phone, a different connection, or a gift order.
  const sameDevice = faker.datatype.boolean({ probability: 0.8 });
  const sameIp = faker.datatype.boolean({ probability: 0.75 });
  const sameAddress = faker.datatype.boolean({ probability: 0.85 });
  const shippingRaw = sameAddress ? identity.shippingRaw : address();

  const deliveryStatus = faker.helpers.weightedArrayElement([
    { value: "delivered", weight: 8 },
    { value: "in_transit", weight: 1 },
    { value: "rto", weight: 1 },
  ]);
  const deliveredAt =
    deliveryStatus === "delivered"
      ? daysFrom(placedAt, faker.number.int({ min: 1, max: 9 }))
      : null;

  return {
    id: randomUUID(),
    merchant_id: merchant.id,
    razorpay_order_id: `order_${faker.string.alphanumeric({ length: 14 })}`,
    razorpay_payment_id: `pay_${faker.string.alphanumeric({ length: 14 })}`,
    customer_id: customer.id,
    amount_paise: faker.number.int({ min: 29_900, max: 499_900 }),
    currency: "INR",
    payment_method: paymentMethod,
    card_network: isCard ? faker.helpers.arrayElement(CARD_NETWORKS) : null,
    is_cod: isCod,
    ip_address_hash: sameIp ? identity.ipHash : sha256(faker.internet.ipv4()),
    device_fingerprint: sameDevice ? identity.deviceFingerprint : fingerprint(),
    shipping_address_hash: sameAddress
      ? identity.shippingHash
      : sha256(shippingRaw.toLowerCase()),
    shipping_address_raw: shippingRaw,
    billing_descriptor_used: merchant.billing_descriptor,
    avs_result: isCard ? faker.helpers.arrayElement(["Y", "A", "Z", "N"]) : null,
    cvv_result: isCard ? faker.helpers.arrayElement(["M", "N", "P"]) : null,
    three_ds_status: isCard
      ? faker.helpers.arrayElement([
          "authenticated",
          "attempted",
          "not_enrolled",
        ])
      : null,
    placed_at: placedAt.toISOString(),
    delivered_at: deliveredAt ? deliveredAt.toISOString() : null,
    delivery_status: deliveryStatus,
    // A tracking number only exists once the parcel is with the courier.
    awb_number: deliveryStatus === "in_transit" ? null : faker.string.numeric(12),
    // Set later, once the dispute targets are picked.
    was_disputed: false,
  };
}

/**
 * Builds a dispute against an already-generated order, deriving amounts,
 * network and timeline from that order so the two stay consistent.
 */
function buildDispute(merchantId: string, order: OrderRow) {
  const reason = pickReasonCode();
  const phase = faker.helpers.weightedArrayElement([
    { value: PHASES[0], weight: 4 },
    { value: PHASES[1], weight: 1 },
  ]);

  // Networks raise disputes days-to-months after the payment, never before it.
  const raisedAt = daysFrom(
    new Date(order.placed_at),
    faker.number.int({ min: 3, max: 120 }),
  );

  // Roughly a third of deadlines are already blown; the rest are live and near
  // enough to exercise the urgency sorting in the queue.
  const isOverdue = faker.datatype.boolean({ probability: 0.35 });
  const respondBy = isOverdue
    ? faker.date.between({ from: monthsAgo(6), to: daysFrom(new Date(), -1) })
    : daysFrom(new Date(), faker.number.int({ min: 1, max: 21 }));

  // Only settled disputes carry a verdict; the rest are still in flight.
  const status = isOverdue
    ? faker.helpers.weightedArrayElement([
        { value: "lost", weight: 4 },
        { value: "won", weight: 3 },
        { value: "under_review", weight: 2 },
        { value: "closed", weight: 1 },
      ])
    : faker.helpers.weightedArrayElement([
        { value: "open", weight: 5 },
        { value: "under_review", weight: 2 },
      ]);
  const isSettled = status === "won" || status === "lost";

  return {
    id: randomUUID(),
    merchant_id: merchantId,
    order_id: order.id,
    razorpay_dispute_id: `disp_${faker.string.alphanumeric({ length: 14 })}`,
    razorpay_payment_id: order.razorpay_payment_id,
    amount_paise: order.amount_paise,
    // The acquirer debits the merchant up front on a chargeback; escalating to
    // pre-arbitration adds the network's own fee on top.
    amount_deducted_paise:
      phase === "pre_arbitration"
        ? order.amount_paise + 150_000
        : order.amount_paise,
    currency: order.currency,
    reason_code: reason.code,
    reason_category: reason.category,
    network: reason.network,
    phase,
    status,
    respond_by: respondBy.toISOString(),
    created_at_rzp: raisedAt.toISOString(),
    final_verdict: isSettled ? status : null,
    verdict_at: isSettled
      ? daysFrom(respondBy, faker.number.int({ min: 5, max: 30 })).toISOString()
      : null,
  };
}

// ------------------------------------------------------------------ seeding

async function resetSeedData(db: SupabaseClient): Promise<void> {
  // Every child table cascades from merchants, so this one delete is enough.
  const { data, error } = await db
    .from("merchants")
    .delete()
    .like("razorpay_account_id", `${SEED_ACCOUNT_PREFIX}%`)
    .select("id");

  if (error) {
    throw new Error(`Reset failed: ${error.message}`);
  }

  console.log(`  removed ${data?.length ?? 0} previously seeded merchant(s)`);
}

async function seedMerchant(
  db: SupabaseClient,
  index: number,
): Promise<{ name: string; ce3Candidates: number }> {
  const merchant = buildMerchant(index);

  const customers = Array.from({ length: CUSTOMERS_PER_MERCHANT }, () =>
    buildCustomer(merchant.id),
  );
  const identities = new Map(customers.map((c) => [c.id, buildIdentity()]));

  // A power-law-ish spread: a few heavy repeat buyers, a long tail of one-off
  // shoppers. Repeat buyers are what CE 3.0 needs, since an eligible dispute
  // requires prior undisputed transactions from the same customer.
  const orders: OrderRow[] = [];
  const ordersByCustomer = new Map<string, OrderRow[]>();

  for (let i = 0; i < ORDERS_PER_MERCHANT; i += 1) {
    const customer = faker.helpers.weightedArrayElement(
      customers.map((c, ci) => ({
        value: c,
        // The first customers in the list are the heavy repeat buyers.
        weight: ci < 10 ? 6 : ci < 25 ? 2 : 1,
      })),
    );

    const order = buildOrder(
      merchant,
      customer,
      identities.get(customer.id)!,
      faker.date.between({ from: monthsAgo(ORDER_HISTORY_MONTHS), to: new Date() }),
    );

    orders.push(order);
    ordersByCustomer.set(customer.id, [
      ...(ordersByCustomer.get(customer.id) ?? []),
      order,
    ]);
  }

  // Bias disputes toward customers with several orders so the CE 3.0 check has
  // prior transactions to match against — richest history first, one dispute
  // per customer, then repeat offenders to make up the count. The result is a
  // realistic mix of eligible and ineligible disputes rather than a clean
  // match on every one.
  const byHistory = [...orders].sort(
    (a, b) =>
      ordersByCustomer.get(b.customer_id)!.length -
      ordersByCustomer.get(a.customer_id)!.length,
  );

  const targets: OrderRow[] = [];
  const targeted = new Set<string>();
  const seenCustomers = new Set<string>();

  for (const order of byHistory) {
    if (targets.length >= DISPUTES_PER_MERCHANT) break;
    if (seenCustomers.has(order.customer_id)) continue;
    seenCustomers.add(order.customer_id);
    targeted.add(order.id);
    targets.push(order);
  }

  for (const order of byHistory) {
    if (targets.length >= DISPUTES_PER_MERCHANT) break;
    if (targeted.has(order.id)) continue;
    targeted.add(order.id);
    targets.push(order);
  }

  const disputes = targets.map((order) => buildDispute(merchant.id, order));

  // ---------------------------------------------------- derived aggregates
  for (const order of orders) {
    order.was_disputed = targeted.has(order.id);
  }

  for (const customer of customers) {
    const own = ordersByCustomer.get(customer.id) ?? [];
    customer.lifetime_order_count = own.length;
    customer.lifetime_gmv_paise = own.reduce((sum, o) => sum + o.amount_paise, 0);
    customer.prior_dispute_count = own.filter((o) => o.was_disputed).length;

    // ISO-8601 UTC strings sort lexicographically, so the min is the earliest.
    if (own.length > 0) {
      customer.first_seen_at = own.reduce(
        (earliest, o) => (o.placed_at < earliest ? o.placed_at : earliest),
        own[0].placed_at,
      );
    }
  }

  // How many disputes could plausibly clear a CE 3.0 check: a Visa 10.4 whose
  // customer has an earlier order sharing device fingerprint or IP hash.
  const ordersById = new Map(orders.map((o) => [o.id, o]));
  const ce3Candidates = disputes.filter((dispute) => {
    if (dispute.reason_code !== "10.4") return false;

    const order = ordersById.get(dispute.order_id)!;
    return (ordersByCustomer.get(order.customer_id) ?? []).some(
      (prior) =>
        prior.id !== order.id &&
        prior.placed_at < order.placed_at &&
        (prior.device_fingerprint === order.device_fingerprint ||
          prior.ip_address_hash === order.ip_address_hash),
    );
  }).length;

  // Insert parents before children so the foreign keys resolve.
  await insertAll(db, "merchants", [merchant]);
  await insertAll(db, "customers", customers);
  await insertAll(db, "orders", orders);
  await insertAll(db, "disputes", disputes);

  return { name: merchant.name, ce3Candidates };
}

async function main(): Promise<void> {
  const url = requireEnv("NEXT_PUBLIC_SUPABASE_URL");
  const serviceRoleKey = requireEnv("SUPABASE_SERVICE_ROLE_KEY");

  const db = createClient(url, serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      detectSessionInUrl: false,
    },
  });

  // Print the target host: this bypasses RLS and --reset deletes rows, so it
  // should be obvious in the log which project just got written to.
  console.log(`Seeding Supabase at ${new URL(url).host}`);

  if (process.argv.includes("--reset")) {
    console.log("Resetting previously seeded data...");
    await resetSeedData(db);
  }

  for (let i = 0; i < MERCHANT_COUNT; i += 1) {
    const { name, ce3Candidates } = await seedMerchant(db, i);
    console.log(
      `  [${i + 1}/${MERCHANT_COUNT}] ${name} — ` +
        `${CUSTOMERS_PER_MERCHANT} customers, ${ORDERS_PER_MERCHANT} orders, ` +
        `${DISPUTES_PER_MERCHANT} disputes (${ce3Candidates} CE 3.0 candidates)`,
    );
  }

  console.log(
    `\nDone: ${MERCHANT_COUNT} merchants, ` +
      `${MERCHANT_COUNT * CUSTOMERS_PER_MERCHANT} customers, ` +
      `${MERCHANT_COUNT * ORDERS_PER_MERCHANT} orders, ` +
      `${MERCHANT_COUNT * DISPUTES_PER_MERCHANT} disputes.`,
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
