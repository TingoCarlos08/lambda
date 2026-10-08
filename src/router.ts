import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { acreditarCupo, actualizarCupo, consultarColaborador, crearColaborador } from './endpoints/colaboradores';
import { registrarFactura } from './endpoints/facturas';
import { sincronizarFacturas, sincronizarGasClub } from './endpoints/sincronizaciones';

type Handler = (
  event: APIGatewayProxyEventV2,
  params: Record<string, string>,
) => Promise<APIGatewayProxyStructuredResultV2>;

interface Route {
  method: string;
  pattern: RegExp;
  handler: Handler;
}

// Convierte '/colaboradores/{cedula}/cupo' en una regex con grupos nombrados.
const route = (method: string, path: string, handler: Handler): Route => ({
  method,
  pattern: new RegExp(`^${path.replace(/\{(\w+)\}/g, '(?<$1>[^/]+)')}/?$`),
  handler,
});

export const routes: Route[] = [
  route('POST', '/colaboradores', crearColaborador),
  route('PATCH', '/colaboradores/{cedula}/cupo', actualizarCupo),
  route('POST', '/colaboradores/{cedula}/acreditaciones', acreditarCupo),
  route('POST', '/facturas', registrarFactura),
  route('POST', '/sincronizaciones/facturas', sincronizarFacturas),
  route('POST', '/sincronizaciones/gasclub', sincronizarGasClub),
  route('GET', '/colaboradores/{cedula}', consultarColaborador),
];

export function matchRoute(
  method: string,
  path: string,
): { handler: Handler | null; params: Record<string, string>; pathMatched: boolean } {
  let pathMatched = false;
  for (const r of routes) {
    const match = r.pattern.exec(path);
    if (!match) continue;
    pathMatched = true;
    if (r.method === method) {
      const params = Object.fromEntries(
        Object.entries(match.groups ?? {}).map(([k, v]) => [k, decodeURIComponent(v)]),
      );
      return { handler: r.handler, params, pathMatched };
    }
  }
  return { handler: null, params: {}, pathMatched };
}
