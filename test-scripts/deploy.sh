#!/bin/bash
# =============================================================================
# Deploy the Cognito Rolling Session POC stack
# 
# Prerequisites:
#   - AWS SAM CLI installed (brew install aws-sam-cli)
#   - AWS CLI configured with appropriate credentials
#   - Node.js 20+ (for Lambda runtime)
#
# Usage:
#   export AWS_REGION=eu-west-1
#   ./deploy.sh
# =============================================================================

set -euo pipefail

REGION="${AWS_REGION:-eu-west-1}"
STACK_NAME="cognito-rolling-session-poc"
TEMPLATE_PATH="../infrastructure/template.yaml"

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Deploying Cognito Rolling Session POC"
echo "Region: $REGION"
echo "Stack:  $STACK_NAME"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# Build
echo ""
echo "Building..."
sam build --template-file "$TEMPLATE_PATH" --region "$REGION"

# Deploy
echo ""
echo "Deploying..."
sam deploy \
  --stack-name "$STACK_NAME" \
  --region "$REGION" \
  --capabilities CAPABILITY_IAM \
  --resolve-s3 \
  --no-confirm-changeset \
  --parameter-overrides \
    Environment=poc \
    MaxInactivityDays=30 \
    RefreshTokenValidityDays=30

# Get outputs
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Stack Outputs (use these for demo.sh):"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

OUTPUTS=$(aws cloudformation describe-stacks \
  --stack-name "$STACK_NAME" \
  --region "$REGION" \
  --query "Stacks[0].Outputs" \
  --output json)

USER_POOL_ID=$(echo "$OUTPUTS" | jq -r '.[] | select(.OutputKey=="UserPoolId") | .OutputValue')
CLIENT_ID=$(echo "$OUTPUTS" | jq -r '.[] | select(.OutputKey=="UserPoolClientId") | .OutputValue')
API_ENDPOINT=$(echo "$OUTPUTS" | jq -r '.[] | select(.OutputKey=="ApiEndpoint") | .OutputValue')
TABLE_NAME=$(echo "$OUTPUTS" | jq -r '.[] | select(.OutputKey=="DynamoDBTable") | .OutputValue')

echo ""
echo "export AWS_REGION=$REGION"
echo "export USER_POOL_ID=$USER_POOL_ID"
echo "export CLIENT_ID=$CLIENT_ID"
echo "export API_ENDPOINT=$API_ENDPOINT"
echo ""
echo "DynamoDB Table: $TABLE_NAME"
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Next: Copy the exports above and run ./demo.sh"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
