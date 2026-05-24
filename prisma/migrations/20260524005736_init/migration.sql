-- CreateEnum
CREATE TYPE "DiscountType" AS ENUM ('PERCENTAGE', 'FIXED_AMOUNT');

-- CreateEnum
CREATE TYPE "PromotionScope" AS ENUM ('PRODUCT', 'CATEGORY');

-- CreateEnum
CREATE TYPE "PromotionStatus" AS ENUM ('SCHEDULED', 'ACTIVE', 'CANCELLED', 'EXPIRED');

-- CreateTable
CREATE TABLE "categories" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "products" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "sku" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category_id" UUID NOT NULL,
    "base_price" DECIMAL(12,2) NOT NULL,
    "stock_quantity" INTEGER NOT NULL,
    "active_promotion_id" UUID,
    "effective_price" DECIMAL(12,2) NOT NULL,
    "effective_price_updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "promotions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,
    "discount_type" "DiscountType" NOT NULL,
    "discount_value" DECIMAL(12,2) NOT NULL,
    "scope" "PromotionScope" NOT NULL,
    "target_product_id" UUID,
    "target_category_id" UUID,
    "starts_at" TIMESTAMPTZ(6) NOT NULL,
    "ends_at" TIMESTAMPTZ(6) NOT NULL,
    "status" "PromotionStatus" NOT NULL DEFAULT 'SCHEDULED',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "promotions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_promotions" (
    "product_id" UUID NOT NULL,
    "promotion_id" UUID NOT NULL,
    "applied_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "product_promotions_pkey" PRIMARY KEY ("product_id","promotion_id")
);

-- CreateTable
CREATE TABLE "ingest_batches" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "vendor_id" TEXT NOT NULL,
    "source_file" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "total_rows" INTEGER,
    "processed_rows" INTEGER NOT NULL DEFAULT 0,
    "failed_rows" INTEGER NOT NULL DEFAULT 0,
    "started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMPTZ(6),

    CONSTRAINT "ingest_batches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ingest_row_results" (
    "batch_id" UUID NOT NULL,
    "row_key" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "error_message" TEXT,
    "processed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ingest_row_results_pkey" PRIMARY KEY ("batch_id","row_key")
);

-- CreateIndex
CREATE UNIQUE INDEX "categories_name_key" ON "categories"("name");

-- CreateIndex
CREATE UNIQUE INDEX "products_sku_key" ON "products"("sku");

-- CreateIndex
CREATE INDEX "idx_products_category_effective_price" ON "products"("category_id", "effective_price");

-- CreateIndex
CREATE INDEX "idx_products_effective_price" ON "products"("effective_price");

-- CreateIndex
CREATE INDEX "idx_promotions_status_window" ON "promotions"("status", "starts_at", "ends_at");

-- CreateIndex
CREATE INDEX "idx_product_promotions_promotion" ON "product_promotions"("promotion_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_ingest_batches_vendor_file" ON "ingest_batches"("vendor_id", "source_file");

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_active_promotion_id_fkey" FOREIGN KEY ("active_promotion_id") REFERENCES "promotions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "promotions" ADD CONSTRAINT "promotions_target_product_id_fkey" FOREIGN KEY ("target_product_id") REFERENCES "products"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "promotions" ADD CONSTRAINT "promotions_target_category_id_fkey" FOREIGN KEY ("target_category_id") REFERENCES "categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_promotions" ADD CONSTRAINT "product_promotions_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_promotions" ADD CONSTRAINT "product_promotions_promotion_id_fkey" FOREIGN KEY ("promotion_id") REFERENCES "promotions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ingest_row_results" ADD CONSTRAINT "ingest_row_results_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "ingest_batches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ──────────────────────────────────────────────────────────────────────────────
-- Plan §5 additions that Prisma's DSL cannot express:
--   CHECK constraints, partial indexes, status-windowed promotion index.
-- ──────────────────────────────────────────────────────────────────────────────

-- CHECK constraints on products
ALTER TABLE "products"
  ADD CONSTRAINT "chk_products_base_price_nonneg" CHECK ("base_price" >= 0),
  ADD CONSTRAINT "chk_products_stock_nonneg"      CHECK ("stock_quantity" >= 0);

-- CHECK constraints on promotions: target exactly-one + valid window + positive value
ALTER TABLE "promotions"
  ADD CONSTRAINT "chk_promotion_target" CHECK (
    (scope = 'PRODUCT'  AND target_product_id  IS NOT NULL AND target_category_id IS NULL) OR
    (scope = 'CATEGORY' AND target_category_id IS NOT NULL AND target_product_id  IS NULL)
  ),
  ADD CONSTRAINT "chk_promotion_dates"         CHECK ("ends_at" > "starts_at"),
  ADD CONSTRAINT "chk_promotion_value_positive" CHECK ("discount_value" > 0);

-- Replace the auto-generated full index with the partial one called for in plan §5:
DROP INDEX "idx_promotions_status_window";
CREATE INDEX "idx_promotions_active_window"
  ON "promotions" ("status", "starts_at", "ends_at")
  WHERE "status" IN ('SCHEDULED', 'ACTIVE');

-- Partial index: only products that currently have an active promotion
CREATE INDEX "idx_products_active_promotion"
  ON "products" ("active_promotion_id")
  WHERE "active_promotion_id" IS NOT NULL;

-- Partial index: only category-scoped promotion rows
CREATE INDEX "idx_promotions_target_category"
  ON "promotions" ("target_category_id")
  WHERE "target_category_id" IS NOT NULL;
