# Permission Matrix

## Overview

Trellis Frontend has one source of truth for role, scope, and action
authorization: `lib/permissions.ts`. Every privileged maintainer and service
action resolves against it, on the server, before the action runs.

This replaces three previously independent role vocabularies and a set of
ad-hoc checks:

| Module | Role vocabulary it used | Problem |
|---|---|---|
| `lib/policy-engine.ts` | `admin \| maintainer \| user \| guest` | declared `retry_operation` with no matrix entry; `user` is a synonym for `contributor` |
| `lib/invitations.ts` | `viewer \| contributor \| maintainer \| admin` | its own `roleHierarchy` and its own `canEscalateRole` |
| `lib/telemetry/roles.ts` | `viewer \| operator \| admin` | a hand-maintained capability table, with a comment telling readers to keep it in sync |
| `app/api/telemetry/session` | any string in the telemetry list | read the role from `?role=` / `body.role` and returned that role's capabilities |

Because each module answered "is this allowed?" on its own, a route's
authorization depended on which helper its author happened to find. There was no
single answer and no way to test the space exhaustively.

## Core concepts

- **Role** — `guest`, `viewer`, `contributor`, `maintainer`, `admin`, ordered by
  `roleLevel()`. The canonical list is `ROLES`.
- **Scope** — how wide the resource being acted on is, ordered narrowest to
  widest: `own` < `resource` < `project` < `global`. `any` means the grant is not
  scope-constrained.
- **Action** — a named privileged operation, listed in `ACTIONS`.
- **Condition** — a narrowing predicate attached to a grant. Conditions can only
  subtract permission, never add it.

### Scope is a width, not a rank to climb

A grant's scope is the **widest** thing the grant reaches. A `project`-scoped
grant covers `own`, `resource` and `project`, but not `global`. A `global` grant
covers everything, including work inside a single project.

This is the opposite of the intuition that "wider scope means more privilege", so
it is worth stating plainly:

```typescript
// Allowed: a project grant applies inside that project.
can('view_audit_logs', { role: 'maintainer', resourceScope: 'project' });  // true

// Denied: the request is platform-wide and the grant is not.
can('view_audit_logs', { role: 'maintainer', resourceScope: 'global' });
// → insufficient_scope, minimumRole: 'admin'
```

## The matrix

`MATRIX` is declared one action at a time, with an explicit grant-or-deny for
**every** role:

```typescript
run_retention_cleanup: {
  description: 'Delete records that have passed their retention window',
  grants: {
    admin: { scope: 'global', conditions: [{ type: 'requires_confirmation' }] },
    maintainer: DENY,
    contributor: DENY,
    viewer: DENY,
    guest: DENY,
  },
},
repair_records: {
  description: 'Repair orphaned or inconsistent derived records',
  grants: {
    admin: { scope: 'global', conditions: [{ type: 'requires_confirmation' }] },
    maintainer: DENY,
    contributor: DENY,
    viewer: DENY,
    guest: DENY,
  },
},
```

`repair_records` is the authorization gate for the projection reconciliation
repair job. It is admin-only and requires explicit confirmation; starting and
resuming checkpointed repairs both re-check authorization.

`PERMISSION_MATRIX` is that declaration expanded to one entry per action per
role. Because `MATRIX` is typed `Record<Action, ActionDefinition>`, adding an
action to `ACTIONS` without deciding it for all five roles is a **compile
error**, not a review item. That is what makes "every privileged action maps to a
permission entry" true by construction.

### Conditions

| Condition | Narrows by |
|---|---|
| `owner_only` | the actor must own the resource |
| `requires_confirmation` | the request must carry an explicit confirmation |
| `rate_limited` | a per-day action count for the actor |
| `max_resources` | a resource count |
| `max_amount` | an amount in base units, compared as `BigInt` |
| `scope_restricted` | an allow-list of scopes |

Adding a condition type requires handling it in `conditionFailure()`, which ends
in a `never` exhaustiveness check — a new condition that is not evaluated is a
compile error rather than a silent allow.

## Entitlement vs enforcement

Two functions, deliberately separate:

- **`isGranted(action, { role, resourceScope })`** — "is this available to me at
  all". Ignores conditions. Use it for capability tables and for deciding which
  controls to render.
- **`checkPermission(action, input)`** — "may I perform it right now, given these
  facts". Evaluates conditions. **This is what a route handler must call before
  acting.**

Folding `requires_confirmation` into an entitlement check would mean an admin
appears unable to export anything until they had already confirmed the export,
which is circular.

## Server-side enforcement

### Identity

`lib/auth/actor.ts` issues and verifies HMAC-SHA256 bearer tokens
(`<payload>.<signature>`, base64url, 15-minute default TTL).

The role comes from the signed token and from nowhere else. There is deliberately
**no** `x-role` fallback, no query-string role, and no role in a request body:
those are self-asserted claims, and trusting one is the bypass this design
removes. Every failure path fails closed — a missing secret is an error, never a
default role.

Signatures are compared in constant time, and the signature is verified before
the payload is parsed, so a forged token leaks nothing through parse errors.

> `issueActorToken` is server-side only. Never call it from a route handler, or a
> client can mint its own admin token.

### In a route handler

```typescript
import { requirePermission } from '@/lib/auth';

export async function GET(request: NextRequest) {
  const auth = await requirePermission(request, {
    action: 'view_audit_logs',
    resourceScope: 'project',
  });
  // The failure branch returns a response, so the handler cannot fall through.
  if (!auth.ok) return auth.response;

  // auth.actor.role, auth.actor.id and auth.decision are available here.
}
```

`requirePermission` returns a discriminated result rather than a boolean, so
forgetting an `if` is a type error and the failure branch has nothing to fall
through to.

Statuses:

| Status | Meaning |
|---|---|
| `401` | identity could not be established (missing, malformed, forged, expired token) |
| `403` | identity established, but the matrix denies the action |
| `500` | `PERMISSION_TOKEN_SECRET` is unset or too short — our bug, reported separately so it is never mistaken for a bad token during incident response |

A `403` body includes `minimumRole` (what would actually be required) and
`outstandingConditions`.

### When authorization must come after validation

If the applicable scope or a condition depends on the request body or on a
resource you have to load, split the two halves so **identity still comes
first**:

```typescript
const identity = await requireActor(request);
if (!identity.ok) return identity.response;

// ... parse the body / load the resource ...

const decision = checkPermission('run_retention_cleanup', {
  role: identity.actor.role,
  actorId: identity.actor.id,
  resourceScope: 'global',
  context: { confirmed: dryRun === false },
});
if (!decision.allowed) return deniedResponse(decision);
```

`deniedResponse` builds the same `403` shape as `requirePermission`, so the two
paths cannot drift.

## Privacy-safe exports

`POST /api/export` keeps its existing request body, response formats, and
`schemaVersion: "2.0"` metadata contract. The server derives the caller's role
from the signed actor token; a role supplied in the body is not accepted. The
export projection is an allowlist: only fields registered for the selected
export type can appear. Registered fields are redacted according to the
caller's role, while unregistered source fields are omitted even for admins.
When fields are absent from a record, JSON omits them and CSV leaves the
corresponding registered column blank.

Batch fetches retry twice by default with a 100 ms delay. After retries are
exhausted, or if the stream writer fails, the response stream fails rather than
being closed as a successful partial download. A cancelled request is not
retried once its abort signal is observed. Clients should discard a failed or
cancelled download and retry the whole request; exports do not support
checkpoints or resuming from a record offset. An empty successful export remains
a valid empty JSON array or header-only CSV document.

For recovery, first restore connectivity to the export's data source and retry
the request. If a deployment must be rolled back, keep the previous endpoint
disabled until it has the allowlisted projection and failure propagation too;
rolling back to a version that copies raw records can reintroduce field leaks.
No stored export data needs cleanup because responses are streamed and not
persisted by this endpoint. The existing API contract is retained, so clients
do not need a migration.

## Configuration

```bash
# .env.example
# Server-only HMAC secret for actor tokens. Must be at least 32 characters.
# Generate with: openssl rand -base64 48
# PERMISSION_TOKEN_SECRET=
```

The privileged routes fail closed without it: an unset secret returns `500`,
never a default role. Rotating it invalidates every outstanding token
immediately, so users must re-authenticate.

## Expiring capabilities for sensitive actions

Live retention cleanup requires both the usual signed actor bearer token and a
short-lived capability token:

1. An authorized admin requests `POST /api/permissions/capability` with
   `{ "action": "run_retention_cleanup", "dryRun": false, "dataClasses": [...] }`.
   The `dataClasses` field may be omitted to target all configured classes.
2. The server rechecks `run_retention_cleanup` at global scope, then returns a
   capability in a `Cache-Control: no-store` response. It expires after two
   minutes (the issuer enforces a one-to-five-minute lifetime).
3. Send that token in `X-Capability-Token` with the same actor bearer token and
   the exact same cleanup request to `POST /api/retention/run`.

The capability signature covers its actor, action, expiry, unique identifier,
and a hash of the canonical request. Changing or adding/removing a data class,
changing `dryRun`, or using another actor invalidates it. It authorizes no other
endpoint or action. It is intentionally retryable for the same exact request
until expiry, so a lost response can be retried without silently broadening
authority; it is not single-use and does not provide transaction-level
idempotency. The downstream cleanup must preserve its own idempotency if it can
partially apply before failing.

Dry runs are unchanged and need only the actor token. Existing actor token
issuance/verification contracts do not change. For clients that previously
sent live cleanup requests directly, the migration is to request a capability
first and send its returned token in `X-Capability-Token`; missing capabilities
return `428`, mismatched actor/request returns `403`, invalid/expired tokens
return `401`, and server secret misconfiguration returns `500`.

### Operational recovery

- If a capability expires before use, request a new one; do not increase token
  lifetime or log/store tokens to work around expiry.
- If a request mismatch is returned, discard that token and request a new one
  for the reviewed target set. Do not retry with modified targets.
- If issuance returns `500`, check that `PERMISSION_TOKEN_SECRET` is present
  and at least 32 characters, then restart/redeploy the server with the
  corrected secret. Secret rotation invalidates all actor and capability
  tokens; clients must re-authenticate and obtain new capabilities.
- On rollback, restore the previous server release and update clients to stop
  using capability issuance. Do not remove the actor permission check from
  live retention cleanup; it remains mandatory. This rollback restores the
  prior request contract but also removes the additional capability gate.

## Introspection

`GET /api/permissions` is itself governed by the matrix, via the
`view_permissions` action (admin and maintainer; checked at `project` scope).

| Query | Response |
|---|---|
| *(none)* | every role, every action, and the full expanded matrix |
| `?role=maintainer` | that role's level, allowed actions, and entries |
| `?action=transfer_funds` | the action's description and all five grants |
| `?role=…&action=…` | the single matching entry |

An unknown `role` or `action` is a `400`, not a fallback to some default.

## Adding an action

1. Add the action to `ACTIONS` in `lib/permissions.ts`.
2. Add its `MATRIX` entry with an explicit decision for all five roles. The
   compiler will not let you skip this.
3. Map the surface to the action, and pick the scope that actually applies.
4. Guard the route with `requirePermission` (or `requireActor` +
   `checkPermission` + `deniedResponse`).
5. Add tests for the allowed, denied, and scope-limited cases.
6. Update the mapping table in the `ACTIONS` doc comment.

## Validation

```bash
npm test -- tests/permissions.test.ts tests/permissions-server.test.ts
npm run typecheck
```

`tests/permissions.test.ts` covers the matrix as a pure module — including a
parity test asserting `getTelemetryCapabilities()` still reproduces the
hand-written capability table it replaced, value for value.
`tests/permissions-server.test.ts` covers the negative cases: forged, expired,
wrong-secret, unsigned and malformed tokens, ignored role headers, and the
`401` / `403` / `500` distinction.

## Known gaps

- `lib/policy-engine.ts` and `lib/invitations.ts` still carry their own role
  types and hierarchies. They are bridged by `normalizeRole()` (`user` →
  `contributor`, `operator` → `maintainer`) and share
  `canEscalateRole()`'s semantics, but they are business-rule and invitation-lifecycle
  logic respectively, not request authorization. Folding them in wholesale is
  follow-up work.
- The general user-facing routes (wallet, agents, referrals, waitlist) are not
  guarded by the matrix. They have no session layer to authorize against today;
  adding one is a larger piece of work than this change, and guessing at identity
  for them would be worse than leaving them alone.
- `features/agent-telemetry` still lets the operator pick a telemetry role from a
  client-side control. That is a local UI simulation only — it gates which
  controls are drawn, and the server no longer trusts it. Binding the picker to
  the caller's real role is follow-up work.
