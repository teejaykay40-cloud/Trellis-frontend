#!/usr/bin/env node

import { pathToFileURL } from 'node:url';

const DEFAULT_URL = 'http://localhost:3000/api/metrics/panel?panelId=sys_http_request_rate&range=7d&step=300';
const MAX_SERIES = 200;
const MAX_POINTS_PER_SERIES = 1_000;
const MAX_REQUESTS = 500;
const MAX_CONCURRENCY = 50;

function parsePositiveInteger(value, option, maximum = Number.MAX_SAFE_INTEGER) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new Error(`${option} must be an integer between 1 and ${maximum}`);
  }
  return parsed;
}

export function parseArgs(argv = []) {
  const parsed = {
    url: process.env.LOAD_TEST_URL || DEFAULT_URL,
    requests: 20,
    concurrency: 10,
    expectedSeries: MAX_SERIES,
    maxRetries: 3,
    authUrl: process.env.LOAD_TEST_AUTH_URL,
    authToken: process.env.LOAD_TEST_AUTH_TOKEN,
    confirmRemote: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const option = argv[i];
    if (option === '--help' || option === '-h') {
      parsed.help = true;
      continue;
    }
    if (option === '--confirm-remote') {
      parsed.confirmRemote = true;
      continue;
    }
    const value = argv[i + 1];
    if (!value || value.startsWith('--')) {
      throw new Error(`${option} requires a value`);
    }
    i += 1;
    switch (option) {
      case '--url':
        parsed.url = value;
        break;
      case '--requests':
        parsed.requests = parsePositiveInteger(value, option, MAX_REQUESTS);
        break;
      case '--concurrency':
        parsed.concurrency = parsePositiveInteger(value, option, MAX_CONCURRENCY);
        break;
      case '--expect-series':
        parsed.expectedSeries = parsePositiveInteger(value, option, MAX_SERIES);
        break;
      case '--max-retries':
        parsed.maxRetries = parsePositiveInteger(value, option, 10);
        break;
      case '--auth-url':
        parsed.authUrl = value;
        break;
      case '--auth-token':
        parsed.authToken = value;
        break;
      default:
        throw new Error(`Unknown option '${option}'. Run with --help for usage.`);
    }
  }

  try {
    if (!parsed.authUrl) {
      const authUrl = new URL(parsed.url);
      authUrl.pathname = '/api/permissions';
      authUrl.search = '';
      authUrl.hash = '';
      parsed.authUrl = authUrl.toString();
    }
  } catch {
    throw new Error('Invalid metrics target URL');
  }

  for (const target of [parsed.url, parsed.authUrl]) {
    let url;
    try {
      url = new URL(target);
    } catch {
      throw new Error('Invalid target URL');
    }
    if (!['http:', 'https:'].includes(url.protocol)) {
      throw new Error('Target URL must use HTTP or HTTPS');
    }
    if (url.username || url.password) {
      throw new Error('Credentials must not be embedded in target URLs');
    }
    if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && !parsed.confirmRemote) {
      throw new Error('Remote targets require --confirm-remote; run load tests only against approved environments.');
    }
  }

  return parsed;
}

export function assertPanelPayload(payload, expectedSeries) {
  if (!payload || !Array.isArray(payload.series)) {
    throw new Error('Metrics response must contain a series array');
  }
  if (payload.series.length < expectedSeries || payload.series.length > MAX_SERIES) {
    throw new Error(
      `Expected ${expectedSeries}-${MAX_SERIES} series, received ${payload.series.length}`,
    );
  }
  for (const series of payload.series) {
    if (!Array.isArray(series.points) || series.points.length > MAX_POINTS_PER_SERIES) {
      throw new Error(`Each metric series must contain at most ${MAX_POINTS_PER_SERIES} points`);
    }
  }
  return payload;
}

function retryDelay(response, attempt) {
  const retryAfter = Number(response.headers.get('retry-after'));
  if (Number.isFinite(retryAfter) && retryAfter > 0) {
    return Math.min(retryAfter * 1_000, 60_000);
  }
  return Math.min(250 * (2 ** attempt), 5_000);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function fetchWithRetry(url, options = {}, maxRetries = 3, fetchImpl = fetch) {
  let retries = 0;
  while (true) {
    const response = await fetchImpl(url, options);
    if (response.status < 500 && response.status !== 429) {
      return { response, retries };
    }
    if (retries >= maxRetries) {
      await response.body?.cancel();
      return { response, retries };
    }
    const delay = retryDelay(response, retries);
    await response.body?.cancel();
    await sleep(delay);
    retries += 1;
  }
}

async function requireStatus(url, expectedStatus, options, maxRetries, fetchImpl) {
  const { response } = await fetchWithRetry(url, options, maxRetries, fetchImpl);
  if (response.status !== expectedStatus) {
    await response.body?.cancel();
    throw new Error(`${new URL(url).pathname} returned ${response.status}; expected ${expectedStatus}`);
  }
  await response.body?.cancel();
  return response;
}

export async function runLoadTest(options, fetchImpl = fetch) {
  const startedAt = Date.now();
  let retryCount = 0;

  const firstRequest = await fetchWithRetry(options.url, {}, options.maxRetries, fetchImpl);
  retryCount += firstRequest.retries;
  if (firstRequest.response.status !== 200) {
    await firstRequest.response.body?.cancel();
    throw new Error(`Metrics request failed with HTTP ${firstRequest.response.status}`);
  }
  assertPanelPayload(await firstRequest.response.json(), options.expectedSeries);

  const invalidPanel = new URL(options.url);
  invalidPanel.searchParams.set('panelId', '__load_test_invalid_panel__');
  await requireStatus(invalidPanel, 400, {}, options.maxRetries, fetchImpl);

  const authHeaders = options.authToken
    ? { authorization: `Bearer ${options.authToken}` }
    : {};
  await requireStatus(options.authUrl, 401, {}, 0, fetchImpl);
  if (options.authToken) {
    await requireStatus(options.authUrl, 200, { headers: authHeaders }, options.maxRetries, fetchImpl);
  }

  let nextRequest = 0;
  let completed = 0;
  let throttled = 0;
  const worker = async () => {
    while (nextRequest < options.requests) {
      nextRequest += 1;
      const result = await fetchWithRetry(options.url, {}, options.maxRetries, fetchImpl);
      retryCount += result.retries;
      if (result.response.status === 429) throttled += 1;
      else if (result.response.status !== 200) {
        throw new Error(`Burst request failed with HTTP ${result.response.status}`);
      } else {
        assertPanelPayload(await result.response.json(), options.expectedSeries);
      }
      completed += 1;
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(options.concurrency, options.requests) }, () => worker()),
  );

  if (throttled > 0) {
    const response = await fetchWithRetry(options.url, {}, options.maxRetries, fetchImpl);
    retryCount += response.retries;
    if (response.response.status !== 200) {
      await response.response.body?.cancel();
      throw new Error(`Post-burst recovery request failed with HTTP ${response.response.status}`);
    }
    assertPanelPayload(await response.response.json(), options.expectedSeries);
  }

  return {
    requests: completed,
    concurrency: Math.min(options.concurrency, options.requests),
    retries: retryCount,
    rateLimited: throttled,
    durationMs: Date.now() - startedAt,
    authorizedCheck: options.authToken ? 'passed' : 'skipped (set LOAD_TEST_AUTH_TOKEN)',
  };
}

function printHelp() {
  console.log(`Metrics API cardinality and burst load test

Usage:
  npm run load:metrics -- [options]

Options:
  --url <url>             Metrics panel URL (default: local HTTP request-rate panel)
  --requests <n>          Burst requests, 1-500 (default: 20)
  --concurrency <n>       Concurrent requests, 1-50 (default: 10)
  --expect-series <n>     Minimum response series, 1-200 (default: 200)
  --max-retries <n>       Retry budget for HTTP 429/5xx responses (default: 3)
  --auth-url <url>        Protected endpoint to probe (default: /api/permissions)
  --auth-token <token>    Valid bearer token for the authorized path
  --confirm-remote        Required before sending requests to a non-local target
  -h, --help              Show this help

Exit codes:
  0  Cardinality, burst, failure, retry, and configured authorization checks passed
  1  A target or response assertion failed
  2  Invalid arguments`);
}

export async function main(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    console.error(error.message);
    return 2;
  }
  if (options.help) {
    printHelp();
    return 0;
  }
  try {
    const result = await runLoadTest(options);
    console.log(JSON.stringify(result, null, 2));
    return 0;
  } catch (error) {
    console.error(`Metrics load test failed: ${error.message}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
