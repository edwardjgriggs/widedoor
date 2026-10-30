/*
 * The one model-id rule: ai.model, --ai-model, the runner and both AI
 * providers check against it, and a model an API reports is recorded only
 * when it matches. It lives here because the server's config may not load
 * @widedoor/ai (D16).
 */

/** A model id: 1 to 100 letters, digits and the separators an API uses. */
export const MODEL_ID = /^[A-Za-z0-9._:@/-]{1,100}$/;

/** MODEL_ID in words, for messages. */
export const MODEL_ID_RULE = '1 to 100 letters, digits, ".", "_", ":", "@", "/" or "-"';
