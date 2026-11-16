import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Inject } from '@nestjs/common';
import type { Request, Response } from 'express';
import type { Logger } from 'pino';
import { ROOT_LOGGER } from './logger';
import { ErrorCode, GatewayError } from './errors';

const statusToCode: Record<number, ErrorCode> = {
  400: 'VALIDATION_FAILED',
  401: 'UNAUTHORIZED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  409: 'CONFLICT',
  413: 'REQUEST_TOO_LARGE',
};

/** Normalises every error to `{ error: { code, message, details? } }`. */
@Catch()
export class GatewayExceptionFilter implements ExceptionFilter {
  constructor(@Inject(ROOT_LOGGER) private readonly logger: Logger) {}

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request>();
    if (res.headersSent) return;
    const { status, body } = toErrorResponse(exception);
    if (status >= 500 && !(exception instanceof GatewayError)) {
      this.logger.error({ err: exception, url: req.originalUrl, method: req.method }, 'unhandled error');
    }
    const retryAfter = (body.error.details as { retryAfterSeconds?: number } | undefined)?.retryAfterSeconds;
    if (retryAfter) res.setHeader('Retry-After', String(retryAfter));
    res.status(status).json(body);
  }
}

export function toErrorResponse(exception: unknown): {
  status: number;
  body: { error: { code: string; message: string; details?: Record<string, unknown> } };
} {
  if (exception instanceof GatewayError) return { status: exception.status, body: exception.toBody() };
  if (exception instanceof HttpException) {
    const status = exception.getStatus();
    const resp = exception.getResponse();
    let message = exception.message;
    let details: Record<string, unknown> | undefined;
    if (typeof resp === 'object' && resp && 'message' in resp) {
      const m = (resp as { message: unknown }).message;
      if (Array.isArray(m)) {
        message = m.join('; ');
        details = { problems: m };
      } else if (typeof m === 'string') message = m;
    }
    const code = statusToCode[status] ?? (status === 429 ? 'AUTH_RATE_LIMITED' : 'INTERNAL_ERROR');
    return { status, body: { error: { code, message, ...(details ? { details } : {}) } } };
  }
  return { status: 500, body: { error: { code: 'INTERNAL_ERROR', message: 'Internal error' } } };
}
