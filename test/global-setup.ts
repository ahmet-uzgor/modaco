/**
 * Jest global setup for e2e tests.
 *
 * Strategy: point all e2e tests at a dedicated database (`modaco_test`) on
 * the same docker-compose Postgres. We create the DB if it doesn't exist,
 * then run `prisma migrate deploy` against it. Dev data in `modaco` stays
 * untouched.
 *
 * This runs once before the entire jest invocation, not per file.
 */

import { execSync } from 'node:child_process';
import { Client } from 'pg';

const ADMIN_URL =
  process.env.TEST_ADMIN_URL ?? 'postgresql://modaco:modaco@localhost:5432/postgres';
const TEST_DB_NAME = process.env.TEST_DB_NAME ?? 'modaco_test';
const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  `postgresql://modaco:modaco@localhost:5432/${TEST_DB_NAME}?schema=public`;

async function ensureDatabase(): Promise<void> {
  const admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();
  try {
    const exists = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [
      TEST_DB_NAME,
    ]);
    if (exists.rowCount === 0) {
      await admin.query(`CREATE DATABASE "${TEST_DB_NAME}"`);
    }
  } finally {
    await admin.end();
  }
}

export default async function globalSetup(): Promise<void> {
  await ensureDatabase();

  // Apply migrations to the test DB.
  execSync('npx prisma migrate deploy', {
    stdio: 'inherit',
    env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL },
  });

  // Expose for individual test files. Also park Redis in a non-default DB so
  // `flushdb` between tests can't touch the dev cache (DB 0).
  process.env.DATABASE_URL = TEST_DATABASE_URL;
  process.env.REDIS_DB = process.env.TEST_REDIS_DB ?? '15';
}
