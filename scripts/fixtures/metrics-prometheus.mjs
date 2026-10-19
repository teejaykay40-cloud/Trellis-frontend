#!/usr/bin/env node

import { createServer } from 'node:http';

const port = Number(process.env.METRICS_FIXTURE_PORT || 9091);
const seriesCount = Number(process.env.METRICS_FIXTURE_SERIES || 205);
const pointCount = Number(process.env.METRICS_FIXTURE_POINTS || 1_005);
const failFirst = process.env.METRICS_FIXTURE_FAIL_FIRST === 'true';
let requests = 0;

if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error('METRICS_FIXTURE_PORT must be between 1 and 65535');
}
if (!Number.isInteger(seriesCount) || seriesCount < 200 || seriesCount > 1_000) {
  throw new Error('METRICS_FIXTURE_SERIES must be between 200 and 1000');
}
if (!Number.isInteger(pointCount) || pointCount < 1_000 || pointCount > 5_000) {
  throw new Error('METRICS_FIXTURE_POINTS must be between 1000 and 5000');
}

const server = createServer((request, response) => {
  if (request.url?.split('?')[0] !== '/api/v1/query_range') {
    response.writeHead(404).end('not found');
    return;
  }

  requests += 1;
  if (failFirst && requests === 1) {
    response.writeHead(503, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ status: 'error', error: 'fixture transient failure' }));
    return;
  }

  const url = new URL(request.url, `http://localhost:${port}`);
  const start = Number(url.searchParams.get('start') || 0);
  const step = Number(url.searchParams.get('step') || 5);
  const result = Array.from({ length: seriesCount }, (_, seriesIndex) => ({
    metric: { instance: `fixture-${seriesIndex}` },
    values: Array.from({ length: pointCount }, (_, pointIndex) => [
      start + pointIndex * step,
      String(seriesIndex + pointIndex / 10),
    ]),
  }));

  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify({
    status: 'success',
    data: { resultType: 'matrix', result },
  }));
});

server.listen(port, '127.0.0.1', () => {
  console.log(
    `Prometheus cardinality fixture listening on http://127.0.0.1:${port} ` +
      `(${seriesCount} series x ${pointCount} points${failFirst ? ', first request fails' : ''})`,
  );
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
