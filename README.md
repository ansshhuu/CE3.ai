# CE3.ai

AI chargeback defence for Razorpay merchants.

CE3.ai ingests disputes from Razorpay, scores each one for win probability and
expected value, checks Visa Compelling Evidence 3.0 (CE3.0) eligibility, assembles
the evidence the network actually requires for that reason code, and drafts a
grounded rebuttal for a human to approve before submission.

> **Status:** early build-out. The database schema is in place; the application
> surface is still a Next.js scaffold.

## Stack

| Layer      | Choice                                        |
| ---------- | --------------------------------------------- |
| App        | Next.js 14 (App Router), TypeScript, Tailwind |
| UI         | shadcn/ui, Recharts, Sonner                   |
| Database   | Supabase (Postgres + RLS + pgvector)          |
| Payments   | Razorpay                                      |
| Queue      | Upstash QStash + Redis                        |
| LLM        | OpenRouter                                    |
| Scoring    | external ML service (`ML_SERVICE_URL`)        |
| Tests      | Vitest                                        |

## Getting started

```bash
npm install
cp .env.local.example .env.local   # then fill in the values
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

### Environment

All keys live in `.env.local` (gitignored). See `.env.local.example` for the full
list — Supabase URL/anon/service-role, Razorpay key/secret/webhook secret,
OpenRouter, the ML service URL and shared secret, Upstash Redis + QStash, Resend,
and `APP_BASE_URL`.

Only `NEXT_PUBLIC_*` values reach the browser. `SUPABASE_SERVICE_ROLE_KEY`
bypasses Row Level Security entirely — server-side use only, never in a client
component.

## Database

The schema lives in [supabase/migrations/](supabase/migrations/) and is the source
of truth. Apply it with the Supabase CLI:

```bash
npm i -g supabase          # one-time
supabase login
supabase link --project-ref <your-project-ref>
supabase db push
```

Or run it locally against Docker:

```bash
supabase start
supabase db reset          # replays every migration into the local DB
```

Without the CLI, paste the whole of `supabase/migrations/0001_init.sql` into the
Supabase Dashboard SQL Editor and run it as a single query. Enable the `vector`
and `pgcrypto` extensions first under **Database → Extensions** if the
`create extension` lines fail.

### Schema overview

| Table                   | Purpose                                                        |
| ----------------------- | -------------------------------------------------------------- |
| `merchants`             | Tenant root — Razorpay credentials, fight-fee and cost economics, risk threshold |
| `users`                 | Dashboard users, `id` = `auth.uid()`, scoped to one merchant    |
| `customers`             | Buyer history — lifetime GMV, prior disputes, returns           |
| `orders`                | Transaction + fulfilment record, the evidentiary backbone       |
| `disputes`              | Razorpay dispute, its reason code, deadline and final verdict    |
| `dispute_scores`        | Versioned model output — win probability, EV, SHAP attributions |
| `evidence_artifacts`    | Uploaded documents, one per Razorpay evidence slot              |
| `evidence_requirements` | Global reference: reason code → required evidence, with embeddings |
| `ce3_checks`            | Visa CE3.0 eligibility result and matched data elements          |
| `rebuttals`             | Versioned LLM drafts with per-sentence claim grounding           |
| `audit_log`             | Append-only record of every action                               |
| `model_runs`            | ML training registry — metrics, thresholds, cost curves          |

### Row Level Security

RLS is enabled on all twelve tables.

- **Merchant-scoped** (`merchants`, `users`, `customers`, `orders`, `disputes`,
  `evidence_artifacts`): rows are visible only to users whose `merchant_id`
  matches. `dispute_scores`, `ce3_checks` and `rebuttals` carry no `merchant_id`
  of their own and are scoped through their parent dispute.
- **`audit_log`** is insert-only. No update or delete policy exists, and both are
  revoked outright; `select` is restricted to users with the `admin` role.
- **`evidence_requirements` and `model_runs`** are global reference tables:
  readable by any authenticated user, writable only via the service-role key
  (which bypasses RLS).

Two helper functions, `current_merchant_id()` and `is_merchant_admin()`, back the
policies. Both are `security definer` so a user can resolve their own merchant
without needing a readable path into `users`.

## Testing

```bash
npm test          # single run
npm run test:watch
```

## Scripts

| Command         | Does                          |
| --------------- | ----------------------------- |
| `npm run dev`   | Development server            |
| `npm run build` | Production build              |
| `npm start`     | Serve the production build    |
| `npm run lint`  | ESLint                        |
| `npm test`      | Vitest, single run            |
