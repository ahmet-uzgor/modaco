# ModaCo Promotion Management API

Backend service for the ModaCo take-home: products, categories, promotions
(product- and category-scoped), bulk vendor ingest, and Prometheus
observability. The architectural decisions are documented in
[ADR.md](ADR.md); the AI collaboration story is in [AI_APPENDIX.md](AI_APPENDIX.md);
the original brief and build plan live in
[modaco-implementation-plan.md](modaco-implementation-plan.md).

## Highlights

- **Denormalized `effective_price`** on `products` for cheap reads; recomputed
  on write via a SQL helper that mirrors the TypeScript domain rules.
- **Materialized `product_promotions` link table** so a flash-sale CATEGORY
  promotion is one `INSERT ... SELECT` + one `UPDATE`, not 50,000 statements.
- **`POST /promotions` returns 202 Accepted** for CATEGORY scope; the
  materialization runs on an in-process JobRunner (Lambda + SQS in
  production).
- **Row-level locking** on PRODUCT-scope promotion creation,
  advisory locks on CATEGORY-scope; "at most one active promotion per
  product" survives concurrent writes. E2E tests prove the conflict
  rule with `Promise.all`.
- **Streaming, chunked, idempotent ingest pipeline** modelled after the
  splitter→queue→processor pattern in the plan.
- **Event-driven Redis cache invalidation** in pipelined batches; TTL is
  the safety net.
- **Prometheus `/metrics`** exposing HTTP latency histograms, cache
  hit/miss/invalidate counters, ingest counters, promotion-create
  counters, and materialization duration histograms.

## Architecture

```
                              ┌──────────────────────┐
                              │       Client         │
                              └──────────┬───────────┘
                                         │
                                         ▼
                  ┌──────────────────────────────────────────┐
                  │   Nest.js API (Express adapter)          │
                  │   • categories  • products  • promotions │
                  │   • ingest      • metrics                │
                  └──┬──────────────────────────────┬────────┘
        hot reads ──▶│                              │──▶ writes
                     ▼                              ▼
              ┌────────────┐               ┌────────────────┐
              │   Redis    │               │   PostgreSQL   │
              │   cache    │◀──────────────│ (source of     │
              │ pipelined  │ invalidation  │  truth)        │
              │   DEL      │ after commit  └────────────────┘
              └────────────┘                          ▲
                                                      │
                                  ┌───────────────────┴──────────┐
                                  │   JobRunner (in-process)     │
                                  │   • CATEGORY materialization │
                                  │   • ingest batch processing  │
                                  └──────────────────────────────┘

                ───── Production-shaped ingest path (modeled, not deployed) ─────

   ┌─────────┐  upload  ┌──────────┐  S3:ObjectCreated  ┌────────────┐
   │ Vendor  │─────────▶│   S3     │───────────────────▶│  Splitter  │
   │  (CSV)  │          │ raw/...  │                    │  Lambda    │
   └─────────┘          └──────────┘                    └─────┬──────┘
                                                              │ chunks of N
                                                              ▼
                                                        ┌──────────┐
                                                        │   SQS    │
                                                        └─────┬────┘
                                                              │
                                                              ▼   bulk UPSERT
                                                        ┌─────────────┐ ─▶
                                                        │  Processor  │
                                                        │   Lambda    │   Postgres
                                                        │  (N rows)   │
                                                        └─────────────┘
```

## Quick start

### Prerequisites

- Node.js ≥ 20
- Docker + Docker Compose
- npm

### Bring it up

```bash
# 1. Install dependencies
npm install

# 2. Copy and (optionally) edit the env file
cp .env.example .env

# 3. Start Postgres + Redis
npm run db:up

# 4. Apply migrations (init + the compute_effective_price SQL helper)
npx prisma migrate deploy

# 5. Generate the Prisma client
npx prisma generate

# 6. Run the API (watch mode)
npm run start:dev
```

The API is now serving on `http://localhost:3000` with the global prefix
`/api/v1` (with `/health`, `/ready`, and `/metrics` outside the prefix).

### Tests

```bash
npm test              # 63 unit tests (pure domain + pricing rules + splitter)
npm run test:e2e      # 17 e2e tests (against the docker-compose Postgres in modaco_test DB)
```

E2E tests need Postgres + Redis running. Global setup auto-creates the
`modaco_test` database, runs migrations against it, and parks Redis on
DB 15 so the dev cache is never flushed.

## Configuration

All env vars are validated with Zod at boot (`src/config/env.ts`). Missing
or malformed values fail fast with an error pointing to the bad keys.

| Variable             | Default                                                 | Notes                                       |
| -------------------- | ------------------------------------------------------- | ------------------------------------------- |
| `NODE_ENV`           | `development`                                           | `development` enables pretty logs.          |
| `PORT`               | `3000`                                                  |                                             |
| `LOG_LEVEL`          | `info`                                                  | Pino levels: `trace`/`debug`/`info`/`warn`/`error`/`fatal`. |
| `DATABASE_URL`       | `postgresql://modaco:modaco@localhost:5432/modaco?...`  | Pointed at the docker-compose Postgres.     |
| `REDIS_HOST`         | `localhost`                                             |                                             |
| `REDIS_PORT`         | `6379`                                                  |                                             |
| `REDIS_PASSWORD`     | _(empty)_                                               | Optional.                                   |
| `REDIS_DB`           | `0`                                                     | E2E tests force this to `15`.               |
| `INGEST_DIR`         | `/tmp/modaco-ingest`                                    | Files must live under here; no traversal.   |
| `INGEST_CHUNK_SIZE`  | `500`                                                   | Rows per chunk in the splitter.             |

## API

All routes under `/api/v1` except `/health`, `/ready`, `/metrics`.

### Health and observability

```bash
curl http://localhost:3000/health       # liveness — no deps checked
curl http://localhost:3000/ready        # readiness — pings Postgres + Redis
curl http://localhost:3000/metrics      # Prometheus text exposition
```

### Categories

```bash
# Create
curl -X POST http://localhost:3000/api/v1/categories \
  -H 'content-type: application/json' \
  -d '{"name":"Footwear"}'

# List
curl http://localhost:3000/api/v1/categories
```

### Products

```bash
# Create (auto-joins any live CATEGORY promotion on this category)
curl -X POST http://localhost:3000/api/v1/products \
  -H 'content-type: application/json' \
  -d '{
    "sku":"SNK-001",
    "name":"Runner",
    "categoryId":"<category-uuid>",
    "basePrice":"100.00",
    "stockQuantity":10
  }'

# Get one (cache-first; misses populate the cache with a 5-minute TTL)
curl http://localhost:3000/api/v1/products/<product-uuid>

# Cursor-paginated list, sort by effective_price, filter by category
curl "http://localhost:3000/api/v1/products?categoryId=<cat>&sort=effective_price&direction=asc&limit=20"

# Walk next page
curl "http://localhost:3000/api/v1/products?cursor=<nextCursor-from-previous>&limit=20"

# Update name/base_price/stock (recomputes effective_price if base_price changed)
curl -X PATCH http://localhost:3000/api/v1/products/<product-uuid> \
  -H 'content-type: application/json' \
  -d '{"basePrice":"120.00"}'
```

### Promotions

```bash
# Create a PRODUCT-scope promotion → 201 with the row, effective_price
# already updated on the target product.
curl -X POST http://localhost:3000/api/v1/promotions \
  -H 'content-type: application/json' \
  -d '{
    "name":"25% launch",
    "discountType":"PERCENTAGE",
    "discountValue":"25",
    "scope":"PRODUCT",
    "targetProductId":"<product-uuid>",
    "startsAt":"2026-05-24T00:00:00Z",
    "endsAt":"2026-05-31T00:00:00Z"
  }'

# Create a CATEGORY-scope promotion → 202 Accepted. The bulk apply runs
# in the background; poll the product or the promotion to observe progress.
curl -X POST http://localhost:3000/api/v1/promotions \
  -H 'content-type: application/json' \
  -d '{
    "name":"Site-wide footwear sale",
    "discountType":"PERCENTAGE",
    "discountValue":"30",
    "scope":"CATEGORY",
    "targetCategoryId":"<category-uuid>",
    "startsAt":"2026-05-24T00:00:00Z",
    "endsAt":"2026-05-25T00:00:00Z"
  }'

# Cancel — for CATEGORY scope this synchronously reverts every affected
# product back to base_price; for PRODUCT it re-evaluates precedence
# against any still-live competitors.
curl -X POST http://localhost:3000/api/v1/promotions/<promo-uuid>/cancel

# Read
curl http://localhost:3000/api/v1/promotions/<promo-uuid>
curl "http://localhost:3000/api/v1/promotions?status=ACTIVE&scope=CATEGORY"
```

Conflict responses look like:

```json
{
  "statusCode": 409,
  "error": "PromotionConflict",
  "reason": "EXISTING_PRODUCT_PROMOTION",
  "conflictingPromotionId": "8c2d…",
  "message": "An existing active or scheduled promotion already applies to this target for the requested time window."
}
```

### Ingest (Scenario A)

```bash
# Put your CSV under INGEST_DIR
mkdir -p /tmp/modaco-ingest
cp sample-feed.csv /tmp/modaco-ingest/

# Register the batch → 202; the splitter + processor run in the background.
# Re-POSTing the same (vendorId, sourceFile) returns the existing batch.
curl -X POST http://localhost:3000/api/v1/ingest/batches \
  -H 'content-type: application/json' \
  -d '{"vendorId":"acme","sourceFile":"sample-feed.csv"}'

# Status — totalRows / processedRows / failedRows.
curl http://localhost:3000/api/v1/ingest/batches/<batch-uuid>
```

CSV columns (header row required):

```
sku,name,category_name,base_price,vendor_cost,stock_quantity
```

`vendor_cost` is optional; when present it enforces a 10% minimum margin
(`base_price ≥ vendor_cost × 1.10`). Rows below that floor are lifted
up, not rejected.

#### Production deployment shape (AWS Lambda + S3 + SQS)

The local `POST /api/v1/ingest/batches` endpoint runs the splitter and
processor in-process via `JobRunner`. The plan's intended production
deployment is two Lambda handlers, checked in under
[src/ingest/splitter.handler.ts](src/ingest/splitter.handler.ts) and
[src/ingest/processor.handler.ts](src/ingest/processor.handler.ts):

```
   vendor CSV  ─▶  S3 raw/{vendor}/file.csv
                              │  ObjectCreated event
                              ▼
                  splitter.handler  (S3Handler)
                  • streams the CSV via IngestSplitter
                  • writes each chunk to S3 chunks/{batch}/{i}.jsonl
                  • SQS SendMessage  { batchId, chunkKey, chunkIndex }
                              │
                              ▼
                          ┌───────┐
                          │  SQS  │
                          └───┬───┘
                              │
                              ▼
                  processor.handler  (SQSHandler)
                  • GetObject the chunk JSONL
                  • IngestProcessor.processChunk(batchId, rows)
                  • SQSBatchResponse.batchItemFailures for retries
```

Both handlers cache a Nest application context across warm
invocations and call the **same** pure services the local endpoint
uses, so idempotency (UNIQUE `(vendor_id, source_file)` on
`ingest_batches`, PK `(batch_id, row_key)` on `ingest_row_results`,
`ON CONFLICT (sku) DO UPDATE` on `products`) is identical between
deployment modes.

The S3 and SQS SDK calls are marked `TODO(production)` inside both
handlers — deploying them adds `@aws-sdk/client-s3` and
`@aws-sdk/client-sqs` and replaces the stubs. The handlers throw
loudly (`'... wire @aws-sdk/client-s3 before deploying'`) if anyone
deploys without that wiring.

## Dev helper scripts

Two ts-node scripts under `scripts/`:

```bash
# Seed: 3 categories + 7 sample products, upserted by natural key
# so subsequent runs are no-ops.
npm run db:seed

# Generate a synthetic vendor CSV under INGEST_DIR (default 500_000 rows).
# First arg = row count, second arg = filename.
npm run ingest:gen                              # 500k rows
npm run ingest:gen -- 100000                    # 100k rows
npm run ingest:gen -- 50000 my-feed.csv         # custom filename
```

### Stress-testing Scenario A end-to-end

```bash
# 1. Bring up Postgres + Redis and the API.
npm run db:up && npm run start:dev

# 2. In another terminal, generate a 500k-row vendor feed.
npm run ingest:gen -- 500000 stress.csv

# 3. Kick off the ingest. 202 with the batch UUID.
curl -X POST http://localhost:3000/api/v1/ingest/batches \
  -H 'content-type: application/json' \
  -d '{"vendorId":"stress","sourceFile":"stress.csv"}'

# 4. Poll progress.
watch -n 1 'curl -s http://localhost:3000/api/v1/ingest/batches/<batch-uuid>'

# 5. Read the metrics — ingest counters, rows/sec, batch transitions.
curl -s http://localhost:3000/metrics | grep ingest_
```

The streaming splitter keeps process memory bounded to ~one chunk's
worth of rows (default 500); the processor bulk-upserts one chunk
per SQL statement. Scenario A's design assumption — that this
pipeline finishes inside a Lambda's 15-minute budget — is what this
script lets you verify against your own hardware before the
interview.

## Project structure

```
src/
├── app.module.ts
├── main.ts
├── config/                    # Zod env, Pino options
├── infra/                     # Prisma + ioredis singletons
├── jobs/                      # In-process JobRunner (Lambda + SQS in prod)
├── cache/                     # Redis adapter, key builders, invalidation
├── domain/                    # Pure: money, effective price, promotion rules
├── shared/                    # ZodValidationPipe, cursor pagination
├── observability/             # Prom-client metrics + HTTP histogram
├── health/                    # /health, /ready (Terminus)
├── categories/                # POST, GET
├── products/                  # CRUD + cache-first GET :id
├── promotions/                # CRUD, cancel, MaterializationService
└── ingest/                    # row schema, pricing rules, splitter,
                               # processor, ingest service + controller
prisma/
├── schema.prisma
└── migrations/
    ├── *_init/                # Schema + partial indexes + CHECK constraints
    └── *_add_compute_effective_price_fn/
test/
├── jest-e2e.json
├── global-setup.ts            # Auto-creates modaco_test DB, runs migrations
├── e2e-utils.ts               # Bootstrap Nest, reset DB, flush jobs
├── promotions-conflict.e2e-spec.ts
├── scenario-b.e2e-spec.ts     # 1000-product materialization
├── ingest.e2e-spec.ts
└── metrics.e2e-spec.ts
scripts/
├── seed.ts                    # Categories + sample products (idempotent)
└── generate-large-csv.ts      # Streams a synthetic vendor CSV under INGEST_DIR
docker-compose.yml             # postgres:15-alpine + redis:7-alpine
ADR.md                         # Architecture Decision Record
AI_APPENDIX.md                 # AI collaboration appendix (form 5)
```

The `ingest/` module also ships AWS Lambda handler stubs
(`splitter.handler.ts`, `processor.handler.ts`) for the production
deployment shape — see the "Production deployment shape" subsection
above.

## Observability

Three layers:

1. **`GET /metrics`** — Prometheus text exposition. Custom series:
   - `http_request_duration_seconds{method,route,status_code}` (route
     templates, not URLs — cardinality safe)
   - `cache_operations_total{operation,resource}` — hit / miss / invalidate
   - `ingest_rows_total{status}` and `ingest_batches_total{transition}`
   - `promotions_created_total{scope}`
   - `promotion_materialization_seconds{kind}` — apply or revert
   - plus `prom-client`'s default Node-process metrics (heap, GC, event
     loop lag).
2. **Structured logs** via `nestjs-pino`. Every request gets an
   `x-request-id` (echoed back on the response). `/health`, `/ready` and
   `/metrics` are excluded from request logs so the operational log
   stays readable.
3. **`/health` and `/ready`** — k8s-style liveness/readiness. `/ready`
   pings Postgres and Redis; `/health` does not.

## Testing approach

- **Unit (`npm test`)** — pure domain functions and stream helpers. No DB,
  no Nest. ~63 tests.
- **E2E (`npm run test:e2e`)** — bootstrap the real Nest app against the
  docker-compose Postgres in the `modaco_test` database (auto-provisioned
  by `test/global-setup.ts`). Each spec truncates between tests and
  flushes the JobRunner in `afterEach` / `afterAll` so background work
  never leaks across test boundaries. ~17 tests covering the conflict
  rule, the bulk materialization at 1000-product scale, the ingest
  pipeline (happy path, partial failure, idempotency, path safety), and
  the metrics endpoint.

## Production considerations

The case-study version is intentionally small. See [ADR.md §15](ADR.md#15-what-we-would-do-at-production-scale)
for the production-scale follow-ups (OpenTelemetry, read replica,
outbox-based cache invalidation, sharded Redis, schema registry,
per-vendor rate limiting, a scheduler for SCHEDULED promotions).

## License

UNLICENSED — case-study material.
