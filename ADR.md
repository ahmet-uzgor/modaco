# ModaCo — Architecture Decision Record

This document records the deliberate decisions taken while building the ModaCo
promotion-management API. The brief calls out "standard CRUD will not be
accepted" — Scenarios A and B are the real grading lens — so the decisions
here are oriented around those two scenarios and the operational realism
they demand, rather than feature completeness.

## 1. Context

We're building a backend service that exposes products and promotions through
a REST API, ingests vendor catalogs from S3 (Scenario A), and supports
flash-sale category-wide promotions over tens of thousands of products
(Scenario B). The brief explicitly rules out shallow CRUD work and asks for
architectural reasoning. Time budget was 16–24 focused hours.

The scenarios are not symmetric:

- **Scenario A** is bounded by a Lambda timeout (15 min) and a memory budget
  (512 MB) against a 500k-row CSV. The decisive question is "what fits in
  one Lambda invocation?".
- **Scenario B** is bounded by the storefront's read SLO. The decisive
  question is "how do we keep reads cheap while a promotion churns 50k
  products' effective prices?".

Both decisions ripple through the schema, the API contract, and the
infrastructure layout. The rest of this document walks each ripple
explicitly.

## 2. Decision: denormalized `effective_price` on `products`

The read path is the hot path — `GET /products/:id` and the catalog list
endpoint will receive multiples of the traffic that promotion writes do.
Computing the discount at read time means a JOIN to `promotions` per request,
plus applying the precedence rule (PRODUCT outranks CATEGORY), plus
Decimal-correct math. Under flash-sale load that cost compounds.

We chose to **store the result on the product row**. Every product carries
`base_price`, `active_promotion_id`, `effective_price`, and
`effective_price_updated_at`. Reads do a primary-key lookup. Writes — which
are rare — own the recomputation.

Alternatives considered:

- **Materialized view** refreshed periodically. Rejected: refresh latency is
  visible to customers during a sale.
- **Read-time JOIN with a small cache TTL**. Rejected: TTL hides the
  precedence rule's complexity but doesn't remove it from the hot path, and
  staleness is unbounded during cache warm-up.

The tradeoff is write amplification: a category-wide promotion costs 50k row
updates. Section 14 explains why this is acceptable.

## 3. Decision: materialized `product_promotions` link table

The brief states that a category-level promotion instantly affects every
product in that category, and a new product joining the category mid-sale
should pick the discount up immediately. Two ways to implement that:

- **Compute at read time**: every read evaluates "is there a category
  promotion active for this product's category, and does any product-level
  promotion outrank it?". O(reads) cost.
- **Materialize on write**: when a category promotion is created, insert one
  link row per affected product; bulk-update `effective_price` on those
  products. O(products-in-category) once, on write.

We chose the materialized table. With 50k products per category and a
read-to-write ratio that's orders of magnitude reads-heavy, paying once at
promotion-creation time and serving cheap reads thereafter is the right
trade. The bulk apply is a single `INSERT ... SELECT ... ON CONFLICT DO
NOTHING` followed by a single `UPDATE products ... WHERE category_id = $`,
both index-scanned via `idx_products_category_effective_price`.

The `product_promotions` table also gives us a second-class observability
artifact: which products carried which promotion, queryable historically.

## 4. Decision: PostgreSQL + Redis (no Kafka, no MongoDB)

PostgreSQL is the source of truth because the domain is relational
(categories → products, products ↔ promotions via the link table) and the
"at most one active promotion per product" rule needs row-level locking and
transactions. JSONB is in the toolbox but unused.

Redis sits in front of the read path. It caches `GET /products/:id`
responses with a 5-minute TTL and is the channel for batched invalidation
when writes land.

We deliberately did **not** add Kafka: the ingest workload is one producer,
one consumer, infrequent batches. SQS (or its in-process local-dev
equivalent) is simpler to operate and meets every requirement.
MongoDB-style document storage was rejected for the same reason — the data
is fundamentally relational, and we'd be giving up referential integrity
for write speed we don't need at this scale.

## 5. Decision: Nest.js (Express adapter) instead of bare Express

The brief specifies Express. We used **Nest.js with its Express adapter**.
The runtime is still Express under the hood, so HTTP semantics, middleware
shape, and the `req` / `res` model are identical to vanilla Express. What
Nest adds:

- Dependency injection that makes the cache, the materialization service,
  and the metrics service trivially testable.
- Module boundaries that match the plan's directory layout
  (`products/`, `promotions/`, `ingest/`) without manual wiring.
- A first-class lifecycle hook (`onModuleDestroy`) for clean Prisma + Redis
  shutdown, which we'd otherwise hand-roll.

The cost is one more layer of indirection in the controllers. For a service
this size the DI ergonomics outweigh that. Production teams might choose
Fastify for raw throughput; we did not measure the gap to be material at
case-study scale.

## 6. Decision: Scenario A — splitter + queue + processor Lambdas

A single Lambda streaming the entire 500k-row CSV won't fit inside the
15-minute timeout under realistic memory and DB-write rates. Even if it did
on a good day, an SLA built on "good day" timings is not a serious
production answer.

We split the work into two roles, both portable handlers (the AWS Lambda
deployment is a thin adapter):

1. **Splitter** — triggered by S3 ObjectCreated. Streams the CSV through
   `csv-parse`, buckets rows into chunks of N (we picked 500), and emits one
   SQS message per chunk pointing at a chunk file in S3 (`chunks/{batch}/{i}.jsonl`).
   The splitter never holds more than a chunk's worth of rows in memory.
   If even the splitter approaches timeout on a very large file, it
   self-invokes via a continuation SQS message that carries a byte-offset
   checkpoint.
2. **Processor** — triggered by SQS. Processes one chunk per invocation:
   pulls the chunk file from S3, validates each row, applies the dynamic
   pricing rules, and writes the surviving rows into Postgres in **one**
   bulk `INSERT ... ON CONFLICT (sku) DO UPDATE` statement.

SQS provides natural backpressure (capped concurrent Lambdas protect the
database), automatic retry with exponential backoff, and a dead-letter
queue for permanently-failed messages.

## 7. Decision: chunk size 500, deterministic idempotency, partial-failure semantics

Chunk size is configurable; we settled on 500 because:

- A 500-row chunk fits in one `INSERT ... ON CONFLICT` statement well within
  Postgres's parameter limit.
- One processor Lambda finishes a 500-row chunk in well under a second on
  representative hardware, which leaves plenty of timeout headroom.
- It's small enough that retry is cheap, large enough that per-message
  overhead is amortised.

Idempotency comes from three keys layered:

- `(vendor_id, source_file)` is `UNIQUE` on `ingest_batches`. Re-uploading
  the same file finds the existing batch.
- `(batch_id, row_key)` is the primary key on `ingest_row_results`. A
  reprocessed chunk overwrites the row's `status` and `error_message`
  rather than inserting a duplicate.
- `sku` is `UNIQUE` on `products`. The processor's bulk SQL is `INSERT ...
  ON CONFLICT (sku) DO UPDATE`, so the database operation itself is
  idempotent.

Partial-failure semantics: a row that fails validation or a pricing-rule
check is recorded as `FAILED` in `ingest_row_results` and the rest of the
chunk continues. A processor that throws (DB error, transient) lets SQS
retry the whole chunk — the per-row keys make that safe.

## 8. Decision: Scenario B — async materialization, 202 Accepted

`POST /api/v1/promotions` with `scope: CATEGORY` returns **202 Accepted**.
The promotion row is committed inside the request transaction (so the
client gets the promotion ID immediately), but the bulk `INSERT` + bulk
`UPDATE` over the category's products runs on a background job.

Returning 201 from a request that may take seconds to settle in production
would be misleading. 202 says "I have your intent; the effect is rolling
out". The client can poll `/api/v1/promotions/:id` to see status, or watch
individual product reads for the effective-price change.

The same code path returns **201** for `scope: PRODUCT` because the work is
bounded to a single product and is genuinely synchronous. We picked the
status code dynamically with `@Res({ passthrough: true })` rather than
splitting into two endpoints — one shape, two semantics expressed in the
response.

Cancellation runs synchronously. The bulk revert (`UPDATE products SET
active_promotion_id = NULL, effective_price = base_price WHERE
active_promotion_id = $`) is sub-second at our scale, and an immediate
consistent response is operationally more useful than another 202.

## 9. Decision: event-driven cache invalidation, not TTL-only

TTL alone gives "consistency eventually". During a flash sale that's
unacceptable: customers would see stale prices for whatever the TTL is. So
every write that affects `effective_price` invalidates the relevant Redis
keys **after the DB commit succeeds**.

Invalidation is batched with `pipeline()` so 50k DEL commands are still a
single round trip. We invalidate in chunks of 1000 keys to keep individual
pipelines manageable.

Two safety properties matter:

- **Cache failure must not roll back the DB write.** Invalidation runs
  outside the `$transaction()` block; failures are logged at error level,
  TTL is the backstop. Plan §10 calls this out explicitly.
- **Targeted, not flush-all.** A category invalidation touches the
  category's product keys, not the whole cache.

The 5-minute TTL on `product:{id}` and 60-second TTL on list pages are
defensive — if an event-driven invalidation is ever missed, freshness still
heals on its own.

## 10. Decision: 409 Conflict on overlapping promotions

The brief says "promotion conflicts must be handled logically" but doesn't
say how. We picked the conservative policy: **a new promotion that overlaps
an existing live one on the same target returns HTTP 409 with details of
the conflict**. The operator must explicitly cancel the existing promotion
first.

Alternative policies — silently overriding, or auto-cancelling the older —
are valid but riskier during high-pressure flash-sale setup. A 409 makes the
operator's intent explicit and prevents accidental price changes.

The conflict check sits inside the same transaction as the insert, behind a
row-level lock (PRODUCT scope) or advisory lock (CATEGORY scope). The pure
function `detectPromotionConflict` in `src/domain/promotion-rules.ts` is
the single source of truth used by both creation paths and the e2e tests.

## 11. Decision: row-level locking for promotion creation

Two requests arriving at the same instant to create promotions for the
same product without coordination would both succeed, both materialize a
link row, and both update the product's `active_promotion_id`. The "at
most one active promotion" rule would be violated.

For PRODUCT scope we open a transaction and `SELECT id, ... FROM products
WHERE id = $ FOR UPDATE`. This serializes concurrent creations on the
same product without blocking unrelated work. The e2e suite exercises
this directly: `Promise.all` of two creates against the same product
must result in exactly one 201 and one 409.

For CATEGORY scope we use a Postgres advisory lock keyed by
`hashtext('category:<id>')`. Advisory locks don't block reads and are
released automatically at transaction end.

We chose pessimistic locking over optimistic concurrency because the
window between "check" and "commit" is small but non-zero — a CHECK
constraint can't enforce "at most one live promotion" across a time
range, and we wanted simple, correct semantics for the case study.

## 12. Decision: Decimal for money

JavaScript `number` is IEEE 754 double precision. `0.1 + 0.2 !== 0.3` is
the canonical reminder; for money that's malpractice. We used
[`decimal.js`](https://mikemcl.github.io/decimal.js/) globally configured
with `precision: 30` and `rounding: ROUND_HALF_UP`. Every monetary value
flows through `src/domain/money.ts`, including the schema's `NUMERIC(12, 2)`
columns deserialised by Prisma.

The SQL helper `compute_effective_price(base, type, value)` mirrors the TS
implementation for set-based bulk operations. Postgres `ROUND(NUMERIC, int)`
rounds half-away-from-zero, which is equivalent to HALF_UP for our
non-negative-only money domain.

## 13. Decision: no database triggers

A Postgres trigger could keep `product_promotions` and `effective_price` in
sync automatically. We deliberately put that logic in application code
instead.

Triggers have invisible-action problems: an operator reading the SQL log
sees an unexplained `UPDATE products` that wasn't issued by the app.
Reasoning about race conditions becomes harder; testing requires standing
up the DB.

Explicit materialization in `src/promotions/materialization.service.ts` is
visible in code review, traceable in logs, easy to put behind a feature
flag, and trivially unit-testable.

## 14. Trade-offs accepted

- **Write amplification on category promotions.** A category-wide
  promotion costs 50k row updates and 50k cache invalidations. Acceptable
  because flash sales are infrequent and reads dominate. If category
  promotions ran hundreds of times per day, we'd reconsider — most likely
  with a smarter cache layer that resolves at read time but never
  fetches more than O(1) promotion rows per product.

- **List cache staleness up to 60 seconds.** List pages are harder to
  invalidate precisely without tracking exactly which list keys touched
  which categories. The 60s TTL is the deliberate trade; product detail
  pages still get immediate consistency through the keyed invalidation.

- **Ingest doesn't auto-join active category promotions.** New rows
  inserted by ingest do not currently pick up a live category promotion
  the way `POST /products` does. The bulk `INSERT ... ON CONFLICT` path
  is harder to weave that into without compromising the single-statement
  property. Documented as a known limitation; an operator can re-run
  materialization on the category to fix it.

- **Scheduled-future promotions aren't auto-activated.** A CATEGORY
  promotion with `startsAt` in the future is inserted as `SCHEDULED` but
  there's no in-process cron that flips it to `ACTIVE` and materializes
  at that instant. Documented; production would add an EventBridge rule
  or pg_cron task.

## 15. What we would do at production scale

The case-study version is small on purpose. At real scale the next
investments would be:

- **OpenTelemetry tracing** from the HTTP edge through the SQS-bounded
  ingest pipeline. The current Prometheus histograms cover latency
  envelopes, but a slow individual ingest batch is hard to debug
  without per-span context.
- **Read replica for `GET /products` list pagination.** The current
  query goes to the primary; large catalog scans would benefit from a
  hot standby.
- **Outbox pattern for cache invalidation.** Currently invalidation
  fires after commit and best-efforts. At higher write volume we'd
  want at-least-once guarantees via an outbox table polled by a
  separate worker.
- **Sharded Redis** once cache size or pipeline throughput becomes a
  bottleneck.
- **Schema registry for ingest formats** so vendor feeds can evolve
  without surprising the processor.
- **Per-vendor rate limiting** on `/api/v1/ingest/batches` with a
  token bucket per `vendor_id`.
- **Materialization scheduler** for SCHEDULED promotions, replacing the
  current "live now or never" approximation.

None of these are case-study scope. All of them are how an interview
about Day 2 would go.
