import { Readable } from 'node:stream';
import { IngestSplitter } from './splitter.service';

function csvStream(content: string): Readable {
  return Readable.from([content]);
}

describe('IngestSplitter.split()', () => {
  let splitter: IngestSplitter;

  beforeEach(() => {
    splitter = new IngestSplitter();
  });

  it('parses CSV headers into objects and emits one full chunk', async () => {
    const csv = ['sku,name,base_price', 'A1,Widget,9.99', 'A2,Gadget,14.50'].join('\n');
    const chunks: unknown[][] = [];

    const result = await splitter.split(csvStream(csv), 10, async (rows) => {
      chunks.push(rows);
    });

    expect(result).toEqual({ totalRows: 2, chunkCount: 1 });
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toEqual([
      { sku: 'A1', name: 'Widget', base_price: '9.99' },
      { sku: 'A2', name: 'Gadget', base_price: '14.50' },
    ]);
  });

  it('emits multiple chunks of the configured size, with the tail as a partial', async () => {
    const rows = Array.from({ length: 7 }, (_, i) => `SKU${i},Item-${i},${i}`);
    const csv = ['sku,name,base_price', ...rows].join('\n');

    const chunkSizes: number[] = [];
    const result = await splitter.split(csvStream(csv), 3, async (chunk) => {
      chunkSizes.push(chunk.length);
    });

    expect(result).toEqual({ totalRows: 7, chunkCount: 3 });
    expect(chunkSizes).toEqual([3, 3, 1]);
  });

  it('numbers chunks starting at zero', async () => {
    const rows = Array.from({ length: 5 }, (_, i) => `SKU${i},Item,1`);
    const csv = ['sku,name,base_price', ...rows].join('\n');
    const seen: number[] = [];

    await splitter.split(csvStream(csv), 2, async (_chunk, index) => {
      seen.push(index);
    });

    expect(seen).toEqual([0, 1, 2]);
  });

  it('returns zero counts for a header-only CSV', async () => {
    const csv = 'sku,name,base_price';
    const handler = jest.fn(async () => undefined);

    const result = await splitter.split(csvStream(csv), 100, handler);

    expect(result).toEqual({ totalRows: 0, chunkCount: 0 });
    expect(handler).not.toHaveBeenCalled();
  });

  it('applies backpressure: the parser pauses while onChunk is awaiting', async () => {
    // 5 rows, chunk size 2. If we don't await between chunks, the splitter
    // would push them all into the handler before the first await resolved.
    // Awaiting onChunk between chunks means the second chunk only arrives
    // after the first handler resolves.
    const rows = Array.from({ length: 5 }, (_, i) => `SKU${i},Item,1`);
    const csv = ['sku,name,base_price', ...rows].join('\n');

    let openChunks = 0;
    let maxConcurrent = 0;

    await splitter.split(csvStream(csv), 2, async () => {
      openChunks += 1;
      maxConcurrent = Math.max(maxConcurrent, openChunks);
      await new Promise((r) => setImmediate(r));
      openChunks -= 1;
    });

    expect(maxConcurrent).toBe(1);
  });

  it('rejects a non-positive chunk size', async () => {
    await expect(splitter.split(csvStream(''), 0, async () => undefined)).rejects.toThrow();
  });
});
