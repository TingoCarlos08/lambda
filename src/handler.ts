import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { HttpError, json } from './lib/http';
import { matchRoute } from './router';

export async function main(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> {
  const method = event.requestContext.http.method.toUpperCase();
  const path = event.rawPath;

  try {
    const { handler, params, pathMatched } = matchRoute(method, path);
    if (!handler) {
      return pathMatched
        ? json(405, { error: 'METODO_NO_PERMITIDO', mensaje: `Método ${method} no permitido en ${path}` })
        : json(404, { error: 'RUTA_NO_ENCONTRADA', mensaje: `No existe la ruta ${method} ${path}` });
    }
    return await handler(event, params);
  } catch (err) {
    if (err instanceof HttpError) {
      return json(err.status, { error: err.code, mensaje: err.message, detalle: err.details });
    }
    console.error(`[${method} ${path}] Error no controlado`, err);
    return json(500, { error: 'ERROR_INTERNO', mensaje: 'Ocurrió un error inesperado' });
  }
}
