/**
 * Post Authentication Lambda
 * 
 * Fires after any successful authentication (initial login).
 * Generates a renewal token and stores its hash in DynamoDB.
 * 
 * The plaintext renewal token is stored temporarily so the client can retrieve it
 * via a separate API call (GET /renewal-token?sub=xxx) immediately after login.
 * 
 * Environment variables:
 *   TABLE_NAME - DynamoDB table name (default: "CognitoRenewalTokens")
 *   MAX_INACTIVITY_DAYS - Default inactivity window (default: 30)
 */
import { DynamoDBClient, PutItemCommand, GetItemCommand } from "@aws-sdk/client-dynamodb";
import { createHash, randomBytes } from "crypto";

const ddb = new DynamoDBClient({});
const TABLE_NAME = process.env.TABLE_NAME || "CognitoRenewalTokens";
const MAX_INACTIVITY_DAYS = parseInt(process.env.MAX_INACTIVITY_DAYS || "30", 10);

export const handler = async (event) => {
  // Only issue renewal tokens for direct user authentication (not token refresh)
  const triggerSource = event.triggerSource;
  if (triggerSource !== "PostAuthentication_Authentication") {
    return event;
  }

  // Skip if this was a CUSTOM_AUTH renewal — VerifyAuthChallenge already handled rotation.
  // PostAuthentication doesn't receive the session array, so we check if a pendingToken
  // was recently written by VerifyAuthChallenge (within last 30 seconds).
  const userSub = event.request.userAttributes.sub;

  const existingRecord = await ddb.send(new GetItemCommand({
    TableName: TABLE_NAME,
    Key: { userSub: { S: userSub } },
    ProjectionExpression: "pendingToken, lastUsedAt"
  }));

  if (existingRecord.Item?.pendingToken?.S) {
    const lastUsedAt = parseInt(existingRecord.Item.lastUsedAt?.N || "0", 10);
    const secondsSinceUpdate = (Date.now() - lastUsedAt) / 1000;
    if (secondsSinceUpdate < 30) {
      console.log(`Skipping renewal token issuance — VerifyAuthChallenge already rotated (${secondsSinceUpdate.toFixed(1)}s ago) for user ${userSub}`);
      return event;
    }
  }

  const now = Date.now();
  const ttlSeconds = Math.floor(now / 1000) + (MAX_INACTIVITY_DAYS * 86400);

  // Generate renewal token
  const renewalToken = randomBytes(32).toString("hex");
  const tokenHash = createHash("sha256").update(renewalToken).digest("hex");

  // Store hash in DynamoDB
  await ddb.send(new PutItemCommand({
    TableName: TABLE_NAME,
    Item: {
      userSub: { S: userSub },
      tokenHash: { S: tokenHash },
      issuedAt: { N: String(now) },
      lastUsedAt: { N: String(now) },
      maxInactivityDays: { N: String(MAX_INACTIVITY_DAYS) },
      ttl: { N: String(ttlSeconds) },
      // Store plaintext temporarily for client pickup (short-lived)
      // In production, use a more secure delivery mechanism
      pendingToken: { S: renewalToken },
      pendingTokenExpiry: { N: String(Math.floor(now / 1000) + 300) } // 5 min to pick up
    }
  }));

  console.log(`Renewal token issued for user ${userSub}`);

  return event;
};
