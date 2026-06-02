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
import { DynamoDBClient, GetItemCommand, PutItemCommand, DeleteItemCommand } from "@aws-sdk/client-dynamodb";
import { createHash, randomBytes } from "crypto";

const ddb = new DynamoDBClient({});
const TABLE_NAME = process.env.TABLE_NAME || "CognitoRenewalTokens";
const MAX_ABSOLUTE_SESSION_DAYS = parseInt(process.env.MAX_ABSOLUTE_SESSION_DAYS || "90", 10);

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
    const maxInactivityDays = parseInt(result.Item.maxInactivityDays.N, 10);

    // Verify the provided token matches the stored hash
    const providedHash = createHash("sha256").update(providedToken).digest("hex");
    const isTokenValid = providedHash === storedHash;

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

      await ddb.send(new PutItemCommand({
        TableName: TABLE_NAME,
        Item: {
          userSub: { S: userSub },
          tokenHash: { S: newHash },
          issuedAt: { N: String(now) },
          lastUsedAt: { N: String(now) },
          maxInactivityDays: { N: String(maxInactivityDays) },
          ttl: { N: String(ttlSeconds) },
          // Store new plaintext token for one-time client pickup via API
          pendingToken: { S: newToken },
          pendingTokenExpiry: { N: String(Math.floor(now / 1000) + 300) } // 5 min window
        }
      }));

      // NOTE: The new renewal token needs to be delivered to the client.
      // Options:
      //   1. Via Pre Token Generation Lambda (inject as custom claim)
      //   2. Via a separate API call after authentication succeeds
      //   3. Via challengeMetadata (limited, not ideal for secrets)
      // 
      // For the POC, we'll use option 2 (separate API call).
      // The client will call GET /renewal-token after successful auth.

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
    console.error(`Error verifying renewal token for user ${userSub}:`, error);
    event.response.answerCorrect = false;
  }

  return event;
};
