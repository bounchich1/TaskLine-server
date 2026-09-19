import type { FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';

import { AppError } from '../../shared/errors.js';

/** What Fastify, zod, pg and our own code may throw into a handler. */
type HandlerError = Error & { code?: string; statusCode?: number; validation?: unknown };

interface ErrorResponse {
  status: number;
  code: string;
  message: string;
  retryable: boolean;
}

/**
 * Maps errors to the API's error shape `{ code, message, request_id, retryable }`. Anything not
 * recognised is logged (without details that could leak data) and reported as a retryable 503.
 */
export function handleError(
  error: HandlerError,
  request: FastifyRequest,
  reply: FastifyReply,
): FastifyReply {
  const known = describeKnownError(error);
  if (!known) {
    request.log.error(
      { reason: error.code ?? error.name, request_id: request.id },
      'Request failed',
    );
  }
  const { status, code, message, retryable } = known ?? {
    status: 503,
    code: 'temporarily_unavailable',
    message: 'Сервис временно недоступен. Повторите позже.',
    retryable: true,
  };
  return reply.code(status).send({ code, message, request_id: request.id, retryable });
}

function describeKnownError(error: HandlerError): ErrorResponse | undefined {
  if (error instanceof AppError) {
    const { status, code, message, retryable } = error;
    return { status, code, message, retryable };
  }
  if (error instanceof ZodError || error.validation) {
    return rejected(422, 'invalid_input', 'Проверьте введённые данные.');
  }
  if (error.code === '23505') {
    return rejected(409, 'conflict', 'Данные уже изменились или существуют.');
  }
  const status = error.statusCode;
  if (status && status >= 400 && status < 500) {
    return rejected(status, 'request_rejected', 'Запрос отклонён.');
  }
  return undefined;
}

function rejected(status: number, code: string, message: string): ErrorResponse {
  return { status, code, message, retryable: false };
}
