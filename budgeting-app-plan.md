# Tally Budget — Self-Hosted, High-Level Plan (rev 2)

**Targets:** Web first. Android late (once everything else works). iOS TBD.
**Stack:** TypeScript everywhere, self-hosted. **SimpleFin is the only provider for the MVP**; the provider interface is designed so other providers (Plaid, Teller, MX) can be added later.

---

## 1. Core Concepts & Rules

### Free-to-Spend (FTS)
The headline metric, defined precisely:

> **FTS = Σ confirmed (posted) balances of active non-credit-card accounts − Σ amounts currently allocated to buckets**

- FTS is computed live from current DB state, never cached-and-stale.
- **Credit card accounts are excluded from the balance sum.** Card debt is represented *solely* by its payoff bucket allocation (§4 step 6) — counting the negative balance AND the allocation would double-count every card purchase.
- `is_active` scopes which accounts count toward FTS (**active-only**, matching the original reference app). Documented caveat: toggling an account swings FTS by its entire balance instantly — the UI should confirm/warn on toggle.
- Conceptually FTS is the **default, undeletable pseudo-bucket**: all money lands there first, and every transfer operation treats it as a valid source/target. It is *not* displayed as a bucket.
- **Buckets cannot go negative.** A matched spend that exceeds a bucket's balance draws the bucket to zero; the remainder comes out of FTS.
- **FTS may go negative**, but *only* through automatic processes (bucket funding sweeps, vault sweeps, spill-over from overspent buckets). The UI displays negative FTS prominently and leaves correction (pulling from buckets) to the user.
- **User-initiated allocations are validated**: any request that would push FTS negative is rejected.

### Buckets
Three types, same schema with a type discriminator:

- **Expense bucket** — recurring fixed cost (rent, car payment). Target amount + recurrence.
- **Goal bucket** — single-use / mid-to-long-term savings target, backed by checking.
- **Vault bucket** — backed by savings accounts. Has a **target balance AND target date**; the target date drives funding (see §6).

### Funding modes
- *Set Aside Target Amount* — fixed amount every funding period, indefinitely.
- *Reach Target Amount* — fund until target hit, pause until drawn down.
- *(Vaults)* *Date-driven* — implied by `target_date`: sweep `(target − current) / periods_remaining` each tick, capped at available FTS.

### Bucket transfers
Any bucket ↔ any bucket, including FTS as either endpoint. Implemented as paired ledger entries (§6). This is the user's tool for correcting negative FTS and rebalancing.

### Internal account transfers ≠ spending
Moving money between the user's own accounts (card payment, checking→savings) must never count as spend or trigger bucket matching. SimpleFin provides **no transfer flag** (its `Transaction` object is just `id/posted/amount/description/pending`), so:
1. **Default-deny pair matching** at ingest: only exact amount inversions across the user's accounts within a tight window, corroborated by near-zero paired balance deltas, are auto-linked as transfer pairs and excluded from all spend/FTS/bucket math.
2. Everything else — including ambiguous near-matches — surfaces in a review queue; the user can manually mark/unmark transfers.
3. When non-SimpleFin providers arrive, explicit provider signals (`Plaid transaction_code: "transfer"`) take precedence over heuristics.

### Explicitly out of scope
No money movement between real bank accounts — read-and-categorize layer only. No ACH/transfers; no money-transmission compliance concerns.

### Deferred to future TBD phases
- Round-ups
- Manual transactions
- Backup / export / import
- Push notifications (mobile push infra generally)
- Additional providers (Plaid, Teller, MX)
- Multi-currency (**USD-only for MVP**, stated explicitly; SimpleFin custom currencies are rejected at import)
- Email delivery (invites, password reset)

---

## 2. Key Architectural Decision: Provider Abstraction (SimpleFin-first)

```
┌──────────────────────────────────────────────┐
│            TransactionProvider                │
│  (link flow, connections[], accounts[],       │
│   balances, transactions[], sync cursor)      │
└──────────────────────────────────────────────┘
                     ▲
                     │
              SimpleFinAdapter        (future: PlaidAdapter, TellerAdapter…)
```

- Normalized types: `NormalizedConnection`, `NormalizedAccount`, `NormalizedTransaction`, `SyncResult`.
- **SimpleFin realities baked into the design** (from the official protocol/dev guide):
  - **Polling only** — no webhooks, no cursors. Sync is a scheduled poll.
  - **~24 requests/day/token** quota (replenished through the day; exceeding disables tokens). Poll 1–6×/day at randomized minutes past the hour.
  - **90-day max date range per request**; history depth varies by institution.
  - Fetch windows **overlap ~5 days** to avoid missing mutated transactions; dedup handled by upsert (§4).
  - Setup-token flow: user generates token at bridge.simplefin.org → pastes into our Settings → we POST to the claim URL once → store the returned Access URL **encrypted**.
  - Pending transactions: requested explicitly (`pending=1`) and tracked through a lifecycle (§4).
  - Handle `errlist`/402/403 responses; treat access-URL credentials as secrets.
- Sync orchestration is provider-agnostic: scheduler calls `provider.sync(connection)` per connection, then runs the shared ingest pipeline (transfers → matching → sweeps).

### Credentials ownership
Credentials belong to the **installation (the app)**, not to a user or budget. Self-hosted = one household = one instance-level config. A **Settings page** holds the SimpleFin setup/access token(s). Stored **encrypted at rest** (AES-256-GCM, key from `APP_SECRET` env var). Never logged, never sent to clients after save.

---

## 3. Data Model (core entities)

Money is **integer cents everywhere** (non-negotiable), guarded by a small `Money` module in `packages/core`.

```
User
Budget (workspace)
BudgetMember (user ↔ budget, role: owner | member)
Category          -- our canonical taxonomy (global list, budget-assignable)
CategoryMapping   -- provider raw string → category_id; learned from user corrections
ProviderCredential (per installation, encrypted payload)
Connection (provider name, provider conn/item id, org name, last_sync_at, status)

Account
  ├── budget_id
  ├── connection_id (nullable — reserved for future manual accounts)
  ├── provider_account_id
  ├── type (checking | savings | cd | credit_card)
  ├── is_active (bool)
  ├── reported_balance, available_balance, reported_balance_date
  └── version (optimistic locking)

BalanceSnapshot (account_id, date, reported_balance)   -- daily snapshot for history/audit

BucketGroup (budget_id, name, color)

Bucket
  ├── budget_id, bucket_group_id (nullable)
  ├── type (expense | goal | vault)
  ├── name, target_amount, target_date (vault)
  ├── funding_mode (set_aside | reach_target)
  ├── funding_schedule_id
  └── version

FundingSchedule (budget_id, name, recurrence_rule + anchor date)

ScheduleOccurrence                    -- the idempotency backbone
  ├── bucket_id, schedule_id
  ├── due_date                        -- the concrete tick this represents
  ├── status (pending | applied | skipped)
  └── UNIQUE(bucket_id, due_date)

LedgerEntry                           -- append-only; source of truth for bucket/FTS math
  ├── budget_id
  ├── bucket_id (nullable = FTS side of an entry)
  ├── kind (funding | spend | transfer_in | transfer_out | correction)
  ├── amount_cents (signed)
  ├── source_type/source_id (occurrence | transaction | transfer pair | manual)
  └── created_at

Transaction
  ├── account_id
  ├── provider_transaction_id
  ├── UNIQUE(account_id, provider_transaction_id)
  ├── status (pending | posted | superseded)
  ├── supersedes_pending_id (app-level link; SimpleFin provides no pending↔posting reference)
  ├── amount_cents, posted_at, transacted_at, merchant_description
  ├── raw_category, category_id (ours, nullable → "Unknown")
  ├── bucket_id (null = hit FTS)
  └── transfer_link_id (nullable — paired internal transfer, excluded from spend math)

CreditCardConfig
  ├── account_id, mode (free_to_spend | bucket), payoff_bucket_id   -- exactly ONE payoff bucket per card (enforced)
```

Notes:
- `Bucket.current_balance` and the FTS number are **derived/cached views over `LedgerEntry`**, never independently mutated.
- `LedgerEntry` is unique on `(source_type, source_id, kind)` — one transaction may legitimately produce multiple entries (e.g., a Bucket-mode card purchase writes a bucket drawdown AND a payoff sweep).
- Transactions are **soft-deleted/unlinked only**; ledger history is never rewritten. Reassigning a transaction's bucket/category writes compensating correction entries.
- `reported_balance` from SimpleFin is the source of truth for *total account balance*. FTS does not attempt to replay history onto it; daily `BalanceSnapshot`s exist for charts, audit, and reconciliation debugging, not for live computation.

---

## 4. Ingest Pipeline (order matters, deterministic)

Per synced batch, per transaction. **Every money-affecting step (3–7) operates on `status='posted'` rows only** — pendings never touch balances, buckets, or FTS.

1. **Upsert** on `(account_id, provider_transaction_id)` — overlapping fetch windows make this safe. Provider-side mutations (amount/date changed between polls) update in place.
2. **Pending→posted merging**: SimpleFin supplies no pending↔posting reference, so postings are heuristically matched to open pendings (normalized descriptor similarity + amount within tolerance + ≤~7-day window). Matched → the posted row supersedes the pending (`status='superseded'`, hidden from all views/math). Outside tolerance → keep both, never merge. Pendings older than ~14 days expire to the review queue.
3. **Transfer detection (default-deny)**: auto-link only exact amount inversions with corroborating near-zero paired balance deltas → `transfer_link_id`, excluded from spend math. All ambiguous cases go to the review queue for manual marking.
4. **Category normalization**: map provider raw category/description → our `Category` via stored `CategoryMapping`; unknown → "Unknown" + user picks; choice persists as a mapping for all future transactions in that raw category.
5. **Auto-spend matching**: explicit merchant match > category match > unmatched → FTS. Bucket drawdown clamps at zero; remainder spills to FTS.
6. **Card logic by direction** (any card-account transaction, either CC mode):
   - Posted *charge* (purchase, interest, fee) → sweeps into the card's payoff bucket (Bucket-mode matched drawdowns net against this).
   - Posted *payment* (paired checking/savings outflow) → linked to the payoff bucket as a normal drawdown, clamped ≥ 0, releasing the reservation for the amount actually paid; any remaining balance keeps its allocation.
   - Non-payment credits (merchant refunds to card) → review queue; routing rule TBD (§9).
7. **Mutation corrections**: if an already-ingested posted transaction mutates (e.g., $48 settles at $52) and ledger entries exist for it, append compensating `kind=correction` entries for the delta — routed through the original split with the same clamp/spill rules. Reconciliation invariant: Σledger(txn) must equal its currently routed amount.

This pipeline is pure/testable in `packages/core` where possible and runs in a queue worker.

---

## 5. Suggested Tech Stack

### Backend
- Node.js + TypeScript, Fastify (NestJS optional if structure warrants).
- PostgreSQL — relational integrity + transactional consistency.
- Drizzle ORM (SQL-close, great TS inference; common pairing in self-hosted OSS finance apps).
- **Job queue: pg-boss (Postgres-backed)** instead of Redis + BullMQ. Rationale: removes an entire self-hosted service; jobs enqueue transactionally with business writes (no dual-write problem); `FOR UPDATE SKIP LOCKED` claiming; crash-safe. We need Postgres anyway.
- Money: integer cents + `Money` helper module.
- **Auth: simple session-based auth** (database-backed sessions, Argon2id password hashing), implemented following the Lucia learning resource. Note: the Lucia *library* was deprecated March 2025 and is no longer maintained — do not depend on the npm package. (Better Auth is the fallback if hand-rolling proves annoying.) MVP user administration via server CLI commands; invite/reset email deferred.
- Encryption at rest for provider credentials: AES-256-GCM with `APP_SECRET`.

### Frontend (web)
React + Vite SPA, TanStack Query, Zustand, Tailwind CSS, Recharts/visx.
FTS is a **server-computed endpoint**; TanStack Query's stale-while-revalidate window is the accepted freshness contract (poll/refetch aggressively on Home).

### Infra / self-hosting
- Docker Compose: **Postgres + API + static web build** (no Redis needed). One `.env` for `APP_SECRET`, `DATABASE_URL`, SimpleFin config.
- Migrations run on container start.
- Local/admin CLI commands for creating/modifying users and accounts (MVP replaces email flows).
- Running locally for MVP — remote-access story (reverse proxy/TLS guidance) documented but minimal; mobile reachability solved later with the Android phase.

### Monorepo layout
```
/apps
  /web        (Vite + React)
  /server     (API + workers)
/packages
  /core       (shared types, zod schemas, Money utils, funding engine, ingest pipeline logic)
  /api-client (typed fetch client)
  /ui         (design tokens)
```
pnpm workspaces (+ Turborepo if useful).

---

## 6. Engine — The Part That Needs Care

### Idempotency strategy
Every side-effectful background operation carries a **materialized idempotency key**:

- **Funding sweeps**: pre-generate `ScheduleOccurrence` rows from schedule + anchor; the worker claims occurrences and flips `pending → applied`. Replays/no-ops are guaranteed by the `UNIQUE(bucket_id, due_date)` constraint — a re-run can never double-fund.
  - Option considered and rejected: deriving keys purely from computed dates (fragile when anchors/RRULEs change); Redis job IDs (not durable across restarts). Occurrence rows are durable, inspectable, and let the UI show "upcoming funding events" for free.
  - Missed ticks (downtime): occurrences accumulate as `pending` and are applied at next run — catch-up semantics, bounded by FTS guard.
- **Sync ingest**: upsert-on-natural-key (`account_id + provider_transaction_id`) makes replays harmless.
- **Transfers/ledger entries**: keyed by `source_type + source_id`; unique index prevents duplicates.

### Funding calculation
Pure functions in `packages/core`: given schedule + bucket + mode (+ `target_date` for vaults), produce occurrence amounts. Vault: `(target − current) / periods_remaining`, capped at available FTS. Date/timezone semantics (anchors, month-end dates in short months, "today" boundaries) live here and get dedicated tests.

### Concurrency control
Investigated options and the chosen mix:

1. **Append-only ledger** (structural fix): money math is inserts, not read-modify-write — most worker/user races become benign appends.
2. **Optimistic locking** (`version` column) on user-editable entities (Bucket, Account, Budget): concurrent edits by two members → second writer gets a conflict, retries. Right fit for low-contention household usage; avoids long-held locks.
3. **Serialized background work per budget**: workers claim jobs via `FOR UPDATE SKIP LOCKED` (pg-boss), and per-budget ordering keeps sweep/ingest sequences deterministic.
4. Rejected: SERIALIZABLE isolation everywhere (retry storms, poor fit), Redis-based locks (extra service, weaker guarantees than DB constraints).

### Reconciliation
A periodic job compares each account's `reported_balance` against the ledger-derived expectation (snapshot anchor + Σ ledger deltas). Divergence beyond a threshold flags the account health view and badges FTS as possibly stale (provider balance can move before the transaction feed catches up). It never rewrites data — drift surfaces, humans resolve.

---

## 7. App Structure & Navigation

1. **Home / FTS** — big live FTS number (negative = loud warning), upcoming funding events (from pending `ScheduleOccurrence`s), buckets nearing target.
2. **Buckets** — filterable Expenses/Goals/Vaults, grouped by Bucket Group; detail shows target, schedule, progress, matched merchants/categories, transfer in/out actions.
3. **Transactions** — feed with filters; reassign bucket/category, split (deferred? see open questions), mark/unmark transfer; "Unknown category" review surface.
4. **Accounts** — grouped by Connection; health (last sync, errors), active toggle, force-sync; credit-card mode config; add-account via SimpleFin token paste.
5. **Activity** — spending breakdown by Bucket Group over time (charts).
6. **Profile / Settings** — budget switcher, member invite (invite links/code for MVP — no email), **instance-level Connections panel (SimpleFin token)**, notification preferences (in-app only for now), funding schedule management.

Web layout: sidebar on wide screens, bottom tabs on narrow — same IA as the eventual mobile app.

---

## 8. Build Phases

**Phase 0 — Foundations**
Monorepo scaffold, Postgres schema (incl. ledger, occurrences, snapshots), session auth + CLI user management, Budget/Bucket/Schedule CRUD, Settings page with encrypted credential storage.

**Phase 1 — SimpleFin sync**
Setup-token link flow, scheduled polling (quota-aware, overlap windows), transaction upsert + pending→posted lifecycle, category mapping + "Unknown" review, balance snapshots, connection health view.

**Phase 2 — Core engine**
Occurrence-based idempotent funding sweeps, vault date-driven math, auto-spend matching pipeline, transfer-pair detection + review, bucket↔bucket transfers (incl. FTS), live FTS endpoint. Pure logic lives in `packages/core` with tests. Pending→posted merging and transfer heuristics are finalized and frozen here, before the matcher is built.

**Phase 3 — Credit card modes**
Both payoff modes over SimpleFin data. The card accounting model (exclusion from FTS sum + direction-based sweeps/drawdowns) is frozen before implementation.

**Phase 4 — Web polish + collaboration**
Activity charts, in-app notifications, joint budgets with invite links, permissions enforcement (owner/member).

**Phase 5 — Android**
Mobile stack decision revisited here (Expo deliberately not chosen yet); remote-access/offline story addressed alongside.

**Phase 6+ — TBD backlog**
Round-ups · manual transactions · backup/export/import (incl. import from Actual/Firefly) · additional providers (Plaid next — note its free Trial tier caps at **10 Items**, where an Item ≈ one linked institution connection, not a transaction or sync) · push notifications · email delivery · multi-currency.

---

## 9. Open Questions
- Split transactions: feature parity with the original reference app suggests they're needed eventually — confirm scope before Phase 2 schema freeze (ledger already supports it via multiple spend entries).
- Refund/credit routing on spending accounts: restore originating bucket capped at the original drawdown, remainder to FTS. Card-account credits stay in the review queue until decided.
- Partial funding of catch-up occurrences when FTS is short: partially-applied vs retried (set_aside buckets need an explicit policy; vaults self-correct via date math).
- Cent conversion: parse arbitrary-precision provider values, round half-even to cents, log anomalies (>2 decimal places).
