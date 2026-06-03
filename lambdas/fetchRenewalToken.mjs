/**
 * Fetch Renewal Token Lambda (API Gateway handler)
 * 
 * Called by the client AFTER successful CUSTOM_AUTH authentication.
 * Reads the pending renewal token from DynamoDB and returns it once.
 * After delivery, the pendingToken field is removed (one-time pickup).
 * 
 * Auth: Protected by Cognito Authorizer (requires valid access token)
 * 
 * Environment variables:
 *   TABLE_NAME - DynamoDB table name
 */
import { DynamoDBClient, GetItemCommand, DeleteItemCommand } from "@aws-sdk/client-dynamodb";

const ddb = new DynamoDBClient({});
const TABLE_NAME = process.env.TABLE_NAME || "CognitoRenewalTokens";

export const handler = async (event) => {
  console.log("FetchRenewalToken invoked", JSON.stringify({
    requestId: event.requestContext?.requestId,
    claims: event.requestContext?.authorizer?.claims?.sub,
    sourceIp: event.requestContext?.identity?.sourceIp,
    userAgent: event.requestContext?.identity?.userAgent
  }));

  // Extract user sub from Cognito authorizer claims
  const userSub = event.requestContext?.authorizer?.claims?.sub;

  if (!userSub) {
    console.error("No user sub found in authorizer claims");
    return {
      statusCode: 401,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Unauthorized" })
    };
  }

  try {
    // Read the pending token from the separate pending item (5-min TTL)
    const result = await ddb.send(new GetItemCommand({
      TableName: TABLE_NAME,
      Key: { userSub: { S: `pending#${userSub}` } }
    }));

    if (!result.Item || !result.Item.pendingToken) {
      console.log(`No pending renewal token for user ${userSub}`);
      return {
        statusCode: 404,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ 
          error: "No pending renewal token",
          message: "Token may have already been collected or not yet issued"
        })
      };
    }

    // Application-level TTL check — DynamoDB TTL deletion can lag up to 48 hours,
    // so we enforce the 5-minute window ourselves before serving the token.
    const ttl = parseInt(result.Item.ttl?.N || "0", 10);
    if (ttl > 0 && Math.floor(Date.now() / 1000) > ttl) {
      console.log(`Pending renewal token expired for user ${userSub} (TTL exceeded)`);
      // Clean up the expired item immediately
      await ddb.send(new DeleteItemCommand({
        TableName: TABLE_NAME,
        Key: { userSub: { S: `pending#${userSub}` } }
      })).catch(() => {});
      return {
        statusCode: 404,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          error: "Token expired",
          message: "Pending renewal token has expired. Re-authenticate to get a new one."
        })
      };
    }

    const renewalToken = result.Item.pendingToken.S;

    // Delete the pending item (one-time pickup)
    await ddb.send(new DeleteItemCommand({
      TableName: TABLE_NAME,
      Key: { userSub: { S: `pending#${userSub}` } },
      ConditionExpression: "attribute_exists(pendingToken)"
    }));

    console.log(`Renewal token delivered to user ${userSub} (one-time pickup)`);

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store, no-cache, must-revalidate",
        "Pragma": "no-cache"
      },
      body: JSON.stringify({
        renewalToken,
        message: "Store this token securely. It cannot be retrieved again."
      })
    };
  } catch (error) {
    console.error(`Error fetching renewal token for user ${userSub}:`, error.name, error.message);

    // Handle condition check failure (token already picked up by concurrent request)
    if (error.name === "ConditionalCheckFailedException") {
      return {
        statusCode: 409,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          error: "Token already collected",
          message: "The renewal token was already picked up by another request."
        })
      };
    }

    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Internal server error" })
    };
  }
};
