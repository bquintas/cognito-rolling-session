# POC Demo Execution Logs — 2 June 2026 (Final Clean Run)

Correlated Lambda execution logs from the end-to-end demo.  
User: `testuser-poc@example.com` | Sub: `f2a5a454-5051-7082-a6de-efe36678ee68`

---

## Timeline Overview

| Time (UTC) | Action | Lambda | Result |
|------------|--------|--------|--------|
| 13:38:12 | Initial login (ADMIN_USER_PASSWORD_AUTH) | PostAuthentication | Renewal token issued ✅ |
| 13:38:15 | Fetch renewal token from API | FetchRenewalToken | Token delivered (one-time) ✅ |
| 13:38:16 | Second fetch attempt (replay test) | FetchRenewalToken | Rejected — 404 ✅ |
| 13:38:20 | Session renewal: InitiateAuth(CUSTOM_AUTH) | DefineAuthChallenge | Issued CUSTOM_CHALLENGE ✅ |
| 13:38:20 | Session renewal: challenge created | CreateAuthChallenge | Asked for renewal token ✅ |
| 13:38:23 | Session renewal: token verified | VerifyAuthChallenge | Token valid → rotated ✅ |
| 13:38:24 | Session renewal: tokens issued | DefineAuthChallenge | issueTokens=true ✅ |
| 13:38:24 | PostAuth on CUSTOM_AUTH success | PostAuthentication | **Skipped** (fix working) ✅ |
| 13:38:26 | Fetch rotated renewal token | FetchRenewalToken | New token delivered ✅ |
| 13:38:32 | Replay old renewal token | VerifyAuthChallenge | Invalid → rejected ✅ |

---

## Phase 1: Initial Login

**User action:** Login with email/password

### PostAuthentication Lambda
```
13:38:12.244Z  RequestId: 53778afc-b5ee-4b53-ad68-e7e5cdaada4f
INFO  Renewal token issued for user f2a5a454-5051-7082-a6de-efe36678ee68
Duration: 1045.29 ms (cold start: 543ms init)
```

**What happened:**
1. User authenticated with password → Cognito issued tokens (access, ID, refresh)
2. PostAuthentication trigger fired
3. Generated 256-bit random renewal token
4. Stored SHA-256 hash in DynamoDB with: `issuedAt`, `lastUsedAt`, `maxInactivityDays=30`, `ttl`
5. Stored plaintext as `pendingToken` for client pickup (5 min window)

---

## Phase 2: Client Fetches Renewal Token via API

**User action:** `GET /renewal-token` with ID token in Authorization header

### FetchRenewalToken — First call (success)
```
13:38:15.361Z  RequestId: 7136ed6d-1466-45c4-a62d-76de7c27c666
INFO  FetchRenewalToken invoked {"requestId":"c097b779-...","claims":"f2a5a454-..."}
13:38:16.393Z  INFO  Renewal token delivered to user f2a5a454-... (one-time pickup)
Duration: 1036.85 ms (cold start: 416ms init)
```

### FetchRenewalToken — Second call (rejected)
```
13:38:16.732Z  RequestId: 2d7c03fb-94a4-4810-acb0-b656f006b60f
INFO  FetchRenewalToken invoked {"requestId":"ab4ed3aa-...","claims":"f2a5a454-..."}
13:38:16.754Z  INFO  No pending renewal token for user f2a5a454-...
Duration: 42.80 ms
```

**One-time pickup enforced** — `pendingToken` was deleted after first fetch. Second call returns 404. ✅

---

## Phase 3: Silent Session Renewal (CUSTOM_AUTH)

**Scenario:** Refresh token has "expired" — app calls `InitiateAuth(CUSTOM_AUTH)`

### Step 3a: DefineAuthChallenge (issue challenge)
```
13:38:20  RequestId: 5e7f2869-1793-4ab7-8bd6-00b5c99ee99b
Duration: 3.24 ms (cold start: 157ms init)
```
→ Session empty → returned `challengeName: "CUSTOM_CHALLENGE"`

### Step 3b: CreateAuthChallenge
```
13:38:20  RequestId: 2d8116b9-8383-42a1-b8fc-91ab32c545d6
Duration: 18.22 ms (cold start: 109ms init)
```
→ Sent `{ challenge: "PROVIDE_RENEWAL_TOKEN" }` to client

### Step 3c: VerifyAuthChallenge (valid → rotated)
```
13:38:23.978Z  RequestId: a82db4b9-beae-417a-8b51-42b3415a097f
INFO  Renewal token rotated for user f2a5a454-5051-7082-a6de-efe36678ee68
Duration: 1072.07 ms (cold start: 520ms init)
```

**Checks performed:**
1. ✅ Token hash matches DynamoDB record
2. ✅ Inactivity window: `now - lastUsedAt` < 30 days
3. ✅ Absolute session: `now - issuedAt` < 90 days
4. → Generated new renewal token, stored new hash + `pendingToken`
5. → Returned `answerCorrect: true`

### Step 3d: DefineAuthChallenge (issue tokens)
```
13:38:24  RequestId: 77f5c4db-0dde-414a-98dc-4de06a39167d
Duration: 12.37 ms
```
→ Session has `CUSTOM_CHALLENGE` with `challengeResult: true` → `issueTokens: true`  
→ **Cognito issued fresh tokens (access 1h + ID 1h + refresh 30 days full reset)**

### PostAuthentication (SKIPPED ✅)
```
13:38:24.320Z  RequestId: 27b740b2-b7eb-43b9-a6cf-db0c81df01a1
INFO  Skipping renewal token issuance — VerifyAuthChallenge already rotated (0.4s ago) for user f2a5a454-5051-7082-a6de-efe36678ee68
Duration: 384.34 ms
```

**Fix confirmed working:** PostAuthentication detected that VerifyAuthChallenge wrote a `pendingToken` 0.4 seconds ago and correctly skipped duplicate issuance. No double-write. ✅

---

## Phase 4: Client Fetches Rotated Renewal Token

### FetchRenewalToken
```
13:38:26.034Z  RequestId: 559b80e4-594e-4b99-9c57-e21fb284c2e1
INFO  FetchRenewalToken invoked {"requestId":"e2b8c92b-...","claims":"f2a5a454-..."}
13:38:26.274Z  INFO  Renewal token delivered to user f2a5a454-... (one-time pickup)
Duration: 405.72 ms
```

Client received the rotated renewal token. Ready for next cycle. ✅

---

## Phase 5: Old Token Replay (Rejected)

### DefineAuthChallenge + CreateAuthChallenge (challenge issued)
```
13:38:30  RequestId: f8716c3b-...  Duration: 1.68 ms
13:38:30  RequestId: ef91af0e-...  Duration: 1.30 ms
```

### VerifyAuthChallenge (REJECTED)
```
13:38:32.099Z  RequestId: aa881f53-5d48-4363-9b8d-30276690e7a5
INFO  Invalid renewal token for user f2a5a454-5051-7082-a6de-efe36678ee68
Duration: 420.48 ms
```

### DefineAuthChallenge (fail auth)
```
13:38:32  RequestId: 2e9d46dd-...  Duration: 1.38 ms
```
→ `failAuthentication: true` — **stolen tokens are dead after rotation** ✅

---

## Performance Summary

| Lambda | Cold Start | Warm |
|--------|-----------|------|
| PostAuthentication | 543ms + 1045ms = **1.59s** | 384ms |
| DefineAuthChallenge | 157ms + 3ms = **160ms** | 1.4–12ms |
| CreateAuthChallenge | 109ms + 18ms = **127ms** | 1.3ms |
| VerifyAuthChallenge | 520ms + 1072ms = **1.59s** | 420ms |
| FetchRenewalToken | 416ms + 1037ms = **1.45s** | 43–406ms |

**Total silent renewal (warm):** ~820ms  
**User-perceived latency:** Zero — background operation.

---

## All Checks Passed

| Security Property | Evidence |
|-------------------|----------|
| ✅ Renewal token issued on login only | PostAuth @ 13:38:12 (issued), PostAuth @ 13:38:24 (skipped) |
| ✅ Secure one-time API delivery | Delivered @ 13:38:15, rejected @ 13:38:16 |
| ✅ Silent re-auth without UI | CUSTOM_AUTH @ 13:38:20–24, tokens issued |
| ✅ Full TTL reset on renewal | New refresh token with 30-day lifetime |
| ✅ Token rotation | "Rotated" @ 13:38:23 |
| ✅ Old token rejected | "Invalid" @ 13:38:32 |
| ✅ Inactivity timeout (30 days) | Checked in VerifyAuthChallenge |
| ✅ Absolute session limit (90 days) | Checked in VerifyAuthChallenge |
| ✅ No duplicate token issuance | PostAuth correctly skipped on CUSTOM_AUTH |
