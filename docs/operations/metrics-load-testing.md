# Metrics API cardinality and burst load test

The load runner exercises the read-only `/api/metrics/panel` route and checks that
the existing response contract stays bounded at 200 series and 1,000 points per
series. It also checks invalid-panel handling, retries transient HTTP 5xx/429
responses, sends a concurrent burst, and probes the protected permissions route.
It does not write application data.

## Local worst-case run

Use a local development server or an approved staging deployment only. Do not
point this at production: the burst is intentional and may make a shared metrics
backend slower for other users. The fixture binds only to `127.0.0.1`.

1. Start the local Prometheus fixture in one terminal. It returns 205 series
   with 1,005 points each, so the API must trim the response to its established
   200-series / 1,000-point limits. Enable a one-time upstream failure to verify
   the runner's retry path:

   ```powershell
   $env:METRICS_FIXTURE_FAIL_FIRST = 'true'
   npm run fixture:metrics
   ```

2. In a second terminal, point the app at the fixture and turn off the
   non-production localhost rate-limit bypass, then start the app:

   ```powershell
   $env:METRICS_PROMETHEUS_BASE_URL = 'http://127.0.0.1:9091'
   $env:RATE_LIMIT_BYPASS_LOCALHOST = 'false'
   npm run dev
   ```

3. In a third terminal, run the bounded burst:

   ```powershell
   npm run test:metrics-load
   npm run load:metrics -- --requests 20 --concurrency 10 --expect-series 200
   ```

For the authorized check, set `LOAD_TEST_AUTH_TOKEN` to a valid bearer token
issued through the application's trusted server-side token process, with
permission to view the project permission matrix, before running the load command.
The app must have a valid `PERMISSION_TOKEN_SECRET`; a missing secret is an
authorization service fault and the runner will fail rather than count it as an
anonymous rejection. Without an auth token, the runner still confirms that an
anonymous permissions request is rejected and reports the authorized check as skipped.
The failure test intentionally requests an unknown panel and expects HTTP 400.
Transient 5xx and rate-limit 429 responses are retried with bounded exponential
backoff or the server's `Retry-After` value; exhausted retries fail the run.

The runner limits the burst to 500 requests and concurrency to 50. Remote URLs
are refused unless `--confirm-remote` is supplied; this is a safeguard, not
approval to test an unowned or production system. Keep any supplied bearer token
out of shell history and logs.

## Operational edge cases and recovery

- A `source: mock` response or fewer than the requested series means the
  Prometheus fixture/configuration is not feeding the tested app. Check that the
  app was restarted with `METRICS_PROMETHEUS_BASE_URL` and that the fixture is
  reachable before treating the run as a cardinality result.
- A 429 is expected only when the configured route budget is reached. The runner
  honors `Retry-After`, then makes a recovery request. If retries are exhausted,
  reduce concurrency/request count or check the limiter's burst/refill values;
  do not disable rate limiting to force a passing result.
- A 5xx after the retry budget indicates an unhealthy app or collector. Inspect
  the app/Prometheus logs and fixture status before retrying; repeated runs can
  amplify an upstream incident.
- The API response remains capped by the existing contract. No migration or
  persisted test state is needed.

To stop traffic immediately, stop the load runner. Stop the local fixture and
app, then remove `METRICS_FIXTURE_FAIL_FIRST`, `METRICS_PROMETHEUS_BASE_URL`, and
`RATE_LIMIT_BYPASS_LOCALHOST` from the development shell and restart the app.
For staging, restore the prior deployment environment and restart/roll back the
app through the normal deployment procedure. This test changes no application
records, so there is no data rollback.
