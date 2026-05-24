import { z } from 'zod';

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),

  DATABASE_URL: z.string().url(),

  REDIS_HOST: z.string().min(1).default('localhost'),
  REDIS_PORT: z.coerce.number().int().positive().default(6379),
  REDIS_PASSWORD: z
    .string()
    .optional()
    .transform((v) => (v === '' ? undefined : v)),
  REDIS_DB: z.coerce.number().int().min(0).default(0),

  // Ingest (Scenario A). INGEST_DIR is the only root allowed for sourceFile
  // resolution so the API can't be tricked into reading arbitrary paths.
  INGEST_DIR: z.string().min(1).default('/tmp/modaco-ingest'),
  INGEST_CHUNK_SIZE: z.coerce.number().int().min(1).max(10_000).default(500),
});

export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    const formatted = parsed.error.flatten().fieldErrors;
    const lines = Object.entries(formatted)
      .map(([key, errs]) => `  - ${key}: ${(errs ?? []).join(', ')}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${lines}`);
  }
  return parsed.data;
}
