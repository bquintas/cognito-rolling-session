/**
 * Create Auth Challenge Lambda
 * 
 * Generates the challenge presented to the client.
 * For the renewal flow, we simply ask the client to provide its renewal token.
 * No secret is passed in privateChallengeParameters because the Verify lambda
 * looks up the expected value from DynamoDB directly.
 */
export const handler = async (event) => {
  if (event.request.challengeName !== "CUSTOM_CHALLENGE") {
    return event;
  }

  event.response.publicChallengeParameters = {
    challenge: "PROVIDE_RENEWAL_TOKEN",
    message: "Please provide your session renewal token"
  };

  event.response.privateChallengeParameters = {
    // The verify lambda will look up the expected answer from DynamoDB
    userSub: event.request.userAttributes.sub
  };

  event.response.challengeMetadata = "RENEWAL_TOKEN_CHALLENGE";

  return event;
};
