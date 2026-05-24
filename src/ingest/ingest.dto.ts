import type { IngestBatch } from '@prisma/client';
import { z } from 'zod';

export const StartIngestSchema = z.object({
  vendorId: z.string().min(1).max(64),
  // Filename only — resolved against INGEST_DIR by the service so callers
  // can't escape the configured root with `../`. Must look like a CSV.
  sourceFile: z
    .string()
    .min(1)
    .max(255)
    .regex(/^[A-Za-z0-9._-]+\.csv$/i, 'sourceFile must be a *.csv filename, no path components'),
});
export type StartIngestDto = z.infer<typeof StartIngestSchema>;

export interface IngestBatchPresented {
  id: string;
  vendorId: string;
  sourceFile: string;
  status: string;
  totalRows: number | null;
  processedRows: number;
  failedRows: number;
  startedAt: string;
  finishedAt: string | null;
}

export function presentBatch(b: IngestBatch): IngestBatchPresented {
  return {
    id: b.id,
    vendorId: b.vendorId,
    sourceFile: b.sourceFile,
    status: b.status,
    totalRows: b.totalRows,
    processedRows: b.processedRows,
    failedRows: b.failedRows,
    startedAt: b.startedAt.toISOString(),
    finishedAt: b.finishedAt ? b.finishedAt.toISOString() : null,
  };
}
