export class BillingMappingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BillingMappingError';
  }
}

export class BillingAccountInactiveError extends Error {}

export class BillingReconciliationError extends Error {
  constructor(
    readonly code: string,
    readonly permanent = false,
  ) {
    super(code);
    this.name = 'BillingReconciliationError';
  }
}
