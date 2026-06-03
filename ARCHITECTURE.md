# Architecture: Cognito Rolling Session via Custom Auth

## Problem

Cognito refresh tokens have a fixed absolute expiration (no rolling/inactivity-based option). The managed login session cookie is hardcoded at 1 hour. This POC implements a **self-managed renewal token** via Cognito's Custom Auth flow that provides rolling inactivity + absolute session limits.

## How It Works

**Initial login:** User authenticates normally (SRP) → PostAuthentication Lambda issues a renewal token (SHA-256 hash stored in DynamoDB, plaintext in a separate `pending#` item with 5-min TTL). Client picks it up via `GET /renewal-token`.

**Session renewal:** When the Cognito refresh token expires, the client calls `InitiateAuth(CUSTOM_AUTH)` → VerifyAuthChallenge validates the renewal token against DynamoDB, checks both expiry windows, then **atomically** rotates the token via `TransactWriteItems` (session record + new pending item). Cognito issues a fresh token set with full TTL.

**Expiry:** Two independent clocks:
- **Inactivity timeout** (default 30 days): resets on each renewal. Configurable policy mode — `enforced` applies tightening immediately, `permissive` honors the value at session creation.
- **Absolute limit** (default 90 days): never resets. `issuedAt` preserved across all rotations. Forces re-auth regardless of activity.

**Revocation:** Delete the DynamoDB session record → next renewal attempt fails immediately.

## Data Model (Single DynamoDB Table)

**Session records** — PK: `userSub`

| Field | Purpose |
|-------|---------|
| tokenHash | SHA-256 of current renewal token |
| issuedAt | Original login timestamp (never resets) |
| lastUsedAt | Last successful renewal |
| rotatedAt | Timestamp of last VerifyAuth rotation (PostAuth skip detection) |
| maxInactivityDays | Inactivity window at creation time |
| ttl | DynamoDB TTL (lastUsedAt + inactivity window) |

**Pending tokens** — PK: `pending#<userSub>`

| Field | Purpose |
|-------|---------|
| pendingToken | Plaintext for one-time client pickup |
| ttl | 5-minute DynamoDB TTL (auto-deleted) |

## Security Properties

| Property | Implementation |
|----------|---------------|
| Rolling inactivity window | `lastUsedAt` vs `maxInactivityDays` (policy-mode aware) |
| Absolute session cap | `issuedAt` vs `MAX_ABSOLUTE_SESSION_DAYS` (never resets) |
| Atomic token rotation | `TransactWriteItems` — session + pending token written together or not at all |
| Concurrent rotation protection | `ConditionExpression` on `tokenHash` within the transaction |
| PostAuth race immunity | Checks `rotatedAt` on session record (not dependent on pending item existence) |
| Constant-time hash comparison | `crypto.timingSafeEqual` |
| One-time token delivery | Pending item deleted on fetch; app-level TTL check rejects expired tokens |
| Stolen token detection | Old hash invalidated immediately on rotation |
| Hash-only storage | DynamoDB stores SHA-256 hash, never plaintext (pending items auto-expire in 5 min) |
| Least-privilege IAM | Each Lambda scoped to only the DynamoDB actions it needs |
| User enumeration prevention | `PreventUserExistenceErrors: ENABLED` on UserPoolClient |

## Session Revocation

```bash
# Kill a user's session (forces full re-authentication)
aws dynamodb delete-item \
  --table-name "CognitoRenewalTokens-poc" \
  --key '{"userSub": {"S": "<user-sub>"}}' \
  --region eu-west-1

# Also delete any pending pickup token
aws dynamodb delete-item \
  --table-name "CognitoRenewalTokens-poc" \
  --key '{"userSub": {"S": "pending#<user-sub>"}}' \
  --region eu-west-1

# Optionally also invalidate Cognito's own refresh token
aws cognito-idp admin-user-global-sign-out \
  --user-pool-id "<pool-id>" --username "<email>" --region eu-west-1
```

## Configuration

| Parameter | Default | Notes |
|-----------|---------|-------|
| `MaxInactivityDays` | 30 | Rolling window (resets on renewal) |
| `MaxAbsoluteSessionDays` | 90 | Hard cap (never resets) |
| `InactivityPolicyMode` | `enforced` | `enforced` = min(env, DB); `permissive` = DB value only |
| `RefreshTokenValidityDays` | 30 | Cognito refresh token TTL |
| Pending token pickup | 5 min | DynamoDB TTL + app-level check |
| Access/ID token TTL | 1 hour | Standard Cognito default |

## Key Constraints

- Custom Auth is **SDK-only** — cannot use managed login/hosted UI for the renewal flow
- `CUSTOM_AUTH` is a full authentication — Cognito issues a brand new refresh token with full TTL
- PostAuthentication fires on all successful auths (including CUSTOM_AUTH) — Lambda uses `rotatedAt` + `ConditionExpression` to avoid clobbering
- Renewal token delivery via API Gateway (`GET /renewal-token`, Cognito Authorizer)
- DynamoDB TTL deletion can lag up to 48h — app-level TTL check enforces the 5-min window

## Cost

< $1/month for 10K users (5 Lambdas at 128MB + DynamoDB on-demand + API Gateway). Scales linearly.

## References

- [Custom Auth Challenge Triggers](https://docs.aws.amazon.com/cognito/latest/developerguide/user-pool-lambda-challenge.html)
- [Refresh Token Docs](https://docs.aws.amazon.com/cognito/latest/developerguide/amazon-cognito-user-pools-using-the-refresh-token.html)
- [Managed Login Session (1h, non-configurable)](https://docs.aws.amazon.com/cognito/latest/developerguide/cognito-user-pools-managed-login.html)
