-- ============================================================================
-- CE3.ai — initial schema (05 Backend Schema)
-- AI chargeback defence for Razorpay merchants
-- ============================================================================

create extension if not exists "pgcrypto";
create extension if not exists "vector";

-- ============================================================================
-- 4.1  TABLES
-- ============================================================================

-- ---------------------------------------------------------------- merchants
create table if not exists public.merchants (
  id                            uuid primary key default gen_random_uuid(),
  name                          text not null,
  razorpay_account_id           text unique,
  razorpay_key_id               text,
  razorpay_key_secret_encrypted text,
  webhook_secret_encrypted      text,
  fight_fee_paise               bigint  not null default 0,
  ops_cost_per_minute_paise     bigint  not null default 0,
  vamp_ratio_current            numeric,
  risk_threshold                numeric not null default 0.55,
  billing_descriptor            text,
  created_at                    timestamptz not null default now()
);

-- -------------------------------------------------------------------- users
-- id equals auth.uid()
create table if not exists public.users (
  id          uuid primary key references auth.users(id) on delete cascade,
  merchant_id uuid references public.merchants(id) on delete cascade,
  email       text unique not null,
  name        text,
  role        text not null default 'analyst'
                check (role in ('admin', 'analyst', 'viewer')),
  created_at  timestamptz not null default now()
);
create index if not exists users_merchant_id_idx on public.users (merchant_id);

-- ---------------------------------------------------------------- customers
create table if not exists public.customers (
  id                   uuid primary key default gen_random_uuid(),
  merchant_id          uuid not null references public.merchants(id) on delete cascade,
  external_user_id     text,
  email_hash           text,
  phone_hash           text,
  first_seen_at        timestamptz,
  lifetime_order_count int    not null default 0,
  lifetime_gmv_paise   bigint not null default 0,
  prior_dispute_count  int    not null default 0,
  return_count         int    not null default 0,
  created_at           timestamptz not null default now()
);
create index if not exists customers_merchant_id_idx on public.customers (merchant_id);
create index if not exists customers_email_hash_idx  on public.customers (email_hash);
create index if not exists customers_phone_hash_idx  on public.customers (phone_hash);
create unique index if not exists customers_merchant_external_uid_key
  on public.customers (merchant_id, external_user_id)
  where external_user_id is not null;

-- ------------------------------------------------------------------- orders
create table if not exists public.orders (
  id                      uuid primary key default gen_random_uuid(),
  merchant_id             uuid not null references public.merchants(id) on delete cascade,
  razorpay_order_id       text,
  razorpay_payment_id     text,
  customer_id             uuid references public.customers(id) on delete set null,
  amount_paise            bigint not null default 0,
  currency                text   not null default 'INR',
  payment_method          text,
  card_network            text,
  is_cod                  boolean not null default false,
  ip_address_hash         text,
  device_fingerprint      text,
  shipping_address_hash   text,
  shipping_address_raw    text,
  billing_descriptor_used text,
  avs_result              text,
  cvv_result              text,
  three_ds_status         text,
  placed_at               timestamptz,
  delivered_at            timestamptz,
  delivery_status         text,
  awb_number              text,
  was_disputed            boolean not null default false,
  created_at              timestamptz not null default now()
);
create index if not exists orders_merchant_id_idx         on public.orders (merchant_id);
create index if not exists orders_razorpay_payment_id_idx on public.orders (razorpay_payment_id);
create index if not exists orders_razorpay_order_id_idx   on public.orders (razorpay_order_id);
create index if not exists orders_customer_id_idx         on public.orders (customer_id);
create index if not exists orders_placed_at_idx           on public.orders (placed_at desc);
create index if not exists orders_ship_addr_hash_idx      on public.orders (shipping_address_hash);

-- ----------------------------------------------------------------- disputes
create table if not exists public.disputes (
  id                    uuid primary key default gen_random_uuid(),
  merchant_id           uuid not null references public.merchants(id) on delete cascade,
  order_id              uuid unique references public.orders(id) on delete set null,  -- one-to-one
  razorpay_dispute_id   text unique not null,
  razorpay_payment_id   text,
  amount_paise          bigint not null default 0,
  amount_deducted_paise bigint not null default 0,
  currency              text   not null default 'INR',
  reason_code           text,
  reason_category       text,
  network               text,
  phase                 text,
  status                text,
  respond_by            timestamptz,
  created_at_rzp        timestamptz,
  final_verdict         text,
  verdict_at            timestamptz,
  created_at            timestamptz not null default now()
);
create index if not exists disputes_merchant_id_idx         on public.disputes (merchant_id);
create index if not exists disputes_status_idx              on public.disputes (status);
create index if not exists disputes_respond_by_idx          on public.disputes (respond_by);
create index if not exists disputes_razorpay_payment_id_idx on public.disputes (razorpay_payment_id);

-- ----------------------------------------------------------- dispute_scores
-- many-to-one, versioned: one row per model_version scoring pass
create table if not exists public.dispute_scores (
  id                   uuid primary key default gen_random_uuid(),
  dispute_id           uuid not null references public.disputes(id) on delete cascade,
  model_version        text not null,
  win_probability      numeric check (win_probability between 0 and 1),
  recommended_action   text check (recommended_action in ('fight', 'accept', 'review')),
  expected_value_paise bigint,
  ev_if_fight_paise    bigint,
  ev_if_accept_paise   bigint,
  confidence_band      text,
  top_features         jsonb not null default '[]'::jsonb,
  shap_values          jsonb not null default '{}'::jsonb,
  scored_at            timestamptz not null default now()
);
create index if not exists dispute_scores_dispute_id_idx
  on public.dispute_scores (dispute_id, scored_at desc);

-- ------------------------------------------------------- evidence_artifacts
-- one-to-many per dispute; slot enumerates the Razorpay evidence object keys
create table if not exists public.evidence_artifacts (
  id                   uuid primary key default gen_random_uuid(),
  dispute_id           uuid not null references public.disputes(id) on delete cascade,
  merchant_id          uuid not null references public.merchants(id) on delete cascade,
  slot                 text not null check (slot in (
                         'shipping_proof',
                         'billing_proof',
                         'cancellation_proof',
                         'customer_communication',
                         'proof_of_service',
                         'explanation_letter',
                         'refund_confirmation',
                         'access_activity_log',
                         'refund_cancellation_policy',
                         'term_and_conditions',
                         'others'
                       )),
  source               text,
  storage_path         text,
  sha256               text,
  extracted_facts      jsonb not null default '{}'::jsonb,
  razorpay_document_id text,
  uploaded_at          timestamptz not null default now()
);
create index if not exists evidence_artifacts_dispute_id_idx  on public.evidence_artifacts (dispute_id);
create index if not exists evidence_artifacts_merchant_id_idx on public.evidence_artifacts (merchant_id);
create index if not exists evidence_artifacts_slot_idx        on public.evidence_artifacts (dispute_id, slot);

-- ---------------------------------------------------- evidence_requirements
-- Global read-only reference table, seeded from the Razorpay published
-- reason-code -> evidence mapping. Not merchant-scoped, no FK.
create table if not exists public.evidence_requirements (
  id              uuid primary key default gen_random_uuid(),
  network         text not null,
  reason_code     text not null,
  slot            text not null,
  is_mandatory    boolean not null default false,
  win_lift_weight numeric not null default 0,
  guidance_text   text,
  embedding       vector(1536)
);
create unique index if not exists evidence_requirements_key
  on public.evidence_requirements (network, reason_code, slot);
create index if not exists evidence_requirements_lookup_idx
  on public.evidence_requirements (network, reason_code);

-- --------------------------------------------------------------- ce3_checks
-- one-to-one with dispute
create table if not exists public.ce3_checks (
  id                      uuid primary key default gen_random_uuid(),
  dispute_id              uuid unique not null references public.disputes(id) on delete cascade,
  is_eligible             boolean not null default false,
  matched_order_ids       uuid[]  not null default '{}',
  matched_elements        text[]  not null default '{}',
  element_match_count     int     not null default 0,
  age_days_txn_1          int,
  age_days_txn_2          int,
  descriptor_prefix_match boolean not null default false,
  failure_reasons         text[]  not null default '{}',
  checked_at              timestamptz not null default now()
);

-- ---------------------------------------------------------------- rebuttals
-- one-to-many per dispute, versioned drafts.
-- claims shape:
--   [{ sentence, source_type: 'order_field' | 'artifact', source_id, verified }]
create table if not exists public.rebuttals (
  id                     uuid primary key default gen_random_uuid(),
  dispute_id             uuid not null references public.disputes(id) on delete cascade,
  draft_text             text,
  claims                 jsonb not null default '[]'::jsonb,
  uncited_claims_removed int  not null default 0,
  grounding_passed       boolean not null default false,
  model_used             text,
  token_cost             int not null default 0,
  approved_by            uuid references public.users(id) on delete set null,
  approved_at            timestamptz,
  submitted_at           timestamptz,
  created_at             timestamptz not null default now()
);
create index if not exists rebuttals_dispute_id_idx on public.rebuttals (dispute_id, created_at desc);

-- ---------------------------------------------------------------- audit_log
create table if not exists public.audit_log (
  id           uuid primary key default gen_random_uuid(),
  merchant_id  uuid not null references public.merchants(id) on delete cascade,
  actor_id     uuid references public.users(id) on delete set null,
  action       text not null,
  entity_type  text,
  entity_id    uuid,
  payload_diff jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now()
);
create index if not exists audit_log_merchant_id_idx on public.audit_log (merchant_id, created_at desc);
create index if not exists audit_log_entity_idx      on public.audit_log (entity_type, entity_id);

-- --------------------------------------------------------------- model_runs
-- Global ML training registry. Service-role writes only.
create table if not exists public.model_runs (
  id                             uuid primary key default gen_random_uuid(),
  version                        text unique not null,
  trained_at                     timestamptz not null default now(),
  train_rows                     int,
  test_rows                      int,
  split_strategy                 text,
  precision                      numeric,
  recall                         numeric,
  pr_auc                         numeric,
  roc_auc                        numeric,
  brier_score                    numeric,
  threshold                      numeric,
  fp_cost_paise                  bigint,
  fn_cost_paise                  bigint,
  net_recovery_vs_baseline_paise bigint,
  feature_importances            jsonb not null default '{}'::jsonb,
  notes                          text
);

-- ============================================================================
-- HELPERS — current user's merchant and role
-- ============================================================================

create or replace function public.current_merchant_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $fn$
  select merchant_id from public.users where id = auth.uid()
$fn$;

create or replace function public.is_merchant_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $fn$
  select coalesce((select role = 'admin' from public.users where id = auth.uid()), false)
$fn$;

-- ============================================================================
-- ROW LEVEL SECURITY
-- The service_role key bypasses RLS entirely, so "service-role only" tables
-- are expressed as: RLS enabled, with no permissive write policy for clients.
-- ============================================================================

alter table public.merchants             enable row level security;
alter table public.users                 enable row level security;
alter table public.customers             enable row level security;
alter table public.orders                enable row level security;
alter table public.disputes              enable row level security;
alter table public.dispute_scores        enable row level security;
alter table public.evidence_artifacts    enable row level security;
alter table public.evidence_requirements enable row level security;
alter table public.ce3_checks            enable row level security;
alter table public.rebuttals             enable row level security;
alter table public.audit_log             enable row level security;
alter table public.model_runs            enable row level security;

-- ---------------------------------------------------------------- merchants
create policy merchants_select on public.merchants
  for select to authenticated
  using (id = public.current_merchant_id());

create policy merchants_update on public.merchants
  for update to authenticated
  using (id = public.current_merchant_id() and public.is_merchant_admin())
  with check (id = public.current_merchant_id());

-- -------------------------------------------------------------------- users
create policy users_select on public.users
  for select to authenticated
  using (merchant_id = public.current_merchant_id() or id = auth.uid());

create policy users_update_self on public.users
  for update to authenticated
  using (id = auth.uid())
  with check (id = auth.uid() and merchant_id = public.current_merchant_id());

create policy users_admin_insert on public.users
  for insert to authenticated
  with check (merchant_id = public.current_merchant_id() and public.is_merchant_admin());

create policy users_admin_delete on public.users
  for delete to authenticated
  using (merchant_id = public.current_merchant_id() and public.is_merchant_admin());

-- -------------------------- standard merchant_id scoped policies (full CRUD)
create policy customers_merchant_scope on public.customers
  for all to authenticated
  using (merchant_id = public.current_merchant_id())
  with check (merchant_id = public.current_merchant_id());

create policy orders_merchant_scope on public.orders
  for all to authenticated
  using (merchant_id = public.current_merchant_id())
  with check (merchant_id = public.current_merchant_id());

create policy disputes_merchant_scope on public.disputes
  for all to authenticated
  using (merchant_id = public.current_merchant_id())
  with check (merchant_id = public.current_merchant_id());

create policy evidence_artifacts_merchant_scope on public.evidence_artifacts
  for all to authenticated
  using (merchant_id = public.current_merchant_id())
  with check (merchant_id = public.current_merchant_id());

-- ------------ child tables with no merchant_id: scoped via parent dispute
create policy dispute_scores_merchant_scope on public.dispute_scores
  for all to authenticated
  using (exists (
    select 1 from public.disputes d
    where d.id = dispute_scores.dispute_id
      and d.merchant_id = public.current_merchant_id()
  ))
  with check (exists (
    select 1 from public.disputes d
    where d.id = dispute_scores.dispute_id
      and d.merchant_id = public.current_merchant_id()
  ));

create policy ce3_checks_merchant_scope on public.ce3_checks
  for all to authenticated
  using (exists (
    select 1 from public.disputes d
    where d.id = ce3_checks.dispute_id
      and d.merchant_id = public.current_merchant_id()
  ))
  with check (exists (
    select 1 from public.disputes d
    where d.id = ce3_checks.dispute_id
      and d.merchant_id = public.current_merchant_id()
  ));

create policy rebuttals_merchant_scope on public.rebuttals
  for all to authenticated
  using (exists (
    select 1 from public.disputes d
    where d.id = rebuttals.dispute_id
      and d.merchant_id = public.current_merchant_id()
  ))
  with check (exists (
    select 1 from public.disputes d
    where d.id = rebuttals.dispute_id
      and d.merchant_id = public.current_merchant_id()
  ));

-- ---------------------------------------------------------------- audit_log
-- Insert-only for members of the merchant; select restricted to admins.
-- No update/delete policy exists, so the log is append-only for all clients.
create policy audit_log_insert on public.audit_log
  for insert to authenticated
  with check (
    merchant_id = public.current_merchant_id()
    and (actor_id is null or actor_id = auth.uid())
  );

create policy audit_log_admin_select on public.audit_log
  for select to authenticated
  using (merchant_id = public.current_merchant_id() and public.is_merchant_admin());

-- ----------------------------------------- evidence_requirements (reference)
-- Global read for any authenticated user; writes only via service_role.
create policy evidence_requirements_read on public.evidence_requirements
  for select to authenticated
  using (true);

-- ------------------------------------------------- model_runs (ML registry)
-- Read for any authenticated user; writes only via service_role.
create policy model_runs_read on public.model_runs
  for select to authenticated
  using (true);

-- ============================================================================
-- GRANTS — defence in depth alongside RLS
-- ============================================================================

revoke all on public.evidence_requirements from anon, authenticated;
revoke all on public.model_runs            from anon, authenticated;
grant select on public.evidence_requirements to authenticated;
grant select on public.model_runs            to authenticated;

revoke update, delete on public.audit_log from anon, authenticated;
grant  select, insert on public.audit_log to authenticated;
