# ModaCo Promotion Management API — Implementation Plan

> This document is the master plan for a backend case study. It will be given to Claude Code (or another AI coding agent) as the source of truth for implementation. The plan encodes deliberate architectural decisions that the AI should follow, not invent. Where the AI is likely to suggest something different, this document calls it out explicitly.

---

## Table of Contents

1. [Context and Grading Lens](#1-context-and-grading-lens)
2. [Non-Negotiable Architectural Principles](#2-non-negotiable-architectural-principles)
3. [Tech Stack (Final)](#3-tech-stack-final)
4. [High-Level Architecture](#4-high-level-architecture)
5. [Database Schema and DDL](#5-database-schema-and-ddl)
6. [Effective Price: The Core Domain Concept](#6-effective-price-the-core-domain-concept)
7. [API Endpoints](#7-api-endpoints)
8. [Scenario A: Massive Data Ingestion (Serverless)](#8-scenario-a-massive-data-ingestion-serverless)
9. [Scenario B: Flash Sales (Read/Write Distribution)](#9-scenario-b-flash-sales-readwrite-distribution)
10. [Caching Strategy and Invalidation](#10-caching-strategy-and-invalidation)
11. [Concurrency, Transactions, and the "One Active Promotion" Rule](#11-concurrency-transactions-and-the-one-active-promotion-rule)
12. [Observability](#12-observability)
13. [Testing Strategy](#13-testing-strategy)
14. [Project Structure](#14-project-structure)
15. [Implementation Order (Build Plan)](#15-implementation-order-build-plan)
16. [ADR.md Outline](#16-adrmd-outline)
17. [AI_APPENDIX.md Outline (Form 5)](#17-ai_appendixmd-outline-form-5)
18. [Common AI Mistakes to Watch For](#18-common-ai-mistakes-to-watch-for)
19. [Interview Talking Points](#19-interview-talking-points)

---

## 1. Context and Grading Lens

This is a take-home for a senior backend role. The brief explicitly states standard CRUD will not be accepted — Scenarios A and B are the core of the evaluation. Three things matter most:

1. **Architectural reasoning over feature completeness.** A working partial solution with clear ADR thinking beats a full CRUD app with no design depth.
2. **Operational realism.** Memory limits, timeouts, cache invalidation correctness, concurrency under load — these are the senior signals.
3. **Honest AI collaboration story.** Form 5 asks specifically what mistakes the AI made and how you corrected them. The interview will dig into this. We deliberately encode decisions in this plan that go against common AI defaults so the story is genuine.

**Time budget:** assume 16–24 hours of focused work spread across several days. Cut scope aggressively if running long — observability, full test coverage, and stretch endpoints can be trimmed. The two scenarios and the ADR cannot.

---

## 2. Non-Negotiable Architectural Principles

These principles override AI suggestions if there's conflict. Most AI defaults will violate at least one of them.

1. **Read path is denormalized.** The GET product detail endpoint reads from a precomputed projection that already contains the effective price. We do NOT compute discounts at read time by joining promotions. Reads must be cheap; complexity moves to write time.

2. **Cache is authoritative for hot reads.** Product detail responses are served from Redis. The database is a fallback. Cache invalidation is event-driven, not TTL-only. (TTL exists as a safety net, not the primary mechanism.)

3. **Promotion-to-product application is materialized.** When a category-level promotion is created, we materialize the (product_id, promotion_id) link rows in the database. We do NOT resolve "this product belongs to this category therefore this promotion applies" at read time across 50k products. This is the structural answer to Scenario B.

4. **"New product joins active category promotion" is an explicit hook.** Product creation/category-change checks for active category promotions and materializes the link synchronously. This is a deliberate write-time cost in exchange for read simplicity.

5. **Bulk ingest is streaming + chunked + idempotent.** The Lambda never holds the full file in memory. Records flow through a stream pipeline. The orchestration handles timeout by checkpointing and self-invoking continuation, or by using S3 event triggers per chunk.

6. **Idempotency is mandatory for ingest.** Vendor files can be retried. Every row has a deterministic key (SKU + vendor_batch_id) so re-running an ingest is safe.

7. **All writes that affect read views invalidate cache deterministically.** Cache keys are predictable; invalidation is targeted, not flush-all.

8. **No premature optimization, but no defaulting to naive patterns either.** We don't add Kafka. We do add structured concurrency, transactions where needed, and proper bulk operations.

---

## 3. Tech Stack (Final)

| Layer | Choice | Reasoning |
|---|---|---|
| Language | TypeScript (strict mode) | Required by brief |
| Runtime | Node.js 20 LTS | Stable, supported on Lambda |
| Framework | Express | Required by brief. (Note: would prefer NestJS/Fastify in real life; documented in ADR.) |
| Database | PostgreSQL 15+ | Strong consistency, JSONB, partial indexes, advisory locks |
| ORM | Prisma | Good DX, type safety, predictable SQL, raw query escape hatch |
| Cache | Redis 7 | Industry standard, supports pipelines, pub/sub for invalidation |
| Queue (Scenario A) | AWS SQS or in-process for local dev | Decouples Lambda invocations; durable |
| Serverless target | AWS Lambda (referenced as design target, implemented as portable handler) | Aligns with brief; Azure Functions equivalent works the same way |
| Validation | Zod | Schema validation at API boundary AND ingest boundary |
| Logging | Pino | Fast structured JSON |
| Testing | Jest + Supertest | Standard |
| Containerization | Docker + docker-compose | Local dev parity (Postgres + Redis + LocalStack for SQS optional) |

**Things deliberately not used and why (mention in ADR):**

- **Kafka:** overkill for one ingest workload at this scale; SQS suffices with simpler ops
- **MongoDB:** the data is relational; promotion-product links and consistency requirements favor Postgres
- **TypeORM:** Prisma's predictable generated SQL is easier to reason about for performance
- **GraphQL:** the brief asks REST; adding GraphQL is scope inflation
- **Elasticsearch:** the read pattern is keyed lookup + simple filtering; Postgres + Redis is sufficient

---

## 4. High-Level Architecture

```
                            ┌─────────────────────────┐
                            │       Client            │
                            └────────────┬────────────┘
                                         │
                                         ▼
                            ┌─────────────────────────┐
                            │   Express API           │
                            │  (read + write paths)   │
                            └──┬────────────┬─────────┘
                               │            │
                  Hot reads ──▶│            │──▶ Writes
                               ▼            ▼
                       ┌───────────┐   ┌───────────────┐
                       │  Redis    │   │  PostgreSQL   │
                       │  (cache)  │◀──┤  (source of   │
                       └───────────┘   │   truth)      │
                              ▲        └───────────────┘
                              │              ▲
                              │              │
                          invalidation   write completes
                              │              │
                              └──────────────┘

                 ──────────── Scenario A path ────────────

   ┌───────────┐   upload    ┌──────────┐   trigger    ┌────────────┐
   │  Vendor   │────────────▶│   S3     │─────────────▶│  Splitter  │
   │  (CSV)    │             │ (raw/)   │  ObjectPut   │  Lambda    │
   └───────────┘             └──────────┘              └─────┬──────┘
                                                             │ chunks of N rows
                                                             ▼
                                                       ┌──────────┐
                                                       │   SQS    │
                                                       └─────┬────┘
                                                             │
                                                             ▼
                                                       ┌────────────┐    DB
                                                       │  Processor │────▶
                                                       │  Lambda    │  (Postgres)
                                                       │  (N rows)  │
                                                       └────────────┘
```

Two independent paths:

- **Synchronous API:** Express handles product reads (cache-first), product writes, and promotion management. Cache invalidation is dispatched synchronously after DB commit.
- **Asynchronous ingest:** S3 → Splitter Lambda → SQS → Processor Lambdas. Each Lambda invocation processes a bounded chunk that fits within timeout and memory constraints.

---

## 5. Database Schema and DDL

```sql
-- Categories (small, slow-changing)
CREATE TABLE categories (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name            TEXT NOT NULL UNIQUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Products
CREATE TABLE products (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    sku             TEXT NOT NULL UNIQUE,
    name            TEXT NOT NULL,
    category_id     UUID NOT NULL REFERENCES categories(id),
    base_price      NUMERIC(12,2) NOT NULL CHECK (base_price >= 0),
    stock_quantity  INTEGER NOT NULL CHECK (stock_quantity >= 0),
    -- Denormalized read-view fields (updated on promotion changes):
    active_promotion_id  UUID NULL,
    effective_price      NUMERIC(12,2) NOT NULL,
    effective_price_updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Indexes supporting list endpoint (filter by category, sort by effective_price, paginate)
CREATE INDEX idx_products_category_effective_price 
    ON products (category_id, effective_price);
CREATE INDEX idx_products_effective_price 
    ON products (effective_price);
CREATE INDEX idx_products_active_promotion 
    ON products (active_promotion_id) WHERE active_promotion_id IS NOT NULL;

-- Promotions
CREATE TYPE discount_type AS ENUM ('PERCENTAGE', 'FIXED_AMOUNT');
CREATE TYPE promotion_scope AS ENUM ('PRODUCT', 'CATEGORY');
CREATE TYPE promotion_status AS ENUM ('SCHEDULED', 'ACTIVE', 'CANCELLED', 'EXPIRED');

CREATE TABLE promotions (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name            TEXT NOT NULL,
    discount_type   discount_type NOT NULL,
    discount_value  NUMERIC(12,2) NOT NULL CHECK (discount_value > 0),
    scope           promotion_scope NOT NULL,
    target_product_id   UUID NULL REFERENCES products(id),
    target_category_id  UUID NULL REFERENCES categories(id),
    starts_at       TIMESTAMPTZ NOT NULL,
    ends_at         TIMESTAMPTZ NOT NULL,
    status          promotion_status NOT NULL DEFAULT 'SCHEDULED',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Exactly one of target_product_id / target_category_id is set
    CONSTRAINT chk_promotion_target CHECK (
        (scope = 'PRODUCT'  AND target_product_id  IS NOT NULL AND target_category_id IS NULL) OR
        (scope = 'CATEGORY' AND target_category_id IS NOT NULL AND target_product_id  IS NULL)
    ),
    CONSTRAINT chk_promotion_dates CHECK (ends_at > starts_at)
);

CREATE INDEX idx_promotions_active_window 
    ON promotions (status, starts_at, ends_at) 
    WHERE status IN ('SCHEDULED', 'ACTIVE');
CREATE INDEX idx_promotions_target_category 
    ON promotions (target_category_id) WHERE target_category_id IS NOT NULL;

-- Materialized link: which promotion applies to which product
-- This table is what makes Scenario B fast: applying/cancelling a category
-- promotion is a bulk insert/delete here, not a recompute against 50k products.
CREATE TABLE product_promotions (
    product_id      UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    promotion_id    UUID NOT NULL REFERENCES promotions(id) ON DELETE CASCADE,
    applied_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (product_id, promotion_id)
);
CREATE INDEX idx_product_promotions_promotion 
    ON product_promotions (promotion_id);

-- "At most one active promotion per product" is enforced by a partial unique index
-- on the products.active_promotion_id field combined with application logic in a
-- transaction. The product_promotions table can hold scheduled-but-not-active links,
-- but only one becomes the current active_promotion_id on the product row.

-- Ingest tracking: idempotency for vendor batches
CREATE TABLE ingest_batches (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    vendor_id       TEXT NOT NULL,
    source_file     TEXT NOT NULL,
    status          TEXT NOT NULL,  -- 'PENDING'|'PROCESSING'|'COMPLETED'|'FAILED'
    total_rows      INTEGER,
    processed_rows  INTEGER NOT NULL DEFAULT 0,
    failed_rows     INTEGER NOT NULL DEFAULT 0,
    started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at     TIMESTAMPTZ NULL,
    UNIQUE (vendor_id, source_file)
);

CREATE TABLE ingest_row_results (
    batch_id        UUID NOT NULL REFERENCES ingest_batches(id) ON DELETE CASCADE,
    row_key         TEXT NOT NULL, -- e.g., SKU
    status          TEXT NOT NULL, -- 'OK'|'FAILED'|'SKIPPED'
    error_message   TEXT NULL,
    processed_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (batch_id, row_key)
);
```

**Notes on schema decisions:**

- `effective_price` lives on `products`. This is the projection that powers the hot read path.
- `product_promotions` is the materialized link that makes category-wide promotions cheap to apply and revoke.
- The "at most one active promotion per product" rule is enforced by application logic inside a transaction with row-level locking (`SELECT ... FOR UPDATE`), not a database constraint alone, because the rule involves time windows.
- All timestamps are `TIMESTAMPTZ`. Always.
- `NUMERIC(12,2)` for money, never `FLOAT`. This is a common AI mistake to watch for.

---

## 6. Effective Price: The Core Domain Concept

Effective price is computed once per (product, active promotion) and stored on the product row. It is recomputed only when:
- A new promotion becomes active for the product
- The active promotion is cancelled or expires
- The product's base price changes
- The product is moved to a different category that has an active promotion

**Computation:**

```typescript
function computeEffectivePrice(
  basePrice: Decimal,
  promotion: Promotion | null
): Decimal {
  if (!promotion) return basePrice;

  if (promotion.discountType === 'PERCENTAGE') {
    // discount_value is the percent off (e.g., 25 means 25%)
    const factor = new Decimal(1).minus(promotion.discountValue.div(100));
    const result = basePrice.times(factor);
    return Decimal.max(result, 0).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  } else {
    // FIXED_AMOUNT: subtract value, floor at 0
    const result = basePrice.minus(promotion.discountValue);
    return Decimal.max(result, 0).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  }
}
```

**Use a real decimal library (e.g., `decimal.js`). Never use JavaScript `number` for money.** This is a deliberate decision called out in the ADR. AI tools default to `number`; do not accept that.

**Promotion selection when multiple exist:**

The brief says "at most one active promotion at a time." But what happens when a product has both a product-level promotion and its category has an active category-level promotion? The rule has to be made explicit:

> **Resolution rule:** Product-level promotions take precedence over category-level promotions. If both exist and overlap in time, the product-level one is active; the category-level one is suppressed for that product until the product-level promotion ends.

This rule is documented in the ADR. Document it; don't let the AI invent a different one silently.

---

## 7. API Endpoints

All routes under `/api/v1`. JSON request/response. Zod validation on all inputs.

### Products

| Method | Path | Notes |
|---|---|---|
| GET | `/products` | Filter by `category_id`, sort by `effective_price` (asc/desc) or `name`, paginate with `cursor` (preferred) or `page`+`limit`. Default limit 20, max 100. |
| GET | `/products/:id` | Highest-traffic endpoint. Cache-first read. |
| POST | `/products` | Create. Auto-applies active category promotion if any (see Scenario B logic). |
| PATCH | `/products/:id` | Update name, base_price, stock. Recompute effective_price if base_price changed. |

**Cursor-based pagination** is preferred over offset/limit because offset over a large filtered set is slow and unstable. Document the choice in ADR.

**Sorting by effective_price** uses the denormalized column with the supporting index. This is what the brief is checking — naive sorting by computed value would require recomputing at query time.

### Promotions

| Method | Path | Notes |
|---|---|---|
| POST | `/promotions` | Create. If scope=CATEGORY and starts_at <= now, schedule immediate materialization job. |
| POST | `/promotions/:id/cancel` | Cancel. Triggers de-materialization and effective_price recompute for affected products. |
| GET | `/promotions/:id` | Get single. |
| GET | `/promotions` | List with filters: status, scope, target_*. |

**No PATCH on promotions.** Mutating an active promotion is a footgun; create a new one and cancel the old. Document in ADR.

### Ingest (admin-side)

| Method | Path | Notes |
|---|---|---|
| POST | `/ingest/batches` | Register a new vendor batch. Returns presigned S3 upload URL OR accepts file reference. |
| GET | `/ingest/batches/:id` | Status, progress, failed rows. |

### Operational

| Method | Path | Notes |
|---|---|---|
| GET | `/health` | Liveness. |
| GET | `/ready` | DB + Redis check. |
| GET | `/metrics` | Prometheus. |

---

## 8. Scenario A: Massive Data Ingestion (Serverless)

This is the first scenario the interview will focus on. The naive AI default — "use Node streams in one Lambda" — fails because of timeout. The correct design uses orchestration.

### Constraints recap

- Lambda hard timeout: 15 minutes (AWS) / 10 minutes (Azure consumption)
- Memory: configurable but bounded; we target 512 MB
- Stateless: nothing in process memory survives between invocations
- File: 500,000+ rows
- Every row must pass through application-layer dynamic pricing rules before being saved

### Design: split + fan-out + idempotent processors

**Step 1 — Upload.**
Vendor uploads CSV to S3 bucket `modaco-ingest/raw/`.

**Step 2 — Splitter Lambda.**
Triggered by S3 ObjectCreated event. Its sole job is to split the file into chunks and emit messages.

- Streams the CSV using `csv-parse` in stream mode — never reads the whole file into memory
- Buckets rows into chunks of N (start with N=500 rows per chunk; tunable)
- For each chunk: writes the chunk to `modaco-ingest/chunks/{batch_id}/{chunk_index}.jsonl` and emits an SQS message `{batch_id, chunk_s3_key, chunk_index}`
- Creates the `ingest_batches` row with total_rows count and status=PROCESSING
- If the splitter itself approaches timeout (large file), it writes a checkpoint (last byte offset processed) and self-invokes via SQS continuation message; the next invocation resumes from the checkpoint. **This is the answer to "what if even the splitter takes too long."**

**Step 3 — Processor Lambda.**
Triggered by SQS. Processes one chunk per invocation.

- Reads the chunk file from S3 (small: a few hundred rows, fits trivially in memory)
- For each row: validates with Zod, applies dynamic pricing rules, then upserts the product
- Uses **batched database operations** (a single bulk upsert per chunk, not 500 individual queries)
- Records per-row results in `ingest_row_results` for observability and debugging
- Atomically increments `ingest_batches.processed_rows`
- On retryable error (DB timeout, transient): throws so SQS retries with backoff
- On non-retryable error (validation): records row as FAILED, does not throw — partial chunk success is fine

**Step 4 — Completion.**
When `processed_rows + failed_rows = total_rows`, mark batch COMPLETED. This is checked atomically at the end of each chunk processor.

### Why this design

| Concern | How it's addressed |
|---|---|
| Timeout | Each Lambda invocation does bounded work; orchestration is across many short invocations |
| Memory | Streaming in splitter; small chunks in processor |
| Stateless | All progress in S3 + Postgres + SQS; no in-process state |
| Idempotency | `(vendor_id, source_file)` UNIQUE on batch; `(batch_id, row_key)` PK on row_results; row processing uses ON CONFLICT DO UPDATE keyed on SKU |
| Partial failure | Row-level result tracking; failed rows queryable later; batch can be retried for only failed rows |
| Backpressure | SQS naturally limits concurrent Lambdas; configure max concurrency to protect DB |
| Cost | No always-on workers; pay per-invocation |

### What we explicitly do NOT do (and why)

- **Do not parse the whole file in one Lambda.** Common AI suggestion. Fails on 500k rows due to timeout and memory.
- **Do not use a single long-running Lambda with streams within one invocation.** Streams help memory but not timeout. The point is timeout protection across invocations.
- **Do not insert row-by-row.** A 500-row chunk should be one SQL statement (bulk upsert).
- **Do not skip idempotency.** Vendor retries are a real operational concern.

### Local development without AWS

Provide an Express endpoint `POST /ingest/test` that reads a local file path and invokes the same processor logic in-process, looping over chunks synchronously. This is for local dev only; production path is the Lambda one. The processor logic is shared code that has no AWS dependency at its core — the AWS layer is a thin adapter. Document this in ADR as a deliberate portability choice.

---

## 9. Scenario B: Flash Sales (Read/Write Distribution)

The naive AI default — "add Redis cache" — only solves half the problem. The other half is what happens when a flash sale creates 50,000 product-promotion links instantly and what happens when a new product joins the category mid-sale.

### Two sub-problems

**B1: Apply a category-wide promotion to 50,000 products fast, without blocking the storefront.**

**B2: Keep newly created products in the category benefiting from the active sale automatically.**

### B1: Materialization on promotion creation

When a `POST /promotions` arrives with scope=CATEGORY and the start time is now or near-now:

1. Insert the promotion row (status=ACTIVE if start <= now, else SCHEDULED)
2. Enqueue an async job: `applyCategoryPromotion(promotionId)`
3. Return 202 Accepted to the client with the promotion ID

The job runs in a background worker (or, in serverless: a Lambda triggered by the queue):

```sql
-- Step 1: bulk insert links (single statement, scales to 50k+)
INSERT INTO product_promotions (product_id, promotion_id)
SELECT p.id, $1
FROM products p
WHERE p.category_id = $2
ON CONFLICT DO NOTHING;

-- Step 2: bulk update effective_price for affected products
-- (only those where this promotion now wins per the resolution rule)
UPDATE products
SET active_promotion_id = $1,
    effective_price = compute_effective_price(base_price, $1),
    effective_price_updated_at = now()
WHERE category_id = $2
  AND (
    active_promotion_id IS NULL
    OR active_promotion_id NOT IN (
        -- product-level promotions outrank category-level
        SELECT id FROM promotions
        WHERE scope = 'PRODUCT' AND status = 'ACTIVE'
          AND starts_at <= now() AND ends_at > now()
    )
  );

-- Step 3: invalidate cache (batched)
-- See Caching section
```

The `compute_effective_price` can be a SQL function, or the update can join against a CTE that computes it. Using a SQL function keeps the read query simple.

**Why this is fast:**
- One INSERT statement for 50,000 rows (not 50,000 statements)
- One UPDATE statement
- Indexes on `category_id` and `active_promotion_id` make both operations index-scanned
- Cache invalidation is keyed and batched, not flush-all

**Why not do this synchronously inside the POST request:**
- A 50k-row update can take seconds; clients shouldn't wait
- 202 Accepted with a status endpoint is the right pattern
- If the update fails, the promotion is still recorded and can be retried

### B2: New product auto-joins active category promotion

In the `POST /products` handler, inside the same transaction as the product insert:

```sql
BEGIN;

-- Insert the product
INSERT INTO products (..., effective_price) VALUES (..., $base_price) RETURNING id;

-- Find an active category-level promotion for this category
WITH active_promo AS (
    SELECT id, discount_type, discount_value
    FROM promotions
    WHERE scope = 'CATEGORY'
      AND target_category_id = $category_id
      AND status = 'ACTIVE'
      AND starts_at <= now() AND ends_at > now()
    ORDER BY created_at DESC
    LIMIT 1
)
-- If found, materialize the link AND update the product's effective_price
-- (done in application code after this query, with the computed value)

COMMIT;
```

The application then computes effective_price and updates the product row, all in the same transaction. Cache write happens after commit.

**Important:** the check for an active product-level promotion (which would outrank) is unnecessary here because the product was just created — it can't already have a product-level promotion.

### What we explicitly do NOT do

- **Do not "join promotions at read time."** Tempting because it's simpler code, but it kills the read path under load. We materialize on write.
- **Do not write-through cache only.** We use write-through for product detail and write-around with invalidation for list queries. (See Caching section.)
- **Do not use a database trigger to materialize.** Tempting, but invisible logic in triggers makes the system harder to reason about and harder to operate. Materialization is explicit in application code. Document this in ADR.

---

## 10. Caching Strategy and Invalidation

### Read paths

**GET /products/:id** — hot path, cache-first:

```
1. Check Redis key: product:{id}
2. If hit: return immediately
3. If miss: 
   a. Read from Postgres
   b. SETEX product:{id} with TTL=300s (safety net)
   c. Return
```

**GET /products (list)** — also cached, with parameterized keys:

```
Key: products:list:{cat=X}:{sort=effective_price_asc}:{cursor=Y}:{limit=Z}
TTL: 60s (shorter because invalidation is harder for lists)
```

List cache TTL is short on purpose: targeted invalidation of list pages on every product update is expensive. The 60s TTL is the tradeoff — slightly stale lists are acceptable; the brief doesn't require real-time list freshness.

### Write paths (invalidation)

Cache invalidation runs **after** the DB commit succeeds. If invalidation fails, log loudly but don't roll back the write — TTL is the safety net.

| Write event | Cache invalidation |
|---|---|
| Product updated | DEL `product:{id}`; flush list cache by category prefix |
| Product created | flush list cache by category prefix |
| Promotion created (PRODUCT scope) | DEL `product:{target_product_id}`; flush list cache by that product's category |
| Promotion created (CATEGORY scope) | After materialization completes: pipeline DEL for all affected `product:{id}` keys (in batches of 1000); flush list cache by category prefix |
| Promotion cancelled | Same as creation, in reverse |

**Implementation detail:** use Redis pipelines for batch invalidation. 50,000 DEL commands in a pipeline is ~milliseconds; 50,000 individual round trips would be unacceptable.

**Why TTL alone isn't enough:** TTL gives consistency *eventually*. But during a flash sale, "eventually" is too long — users would see stale prices. Event-driven invalidation gives near-immediate consistency. TTL is the fallback for bugs and missed events.

### What we explicitly do NOT do

- **Do not use cache-aside without invalidation.** Pure TTL caching is the AI default; it gives unacceptable staleness during sales.
- **Do not invalidate inside the DB transaction.** If the cache call fails, we don't want to roll back the DB. Invalidate after commit.
- **Do not FLUSHALL or FLUSHDB on writes.** Tempting under deadline pressure, but it destroys cache hit rate for unrelated keys.

---

## 11. Concurrency, Transactions, and the "One Active Promotion" Rule

### The race condition

Two requests arrive simultaneously:
- Request 1: create product-level promotion P1 for product X (active immediately)
- Request 2: create product-level promotion P2 for product X (active immediately)

Without coordination, both might succeed and X ends up with two active promotions, violating the rule.

### Resolution: row-level locking on the product

When creating a product-scoped promotion (or activating a category-scoped one that affects a specific product):

```sql
BEGIN;
-- Lock the product row
SELECT id, active_promotion_id FROM products WHERE id = $product_id FOR UPDATE;

-- Check: does the product already have an active promotion?
-- If yes, return an error (or cancel the existing one if business says so — clarify in ADR)

-- Insert the promotion
INSERT INTO promotions (...) VALUES (...) RETURNING id;

-- Update the product row with new active_promotion_id and new effective_price
UPDATE products SET active_promotion_id = $new_promo_id, effective_price = $new_price WHERE id = $product_id;

COMMIT;
```

`FOR UPDATE` serializes promotion creation for the same product without locking unrelated work.

### For category-scoped promotions

The materialization job acquires an advisory lock on the category to prevent two concurrent category promotions from interleaving:

```sql
SELECT pg_advisory_xact_lock(hashtext('category:' || $category_id));
```

Advisory locks are released automatically at transaction end. They don't block reads.

### Document the chosen resolution rule

The brief says "promotion conflicts must be handled logically" but doesn't say *how*. Make the choice and document it in ADR:

> **Conflict policy:** When a new promotion would conflict with an existing active one on the same product (directly or via category), the request returns 409 Conflict with details of the existing promotion. We do NOT silently override. Operators must explicitly cancel the existing promotion first. This prevents accidental overwrites during high-pressure flash sale setup.

(Alternative policies are valid; the point is choosing and defending one explicitly.)

---

## 12. Observability

| Concern | Implementation |
|---|---|
| Structured logging | Pino with request_id middleware; propagate request_id through queue jobs |
| HTTP metrics | prom-client histogram on route + status code |
| Cache metrics | Counter: hits, misses, invalidations |
| Ingest metrics | Gauge: batches in flight; counter: rows processed, rows failed |
| Promotion metrics | Counter: promotions created, materializations completed, materialization duration |
| Errors | Surface via /metrics + log at error level with stack |
| Health | /health (process) and /ready (DB + Redis ping) |

**Note for the interview:** observability is the easiest section to cut if running short on time. Cover logging + /health + /ready as a minimum. Mention what else you would add in the ADR.

---

## 13. Testing Strategy

Coverage targets are intentionally not "100%". Focus on the high-value tests.

### Must-have tests

1. **Effective price computation** — pure function, table-driven tests across PERCENTAGE/FIXED_AMOUNT, zero floor, rounding edges
2. **Promotion conflict resolution** — concurrent creation tests using `Promise.all` against a real DB (testcontainers or a docker-compose Postgres)
3. **Category promotion materialization** — seed N products in a category, create promotion, assert all linked + effective_price updated
4. **Ingest processor** — given a chunk file, processes idempotently; re-running has no extra effect
5. **Cache invalidation** — write triggers DEL on expected keys
6. **API contract** — supertest against routes; sorting by effective_price returns correct order

### Skip (and say so in ADR)

- Frontend-style E2E tests
- Load tests in the deliverable itself (mention expected behavior in ADR)
- 100% line coverage chasing

---

## 14. Project Structure

```
modaco-promotion-api/
├── README.md
├── ADR.md
├── AI_APPENDIX.md
├── docker-compose.yml
├── Dockerfile
├── package.json
├── tsconfig.json
├── prisma/
│   ├── schema.prisma
│   └── migrations/
├── src/
│   ├── main.ts                     # Express bootstrap
│   ├── app.ts                      # Wiring, middleware
│   ├── config/
│   │   ├── env.ts                  # Zod-validated env config
│   │   └── logger.ts
│   ├── domain/                     # Pure domain logic, no I/O
│   │   ├── money.ts                # Decimal helpers
│   │   ├── effectivePrice.ts
│   │   └── promotionRules.ts       # Conflict resolution, precedence
│   ├── products/
│   │   ├── products.routes.ts
│   │   ├── products.service.ts
│   │   ├── products.repository.ts
│   │   └── products.dto.ts
│   ├── promotions/
│   │   ├── promotions.routes.ts
│   │   ├── promotions.service.ts
│   │   ├── promotions.repository.ts
│   │   ├── materialization.service.ts   # Scenario B core
│   │   └── promotions.dto.ts
│   ├── ingest/
│   │   ├── ingest.routes.ts            # Admin endpoints
│   │   ├── splitter.handler.ts         # Lambda handler
│   │   ├── processor.handler.ts        # Lambda handler
│   │   ├── ingest.service.ts           # Shared processing logic
│   │   └── pricingRules.ts             # Dynamic pricing rules
│   ├── cache/
│   │   ├── cache.client.ts
│   │   ├── keys.ts                     # All cache key builders
│   │   └── invalidation.ts             # Invalidation handlers
│   ├── infra/
│   │   ├── prisma.ts
│   │   ├── redis.ts
│   │   ├── sqs.ts
│   │   └── s3.ts
│   └── shared/
│       ├── errors.ts
│       ├── middleware.ts
│       └── pagination.ts               # Cursor pagination helpers
├── tests/
│   ├── unit/
│   ├── integration/
│   └── fixtures/
└── scripts/
    ├── seed.ts                         # Seed categories + sample products
    └── generate-large-csv.ts           # Generate a 500k row test file
```

**Domain layer is pure.** No Prisma imports in `domain/`. This makes effective price logic, conflict resolution, and pricing rules trivially testable.

---

## 15. Implementation Order (Build Plan)

Roughly mapped to time. Cut from the bottom if running short.

### Phase 1 — Foundation (3–4h)
1. Repo init, TypeScript strict mode, ESLint/Prettier, Jest
2. docker-compose: Postgres + Redis
3. Prisma schema (from section 5)
4. First migration
5. Pino logger, env config with Zod
6. Express app skeleton with /health and /ready

### Phase 2 — Domain core (2–3h)
1. `domain/money.ts` with Decimal helpers + tests
2. `domain/effectivePrice.ts` with full test coverage
3. `domain/promotionRules.ts` (precedence, conflict detection)

### Phase 3 — Products + Promotions APIs (4–5h)
1. Product CRUD with cursor pagination, sort by effective_price
2. Cache-first GET /products/:id
3. Promotion creation (PRODUCT scope) with row-level locking
4. Promotion cancellation with effective_price recompute
5. Integration tests for the conflict rule

### Phase 4 — Scenario B (3–4h)
1. Category-scope promotion creation returning 202
2. Materialization service: bulk INSERT + bulk UPDATE
3. Cache invalidation via Redis pipeline
4. New-product auto-join on POST /products
5. Tests: 1000-product category, verify all linked and prices updated

### Phase 5 — Scenario A (3–4h)
1. Pricing rules module with a small set of example rules
2. Processor service (pure, no AWS) operating on a row chunk
3. Splitter logic operating on a stream
4. Lambda handler wrappers
5. Local dev endpoint that runs splitter+processor synchronously
6. Idempotency tests
7. Generate 500k-row test file, run end-to-end

### Phase 6 — Observability and polish (1–2h)
1. /metrics endpoint
2. Request id middleware
3. Cache hit/miss counters

### Phase 7 — Documents (2–3h)
1. ADR.md
2. AI_APPENDIX.md
3. README with how to run, architecture diagram, screenshots/curl examples

---

## 16. ADR.md Outline

The ADR is one of the two artifacts the brief explicitly grades. It should be ~1500–2500 words. Structure:

1. **Context** (1 paragraph): what we're building, what the constraints are
2. **Decision: Denormalized effective_price** — why precompute, alternatives considered, tradeoffs
3. **Decision: Materialized product_promotions table** — why, vs computing at read time
4. **Decision: PostgreSQL + Redis (no Kafka, no Mongo)** — why this combo
5. **Decision: Express + Prisma** — required by brief; honest note about Fastify/NestJS preference
6. **Decision: Scenario A — splitter + SQS + processor Lambdas** — why not a single streaming Lambda
7. **Decision: Scenario A — chunk size, idempotency strategy, error handling** — concrete tradeoffs
8. **Decision: Scenario B — async materialization with 202 Accepted** — why not synchronous in the request
9. **Decision: Scenario B — event-driven cache invalidation, not TTL-only** — why
10. **Decision: Conflict resolution policy** — 409 over silent override, with rationale
11. **Decision: Row-level locking for promotion creation** — why this over optimistic concurrency
12. **Decision: Decimal for money** — never floats
13. **Decision: No DB triggers** — explicit application logic instead
14. **Trade-offs accepted**:
    - Write amplification: a category-wide promotion costs 50k+ row updates. Acceptable because flash sales are infrequent and reads dominate.
    - List cache staleness up to 60s. Acceptable per brief; documented.
    - Effective price requires backfill if pricing rule changes. Out of scope; documented.
15. **What we would do at production scale**:
    - OpenTelemetry tracing
    - Read replica for /products list
    - Sharded Redis if cache size grows
    - Outbox pattern for cache invalidation if at-least-once guarantees needed
    - Token bucket rate limiting per vendor
    - Schema registry for ingest formats

---

## 17. AI_APPENDIX.md Outline (Form 5)

This document is what the interviewer will probe hardest. Write it honestly. Some of the "AI mistakes" listed below in section 18 are real and will become genuine material here. **Do not fabricate AI mistakes** — interviewers can tell.

Structure:

1. **Tools used**
   - Claude (specific model, e.g., Opus) for architecture discussion and most code generation
   - GitHub Copilot for line-level autocomplete inside the IDE
   - Be specific: don't say "AI." Say which tool for which purpose.

2. **The 2 most critical prompts**
   - Prompt 1: the system design framing prompt where you set up the constraints and asked for an architecture for Scenario A
   - Prompt 2: the prompt where you asked for the Scenario B materialization SQL and cache invalidation strategy
   - Include the actual text of these prompts (or close paraphrases). The interviewer is checking if you can prompt well.

3. **The most significant AI mistake and how it was corrected**
   - Pick a real one. Section 18 below lists likely candidates.
   - Describe: what the AI suggested, why it was wrong, how you noticed, what you did instead, what tests confirmed the fix.
   - This is the single highest-leverage paragraph in the entire submission.

4. **Other notable corrections** (briefly)
   - 2–3 smaller examples to show the pattern of vigilant collaboration

5. **Where AI was genuinely helpful**
   - Boilerplate, test scaffolding, refactoring suggestions
   - Be honest. Pretending AI did nothing is as bad as pretending it did everything.

---

## 18. Common AI Mistakes to Watch For

These are real failure patterns to watch for during implementation. Each one is a candidate for the AI_APPENDIX error-correction story.

1. **Computing effective_price at query time via JOIN.** AI loves clean normalized schemas. This kills Scenario B performance. Catch it: the read path must go through the denormalized column.

2. **Using `number` for money.** AI defaults to it. Catch it: any `price * (1 - discount/100)` in plain JS is wrong.

3. **Loading the CSV into memory.** AI will write `fs.readFileSync` or `csv-parse` with the whole-file API. Catch it: must use stream mode.

4. **Doing 50,000 individual INSERTs in materialization.** AI will write a loop with `await prisma.productPromotion.create(...)`. Catch it: must be a single SQL statement.

5. **Trigger-based materialization.** AI may suggest a Postgres trigger to maintain `product_promotions`. Catch it: hard to operate, invisible logic, document the rejection.

6. **TTL-only caching.** AI may suggest "just set a 60s TTL and don't worry about invalidation." Catch it: unacceptable staleness during flash sales.

7. **Invalidating cache inside the DB transaction.** AI may put `redis.del()` inside the `prisma.$transaction` callback. Catch it: cache failure shouldn't roll back DB writes; do it after commit.

8. **Forgetting idempotency on ingest.** AI will write a happy-path processor. Catch it: vendor retries are a real concern; need deterministic keys and ON CONFLICT.

9. **Using offset/limit pagination.** AI default. Catch it: cursor-based is correct for large filtered sets sorted by mutable fields.

10. **Single long-running Lambda assumption.** AI may design "one Lambda streams the file." Catch it: works for memory, fails on timeout for 500k rows; needs orchestration.

11. **Synchronous materialization inside POST /promotions.** AI default. Catch it: 50k-row update in a request handler is unacceptable; return 202.

12. **Missing locking in promotion creation.** AI will write the create flow without `FOR UPDATE`. Catch it: race conditions on the "one active promotion" rule.

13. **Float comparison or non-deterministic rounding.** Catch it: explicit Decimal.ROUND_HALF_UP, floor at zero.

14. **Resolving promotion precedence inconsistently.** AI may resolve product-vs-category precedence differently in different code paths. Catch it: one shared `domain/promotionRules.ts` function used everywhere.

15. **Plain `console.log` instead of structured logging.** Catch it: Pino throughout, request_id propagated.

**For the AI_APPENDIX, pick the one that genuinely happened to you and write about it specifically.**

---

## 19. Interview Talking Points

Have these ready. Most are 60–90 seconds spoken.

1. **"Why did you denormalize effective_price?"**
   The read path is the hot path — GET product detail is the most-trafficked endpoint per the brief. Computing discounts at read time means joining promotions, applying precedence rules, and computing per request. That cost compounds during flash sales when reads spike. Denormalizing moves the work to write time, which is rare and bounded. The tradeoff is a recomputation cost when promotions change, which I handle with materialization jobs.

2. **"Why a materialized product_promotions table for category promotions?"**
   Scenario B says a category-wide promotion instantly affects 50,000 products. Without materialization, every product read would need to evaluate "is there a category promotion active for this product's category and does it outrank any product-level promotion?" That's expensive at read time. Materializing means promotion creation is a heavier write — one INSERT and one UPDATE statement — but reads stay cheap.

3. **"How did you handle the new-product-joins-active-sale requirement?"**
   In the POST /products handler, inside the same transaction as the insert, I check for an active category-level promotion for the new product's category. If one exists, I materialize the link and compute effective_price right there. The whole thing is one transaction. Cache write follows commit. The alternative — a database trigger — works but hides logic that operators need to reason about.

4. **"Why did you split Scenario A into multiple Lambdas?"**
   A single Lambda can't process 500k rows within the 15-minute timeout under realistic memory limits. So the unit of work has to be smaller than what one Lambda can do. I split into a Splitter — which streams the file and emits chunk messages to SQS — and a Processor — which handles one chunk per invocation. SQS gives natural backpressure, retries, and lets me scale Processor concurrency to protect the database.

5. **"How does the system handle ingest retries?"**
   Three layers. The batch has a unique key of (vendor_id, source_file), so re-running the same file finds the existing batch instead of starting a new one. Per-row results are keyed by SKU, so reprocessing a chunk doesn't create duplicates. And the actual product upsert uses ON CONFLICT (sku) DO UPDATE, so the database operation itself is idempotent.

6. **"Why event-driven cache invalidation and not just TTL?"**
   TTL is consistency-eventually. During a flash sale, "eventually" is too long — users would see stale prices. So I invalidate keys explicitly on every relevant write, batched in a Redis pipeline. TTL stays as a safety net for bugs or missed invalidations. The 60-second list cache TTL is a deliberate choice: lists are harder to invalidate precisely, and slightly-stale lists are acceptable while detail pages need to be fresh.

7. **"What's the biggest tradeoff you made?"**
   Write amplification for category promotions. Applying a 50k-product category promotion costs 50k product row updates and 50k cache invalidations. That's a heavy write. I accepted it because flash sales are infrequent events while reads are constant. If category promotions became more frequent — say, hundreds per day — I'd reconsider, probably by switching to a read-time resolution with a much smarter cache layer.

8. **"What did the AI get wrong?"**
   *(Use the real one from your build experience. Section 18 has the likely candidates.)*

9. **"What would you change at production scale?"**
   A few things. Add OpenTelemetry tracing — the boundary between API and queue is the hardest part to debug without it. Add a read replica for the list endpoint once query volume justifies it. Switch from in-process cache invalidation to an outbox pattern if at-least-once delivery guarantees become important. And add per-vendor rate limiting on the ingest endpoint with a token bucket.

10. **"What would you NOT do that the brief might tempt you toward?"**
    I wouldn't add Kafka. The ingest workload has one producer, one consumer pattern, and infrequent batches. SQS is simpler to operate and meets every requirement. Kafka would be résumé-driven architecture.

---

## Final Note to Future Self (or the AI Implementing This)

This plan is opinionated. If the AI implementing it suggests a different approach, the burden of proof is on the suggestion — every decision here has a reason. If you discover during implementation that a decision is wrong, change it deliberately and update the ADR with the new reasoning. Plans that don't evolve are plans that stopped being useful. Plans that get abandoned silently are plans that fail interviews.
