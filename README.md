# POC: Cognito Rolling Session via Custom Auth

## What This Deploys

A fully self-contained stack you can deploy in any AWS account to demonstrate the rolling session mechanism:

- **Cognito User Pool** with Custom Auth Lambda triggers
- **DynamoDB table** for renewal token storage
- **API Gateway** (Cognito-authorized) for secure renewal token delivery
- **6 Lambda functions** covering the full lifecycle
- **Demo script** that walks through the entire flow with colored output and logging

## Structure

```
├── ARCHITECTURE.md             # Full technical design and flow documentation
├── README.md                   # This file (quick start + how to run)
├── demo-execution-logs.md      # Example run with correlated CloudWatch logs
├── lambdas/
│   ├── defineAuthChallenge.mjs     # Controls flow: 1 challenge → issue tokens
│   ├── createAuthChallenge.mjs     # Asks client for renewal token
│   ├── verifyAuthChallenge.mjs     # Validates against DynamoDB, rotates token
│   ├── postAuthentication.mjs      # Issues renewal token on initial login
│   ├── postConfirmation.mjs       # Revokes session on password change
│   └── fetchRenewalToken.mjs       # API handler: one-time token pickup
├── client-example/
│   └── renewSession.ts             # Client-side renewal logic (TypeScript)
├── infrastructure/
│   ├── template.yaml               # SAM template (full stack)
│   └── dynamodb-table.json         # Standalone DynamoDB (if deploying separately)
└── test-scripts/
    ├── deploy.sh                   # Deploy the stack
    ├── demo.sh                     # Run end-to-end demo with logging
    └── teardown.sh                 # Clean up everything
```

## Documentation

- **[ARCHITECTURE.md](./ARCHITECTURE.md)** — Full technical design: problem statement, flow diagrams, security properties, dual-expiry model, constraints, and cost estimate
- **[demo-execution-logs.md](./demo-execution-logs.md)** — Example demo run with correlated CloudWatch Lambda logs showing the exact invocation chain and timestamps

## Quick Start

### Prerequisites

- AWS SAM CLI (`brew install aws-sam-cli`)
- AWS CLI v2 configured with credentials
- `jq` installed (`brew install jq`)
- An AWS account (the stack is self-contained, no existing resources needed)

### Deploy

```bash
cd test-scripts
export AWS_REGION=eu-west-1
./deploy.sh
```

The deploy script outputs environment variables — copy/paste them.

### Run Demo

```bash
# Paste the exports from deploy.sh output, then:
./demo.sh
```

The demo walks through:

1. ✅ Creates a test user
2. ✅ Performs initial login → gets tokens
3. ✅ Fetches the renewal token from the API (one-time pickup)
4. ✅ Verifies one-time pickup enforcement
5. ✅ Performs **silent session renewal** via `CUSTOM_AUTH` + renewal token
6. ✅ Fetches the **rotated** renewal token
7. ✅ Verifies old token is **invalidated**
8. ✅ **Session revocation** — deletes DynamoDB record, proves valid token is rejected

Each step shows colored output with timestamps. After the demo, check CloudWatch Logs for detailed Lambda traces.

### Observe Logs

Open CloudWatch Log Groups in the AWS Console:

| Log Group | What to Look For |
|-----------|-----------------|
| `/aws/lambda/cognito-define-auth-challenge-poc` | Session array progression |
| `/aws/lambda/cognito-create-auth-challenge-poc` | Challenge issued to client |
| `/aws/lambda/cognito-verify-auth-challenge-poc` | Token validation + rotation |
| `/aws/lambda/cognito-post-authentication-poc` | Initial token issuance |
| `/aws/lambda/cognito-fetch-renewal-token-poc` | One-time token delivery |

### Teardown

```bash
./teardown.sh
```

## How It Proves the Rolling Session

| What the Demo Shows | Why It Matters |
|---------------------|---------------|
| Fresh tokens issued via CUSTOM_AUTH without user interaction | Session "rolls" without a login screen |
| Refresh token in the response has full TTL (30 days) | Clock resets on each renewal |
| Renewal token rotated after each use | Stolen tokens are useless |
| Old renewal token rejected | Forward secrecy |
| API returns 404 on second fetch | One-time pickup prevents replay |
| Absolute session cap enforced (90 days) | Even active users must re-auth eventually (compliance) |
| Session revocation via DynamoDB delete | Admins can instantly kill any session |

## Customization

| Parameter | Where to Change | Default |
|-----------|----------------|---------|
| Inactivity window | `template.yaml` → `MaxInactivityDays` | 30 days |
| Absolute session limit | `template.yaml` → `MaxAbsoluteSessionDays` | 90 days |
| Inactivity policy mode | `template.yaml` → `InactivityPolicyMode` | `enforced` (tightening applies immediately) |
| Refresh token TTL | `template.yaml` → `RefreshTokenValidityDays` | 30 days |
| Pending token pickup window | DynamoDB TTL + application-level TTL check in `fetchRenewalToken` | 5 minutes |
| Region | `deploy.sh` → `AWS_REGION` | eu-west-1 |

For a full explanation of the two-timer expiry model (inactivity + absolute), see [ARCHITECTURE.md](./ARCHITECTURE.md).

## Limitations (POC vs Production)

| POC | Production Needs |
|-----|-----------------|
| Uses `ADMIN_USER_PASSWORD_AUTH` for demo simplicity | Use SRP or managed login for initial auth |
| Single renewal token per user (last login wins) | Multi-device: one token per (user, device) pair |
| No monitoring/alerting | CloudWatch alarms on failed renewals, DynamoDB throttling |
| No WAF protection on API | Add WAF rules to prevent brute-force on renewal endpoint |
| No CloudWatch Log encryption/retention configured | Add explicit LogGroups with KMS + retention policy |
| No API Gateway access logging | Add AccessLogSetting for HTTP-level audit trail |
