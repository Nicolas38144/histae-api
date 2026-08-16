import { ValidationPipe } from '@nestjs/common';
import { apiError } from '../api-error';

/**
 * Validates and transforms a DTO while retaining the API's stable error envelope.
 * Each endpoint selects its historical error code rather than exposing validator details.
 */
export class ApiValidationPipe extends ValidationPipe {
  constructor(code = 'invalid_request_body', message = 'The request body is invalid.') {
    super({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: true,
      forbidUnknownValues: true,
      exceptionFactory: () => apiError(400, code, message),
    });
  }
}
