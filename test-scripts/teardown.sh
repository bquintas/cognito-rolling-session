#!/bin/bash
# =============================================================================
# Teardown the Cognito Rolling Session POC stack
# =============================================================================

set -euo pipefail

REGION="${AWS_REGION:-eu-west-1}"
STACK_NAME="cognito-rolling-session-poc"

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Tearing down: $STACK_NAME"
echo "Region: $REGION"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# Delete test user first (if exists)
# Resolve USER_POOL_ID from stack outputs if not set in environment
if [ -z "${USER_POOL_ID:-}" ]; then
  echo "Resolving USER_POOL_ID from CloudFormation stack outputs..."
  USER_POOL_ID=$(aws cloudformation describe-stacks \
    --stack-name "$STACK_NAME" \
    --region "$REGION" \
    --query 'Stacks[0].Outputs[?OutputKey==`UserPoolId`].OutputValue' \
    --output text 2>/dev/null) || true
fi

if [ -n "${USER_POOL_ID:-}" ]; then
  echo "Deleting test user..."
  aws cognito-idp admin-delete-user \
    --user-pool-id "$USER_POOL_ID" \
    --username "testuser-poc@example.com" \
    --region "$REGION" 2>/dev/null || echo "User may not exist, continuing..."
else
  echo "Could not resolve USER_POOL_ID — skipping test user cleanup (stack may already be deleted)"
fi

# Delete stack
echo "Deleting CloudFormation stack..."
sam delete \
  --stack-name "$STACK_NAME" \
  --region "$REGION" \
  --no-prompts

echo ""
echo "✓ Stack deleted successfully"
