# Operational rollout and accessibility checks

## Feature flags

Feature flags fall back to environment variables when no remote value is available. Missing values use the safer defaults:

- `TRELLIS_FEATURE_STABLE_BUG_REPORT_PAGINATION=true` enables deterministic cursor pagination.
- `TRELLIS_FEATURE_SECURITY_REPORT_EXPORT=false` keeps security report exports disabled until explicitly enabled.

Set a flag to `false` to roll back pagination, or set the export flag to `true` only after verifying authorization and output handling in the deployment environment. Environment changes take effect on process restart.

### Percentage rollouts and remote configuration

Set `TRELLIS_FEATURE_FLAGS_URL` on the server, or `NEXT_PUBLIC_TRELLIS_FEATURE_FLAGS_URL` for a browser client, to an endpoint returning JSON in this shape:

```json
{
	"flags": {
		"securityReportExport": {
			"enabled": true,
			"rolloutPercentage": 10
		}
	}
}
```

Existing `{ "enabled": boolean, "rolloutPercentage"?: number }` configurations remain compatible; `emergencyDisabled` is an optional additional guard. The helper polls immediately when a flag is evaluated, then every 30 seconds. Remote values replace the corresponding environment fallback and are applied to subsequent evaluations without a restart. A percentage rollout requires a stable user ID; pass it as the third argument to `isFeatureEnabled(flag, environment, userId)` or as the second argument to `getFeatureFlags(environment, userId)`. Users are assigned by MurmurHash3, and evaluations without a user ID fail closed for percentage-limited flags. Invalid remote values are ignored, except a valid emergency-disable value is honored even if another rollout field in the same object is invalid.

In a browser, maintainers can force a flag locally with `setFeatureFlagOverride(flag, true)` or `setFeatureFlagOverride(flag, false)`. Pass `null` to clear an override. Values are stored under `trellis.feature-flags.override.<flag>` in local storage and do not affect server-side evaluations. Use `subscribeToFeatureFlagChanges` to refresh client UI when polling or an override changes a flag.

### Emergency disablement, retry, and recovery

Emergency disablement takes precedence over percentage cohorts and browser-local overrides. For a durable, fleet-wide kill switch, publish `emergencyDisabled: true` for that flag in the remote configuration, or set its environment guard to `true` and restart the deployment:

- `TRELLIS_FEATURE_STABLE_BUG_REPORT_PAGINATION_EMERGENCY_DISABLED`
- `TRELLIS_FEATURE_SECURITY_REPORT_EXPORT_EMERGENCY_DISABLED`

Browser builds can use the corresponding `NEXT_PUBLIC_` environment variables; changing these build-time values requires rebuilding and redeploying the browser bundle. Server environment changes take effect after restarting the process. A `true` emergency guard always disables that feature even if its ordinary flag or a local override is enabled.

For immediate diagnosis, an authenticated admin can `POST /api/feature-flags/emergency-disable` with a signed bearer token and `{ "flag": "securityReportExport", "disabled": true, "confirm": true }`. Only admins may change this state. The endpoint returns `scope: "process"` because this emergency overlay is in-memory: it affects only the server process handling the request, is lost on restart, and does not propagate to other instances. Do not treat it as a fleet-wide control on a multi-instance deployment; update the shared remote configuration or deployment environment first. Sending `disabled: false` clears only this process-local overlay and does not override an environment guard or a remote `emergencyDisabled` setting.

Remote polling keeps the last valid configuration during network, HTTP, or payload failures, reports failures through `onError` (or the server error log), and retries with exponential backoff capped at five minutes. A successful response resets the retry delay. If a remote value is stale, restore the shared configuration source and verify a successful poll; if that source is unavailable, use the environment emergency guard and restart as the fallback. To recover, remove the remote emergency property (or set it to `false`), clear any process-local overlay through the authenticated endpoint, and verify the intended flag value with a known cohort. Rollback to the pre-rollout behavior by setting the normal flag to its safe default; do not remove the authorization check from gated operations.

## Operational health

Open `/dashboard/operations` to review redacted counts for unresolved exceptions, stale records, reconciliation drift, and critical user incidents. Each category links to the relevant bug-report view without including reporter email addresses or wallet addresses in the summary.

The **Cache freshness** panel inspects only the current browser's Trellis Cache Storage. It reports counts by cache type, entries older than that cache's configured maximum age, and entries with no usable `sw-cached-at` timestamp. It never displays cached URLs or values. The repair button removes entries whose timestamp proves they exceed the configured age; entries without freshness evidence are retained for manual investigation. This is a local browser repair and does not report cache state for other users.

Search-index drift requires comparing authoritative records and permissions with the index snapshot. `recommendIndexRepair(record, permissions, indexedEntry)` returns redacted evidence (`missing-index-entry`, `visibility-mismatch`, `permission-scope-mismatch`, or `consistent`) and a suggested action without including permission values. Feed its inputs from the trusted source of truth; the operations dashboard does not claim remote index health when that comparison has not been run.

## Accessibility verification

Run the existing checks with:

```bash
npm run typecheck
npm test -- --runInBand
npm run test:e2e
```

Keyboard users can tab through the bug-report form, and invalid fields expose `aria-invalid`, `aria-describedby`, and live error messages.
