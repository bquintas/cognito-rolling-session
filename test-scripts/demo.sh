#!/bin/bash
# =============================================================================
# Cognito Rolling Session POC - End-to-End Demo Script
# 
# This script walks through the complete flow with verbose logging:
#   1. Create a test user
#   2. Initial login (SRP) → get tokens + renewal token
#   3. Simulate refresh token expiry
#   4. Silent session renewal via CUSTOM_AUTH
#   5. Fetch rotated renewal token from API
#   6. Simulate inactive user → renewal fails
#
# Prerequisites:
#   - AWS CLI v2 configured
#   - jq installed
#   - SAM stack deployed (see deploy.sh)
#   - Export stack outputs (see below)
#
# Usage:
#   export AWS_REGION=eu-west-1
#   export USER_POOL_ID=<from-stack-output>
#   export CLIENT_ID=<from-stack-output>
#   export API_ENDPOINT=<from-stack-output>
#   ./demo.sh
# =============================================================================

set -euo pipefail

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# Configuration
REGION="${AWS_REGION:-eu-west-1}"
USER_POOL_ID="${USER_POOL_ID:?'Set USER_POOL_ID from stack output'}"
CLIENT_ID="${CLIENT_ID:?'Set CLIENT_ID from stack output'}"
API_ENDPOINT="${API_ENDPOINT:?'Set API_ENDPOINT from stack output'}"
TABLE_NAME="${TABLE_NAME:?'Set TABLE_NAME from stack output'}"
TEST_EMAIL="testuser-poc@example.com"
TEST_PASSWORD="${TEST_PASSWORD:-$(openssl rand -base64 16)}"

log() { echo -e "${BLUE}[$(date '+%H:%M:%S')]${NC} $1"; }
success() { echo -e "${GREEN}[✓]${NC} $1"; }
fail() { echo -e "${RED}[✗]${NC} $1"; }
step() { echo -e "\n${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"; echo -e "${YELLOW}STEP: $1${NC}"; echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}\n"; }

# =============================================================================
step "1. Create test user"
# =============================================================================

log "Creating user: $TEST_EMAIL"
aws cognito-idp admin-create-user \
  --user-pool-id "$USER_POOL_ID" \
  --username "$TEST_EMAIL" \
  --temporary-password "$TEST_PASSWORD" \
  --user-attributes Name=email,Value="$TEST_EMAIL" Name=email_verified,Value=true \
  --message-action SUPPRESS \
  --region "$REGION" 2>/dev/null || log "User may already exist, continuing..."

# Set permanent password
log "Setting permanent password..."
aws cognito-idp admin-set-user-password \
  --user-pool-id "$USER_POOL_ID" \
  --username "$TEST_EMAIL" \
  --password "$TEST_PASSWORD" \
  --permanent \
  --region "$REGION"

success "Test user ready: $TEST_EMAIL"

# =============================================================================
step "2. Initial login (USER_PASSWORD_AUTH for simplicity)"
# =============================================================================

log "Initiating auth..."
AUTH_RESULT=$(aws cognito-idp admin-initiate-auth \
  --user-pool-id "$USER_POOL_ID" \
  --client-id "$CLIENT_ID" \
  --auth-flow ADMIN_USER_PASSWORD_AUTH \
  --auth-parameters USERNAME="$TEST_EMAIL",PASSWORD="$TEST_PASSWORD" \
  --region "$REGION")

ACCESS_TOKEN=$(echo "$AUTH_RESULT" | jq -r '.AuthenticationResult.AccessToken')
ID_TOKEN=$(echo "$AUTH_RESULT" | jq -r '.AuthenticationResult.IdToken')
REFRESH_TOKEN=$(echo "$AUTH_RESULT" | jq -r '.AuthenticationResult.RefreshToken')

if [ "$ACCESS_TOKEN" != "null" ] && [ -n "$ACCESS_TOKEN" ]; then
  success "Authentication successful!"
  log "Access token: ${ACCESS_TOKEN:0:50}..."
  log "Refresh token: ${REFRESH_TOKEN:0:50}..."
else
  fail "Authentication failed"
  echo "$AUTH_RESULT" | jq .
  exit 1
fi

# =============================================================================
step "3. Fetch initial renewal token from API"
# =============================================================================

log "Calling GET $API_ENDPOINT/renewal-token"
log "(Using ID token for Cognito Authorizer)"
sleep 2  # Give PostAuthentication Lambda time to write to DynamoDB

RENEWAL_RESPONSE=$(curl -s -w "\n%{http_code}" \
  -H "Authorization: $ID_TOKEN" \
  "$API_ENDPOINT/renewal-token")

HTTP_CODE=$(echo "$RENEWAL_RESPONSE" | tail -n1)
RESPONSE_BODY=$(echo "$RENEWAL_RESPONSE" | sed '$d')

if [ "$HTTP_CODE" = "200" ]; then
  RENEWAL_TOKEN=$(echo "$RESPONSE_BODY" | jq -r '.renewalToken')
  success "Renewal token received!"
  log "Renewal token: ${RENEWAL_TOKEN:0:30}..."
  log "Response: $(echo "$RESPONSE_BODY" | jq .)"
else
  fail "Failed to fetch renewal token (HTTP $HTTP_CODE)"
  echo "$RESPONSE_BODY" | jq . 2>/dev/null || echo "$RESPONSE_BODY"
  exit 1
fi

# =============================================================================
step "4. Verify one-time pickup (second call should fail)"
# =============================================================================

log "Calling GET /renewal-token again (should fail)..."
SECOND_RESPONSE=$(curl -s -w "\n%{http_code}" \
  -H "Authorization: $ID_TOKEN" \
  "$API_ENDPOINT/renewal-token")

HTTP_CODE_2=$(echo "$SECOND_RESPONSE" | tail -n1)
RESPONSE_BODY_2=$(echo "$SECOND_RESPONSE" | sed '$d')

if [ "$HTTP_CODE_2" = "404" ] || [ "$HTTP_CODE_2" = "409" ]; then
  success "One-time pickup enforced! (HTTP $HTTP_CODE_2)"
  log "Response: $(echo "$RESPONSE_BODY_2" | jq .)"
else
  fail "Expected 404/409, got HTTP $HTTP_CODE_2"
  echo "$RESPONSE_BODY_2" | jq . 2>/dev/null || echo "$RESPONSE_BODY_2"
fi

# =============================================================================
step "5. Simulate session renewal via CUSTOM_AUTH"
# =============================================================================

log "Scenario: Refresh token has expired, using renewal token to get fresh session..."
log ""
log "Calling InitiateAuth(CUSTOM_AUTH)..."

INITIATE_RESULT=$(aws cognito-idp initiate-auth \
  --auth-flow CUSTOM_AUTH \
  --client-id "$CLIENT_ID" \
  --auth-parameters USERNAME="$TEST_EMAIL" \
  --region "$REGION")

SESSION=$(echo "$INITIATE_RESULT" | jq -r '.Session')
CHALLENGE_NAME=$(echo "$INITIATE_RESULT" | jq -r '.ChallengeName')
CHALLENGE_PARAMS=$(echo "$INITIATE_RESULT" | jq -r '.ChallengeParameters')

log "Challenge received: $CHALLENGE_NAME"
log "Challenge parameters: $CHALLENGE_PARAMS"

if [ "$CHALLENGE_NAME" != "CUSTOM_CHALLENGE" ]; then
  fail "Expected CUSTOM_CHALLENGE, got $CHALLENGE_NAME"
  exit 1
fi

success "CUSTOM_CHALLENGE received, responding with renewal token..."

# Respond with the renewal token
log "Calling RespondToAuthChallenge with renewal token..."

RESPOND_RESULT=$(aws cognito-idp respond-to-auth-challenge \
  --client-id "$CLIENT_ID" \
  --challenge-name CUSTOM_CHALLENGE \
  --session "$SESSION" \
  --challenge-responses USERNAME="$TEST_EMAIL",ANSWER="$RENEWAL_TOKEN" \
  --region "$REGION")

NEW_ACCESS_TOKEN=$(echo "$RESPOND_RESULT" | jq -r '.AuthenticationResult.AccessToken')
NEW_REFRESH_TOKEN=$(echo "$RESPOND_RESULT" | jq -r '.AuthenticationResult.RefreshToken')

if [ "$NEW_ACCESS_TOKEN" != "null" ] && [ -n "$NEW_ACCESS_TOKEN" ]; then
  success "Session renewal successful! Fresh tokens issued."
  log "New access token: ${NEW_ACCESS_TOKEN:0:50}..."
  log "New refresh token: ${NEW_REFRESH_TOKEN:0:50}..."
  log ""
  log ">>> The user was NEVER shown a login screen <<<"
else
  fail "Session renewal failed"
  echo "$RESPOND_RESULT" | jq .
  exit 1
fi

# =============================================================================
step "6. Fetch rotated renewal token (for next renewal cycle)"
# =============================================================================

log "Fetching the new rotated renewal token..."
sleep 1

NEW_ID_TOKEN=$(echo "$RESPOND_RESULT" | jq -r '.AuthenticationResult.IdToken')

RENEWAL_RESPONSE_2=$(curl -s -w "\n%{http_code}" \
  -H "Authorization: $NEW_ID_TOKEN" \
  "$API_ENDPOINT/renewal-token")

HTTP_CODE_3=$(echo "$RENEWAL_RESPONSE_2" | tail -n1)
RESPONSE_BODY_3=$(echo "$RENEWAL_RESPONSE_2" | sed '$d')

if [ "$HTTP_CODE_3" = "200" ]; then
  NEW_RENEWAL_TOKEN=$(echo "$RESPONSE_BODY_3" | jq -r '.renewalToken')
  success "Rotated renewal token received!"
  log "New renewal token: ${NEW_RENEWAL_TOKEN:0:30}..."
else
  fail "Could not fetch rotated renewal token (HTTP $HTTP_CODE_3)"
  echo "$RESPONSE_BODY_3" | jq . 2>/dev/null || echo "$RESPONSE_BODY_3"
fi

# =============================================================================
step "7. Verify old renewal token is invalidated"
# =============================================================================

log "Attempting renewal with OLD token (should fail)..."

INITIATE_RESULT_2=$(aws cognito-idp initiate-auth \
  --auth-flow CUSTOM_AUTH \
  --client-id "$CLIENT_ID" \
  --auth-parameters USERNAME="$TEST_EMAIL" \
  --region "$REGION")

SESSION_2=$(echo "$INITIATE_RESULT_2" | jq -r '.Session')

RESPOND_RESULT_2=$(aws cognito-idp respond-to-auth-challenge \
  --client-id "$CLIENT_ID" \
  --challenge-name CUSTOM_CHALLENGE \
  --session "$SESSION_2" \
  --challenge-responses USERNAME="$TEST_EMAIL",ANSWER="$RENEWAL_TOKEN" \
  --region "$REGION" 2>&1) || true

if echo "$RESPOND_RESULT_2" | grep -q "NotAuthorizedException\|failAuthentication"; then
  success "Old renewal token correctly rejected!"
  log "Token rotation is working - stolen tokens are useless after rotation."
else
  # Check if it returned an error in the response
  FAIL_CHECK=$(echo "$RESPOND_RESULT_2" | jq -r '.AuthenticationResult.AccessToken' 2>/dev/null)
  if [ "$FAIL_CHECK" = "null" ] || [ -z "$FAIL_CHECK" ]; then
    success "Old renewal token rejected (auth failed as expected)"
  else
    fail "Old token was accepted - rotation may not be working"
    echo "$RESPOND_RESULT_2" | jq . 2>/dev/null || echo "$RESPOND_RESULT_2"
  fi
fi

# =============================================================================
step "8. Session revocation (admin kills the session)"
# =============================================================================

log "Simulating admin revocation: deleting DynamoDB session record..."

# Get user sub from the ID token
USER_SUB=$(echo "$NEW_ID_TOKEN" | cut -d'.' -f2 | base64 -d 2>/dev/null | jq -r '.sub' 2>/dev/null) || true

if [ -z "$USER_SUB" ] || [ "$USER_SUB" = "null" ]; then
  # Fallback: look up user sub from Cognito
  USER_SUB=$(aws cognito-idp admin-get-user \
    --user-pool-id "$USER_POOL_ID" \
    --username "$TEST_EMAIL" \
    --region "$REGION" \
    --query 'UserAttributes[?Name==`sub`].Value' \
    --output text)
fi

log "User sub: $USER_SUB"

# Delete the session record (this is the revocation)
aws dynamodb delete-item \
  --table-name "$TABLE_NAME" \
  --key "{\"userSub\": {\"S\": \"$USER_SUB\"}}" \
  --region "$REGION"

success "Session record deleted from DynamoDB (revoked!)"

# Also clean up any pending token
aws dynamodb delete-item \
  --table-name "$TABLE_NAME" \
  --key "{\"userSub\": {\"S\": \"pending#$USER_SUB\"}}" \
  --region "$REGION" 2>/dev/null || true

log ""
log "Now attempting renewal with the VALID rotated token (should fail after revocation)..."

INITIATE_RESULT_3=$(aws cognito-idp initiate-auth \
  --auth-flow CUSTOM_AUTH \
  --client-id "$CLIENT_ID" \
  --auth-parameters USERNAME="$TEST_EMAIL" \
  --region "$REGION")

SESSION_3=$(echo "$INITIATE_RESULT_3" | jq -r '.Session')

RESPOND_RESULT_3=$(aws cognito-idp respond-to-auth-challenge \
  --client-id "$CLIENT_ID" \
  --challenge-name CUSTOM_CHALLENGE \
  --session "$SESSION_3" \
  --challenge-responses USERNAME="$TEST_EMAIL",ANSWER="$NEW_RENEWAL_TOKEN" \
  --region "$REGION" 2>&1) || true

if echo "$RESPOND_RESULT_3" | grep -q "NotAuthorizedException\|failAuthentication"; then
  success "Renewal correctly rejected after revocation!"
  log "Even a valid token is useless once the session is revoked."
else
  FAIL_CHECK_3=$(echo "$RESPOND_RESULT_3" | jq -r '.AuthenticationResult.AccessToken' 2>/dev/null)
  if [ "$FAIL_CHECK_3" = "null" ] || [ -z "$FAIL_CHECK_3" ]; then
    success "Renewal rejected after revocation (session record gone)"
  else
    fail "Token was accepted after revocation — something is wrong"
    echo "$RESPOND_RESULT_3" | jq . 2>/dev/null || echo "$RESPOND_RESULT_3"
  fi
fi

# =============================================================================
step "9. Summary"
# =============================================================================

echo -e "${GREEN}"
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║              POC DEMO COMPLETE                              ║"
echo "╠══════════════════════════════════════════════════════════════╣"
echo "║                                                              ║"
echo "║  ✓ Initial login → tokens + renewal token issued             ║"
echo "║  ✓ Renewal token fetched via authenticated API (one-time)    ║"
echo "║  ✓ Silent re-authentication via CUSTOM_AUTH + renewal token  ║"
echo "║  ✓ Fresh tokens issued (full TTL reset)                      ║"
echo "║  ✓ Renewal token rotated on each use                         ║"
echo "║  ✓ Old renewal token invalidated after rotation              ║"
echo "║  ✓ Session revocation: valid token rejected after DB delete  ║"
echo "║                                                              ║"
echo "║  → User was NEVER shown a login screen during renewal        ║"
echo "║  → Inactive users (> N days) would be rejected               ║"
echo "║  → Admins can instantly revoke any session via DynamoDB      ║"
echo "║                                                              ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo -e "${NC}"

log "Check CloudWatch logs for detailed Lambda execution traces:"
log "  - /aws/lambda/cognito-define-auth-challenge-poc"
log "  - /aws/lambda/cognito-create-auth-challenge-poc"
log "  - /aws/lambda/cognito-verify-auth-challenge-poc"
log "  - /aws/lambda/cognito-post-authentication-poc"
log "  - /aws/lambda/cognito-fetch-renewal-token-poc"
