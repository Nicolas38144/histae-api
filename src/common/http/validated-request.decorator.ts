import { Body, Param, Query } from '@nestjs/common';
import { ApiValidationPipe } from '../dto/api-validation.pipe';

type ValidationError = Readonly<{ code: string; message: string }>;

const defaultBodyError: ValidationError = { code: 'invalid_request_body', message: 'The request body is invalid.' };

export function ValidatedBody(error: ValidationError = defaultBodyError): ParameterDecorator {
  return Body(new ApiValidationPipe(error.code, error.message));
}

export function ValidatedParams(error: ValidationError): ParameterDecorator {
  return Param(new ApiValidationPipe(error.code, error.message));
}

export function ValidatedQuery(error: ValidationError): ParameterDecorator {
  return Query(new ApiValidationPipe(error.code, error.message));
}
