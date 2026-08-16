export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly cause?: unknown,
    public readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export const apiError = (status: number, code: string, message: string, cause?: unknown, retryAfterSeconds?: number): ApiError =>
  new ApiError(status, code, message, cause, retryAfterSeconds);
