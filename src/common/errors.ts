/**
 * Machine-readable error codes returned as `{ error: { code, message, details } }`.
 * Messages are written so an LLM agent can understand what to change.
 */
export const ErrorCodes = {
  // auth
  UNAUTHORIZED: 401,
  INVALID_API_KEY: 401,
  AUTH_RATE_LIMITED: 429,
  FORBIDDEN: 403,
  INVALID_CREDENTIALS: 401,
  MFA_REQUIRED: 401,
  ACCOUNT_LOCKED: 423,
  CSRF_FAILED: 403,
  SSO_ERROR: 400,
  INVITE_INVALID: 400,
  // gateway / key state
  GATEWAY_PAUSED: 503,
  KEY_DISABLED: 403,
  PROVIDER_UNAVAILABLE: 503,
  QUEUE_UNAVAILABLE: 503,
  // request validation
  VALIDATION_FAILED: 400,
  INVALID_JSON: 400,
  REQUEST_TOO_LARGE: 413,
  FROM_NOT_ALLOWED: 400,
  // policy
  RECIPIENT_NOT_ALLOWED: 403,
  TOO_MANY_RECIPIENTS: 400,
  MESSAGE_TOO_LARGE: 413,
  REPLY_TO_NOT_ALLOWED: 400,
  ATTACHMENTS_NOT_ALLOWED: 400,
  ATTACHMENT_TOO_LARGE: 413,
  // guardrails
  DUPLICATE_MESSAGE: 409,
  IDEMPOTENCY_CONFLICT: 409,
  QUOTA_EXCEEDED: 429,
  GLOBAL_RATE_LIMITED: 429,
  // generic
  NOT_FOUND: 404,
  MESSAGE_NOT_FOUND: 404,
  KEY_NOT_FOUND: 404,
  CONFLICT: 409,
  INVALID_STATE: 409,
  INTERNAL_ERROR: 500,
} as const;

export type ErrorCode = keyof typeof ErrorCodes;

export class GatewayError extends Error {
  readonly status: number;
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'GatewayError';
    this.status = ErrorCodes[code];
  }

  toBody() {
    return { error: { code: this.code, message: this.message, ...(this.details ? { details: this.details } : {}) } };
  }
}

export const isGatewayError = (e: unknown): e is GatewayError => e instanceof GatewayError;
