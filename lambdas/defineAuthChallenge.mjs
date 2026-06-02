/**
 * Define Auth Challenge Lambda
 * 
 * Controls the custom auth flow for session renewal.
 * Flow: one custom challenge (renewal token) → issue tokens on success.
 * 
 * This Lambda does NOT include SRP — the renewal flow skips password verification
 * entirely. The security comes from the renewal token validated in VerifyAuthChallenge.
 */
export const handler = async (event) => {
  const session = event.request.session;

  if (session.length === 0) {
    // First call: issue a custom challenge (ask for renewal token)
    event.response.challengeName = "CUSTOM_CHALLENGE";
    event.response.issueTokens = false;
    event.response.failAuthentication = false;
  } else if (
    session.length === 1 &&
    session[0].challengeName === "CUSTOM_CHALLENGE" &&
    session[0].challengeResult === true
  ) {
    // Renewal token was valid → issue tokens
    event.response.issueTokens = true;
    event.response.failAuthentication = false;
  } else {
    // Challenge failed or unexpected state → fail authentication
    event.response.issueTokens = false;
    event.response.failAuthentication = true;
  }

  return event;
};
