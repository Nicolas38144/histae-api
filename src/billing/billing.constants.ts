/**
 * Stripe keeps POST idempotency results for at least 24 hours. Histae stops
 * replaying one hour earlier to absorb clock skew and request latency.
 */
export const CUSTOMER_CREATE_IDEMPOTENCY_SAFETY_MILLIS = 23 * 60 * 60_000;
