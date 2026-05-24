import { Injectable } from '@nestjs/common';
import { parse } from 'csv-parse';
import type { Readable } from 'node:stream';

export interface SplitResult {
  totalRows: number;
  chunkCount: number;
}

export type ChunkHandler = (rows: unknown[], chunkIndex: number) => Promise<void>;

/**
 * Stream a CSV (the file is never fully read into memory) and hand
 * chunk-sized buckets of rows off to `onChunk` as they accumulate.
 *
 * This is the local-dev / pure version of the splitter Lambda in plan §8.
 * In production the same shape is invoked from an S3 ObjectCreated trigger
 * and `onChunk` writes a JSONL file to S3 plus emits an SQS message.
 * Locally, `onChunk` is the in-process processor.
 *
 * Backpressure: we `await` onChunk so a slow processor naturally stalls
 * the upstream parser — the csv-parse stream stays paused until we drain
 * a chunk. That's how memory stays bounded to ~one chunk's worth of
 * parsed rows regardless of file size.
 *
 * No buffering more than `chunkSize` rows; no full file in memory; no
 * recursion. The plan §18 "common AI mistake" #3 (loading the CSV into
 * memory) is structurally prevented.
 */
@Injectable()
export class IngestSplitter {
  async split(stream: Readable, chunkSize: number, onChunk: ChunkHandler): Promise<SplitResult> {
    if (chunkSize <= 0) throw new Error('chunkSize must be positive');

    const parser = stream.pipe(
      parse({
        columns: true,
        skip_empty_lines: true,
        trim: true,
        bom: true,
      }),
    );

    let buffer: unknown[] = [];
    let totalRows = 0;
    let chunkIndex = 0;

    for await (const row of parser) {
      buffer.push(row);
      totalRows += 1;
      if (buffer.length >= chunkSize) {
        await onChunk(buffer, chunkIndex);
        chunkIndex += 1;
        buffer = [];
      }
    }

    if (buffer.length > 0) {
      await onChunk(buffer, chunkIndex);
      chunkIndex += 1;
    }

    return { totalRows, chunkCount: chunkIndex };
  }
}
