import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, before, test } from 'node:test';
import {
  assertPanelPayload,
  fetchWithRetry,
  parseArgs,
  runLoadTest,
} from './metrics-load-test.mjs';

let server;
let baseUrl;

before(async () => {
  server = createServer((request, response) => {
    if (request.url === '/transient') {
      server.transientRequests = (server.transientRequests || 0) + 1;
      if (server.transientRequests === 1) {
        response.writeHead(503).end();
        return;
      }
    }
    if (request.url?.startsWith('/metrics')) {
      if (request.url.includes('__load_test_invalid_panel__')) {
        response.writeHead(400).end(JSON.stringify({ message: 'Unknown panelId' }));
        return;
      }
      server.metricsRequests = (server.metricsRequests || 0) + 1;
      if (server.metricsRequests === 1) {
        response.writeHead(500).end(JSON.stringify({ message: 'temporary failure' }));
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ series: [{ points: [{ ts: 1, value: 2 }] }] }));
      return;
    }
    if (request.url === '/permissions') {
      if (request.headers.authorization === 'Bearer test-token') {
        response.writeHead(200).end('{}');
      } else {
        response.writeHead(401).end('{}');
      }
      return;
    }
    response.writeHead(200).end('ok');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

test('rejects an unsafe cardinality response', () => {
  assert.throws(() => assertPanelPayload({ series: Array(201).fill({ points: [] }) }, 200), /Expected/);
  assert.throws(() => assertPanelPayload({ series: [{ points: Array(1_001) }] }, 1), /at most 1000/);
  assert.doesNotThrow(() => assertPanelPayload({ series: [{ points: Array(1_000) }] }, 1));
});

test('limits burst configuration and requires explicit remote-target confirmation', () => {
  assert.throws(() => parseArgs(['--requests', '501']), /between 1 and 500/);
  assert.throws(() => parseArgs(['--url', 'https://example.test/api/metrics/panel']), /--confirm-remote/);
  assert.equal(
    parseArgs(['--url', 'https://example.test/api/metrics/panel', '--confirm-remote']).url,
    'https://example.test/api/metrics/panel',
  );
  assert.equal(
    parseArgs(['--url', 'https://example.test/api/metrics/panel', '--confirm-remote']).authUrl,
    'https://example.test/api/permissions',
  );
  assert.throws(
    () => parseArgs(['--url', 'https://user:password@example.test/api/metrics/panel', '--confirm-remote']),
    /Credentials must not be embedded/,
  );
});

test('retries a transient server failure and reports the retry count', async () => {
  const result = await fetchWithRetry(`${baseUrl}/transient`, {}, 1);
  assert.equal(result.response.status, 200);
  assert.equal(result.retries, 1);
});

test('runs normal, failure, retry, burst, and authorization paths', async () => {
  const result = await runLoadTest({
    url: `${baseUrl}/metrics?panelId=sys_http_request_rate`,
    authUrl: `${baseUrl}/permissions`,
    authToken: 'test-token',
    expectedSeries: 1,
    requests: 2,
    concurrency: 2,
    maxRetries: 1,
  });
  assert.equal(result.requests, 2);
  assert.equal(result.retries, 1);
  assert.equal(result.authorizedCheck, 'passed');
});
