# Cupo vehicular de colaboradores

Lambda en **TypeScript** con **Serverless Framework v3** y **PostgreSQL 16**. Lleva una cuenta corriente por colaborador alimentada por acreditaciones del cupo, facturas (`SGR_FACTURAS`) y consumos de GasClub (`SGR_GASCLUB_GASTOS`).

- Modelo de datos y decisiones: [docs/MODELO_DATOS.md](docs/MODELO_DATOS.md)
- Scripts SQL: [db/](db/) (`01` tablas dadas, `02` datos de ejemplo, `03` tablas propias)

## Requisitos

- Node.js 20 o superior
- Docker con Docker Compose (o un PostgreSQL propio, ver más abajo)

## Ejecutar

```bash
npm install
npm run db:up      # levanta Postgres en localhost:5432 y ejecuta db/*.sql
npm start          # compila (esbuild → dist/) y levanta la lambda en http://localhost:3000
```

En otra terminal, el escenario completo de la sección 8 del enunciado, con verificaciones automáticas:

```bash
npm run escenario
```

Otros comandos:

| Comando | Qué hace |
|---|---|
| `npm run db:reset` | Borra el volumen y recrea la BD desde los scripts (estado inicial limpio). |
| `npm run db:down` | Detiene Postgres. |
| `npm run typecheck` | Verificación de tipos con `tsc`. |

**Usar otro PostgreSQL:** ejecuta los tres scripts de `db/` en orden y define `PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD` y `PGDATABASE` antes de `npm start` (por defecto: `localhost`, `5432`, `cupo`, `cupo`, `cupo`). Si el puerto 5432 está ocupado: `PGPORT=5433 npm run db:up` y `PGPORT=5433 npm start`.

Para entrar a la BD: `docker exec -it cupo-vehicular-db psql -U cupo -d cupo`

## Endpoints

| # | Método y ruta | Body | Respuestas |
|---|---|---|---|
| 1 | `POST /colaboradores` | `{ "cedula": "0912345678", "cupoMensual": 150 }` | `201` · `400` validación · `409` cédula ya existe |
| 2 | `PATCH /colaboradores/{cedula}/cupo` | `{ "cupoMensual": 300, "motivo": "opcional" }` | `200` · `400` · `404` |
| 3 | `POST /colaboradores/{cedula}/acreditaciones` | — | `201` · `404` · `422 CUPO_CERO` |
| 4 | `POST /facturas` | `{ "cedula", "numeroFactura": "001-001-000000123", "rucProveedor": "1790012345001", "total": 10.5, "fecha?": "2026-10-01" }` | `201` · `400` · `404` colaborador no existe · `409` factura duplicada · `422 SALDO_INSUFICIENTE` |
| 5 | `POST /sincronizaciones/facturas` | — | `200` con resumen (`leidos`, `nuevos`, `actualizados`, `sinCambios`, `omitidos`, `detalle`) |
| 6 | `POST /sincronizaciones/gasclub` | — | `200` con resumen |
| + | `GET /colaboradores/{cedula}` | — | Extra para verificar: saldo, `saldoCalculado`, historial de cupo y movimientos |

Los errores tienen la forma `{ "error": "CODIGO", "mensaje": "...", "detalle": ... }`.

Hay ejemplos listos en [requests.http](requests.http) (extensión REST Client de VS Code).

## Probar a mano (escenario del enunciado)

Ejemplos con `curl` (en PowerShell usa `curl.exe` y escapa las comillas del JSON, o usa `requests.http`).

**1. Crear, actualizar cupo y acreditar**

```bash
curl -X POST localhost:3000/colaboradores -H "Content-Type: application/json" -d '{"cedula":"0999999999","cupoMensual":100}'
curl -X PATCH localhost:3000/colaboradores/0999999999/cupo -H "Content-Type: application/json" -d '{"cupoMensual":200,"motivo":"Ascenso"}'
curl -X POST localhost:3000/colaboradores/0999999999/acreditaciones          # saldo = 200
```

**2. Consumos de GasClub**

```sql
INSERT INTO SGR_GASCLUB_GASTOS (ID, CEDULA, REFERENCIA, TOTAL, FECHA) VALUES
  (11, '0999999999', 'GC-002000', 50.00, '2026-10-01'),
  (12, '0999999999', 'GC-002001', 30.00, '2026-10-02');
```

```bash
curl -X POST localhost:3000/sincronizaciones/gasclub                          # saldo = 120
```

**3. Factura → aprobación manual → sincronización**

```bash
curl -X POST localhost:3000/facturas -H "Content-Type: application/json" \
  -d '{"cedula":"0999999999","numeroFactura":"001-001-000009999","rucProveedor":"1790012345001","total":100}'
# → facturaId (p. ej. 11), estado Pendiente, saldo = 20
```

```sql
UPDATE SGR_FACTURAS SET ESTADO = 'Aprobado' WHERE ID = 11;
```

```bash
curl -X POST localhost:3000/sincronizaciones/facturas
```

```sql
SELECT ESTADO, APROBADO_EN FROM CUPO_MOVIMIENTOS WHERE ORIGEN = 'Facturas' AND ID_EXTERNO = 11;  -- Aprobado
```

### Consultas útiles

```sql
-- Saldo materializado vs. recalculado desde el libro (deben coincidir)
SELECT c.CEDULA, c.CUPO_MENSUAL, c.SALDO,
       COALESCE(SUM(CASE m.TIPO WHEN 'Acreditacion' THEN m.MONTO ELSE -m.MONTO END), 0) AS SALDO_CALCULADO
  FROM CUPO_COLABORADORES c
  LEFT JOIN CUPO_MOVIMIENTOS m ON m.COLABORADOR_ID = c.ID
 GROUP BY c.ID, c.CEDULA, c.CUPO_MENSUAL, c.SALDO;

-- Movimientos de un colaborador con su origen
SELECT ID, TIPO, ORIGEN, ID_EXTERNO, REFERENCIA, MONTO, ESTADO, SALDO_ANTERIOR, SALDO_POSTERIOR
  FROM CUPO_MOVIMIENTOS WHERE CEDULA = '0999999999' ORDER BY ID;

-- Trazabilidad del cupo y de las sincronizaciones
SELECT * FROM CUPO_HISTORIAL WHERE CEDULA = '0999999999' ORDER BY ID;
SELECT ID, TIPO, INICIADO_EN, LEIDOS, NUEVOS, ACTUALIZADOS, SIN_CAMBIOS, DETALLE FROM CUPO_SINCRONIZACIONES ORDER BY ID DESC;
```

## Estructura

```
serverless.yml            una función (api) con 7 rutas httpApi + serverless-offline
docker-compose.yml        PostgreSQL 16; monta db/ como scripts de inicialización
db/                       scripts SQL (tablas dadas, datos de ejemplo, tablas propias)
src/handler.ts            entrada de la lambda: enruta y traduce errores a HTTP
src/router.ts             tabla de rutas → endpoint
src/ledger.ts             cuenta corriente: bloqueo del colaborador, movimientos, saldo
src/endpoints/            colaboradores (1, 2, 3), facturas (4), sincronizaciones (5, 6)
src/lib/                  db (pool, transacciones, advisory locks), http, dinero, validación
scripts/escenario.ts      prueba de punta a punta del escenario de evaluación
```

## Notas

- El TypeScript se compila con `esbuild` (`npm run build`) y Serverless ejecuta `dist/handler.js`. Se eligió así en lugar del plugin `serverless-esbuild` porque ese plugin se colgaba al cargar en Node 24 / Windows.
- Se usa Serverless **v3** porque v4 exige iniciar sesión con una cuenta de Serverless incluso para correr en local.
