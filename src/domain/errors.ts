export class LeadNotFoundError extends Error {
  constructor(public readonly leadId: string) {
    super(`LEAD_NOT_FOUND: ${leadId}`);
    this.name = "LeadNotFoundError";
  }
}

export class InvalidLeadTransitionError extends Error {
  constructor(public readonly from: string, public readonly to: string) {
    super(`Invalid lead transition: ${from} -> ${to}`);
    this.name = "InvalidLeadTransitionError";
  }
}

export class SlotUnavailableError extends Error {
  constructor(message = "The requested time slot is no longer available") {
    super(message);
    this.name = "SlotUnavailableError";
  }
}

export class CalendarProviderError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "CalendarProviderError";
  }
}

export class IdempotencyConflictError extends Error {
  constructor(public readonly idempotencyKey: string) {
    super(`Idempotency-Key ${idempotencyKey} was reused with a different request payload`);
    this.name = "IdempotencyConflictError";
  }
}

export class InvalidQualificationFieldError extends Error {
  constructor(public readonly vertical: string, public readonly fieldName: string) {
    super(`Field "${fieldName}" is not in the allowed qualification whitelist for ${vertical}`);
    this.name = "InvalidQualificationFieldError";
  }
}

export class DuplicateMessageError extends Error {
  constructor(public readonly channel: string, public readonly providerMessageId: string) {
    super(`Message with providerMessageId ${providerMessageId} on channel ${channel} was already ingested`);
    this.name = "DuplicateMessageError";
  }
}

export class MessagingProviderError extends Error {
  /** HTTP status Meta returned, when known. */
  public readonly httpStatus?: number;
  /** Meta's numeric error taxonomy code (e.g. 190 = invalid/expired OAuth token). Public API
   * error code, not a secret -- safe to surface in diagnostics. */
  public readonly metaErrorCode?: number;
  /** Meta's error type string (e.g. "OAuthException"). Also public taxonomy, not a secret. */
  public readonly metaErrorType?: string;
  /** Static, code-derived diagnosis text (see diagnoseMetaError) -- never Meta's raw error.message. */
  public readonly sanitizedDiagnosis?: string;
  /** Last 4 characters of the WHATSAPP_PHONE_NUMBER_ID used for the request, for log correlation
   * without exposing the full id. */
  public readonly phoneNumberIdLast4?: string;

  constructor(
    message: string,
    options?: {
      cause?: unknown;
      httpStatus?: number;
      metaErrorCode?: number;
      metaErrorType?: string;
      sanitizedDiagnosis?: string;
      phoneNumberIdLast4?: string;
    },
  ) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "MessagingProviderError";
    this.httpStatus = options?.httpStatus;
    this.metaErrorCode = options?.metaErrorCode;
    this.metaErrorType = options?.metaErrorType;
    this.sanitizedDiagnosis = options?.sanitizedDiagnosis;
    this.phoneNumberIdLast4 = options?.phoneNumberIdLast4;
  }
}
