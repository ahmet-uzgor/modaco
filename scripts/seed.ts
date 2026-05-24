/**
 * Dev-only seed script. Inserts a few categories and a handful of sample
 * products so you can poke at the API right after `npm run db:up`.
 *
 *   npx ts-node scripts/seed.ts
 *
 * Idempotent against the existing DB — uses upsert on natural keys
 * (Category.name, Product.sku) so a second run is a no-op.
 */

import { Prisma, PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const CATEGORIES = ['Footwear', 'Outerwear', 'Accessories'] as const;

interface SeedProduct {
  sku: string;
  name: string;
  category: (typeof CATEGORIES)[number];
  basePrice: string;
  stockQuantity: number;
}

const PRODUCTS: SeedProduct[] = [
  { sku: 'SEED-SNK-01', name: 'Trail Runner', category: 'Footwear', basePrice: '120.00', stockQuantity: 25 },
  { sku: 'SEED-SNK-02', name: 'Court Sneaker', category: 'Footwear', basePrice: '95.00', stockQuantity: 40 },
  { sku: 'SEED-BOO-01', name: 'Hiking Boot', category: 'Footwear', basePrice: '180.00', stockQuantity: 10 },
  { sku: 'SEED-JKT-01', name: 'Rain Shell', category: 'Outerwear', basePrice: '220.00', stockQuantity: 15 },
  { sku: 'SEED-JKT-02', name: 'Down Puffer', category: 'Outerwear', basePrice: '299.99', stockQuantity: 8 },
  { sku: 'SEED-HAT-01', name: 'Beanie', category: 'Accessories', basePrice: '24.50', stockQuantity: 100 },
  { sku: 'SEED-BAG-01', name: 'Day Pack', category: 'Accessories', basePrice: '79.00', stockQuantity: 30 },
];

async function main(): Promise<void> {
  const categoryIdByName = new Map<string, string>();
  for (const name of CATEGORIES) {
    const category = await prisma.category.upsert({
      where: { name },
      create: { name },
      update: {},
    });
    categoryIdByName.set(name, category.id);
  }

  for (const p of PRODUCTS) {
    const categoryId = categoryIdByName.get(p.category)!;
    await prisma.product.upsert({
      where: { sku: p.sku },
      create: {
        sku: p.sku,
        name: p.name,
        categoryId,
        basePrice: new Prisma.Decimal(p.basePrice),
        stockQuantity: p.stockQuantity,
        effectivePrice: new Prisma.Decimal(p.basePrice),
      },
      update: {
        name: p.name,
        categoryId,
        basePrice: new Prisma.Decimal(p.basePrice),
        stockQuantity: p.stockQuantity,
      },
    });
  }

  console.log(
    `Seeded ${CATEGORIES.length} categories and ${PRODUCTS.length} products. ` +
      'Run again any time — the script is idempotent.',
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
