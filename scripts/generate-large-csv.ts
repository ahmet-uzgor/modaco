/**
 * Generates a synthetic vendor CSV under INGEST_DIR so you can stress-test
 * the ingest pipeline end-to-end against the real Postgres.
 *
 *   npx ts-node scripts/generate-large-csv.ts                 # 500k rows
 *   npx ts-node scripts/generate-large-csv.ts 100000          # 100k rows
 *   npx ts-node scripts/generate-large-csv.ts 50000 my.csv    # custom filename
 *
 * Output goes to $INGEST_DIR/<filename>. The default filename embeds the
 * row count so multiple sizes can coexist.
 *
 * Writes are streamed line-by-line — the script never builds the whole
 * file in memory, so generating a 500k row file uses well under 32 MB.
 */

import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import * as path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

const CATEGORIES = ['Footwear', 'Outerwear', 'Accessories', 'Bags', 'Hats'] as const;

async function main(): Promise<void> {
  const rowCount = Number.parseInt(process.argv[2] ?? '500000', 10);
  if (!Number.isFinite(rowCount) || rowCount <= 0) {
    throw new Error(`Invalid row count: ${process.argv[2]}`);
  }

  const ingestDir = process.env.INGEST_DIR ?? '/tmp/modaco-ingest';
  const filename = process.argv[3] ?? `synthetic-${rowCount}.csv`;
  const fullPath = path.resolve(ingestDir, filename);
  await mkdir(ingestDir, { recursive: true });

  console.log(`Writing ${rowCount.toLocaleString()} rows to ${fullPath}`);
  const startedAt = Date.now();

  const source = Readable.from(rowGenerator(rowCount));
  await pipeline(source, createWriteStream(fullPath, { encoding: 'utf8' }));

  const durationSec = ((Date.now() - startedAt) / 1000).toFixed(2);
  console.log(`Done in ${durationSec}s — POST /api/v1/ingest/batches with`);
  console.log(`  { "vendorId": "stress-test", "sourceFile": "${filename}" }`);
}

function* rowGenerator(rowCount: number): Generator<string> {
  yield 'sku,name,category_name,base_price,vendor_cost,stock_quantity\n';

  for (let i = 0; i < rowCount; i++) {
    const sku = `STRESS-${i.toString().padStart(8, '0')}`;
    const name = `Synthetic Product ${i}`;
    const category = CATEGORIES[i % CATEGORIES.length];
    // 5 .. 504.99 — a wide enough spread that the pricing rule lifts some.
    const basePrice = (5 + (i % 50_000) / 100).toFixed(2);
    // Vendor cost on 30% of rows, low enough that the margin floor kicks
    // in occasionally so the FAILED branch isn't 0% of the run.
    const vendorCost = i % 3 === 0 ? (Number(basePrice) * 0.95).toFixed(2) : '';
    const stock = (i % 500).toString();
    yield `${sku},${name},${category},${basePrice},${vendorCost},${stock}\n`;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
