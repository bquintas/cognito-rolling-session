# Architecture: Cognito Rolling Session via Custom Auth

## Problem Statement

Amazon Cognito refresh tokens have a fixed absolute expiration (configurable from 60 minutes to 10 years). There is no native "rolling" or "inactivity-based" expiration — the token expires at the same time regardless of user activity. The managed login session cookie is hardcoded at 1 hour and not configurable.

Requirements:
- Users stay logged in as long as they are active
- Inactive users are forced to re-authenticate after a configurable inactivity window
- No visible login screen for active users when the Cognito refresh token expires
- Even active users must re-authenticate after an absolute session cap (compliance)

## Solution Overview

Implement a **self-managed renewal token** validated through Cognito's Custom Auth (CUSTOM_AUTH) flow. When the Cognito refresh token expires, the app silently performs a full re-authentication using the renewal token, obtaining a brand new set of tokens with a fully reset TTL.

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────────┐
│ CLIENT (Mobile / Web App)                                                │
│                                                                          │
│  Normal Operation:                                                       │
│    refresh_token → GetTokensFromRefreshToken → new access/ID tokens      │
│                                                                          │
│  When refresh token expired or near expiry:                              │
│    renewal_token → InitiateAuth(CUSTOM_AUTH) → fresh token set           │
│                     └→ RespondToAuthChallenge(renewal_token)              │
│                                                                          │
└──────────────────────────────────┬───────────────────────────────────────┘
                                   │
                    ┌──────────────▼──────────────────┐
                    │     COGNITO USER POOL            │
                    │                                  │
                    │  ┌────────────────────────────┐  │
                    │  │ Post Authentication Lambda │──┼──→ Issues initial renewal_token
                    │  └────────────────────────────┘  │
                    │                                  │
                    │  ┌────────────────────────────┐  │
                    │  │ Define Auth Challenge      │  │   Controls flow: 1 challenge → issue tokens
                    │  └────────────────────────────┘  │
                    │                                  │
                    │  ┌────────────────────────────┐  │
                    │  │ Create Auth Challenge      │  │   Asks client for renewal_token
                    │  └────────────────────────────┘  │
                    │                                  │
                    │  ┌────────────────────────────┐  │
                    │  │ Verify Auth Challenge      │──┼──→ Validates against DynamoDB
                    │  └────────────────────────────┘  │
                    │                                  │
                    └──────────────────┬───────────────┘
                                       │
                    ┌──────────────────▼───────────────┐
                    │         DynamoDB Table            │
                    │   "CognitoRenewalTokens"         │
                    │                                   │
                    │  Session records (PK: userSub):   │
                    │    tokenHash (String, SHA-256)    │
                    │    issuedAt (Number, epoch ms)    │
                    │    lastUsedAt (Number, epoch ms)  │
                    │    maxInactivityDays (Number)     │
                    │    ttl (Number, DynamoDB TTL)     │
                    │    deviceId (String, optional)    │
                    │                                   │
                    │  Pending tokens (PK: pending#sub):│
                    │    pendingToken (String, plain)   │
                    │    ttl (Number, 5-min DynamoDB)   │
                    └──────────────────────────────────┘
```

```
                    ┌──────────────────────────────────┐
                    │     API Gateway + Lambda          │
                    │   "FetchRenewalToken"             │
                    │                                   │
                    │  GET /renewal-token               │
                    │  Auth: Cognito Authorizer (ID)    │
                    │  → One-time pickup of new token   │
                    └──────────────────────────────────┘
```

## Flow Detail

### 1. Initial Login (Normal Authentication)

1. User logs in via username/password (SRP, managed login, or SDK)
2. Cognito issues: access token, ID token, refresh token (TTL = 30 days)
3. **Post Authentication Lambda** fires:
   - Generates a cryptographically random 256-bit `renewal_token`
   - Stores SHA-256 hash in DynamoDB (session record) with `issuedAt = now`, `lastUsedAt = now`, `maxInactivityDays = 30`
   - Stores plaintext as a **separate DynamoDB item** (`pending#<userSub>`) with a 5-minute TTL (auto-deleted by DynamoDB)
   - Skips issuance if triggered by CUSTOM_AUTH (detects recently-written pending item)
4. Client calls `GET /renewal-token` (API Gateway, protected by Cognito Authorizer):
   - Returns `pendingToken` once then deletes it (one-time pickup)
   - Client stores `renewal_token` securely:
     - iOS: Keychain
     - Android: EncryptedSharedPreferences
     - Web: HttpOnly Secure cookie (separate domain/path from main app)

### 2. Normal Operation (Refresh Token Still Valid)

1. Access token expires (e.g., every 60 min)
2. App calls `GetTokensFromRefreshToken` with the refresh token
3. Receives new access + ID tokens (and optionally rotated refresh token)
4. App updates `lastUsedAt` in DynamoDB (via a lightweight API call or Lambda)

### 3. Session Renewal (Refresh Token Expired)

1. App detects refresh token is expired (or will expire within buffer period)
2. App initiates silent re-authentication:
   ```
   InitiateAuth({
     AuthFlow: "CUSTOM_AUTH",
     ClientId: "app-client-id",
     AuthParameters: {
       USERNAME: "user@example.com"
     }
   })
   ```
3. Cognito invokes **Define Auth Challenge** → issues `CUSTOM_CHALLENGE`
4. Cognito invokes **Create Auth Challenge** → sends `{ challenge: "PROVIDE_RENEWAL_TOKEN" }`
5. App responds:
   ```
   RespondToAuthChallenge({
     ChallengeName: "CUSTOM_CHALLENGE",
     ChallengeResponses: {
       USERNAME: "user@example.com",
       ANSWER: "<stored_renewal_token>"
     }
   })
   ```
6. Cognito invokes **Verify Auth Challenge**:
   - Hashes provided token → compares with DynamoDB record (`timingSafeEqual`)
   - Checks `(now - lastUsedAt) < maxInactivityDays` (rolling, policy-mode aware)
   - Checks `(now - issuedAt) < MAX_ABSOLUTE_SESSION_DAYS` (hard cap, 90 days)
   - If valid: **atomically** rotates the renewal token via `TransactWriteItems` (session record + pending token in one transaction, with `ConditionExpression` on `tokenHash`)
   - Sets `rotatedAt = now` on the session record (used by PostAuth to detect recent rotation)
   - If concurrent rotation detected (transaction cancelled): returns `answerCorrect: false`
   - If invalid or expired: returns `answerCorrect: false` → user must re-login
7. Cognito invokes **Define Auth Challenge** → sees success → `issueTokens: true`
8. Cognito issues **fresh tokens** (access + ID + refresh with full 30-day TTL)
9. **Post Authentication Lambda** fires but **skips** issuance (detects `rotatedAt` within last 30s on the session record — immune to pending token already being fetched by client)
10. Client calls `GET /renewal-token` to pick up the rotated token (one-time, with application-level TTL enforcement)

### 4. Forced Re-authentication (Inactive User)

If a user hasn't used the app for more than `maxInactivityDays`:
1. The Verify Auth Challenge Lambda rejects the renewal token
2. `InitiateAuth` returns an auth failure
3. App redirects to login screen
4. User must authenticate interactively (username/password, MFA, etc.)

### 5. Forced Re-authentication (Absolute Session Limit)

If a user's session exceeds `MAX_ABSOLUTE_SESSION_DAYS` (even if active daily):
1. The Verify Auth Challenge Lambda checks `issuedAt` against the 90-day cap
2. Rejects the renewal and deletes the DynamoDB record
3. App redirects to login screen
4. User re-authenticates → new `issuedAt` starts the 90-day clock from zero

## Session Revocation (Manual)

If a renewal token is compromised or a user needs to be force-logged-out, delete their session record from DynamoDB:

```bash
# Revoke a specific user's session (forces full re-authentication)
aws dynamodb delete-item \
  --table-name "CognitoRenewalTokens-poc" \
  --key '{"userSub": {"S": "<user-sub-uuid>"}}' \
  --region eu-west-1

# Also delete any pending token (if pickup hasn't happened yet)
aws dynamodb delete-item \
  --table-name "CognitoRenewalTokens-poc" \
  --key '{"userSub": {"S": "pending#<user-sub-uuid>"}}' \
  --region eu-west-1
```

After deletion, the next renewal attempt will fail (`No renewal token found`) and the user will be redirected to the login screen.

To additionally invalidate Cognito's own refresh token (belt-and-suspenders):

```bash
aws cognito-idp admin-user-global-sign-out \
  --user-pool-id "<user-pool-id>" \
  --username "<user-email>" \
  --region eu-west-1
```

For production, consider adding a `DELETE /renewal-token` admin endpoint or a revocation flag in the DynamoDB record.

## Security Properties

| Property | Implementation |
|----------|---------------|
| Rolling inactivity window | `lastUsedAt` checked against `maxInactivityDays` (policy-mode configurable) |
| Absolute session cap | `issuedAt` checked against `MAX_ABSOLUTE_SESSION_DAYS` (never resets, preserved across rotations and PostAuth re-issuance) |
| Atomic token rotation | `TransactWriteItems` ensures session record + pending token are written together — no partial failures |
| Concurrent rotation protection | `ConditionExpression` on `tokenHash` within the transaction; PostAuth uses `ConditionExpression` on `lastUsedAt` |
| Robust PostAuth skip | Checks `rotatedAt` marker on session record (immune to client fetching pending token before PostAuth fires) |
| Constant-time hash comparison | `crypto.timingSafeEqual` prevents timing side-channel on token validation |
| Stolen token detection | Old token invalidated immediately on rotation |
| Hash-only storage | DynamoDB stores SHA-256 hash, never plaintext |
| One-time token delivery | `pendingToken` item deleted after first `GET /renewal-token` call; DynamoDB TTL auto-deletes after 5 minutes if uncollected |
| Expired token cleanup | Application-level TTL check in `fetchRenewalToken` + DynamoDB TTL as backup — expired tokens never served |
| Revocation | Delete DynamoDB record → user must re-auth |
| No duplicate issuance | PostAuth checks `rotatedAt` on session record (not dependent on pending token existence); `ConditionExpression` as fallback |
| Least-privilege IAM | Each Lambda scoped to only the DynamoDB actions it uses |
| Device binding (optional) | Tie renewal token to device fingerprint |
| MFA enforcement (optional) | Force MFA every N renewals via counter in DynamoDB |

## Key Technical Constraints

| Constraint | Detail |
|-----------|--------|
| Custom Auth is SDK-only | Cannot use managed login/hosted UI for the renewal flow. Client must use AWS SDK or Amplify. |
| Separate app client recommended | Use one app client for normal login (with managed login) and another for CUSTOM_AUTH renewal. Cognito allows multiple app clients per user pool. |
| Refresh token rotation + CUSTOM_AUTH | CUSTOM_AUTH is a full authentication — Cognito issues a brand new refresh token with full TTL. Rotation settings don't affect this path. ✅ |
| Renewal token delivery | Via authenticated API Gateway endpoint (`GET /renewal-token`). Protected by Cognito Authorizer (ID token). One-time pickup enforced. |
| PostAuth Lambda on CUSTOM_AUTH | Cognito fires PostAuthentication on all successful auths including CUSTOM_AUTH. Lambda detects and skips to avoid overwriting VerifyAuthChallenge's rotation. |
| DynamoDB TTL | Set a TTL attribute = `lastUsedAt + maxInactivityDays` so expired records are auto-cleaned. |

## Configuration

| Parameter | Recommended Value | Rationale |
|-----------|-------------------|-----------|
| Cognito refresh token TTL | 30 days | Short enough to satisfy compliance; configurable |
| Cognito access/ID token TTL | 60 minutes | Standard |
| `maxInactivityDays` in DynamoDB | 30 days | Rolling — resets on each renewal |
| `INACTIVITY_POLICY_MODE` | `enforced` | `enforced` = policy tightening applies immediately (uses min of env var and DB); `permissive` = existing sessions keep their original window |
| `MAX_ABSOLUTE_SESSION_DAYS` | 90 days | Hard cap — even active users must re-auth after this |
| Renewal token length | 256 bits (32 bytes hex) | Cryptographically strong |
| Buffer before expiry to trigger renewal | 24 hours | Avoids race conditions |

### Two-Timer Expiry Model

```
Day 0          Day 30          Day 60          Day 90
│               │               │               │
├── Inactivity ─┤  (resets)     │               │
│    timeout    ├── Inactivity ─┤  (resets)     │
│               │    timeout    ├── Inactivity ─┤
│               │               │    timeout    │
├───────────────┴───────────────┴───────────────┤
│         Absolute session limit (90 days)       │
│         NEVER resets — forces re-auth          │
└────────────────────────────────────────────────┘
```

- **Inactivity timeout (30 days):** If user doesn't renew within 30 days → forced login
- **Absolute limit (90 days):** Even daily users must re-authenticate after 90 days from first login
- Both configurable per security/compliance policy

## Cost Estimate (Minimal)

| Component | Cost |
|-----------|------|
| 5 Lambda functions (128MB, <1s each) | ~$0.50/month for 10K users |
| DynamoDB table (on-demand, ~1KB per user) | ~$0.25/month |
| API Gateway (renewal token fetch, ~10K requests/month) | ~$0.03/month |
| **Total** | **< $1/month** |

Scales linearly. Even at 1M users, stays under $100/month.

## References

- [Cognito Custom Authentication Challenge Lambda Triggers](https://docs.aws.amazon.com/cognito/latest/developerguide/user-pool-lambda-challenge.html)
- [Cognito Refresh Token Documentation](https://docs.aws.amazon.com/cognito/latest/developerguide/amazon-cognito-user-pools-using-the-refresh-token.html)
- [Cognito Authorize Endpoint - prompt=none](https://docs.aws.amazon.com/cognito/latest/developerguide/authorization-endpoint.html)
- [Managed Login Session Cookie (1 hour, non-configurable)](https://docs.aws.amazon.com/cognito/latest/developerguide/cognito-user-pools-managed-login.html)
