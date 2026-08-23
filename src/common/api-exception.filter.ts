import type { ArgumentsHost, ExceptionFilter} from '@nestjs/common';
import { Catch, HttpException, Logger } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ApiError } from './api-error';
import { requestPath } from './http/request-path';

@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(ApiExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const reply = http.getResponse<FastifyReply>();
    const request = http.getRequest<FastifyRequest>();
    if (reply.sent) return;

    if (exception instanceof ApiError) {
      if (exception.status >= 500) this.logException(exception, request);
      if (exception.retryAfterSeconds) reply.header('Retry-After', String(exception.retryAfterSeconds));
      reply.status(exception.status).send({ error: { code: exception.code, message: exception.message } });
      return;
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const response = exception.getResponse();
      const isBodyError = status === 400 || status === 413 || status === 415;
      const isRouteNotFound = status === 404;
      reply.status(status).send({
        error: {
          code: isBodyError ? 'invalid_request_body' : isRouteNotFound ? 'route_not_found' : 'request_failed',
          message: isBodyError ? 'The request body is invalid.' : isRouteNotFound ? 'This route is not available.' : extractMessage(response),
        },
      });
      return;
    }

    // Database driver details and cryptographic failures must never escape the API boundary.
    this.logException(exception, request);
    reply.status(500).send({
      error: { code: 'internal_error', message: 'The request could not be completed.' },
    });
  }

  private logException(exception: unknown, request: FastifyRequest): void {
    const context = `${request.method} ${requestPath(request.url)} request_id=${request.id}`;
    if (exception instanceof Error) this.logger.error(context, exception.stack);
    else this.logger.error(`${context} non_error_exception=${String(exception)}`);
  }
}

function extractMessage(response: string | object): string {
  if (typeof response === 'string') return response;
  if ('message' in response && typeof response.message === 'string') return response.message;
  return 'The request could not be completed.';
}
