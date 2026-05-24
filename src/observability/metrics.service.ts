import { Injectable } from '@nestjs/common';
import { Counter, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

/**
 * Central registry for application metrics. All counters and histograms
 * are declared here so the wire format is owned in one place — operators
 * grepping the codebase always find the labels and buckets next to each
 * other.
 *
 * Default Node process metrics (heap, gc, event loop lag) are collected
 * automatically via prom-client's collectDefaultMetrics.
 */
@Injectable()
export class MetricsService {
  readonly registry = new Registry();

  readonly httpRequestDuration = new Histogram({
    name: 'http_request_duration_seconds',
    help: 'Duration of HTTP requests in seconds, by route template + status code',
    labelNames: ['method', 'route', 'status_code'] as const,
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  });

  readonly cacheOperations = new Counter({
    name: 'cache_operations_total',
    help: 'Cache operations by outcome — hit, miss, or invalidate',
    labelNames: ['operation', 'resource'] as const,
  });

  readonly ingestRows = new Counter({
    name: 'ingest_rows_total',
    help: 'CSV rows processed by ingest, partitioned by row-level status',
    labelNames: ['status'] as const,
  });

  readonly ingestBatches = new Counter({
    name: 'ingest_batches_total',
    help: 'Ingest batch state transitions',
    labelNames: ['transition'] as const,
  });

  readonly materializationDuration = new Histogram({
    name: 'promotion_materialization_seconds',
    help: 'Bulk apply / revert duration for category-scope promotions',
    labelNames: ['kind'] as const,
    buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
  });

  readonly promotionsCreated = new Counter({
    name: 'promotions_created_total',
    help: 'Promotions created, partitioned by scope',
    labelNames: ['scope'] as const,
  });

  constructor() {
    this.registry.registerMetric(this.httpRequestDuration);
    this.registry.registerMetric(this.cacheOperations);
    this.registry.registerMetric(this.ingestRows);
    this.registry.registerMetric(this.ingestBatches);
    this.registry.registerMetric(this.materializationDuration);
    this.registry.registerMetric(this.promotionsCreated);
    collectDefaultMetrics({ register: this.registry });
  }
}
