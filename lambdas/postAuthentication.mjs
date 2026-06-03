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
import { DynamoDBClient, PutItemCommand, GetItemCommand, DeleteItemCommand } from "@aws-sdk/client-dynamodb";
import { createHash, randomBytes } from "crypto";

const ddb = new DynamoDBClient({});
const TABLE_NAME = process.env.TABLE_NAME || "CognitoRenewalTokens";
const MAX_INACTIVITY_DAYS = parseInt(process.env.MAX_INACTIVITY_DAYS || "30", 10);
const MAX_ABSOLUTE_SESSION_DAYS = parseInt(process.env.MAX_ABSOLUTE_SESSION_DAYS || "90", 10);

export const handler = async (event) => {
  // Only issue renewal tokens for direct user authentication (not token refresh)
  const triggerSource = event.triggerSource;
  if (triggerSource !== "PostAuthentication_Authentication") {
    return event;
  }

  // Skip if this was a CUSTOM_AUTH renewal — VerifyAuthChallenge already handled rotation.
  // Detection: if the session record has a `rotatedAt` field written within the last 30 seconds,
  // it means VerifyAuthChallenge just rotated the token. This is more reliable than checking
  // the pending item (which may already be fetched/deleted by the client).
  const userSub = event.request.userAttributes.sub;

  const existingRecord = await ddb.send(new GetItemCommand({
    TableName: TABLE_NAME,
    Key: { userSub: { S: userSub } },
    ProjectionExpression: "lastUsedAt, issuedAt, rotatedAt"
  }));

  if (existingRecord.Item?.rotatedAt?.N) {
    const rotatedAt = parseInt(existingRecord.Item.rotatedAt.N, 10);
    const secondsSinceRotation = (Date.now() - rotatedAt) / 1000;
    if (secondsSinceRotation < 30) {
      console.log(`Skipping renewal token issuance — VerifyAuthChallenge already rotated (${secondsSinceRotation.toFixed(1)}s ago) for user ${userSub}`);
      return event;
    }
  }

  const now = Date.now();
  const ttlSeconds = Math.floor(now / 1000) + (MAX_INACTIVITY_DAYS * 86400);

  // Generate renewal token
  const renewalToken = randomBytes(32).toString("hex");
  const tokenHash = createHash("sha256").update(renewalToken).digest("hex");

  // Preserve the original issuedAt if a record already exists (absolute session limit
  // must count from the very first login, not from re-issuance).
  const existingIssuedAt = existingRecord.Item?.issuedAt?.N
    ? parseInt(existingRecord.Item.issuedAt.N, 10)
    : now;

  // If the existing session has exceeded the absolute limit, delete it instead of re-issuing.
  // This prevents issuing tokens for sessions that should have been terminated.
  let sessionIssuedAt = existingIssuedAt;
  if (existingRecord.Item?.issuedAt?.N) {
    const absoluteLimitMs = MAX_ABSOLUTE_SESSION_DAYS * 24 * 60 * 60 * 1000;
    if ((now - existingIssuedAt) > absoluteLimitMs) {
      await ddb.send(new DeleteItemCommand({
        TableName: TABLE_NAME,
        Key: { userSub: { S: userSub } }
      }));
      console.log(`Expired session cleaned up for user ${userSub} (absolute limit exceeded, starting fresh)`);
      sessionIssuedAt = now; // Fresh login — reset the clock
    }
  }

  // Store hash in DynamoDB with ConditionExpression to avoid clobbering a
  // VerifyAuthChallenge rotation that happened between our GetItem and now.
  try {
    await ddb.send(new PutItemCommand({
      TableName: TABLE_NAME,
      Item: {
        userSub: { S: userSub },
        tokenHash: { S: tokenHash },
        issuedAt: { N: String(sessionIssuedAt) },  // Preserved or reset if absolute limit exceeded
        lastUsedAt: { N: String(now) },
        maxInactivityDays: { N: String(MAX_INACTIVITY_DAYS) },
        ttl: { N: String(ttlSeconds) }
      },
      // Only write if no recent rotation occurred (lastUsedAt hasn't been updated
      // since our read, or the record doesn't exist yet)
      ConditionExpression: "attribute_not_exists(userSub) OR lastUsedAt = :expectedLastUsed",
      ExpressionAttributeValues: {
        ":expectedLastUsed": { N: existingRecord.Item?.lastUsedAt?.N || "0" }
      }
    }));

    // Store plaintext renewal token as a SEPARATE item with 5-minute TTL.
    // DynamoDB TTL auto-deletes it — no lingering plaintext beyond pickup window.
    await ddb.send(new PutItemCommand({
      TableName: TABLE_NAME,
      Item: {
        userSub: { S: `pending#${userSub}` },
        pendingToken: { S: renewalToken },
        ttl: { N: String(Math.floor(now / 1000) + 300) } // 5 min DynamoDB TTL
      }
    }));

    console.log(`Renewal token issued for user ${userSub}`);
  } catch (error) {
    if (error.name === "ConditionalCheckFailedException") {
      // VerifyAuthChallenge rotated the record between our read and write — skip safely
      console.log(`Skipping renewal token issuance — concurrent rotation detected for user ${userSub}`);
    } else {
      throw error;
    }
  }

  return event;
};
