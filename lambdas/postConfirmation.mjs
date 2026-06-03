/**
 * Post Confirmation Lambda
 * 
 * Fires after password change or account confirmation.
 * Deletes the user's renewal token session record, forcing re-authentication
 * via the new credentials. This ensures stolen renewal tokens are invalidated
 * when a user changes their password.
 * 
 * Environment variables:
 *   TABLE_NAME - DynamoDB table name (default: "CognitoRenewalTokens")
 */
import { DynamoDBClient, DeleteItemCommand } from "@aws-sdk/client-dynamodb";

const ddb = new DynamoDBClient({});
const TABLE_NAME = process.env.TABLE_NAME || "CognitoRenewalTokens";

export const handler = async (event) => {
  const triggerSource = event.triggerSource;

  // Only revoke sessions on password change (not initial signup confirmation)
  if (triggerSource !== "PostConfirmation_ConfirmForgotPassword") {
    return event;
  }

  const userSub = event.request.userAttributes.sub;

  // Delete session record — any existing renewal token is now invalid
  await ddb.send(new DeleteItemCommand({
    TableName: TABLE_NAME,
    Key: { userSub: { S: userSub } }
  }));

  // Also delete any pending pickup token
  await ddb.send(new DeleteItemCommand({
    TableName: TABLE_NAME,
    Key: { userSub: { S: `pending#${userSub}` } }
  }));

  console.log(`Session revoked for user ${userSub} (password change via ${triggerSource})`);

  return event;
};
