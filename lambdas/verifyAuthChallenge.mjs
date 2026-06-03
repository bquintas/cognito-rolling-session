/**
 * Verify Auth Challenge Lambda
 * 
 * Validates the renewal token provided by the client against DynamoDB.
 * On success: rotates the renewal token and marks the answer as correct.
 * On failure: rejects the authentication attempt.
 * 
 * Two expiry checks:
 *   1. Inactivity timeout (rolling) — resets on each renewal
 *   2. Absolute session limit (hard cap) — never resets, forces re-auth after N days
 * 
 * Environment variables:
 *   TABLE_NAME - DynamoDB table name (default: "CognitoRenewalTokens")
 *   MAX_ABSOLUTE_SESSION_DAYS - Hard cap on session lifetime (default: 90)
 */
import { DynamoDBClient, GetItemCommand, PutItemCommand, DeleteItemCommand, TransactWriteItemsCommand } from "@aws-sdk/client-dynamodb";
import { createHash, randomBytes, timingSafeEqual } from "crypto";

const ddb = new DynamoDBClient({});
const TABLE_NAME = process.env.TABLE_NAME || "CognitoRenewalTokens";
const MAX_ABSOLUTE_SESSION_DAYS = parseInt(process.env.MAX_ABSOLUTE_SESSION_DAYS || "90", 10);
const MAX_INACTIVITY_DAYS = parseInt(process.env.MAX_INACTIVITY_DAYS || "30", 10);
const INACTIVITY_POLICY_MODE = process.env.INACTIVITY_POLICY_MODE || "enforced";

export const handler = async (event) => {
  const userSub = event.request.userAttributes.sub;
  const providedToken = event.request.challengeAnswer;

  if (!providedToken) {
    event.response.answerCorrect = false;
    return event;
  }

  try {
    // Look up stored renewal token record
    const result = await ddb.send(new GetItemCommand({
      TableName: TABLE_NAME,
      Key: { userSub: { S: userSub } }
    }));

    if (!result.Item) {
      console.log(`No renewal token found for user ${userSub}`);
      event.response.answerCorrect = false;
      return event;
    }

    const storedHash = result.Item.tokenHash.S;
    const lastUsedAt = parseInt(result.Item.lastUsedAt.N, 10);
    const issuedAt = parseInt(result.Item.issuedAt.N, 10);
    const recordMaxInactivityDays = parseInt(result.Item.maxInactivityDays.N, 10);

    // Inactivity policy mode:
    //   "enforced" = use the stricter of env var vs DB value (policy tightening applies immediately)
    //   "permissive" = use the DB value from session creation time (existing sessions keep original window)
    const maxInactivityDays = INACTIVITY_POLICY_MODE === "enforced"
      ? Math.min(MAX_INACTIVITY_DAYS, recordMaxInactivityDays)
      : recordMaxInactivityDays;

    // Verify the provided token matches the stored hash (constant-time comparison)
    const providedHash = createHash("sha256").update(providedToken).digest("hex");
    const isTokenValid = timingSafeEqual(Buffer.from(providedHash, "hex"), Buffer.from(storedHash, "hex"));

    // Check 1: Inactivity window (rolling — resets on each renewal)
    const maxInactivityMs = maxInactivityDays * 24 * 60 * 60 * 1000;
    const isWithinInactivityWindow = (Date.now() - lastUsedAt) < maxInactivityMs;

    // Check 2: Absolute session limit (hard cap — never resets)
    const absoluteSessionMs = MAX_ABSOLUTE_SESSION_DAYS * 24 * 60 * 60 * 1000;
    const isWithinAbsoluteLimit = (Date.now() - issuedAt) < absoluteSessionMs;

    if (!isWithinAbsoluteLimit) {
      console.log(`Absolute session limit exceeded for user ${userSub} (session started: ${new Date(issuedAt).toISOString()}, limit: ${MAX_ABSOLUTE_SESSION_DAYS} days)`);
      // Clean up — user must fully re-authenticate
      await ddb.send(new DeleteItemCommand({
        TableName: TABLE_NAME,
        Key: { userSub: { S: userSub } }
      }));
      event.response.answerCorrect = false;
      return event;
    }

    if (isTokenValid && isWithinInactivityWindow) {
      // SUCCESS: Rotate the renewal token
      const newToken = randomBytes(32).toString("hex");
      const newHash = createHash("sha256").update(newToken).digest("hex");
      const now = Date.now();
      const ttlSeconds = Math.floor(now / 1000) + (maxInactivityDays * 86400);

      // Atomic write: session record + pending token in one transaction.
      // If the ConditionExpression fails (concurrent rotation), neither write commits.
      // This prevents partial failures where the session is rotated but no pending token exists.
      await ddb.send(new TransactWriteItemsCommand({
        TransactItems: [
          {
            Put: {
              TableName: TABLE_NAME,
              Item: {
                userSub: { S: userSub },
                tokenHash: { S: newHash },
                issuedAt: { N: String(issuedAt) },  // Preserve original — never reset
                lastUsedAt: { N: String(now) },
                maxInactivityDays: { N: String(maxInactivityDays) },
                ttl: { N: String(ttlSeconds) },
                rotatedAt: { N: String(now) }  // Marker for PostAuth skip logic
              },
              // Optimistic lock: only succeed if tokenHash hasn't changed since our read
              ConditionExpression: "tokenHash = :expectedHash",
              ExpressionAttributeValues: {
                ":expectedHash": { S: storedHash }
              }
            }
          },
          {
            Put: {
              TableName: TABLE_NAME,
              Item: {
                userSub: { S: `pending#${userSub}` },
                pendingToken: { S: newToken },
                ttl: { N: String(Math.floor(now / 1000) + 300) } // 5 min DynamoDB TTL
              }
            }
          }
        ]
      }));

      console.log(`Renewal token rotated for user ${userSub}`);
      event.response.answerCorrect = true;
    } else {
      if (!isTokenValid) {
        console.log(`Invalid renewal token for user ${userSub}`);
      }
      if (!isWithinInactivityWindow) {
        console.log(`Inactivity window exceeded for user ${userSub} (last used: ${new Date(lastUsedAt).toISOString()})`);
        // Clean up expired record
        await ddb.send(new DeleteItemCommand({
          TableName: TABLE_NAME,
          Key: { userSub: { S: userSub } }
        }));
      }
      event.response.answerCorrect = false;
    }
  } catch (error) {
    if (error.name === "ConditionalCheckFailedException" || error.name === "TransactionCanceledException") {
      // Another concurrent request already rotated the token (TOCTOU protection)
      console.log(`Token already rotated by concurrent request for user ${userSub}`);
      event.response.answerCorrect = false;
    } else {
      console.error(`Error verifying renewal token for user ${userSub}:`, error.name, error.message);
      event.response.answerCorrect = false;
    }
  }

  return event;
};
