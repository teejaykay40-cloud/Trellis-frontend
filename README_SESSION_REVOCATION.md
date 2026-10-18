# Session Revocation Implementation

This document covers the implementation details for Issue #334: Implement stale session and token revocation after security events.

## Persistence
To avoid memory leaks and state loss on server restarts, the `SessionRevocationManager` uses `CacheManager` (`lib/cache-manager.ts`). It handles saving and matching requests. This avoids keeping revocations entirely in memory, handles potential garbage collection properly using the underlying persistent cache mechanism, and operates correctly across serverless boundaries where appropriate.

## Token Metadata
The JWT issuing process (`lib/auth/actor.ts`) was updated to include an `iat` (issued at) claim. The authentication middleware (`requireActor` and `requirePermission` in `lib/auth/guard.ts`) *awaits* checking the token's issuance time against the latest cached revocation timestamp.

If `tokenIssuedAt < revocation.revokedAt`, the token is deemed stale, and the request is rejected with a 401 Unauthorized (`revoked_token` error).

## Edge Cases
- Tokens issued before the revocation framework was added lack an `iat` claim. The validator falls back to treating `iat` as `0`, which safely renders them "stale" immediately if a revocation has been posted for that user.
- If the `CacheManager` throws an exception (e.g. storage unavailability), the check gracefully handles it by returning `false` (fail-open) to maintain operations, rather than creating a global DoS.
