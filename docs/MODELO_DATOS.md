# Modelo de datos y decisiones

## Tablas propias (`db/03_tablas_propias.sql`)

| Tabla | Rol |
|---|---|
| `CUPO_COLABORADORES` | Colaboradores habilitados: cédula, `CUPO_MENSUAL` y `SALDO` actual. |
| `CUPO_HISTORIAL` | Trazabilidad del cupo: `CUPO_ANTERIOR → CUPO_NUEVO`, motivo y fecha. La creación también queda registrada (anterior `NULL`). |
| `CUPO_MOVIMIENTOS` | **Cuenta corriente** (libro mayor). Una fila por acreditación o gasto, con `TIPO` (`Acreditacion`/`Gasto`), `ORIGEN` (`Cupo`/`Facturas`/`GasClub`), `ID_EXTERNO` (ID de la fila en `SGR_FACTURAS` o `SGR_GASCLUB_GASTOS`), `MONTO` positivo, `ESTADO` (solo facturas) y foto `SALDO_ANTERIOR/SALDO_POSTERIOR`. |
| `CUPO_SINCRONIZACIONES` | Bitácora de cada sincronización: cuándo, cuántas filas leyó/creó/actualizó y un `DETALLE` JSONB con qué cambió. |

**Invariante:** `SALDO = Σ acreditaciones − Σ gastos` de `CUPO_MOVIMIENTOS`. `SALDO` se guarda materializado para validar rápido el endpoint 4. Solo lo modifica una función (`registrarMovimiento`/`ajustarSaldo` en `src/ledger.ts`), siempre en la misma transacción que el movimiento. `GET /colaboradores/{cedula}` devuelve ambos valores (`saldo` y `saldoCalculado`) para comprobarlo.

## Decisiones

1. **Un solo libro de movimientos en lugar de tablas por origen.** El saldo sale de una sola suma, y el origen de cada gasto queda en la columna `ORIGEN`. Las facturas guardan en la misma fila su número, RUC y estado.
2. **Sin restricciones en BD → la integridad vive en el código:**
   - *Unicidad de cédula:* `pg_advisory_xact_lock` por cédula + verificación previa (reemplaza el `UNIQUE`).
   - *Concurrencia sobre el saldo:* toda operación que lo cambia bloquea primero la fila del colaborador (`SELECT … FOR UPDATE`). Dos facturas simultáneas no pueden superar el saldo, cosa que verificó la prueba de concurrencia.
   - *Idempotencia de las sincronizaciones:* `(ORIGEN, ID_EXTERNO)` funciona como llave lógica. Re-ejecutar una sincronización no duplica gastos, y un advisory lock por tipo evita dos corridas en paralelo.
   - *IDs:* secuencias como `DEFAULT` (un default no es una restricción). No hay PK, FK, UNIQUE, CHECK ni NOT NULL; solo índices **no únicos** por rendimiento.
3. **La factura descuenta saldo al registrarse (estado Pendiente).** Como no hay rechazos, toda factura registrada terminará aprobada. Si se descontara recién al aprobar, podrían registrarse varias facturas que juntas superen el saldo. Aprobar solo cambia `ESTADO` y `APROBADO_EN`, sin volver a descontar.
4. **Registro de factura atómico.** El INSERT en `SGR_FACTURAS` (con `ID = MAX+1` bajo `LOCK TABLE … SHARE ROW EXCLUSIVE`) y el movimiento propio van en la misma transacción. Se rechaza una factura duplicada (mismo número + RUC del proveedor).
5. **Sincronización de facturas = alineación completa con `SGR_FACTURAS`:**
   - Si la factura existe en ambos lados, se copian `ESTADO`, número, RUC, fecha y total. Si cambió el total, el saldo se corrige por la diferencia. Cada cambio queda con su valor anterior y nuevo en `CUPO_SINCRONIZACIONES.DETALLE`.
   - Si solo existe en `SGR_FACTURAS` (cargada fuera del endpoint 4, como los datos de ejemplo), se registra como gasto aunque el saldo quede negativo, porque así queda alineado.
   - Las filas con ID nulo o duplicado, o con total no positivo, se omiten y se reportan; no se mueven gastos entre cédulas.
6. **GasClub:** solo inserta los consumos nuevos, siempre, aunque el saldo quede negativo. Los consumos ya sincronizados se consideran inmutables.
7. **Alcance de las sincronizaciones:** solo se leen filas de cédulas registradas en `CUPO_COLABORADORES` (cédulas `0967890123` y `0978901234` de GasClub quedan fuera hasta que se registren).
8. **Una sola lambda con router interno** (el enunciado dice "una lambda con los endpoints"). Cada endpoint vive en su propio módulo, así que separarlos en varias funciones solo requiere cambiar `serverless.yml`.
9. **Montos en centavos (enteros)** dentro del código para evitar errores de punto flotante; en BD, `DECIMAL(12,2)`.
10. **Validaciones de formato:** cédula de 10 dígitos, RUC de 13 dígitos, número de factura `000-000-000000000` (formato SRI, el mismo de los datos de ejemplo), montos > 0 (cupo ≥ 0) con máximo 2 decimales.
