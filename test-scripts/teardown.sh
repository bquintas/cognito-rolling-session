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
if [ -n "${USER_POOL_ID:-}" ]; then
  echo "Deleting test user..."
  aws cognito-idp admin-delete-user \
    --user-pool-id "$USER_POOL_ID" \
    --username "testuser-poc@example.com" \
    --region "$REGION" 2>/dev/null || echo "User may not exist, continuing..."
fi

# Delete stack
echo "Deleting CloudFormation stack..."
sam delete \
  --stack-name "$STACK_NAME" \
  --region "$REGION" \
  --no-prompts

echo ""
echo "✓ Stack deleted successfully"
