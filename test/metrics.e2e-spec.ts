/**
 * Phase 6 / Plan §12 — observability smoke test.
 *
 *   1. /metrics responds with the Prometheus text format.
 *   2. The HTTP histogram records a sample for an actual matched route
 *      (we hit /health to keep the test independent of business setup —
 *      wait, /health is in the IGNORED set; use a categories request
 *      instead so the metric labels exercise the interceptor).
 */

import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp, resetDatabase, resetRedis, type E2EContext } from './e2e-utils';

describe('Metrics endpoint (e2e)', () => {
  let ctx: E2EContext;
  let app: INestApplication;

  beforeAll(async () => {
    ctx = await createTestApp();
    app = ctx.app;
  });

  afterAll(async () => {
    await ctx.jobs.flush();
    await app.close();
  });

  beforeEach(async () => {
    await resetDatabase(ctx.prisma);
    await resetRedis(ctx.redis);
  });

  it('GET /metrics returns Prometheus text exposition', async () => {
    const res = await request(app.getHttpServer()).get('/metrics').expect(200);

    expect(res.headers['content-type']).toContain('text/plain');
    // Default node metrics from prom-client
    expect(res.text).toContain('process_cpu_user_seconds_total');
    expect(res.text).toContain('nodejs_eventloop_lag_seconds');
    // Our custom HELP lines
    expect(res.text).toContain('# HELP http_request_duration_seconds');
    expect(res.text).toContain('# HELP cache_operations_total');
  });

  it('records http_request_duration_seconds with route template + status', async () => {
    await request(app.getHttpServer()).get('/api/v1/categories').expect(200);

    const res = await request(app.getHttpServer()).get('/metrics').expect(200);
    expect(res.text).toMatch(
      /http_request_duration_seconds_count\{[^}]*route="\/api\/v1\/categories"[^}]*status_code="200"[^}]*\}/,
    );
  });

  it('does not record /metrics or /health in the http histogram', async () => {
    await request(app.getHttpServer()).get('/health').expect(200);
    await request(app.getHttpServer()).get('/metrics').expect(200);

    const res = await request(app.getHttpServer()).get('/metrics').expect(200);
    expect(res.text).not.toMatch(/route="\/health"/);
    expect(res.text).not.toMatch(/route="\/metrics"/);
  });
});
