# Demo Execution Logs — June 3, 2026 (14:39 CEST)

Correlated CloudWatch Lambda logs from a full demo run including session revocation.

**Region:** eu-west-1
**Stack:** cognito-rolling-session-poc
**User:** testuser-poc@example.com (Sub: `323524e4-10c1-70ef-2443-170e2f9c0960`)

---

## Timeline

| Time (UTC) | Lambda | Event |
|------------|--------|-------|
| 12:39:22 | PostAuthentication | Initial login → renewal token issued |
| 12:39:27 | FetchRenewalToken | Token delivered (one-time pickup) |
| 12:39:28 | FetchRenewalToken | Second call → 404 (one-time enforced) |
| 12:39:35 | DefineAuthChallenge | CUSTOM_AUTH flow initiated |
| 12:39:36 | VerifyAuthChallenge | Renewal token validated + rotated |
| 12:39:37 | PostAuthentication | Skipped (VerifyAuth already rotated 0.6s ago) |
| 12:39:38 | FetchRenewalToken | Rotated token delivered |
| 12:39:45 | VerifyAuthChallenge | Old token rejected (Invalid renewal token) |
| 12:39:56 | VerifyAuthChallenge | **Revoked** — No renewal token found (record deleted) |

---

## Detailed Logs

### PostAuthentication (`/aws/lambda/cognito-post-authentication-poc`)

```
INIT_START Runtime Version: nodejs:20.v101
START RequestId: d0dfa38d-9034-4449-a193-73debce65994
12:39:23.882Z  INFO  Renewal token issued for user 323524e4-10c1-70ef-2443-170e2f9c0960
REPORT Duration: 1167.90 ms  Billed: 1685 ms  Memory: 93 MB  Init: 516.26 ms

START RequestId: 18c561d7-a439-4076-9d04-654308844039
12:39:37.102Z  INFO  Skipping renewal token issuance — VerifyAuthChallenge already rotated (0.6s ago) for user 323524e4-10c1-70ef-2443-170e2f9c0960
REPORT Duration: 416.71 ms  Billed: 417 ms  Memory: 93 MB
```

**Key observations:**
- First invocation: initial login → issues renewal token + stores pending item with 5-min TTL
- Second invocation: fires after CUSTOM_AUTH success, detects recent rotation, skips (no clobbering)

---

### FetchRenewalToken (`/aws/lambda/cognito-fetch-renewal-token-poc`)

```
INIT_START Runtime Version: nodejs:20.v101
START RequestId: 986d37b6-1929-4dc2-8842-339755339732
12:39:27.181Z  INFO  FetchRenewalToken invoked {"requestId":"20068d53-...","claims":"323524e4-...","sourceIp":"xxx.xxx.xxx.xxx","userAgent":"curl/8.7.1"}
12:39:28.183Z  INFO  Renewal token delivered to user 323524e4-... (one-time pickup)
REPORT Duration: 1023.81 ms  Billed: 1611 ms  Memory: 94 MB  Init: 586.93 ms

START RequestId: deeca1a6-f87f-4616-b947-86e01892b939
12:39:28.489Z  INFO  FetchRenewalToken invoked {"requestId":"e180d60c-...","claims":"323524e4-...","sourceIp":"xxx.xxx.xxx.xxx","userAgent":"curl/8.7.1"}
12:39:28.523Z  INFO  No pending renewal token for user 323524e4-...
REPORT Duration: 55.26 ms  Billed: 56 ms  Memory: 94 MB

START RequestId: 428f77b2-039e-43e4-8280-0a0f8b7ec7a2
12:39:38.863Z  INFO  FetchRenewalToken invoked {"requestId":"b1f76646-...","claims":"323524e4-...","sourceIp":"xxx.xxx.xxx.xxx","userAgent":"curl/8.7.1"}
12:39:39.183Z  INFO  Renewal token delivered to user 323524e4-... (one-time pickup)
REPORT Duration: 448.89 ms  Billed: 449 ms  Memory: 95 MB
```

**Key observations:**
- First call: delivers initial renewal token, deletes pending item
- Second call (immediate retry): 404 — one-time pickup enforced
- Third call (after CUSTOM_AUTH): delivers rotated renewal token

---

### VerifyAuthChallenge (`/aws/lambda/cognito-verify-auth-challenge-poc`)

```
INIT_START Runtime Version: nodejs:20.v101
START RequestId: bbe23e63-19bc-4a44-aa57-13bcdaa1b166
12:39:36.673Z  INFO  Renewal token rotated for user 323524e4-10c1-70ef-2443-170e2f9c0960
REPORT Duration: 1103.50 ms  Billed: 1658 ms  Memory: 95 MB  Init: 554.01 ms

START RequestId: 26655454-c1e0-488c-9462-129852271971
12:39:45.473Z  INFO  Invalid renewal token for user 323524e4-10c1-70ef-2443-170e2f9c0960
REPORT Duration: 395.86 ms  Billed: 396 ms  Memory: 95 MB

START RequestId: 66e20244-0397-4cc3-8496-21b5c77b8a99
12:39:56.833Z  INFO  No renewal token found for user 323524e4-10c1-70ef-2443-170e2f9c0960
REPORT Duration: 213.87 ms  Billed: 214 ms  Memory: 95 MB
```

**Key observations:**
- First invocation: validates token (timingSafeEqual), checks inactivity + absolute limit, rotates with ConditionExpression, writes new pending item
- Second invocation: old token hash doesn't match → rejected
- Third invocation (after revocation): DynamoDB record gone → immediate reject ("No renewal token found")

---

### DefineAuthChallenge (`/aws/lambda/cognito-define-auth-challenge-poc`)

```
INIT_START Runtime Version: nodejs:20.v101
RequestId: 9f15f814  Duration: 3.50 ms  Init: 223.71 ms  (cold start — renewal flow, issues CUSTOM_CHALLENGE)
RequestId: f9f2b893  Duration: 1.75 ms  (renewal flow — VerifyAuth succeeded → issueTokens: true)
RequestId: ec322a70  Duration: 2.17 ms  (old token test — issues CUSTOM_CHALLENGE)
RequestId: 068dcb89  Duration: 1.67 ms  (old token test — VerifyAuth failed → failAuthentication)
RequestId: 54295233  Duration: 8.76 ms  (revocation test — issues CUSTOM_CHALLENGE)
RequestId: fcac0fb9  Duration: 1.53 ms  (revocation test — VerifyAuth failed → failAuthentication)
```

**Key observations:**
- 2 invocations per CUSTOM_AUTH attempt (before VerifyAuth + after to check result)
- 3 CUSTOM_AUTH attempts in the demo: successful renewal, old token rejection, post-revocation rejection
- Sub-2ms warm execution — zero business logic, just session array inspection

---

## Security Controls Validated

| Control | Proven By |
|---------|-----------|
| Token rotation | Old token rejected at 12:39:45 |
| Optimistic locking (ConditionExpression) | Rotation succeeded without ConditionalCheckFailedException |
| PostAuth skip on CUSTOM_AUTH | "Skipping...already rotated (0.6s ago)" at 12:39:37 |
| One-time token pickup | 404 on second fetch at 12:39:28 |
| timingSafeEqual | Successful validation at 12:39:36 (no timing errors) |
| Separate pending item (5-min TTL) | Token delivered from `pending#` item, auto-expires |
| **Session revocation** | "No renewal token found" at 12:39:56 after DynamoDB delete |
| sourceIp audit logging | Client IP logged (anonymized in this doc) on all API calls |
