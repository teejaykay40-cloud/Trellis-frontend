# Client Error Handling

`lib/soroban/errors.ts` provides a stable error boundary for wallet, network, and contract-interaction failures.

## UI contract

Use `toUserSafeError(error)` at user-facing boundaries. It returns:

- `code`: a stable value suitable for UI state, analytics, and support triage;
- `message`: a recovery-oriented message that does not expose raw provider or contract details;
- `remediation`: a documented next step appropriate to the failure;
- `retryable`: whether the user can reasonably retry without changing input;
- `correlationId`: a support reference that can be paired with protected diagnostic logs.

Use `getHumanReadableError(error)` only for existing text-only call sites. New flows should keep the full structured result so they can render an appropriate retry affordance and include the correlation ID in a support path.

## Stable code and recovery catalog

The codes and default retry policies below are defined by `USER_SAFE_ERROR_CATALOG`. Keep the existing values stable; add new values only for a distinct recovery path.

| Code | Typical cause | Retryable | Remediation |
| --- | --- | --- | --- |
| `TX_CANCELLED` | Wallet user rejected the signing prompt | No | No transaction was submitted. Start again and approve the wallet prompt if desired. |
| `SIMULATION_FAILED` | Simulation or contract execution rejected the operation | Yes, after review | Check amount, permissions, and network state; correct any invalid details before retrying. |
| `INSUFFICIENT_BALANCE` | Wallet balance or fee reserve is insufficient | No | Add the required asset and native token for network fees, then submit again. |
| `UNAUTHORIZED` | Authentication, role, or permission failure (including HTTP 401/403) | No | Reconnect the intended account and verify its access. Do not retry until access is corrected. |
| `VALIDATION_FAILED` | Required or supplied transaction values are invalid | No | Correct invalid or missing fields and verify network and asset selection. |
| `NETWORK_UNAVAILABLE` | Network, timeout, HTTP 429, or HTTP 5xx failure | Yes | Restore connectivity/service availability. Check a submitted transaction's status before replaying it to prevent duplicates. |
| `UNEXPECTED_ERROR` | Unclassified failure | Yes, cautiously | Check whether the operation was accepted before retrying. Contact support with the correlation ID if it persists. |

`toUserSafeError` also recognizes the existing cross-repository codes (`INSUFFICIENT_FUNDS`, `UNAUTHORIZED`, `NETWORK_ERROR`, `CONTRACT_REVERTED`, `VALIDATION_FAILED`, and `UNKNOWN_ERROR`) without changing that contract. Unknown provider codes fall back to `UNEXPECTED_ERROR`; provider messages are not returned in the user-safe result.

## Logging

Raw errors may contain provider or contract context and must not be displayed to users. Log them only through the application’s protected diagnostics path, alongside the returned correlation ID. Do not store wallet secrets, signed transaction payloads, or private user data in error telemetry.

## Extending the taxonomy

Add a new stable error code only when a failure mode needs different user guidance or retry behavior. Keep existing codes stable once released so analytics and support workflows remain reliable.

## Operational edge cases and rollback

- A cancelled signing prompt is not an infrastructure failure; do not automatically reopen the prompt.
- Authorization and validation failures require user or operator action and should not be put on a transient retry loop.
- A timeout or disconnect can happen after the network accepted a transaction. Query by its transaction hash or idempotency key before resubmitting; never infer that a missing response means no side effect occurred.
- If a new mapper rule is incorrect, revert that rule or the frontend release. Existing code strings and the optional, additive `remediation` field remain backward-compatible; older clients may continue using `message` and `retryable`.
- Keep the previous mapping available during rollout. A rollback must not reuse an existing code for a different meaning; unknown failures safely use `UNEXPECTED_ERROR` until a corrected frontend is deployed.

Run the focused executable contract with `npx jest --config jest.config.cjs lib/soroban/errors.test.ts --runInBand`. It covers cancellation, authorization, structured contract/validation errors, retryable network failures, unknown errors, and catalog completeness.