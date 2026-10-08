import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

export const badRequest = (message: string, details?: unknown) =>
  new HttpError(400, 'VALIDACION', message, details);
export const notFound = (message: string) => new HttpError(404, 'NO_ENCONTRADO', message);
export const conflict = (message: string) => new HttpError(409, 'CONFLICTO', message);
export const unprocessable = (code: string, message: string, details?: unknown) =>
  new HttpError(422, code, message, details);

export function json(status: number, body: unknown): APIGatewayProxyStructuredResultV2 {
  return {
    statusCode: status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify(body),
  };
}

export function parseBody(event: APIGatewayProxyEventV2): Record<string, unknown> {
  if (!event.body) return {};
  const raw = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw badRequest('El cuerpo de la petición no es un JSON válido');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw badRequest('El cuerpo de la petición debe ser un objeto JSON');
  }
  return parsed as Record<string, unknown>;
}
