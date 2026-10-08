/**
 * Reproduce el escenario de prueba del enunciado (sección 8) contra la lambda local.
 * Requiere: `npm run db:up` y `npm start` en otra terminal.
 *
 *   npm run escenario
 *
 * Usa una cédula aleatoria en cada corrida para poder ejecutarse varias veces.
 */
import { Client } from 'pg';

const API = process.env.API_URL ?? 'http://localhost:3000';
const db = new Client({
  host: process.env.PGHOST ?? 'localhost',
  port: Number(process.env.PGPORT ?? 5432),
  user: process.env.PGUSER ?? 'cupo',
  password: process.env.PGPASSWORD ?? 'cupo',
  database: process.env.PGDATABASE ?? 'cupo',
});

let fallos = 0;
function check(condicion: boolean, descripcion: string, extra?: unknown) {
  console.log(`  ${condicion ? '✔' : '✘'} ${descripcion}`);
  if (!condicion) {
    fallos++;
    if (extra !== undefined) console.log('    →', JSON.stringify(extra));
  }
}

async function call(method: string, path: string, body?: unknown) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await res.json()) as any;
  return { status: res.status, data };
}

const saldoDe = async (cedula: string) => (await call('GET', `/colaboradores/${cedula}`)).data;

async function main() {
  await db.connect();
  const cedula = `09${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;
  const sufijo = String(Math.floor(Math.random() * 1e9)).padStart(9, '0');
  console.log(`Cédula de prueba: ${cedula}\n`);

  // ---------------------------------------------------------------- 1
  console.log('1) Crear colaborador, actualizar cupo y acreditar');
  let r = await call('POST', '/colaboradores', { cedula, cupoMensual: 100 });
  check(r.status === 201, 'crea colaborador con cupo 100', r);
  r = await call('POST', '/colaboradores', { cedula, cupoMensual: 100 });
  check(r.status === 409, 'rechaza cédula duplicada (409)', r);
  r = await call('POST', '/facturas', { cedula: '0000000001', numeroFactura: `001-001-${sufijo}`, rucProveedor: '1790012345001', total: 1 });
  check(r.status === 404, 'factura de colaborador inexistente → 404', r);

  r = await call('PATCH', `/colaboradores/${cedula}/cupo`, { cupoMensual: 200, motivo: 'Ascenso' });
  check(r.status === 200 && r.data.cupoAnterior === 100 && r.data.cupoNuevo === 200, 'actualiza cupo 100 → 200', r);
  check(r.data.saldo === 0, 'actualizar cupo NO modifica el saldo (sigue en 0)', r);

  r = await call('POST', `/colaboradores/${cedula}/acreditaciones`);
  check(r.status === 201 && r.data.saldo === 200, 'acredita cupo → saldo 200', r);

  const historial = await db.query('SELECT cupo_anterior, cupo_nuevo FROM cupo_historial WHERE cedula = $1 ORDER BY id', [cedula]);
  check(historial.rowCount === 2, 'CUPO_HISTORIAL tiene la creación y el cambio', historial.rows);

  // ---------------------------------------------------------------- 2
  console.log('\n2) Consumos manuales en SGR_GASCLUB_GASTOS + sincronización');
  const { rows: [{ next }] } = await db.query('SELECT COALESCE(MAX(id), 0) + 1 AS next FROM sgr_gasclub_gastos');
  await db.query(
    `INSERT INTO sgr_gasclub_gastos (id, cedula, referencia, total, fecha) VALUES
       ($1, $3, $4, 50.00, CURRENT_DATE),
       ($2, $3, $5, 30.25, CURRENT_DATE)`,
    [next, next + 1, cedula, `GC-T${next}`, `GC-T${next + 1}`],
  );
  r = await call('POST', '/sincronizaciones/gasclub');
  const nuevosMios = r.data.detalle.nuevos.filter((n: any) => n.cedula === cedula);
  check(r.status === 200 && nuevosMios.length === 2, 'sincroniza los 2 consumos nuevos', r.data);
  check((await saldoDe(cedula)).saldo === 119.75, 'saldo 200 - 50 - 30.25 = 119.75');
  r = await call('POST', '/sincronizaciones/gasclub');
  check(r.data.nuevos === 0, 'segunda ejecución no duplica (idempotente)', r.data);

  // ---------------------------------------------------------------- 3
  console.log('\n3) Registrar factura, aprobarla a mano y sincronizar');
  const numeroFactura = `001-001-${sufijo}`;
  r = await call('POST', '/facturas', { cedula, numeroFactura, rucProveedor: '1790012345001', total: 500 });
  check(r.status === 422 && r.data.error === 'SALDO_INSUFICIENTE', 'factura mayor al saldo → 422', r);

  r = await call('POST', '/facturas', { cedula, numeroFactura, rucProveedor: '1790012345001', total: 100 });
  check(r.status === 201 && r.data.estado === 'Pendiente' && r.data.saldo === 19.75, 'registra factura de 100 → Pendiente, saldo 19.75', r);
  const facturaId: number = r.data.facturaId;

  const sgr = await db.query('SELECT estado FROM sgr_facturas WHERE id = $1', [facturaId]);
  check(sgr.rows[0]?.estado === 'Pendiente', 'también quedó Pendiente en SGR_FACTURAS', sgr.rows);

  r = await call('POST', '/facturas', { cedula, numeroFactura, rucProveedor: '1790012345001', total: 1 });
  check(r.status === 409, 'misma factura del mismo proveedor → 409', r);

  await db.query(`UPDATE sgr_facturas SET estado = 'Aprobado' WHERE id = $1`, [facturaId]);
  r = await call('POST', '/sincronizaciones/facturas');
  const actualizada = r.data.detalle.actualizados.find((a: any) => a.facturaId === facturaId);
  check(r.status === 200 && actualizada?.cambios?.estado?.despues === 'Aprobado', 'sincronización detecta la aprobación', r.data);

  const mov = await db.query(
    `SELECT estado, aprobado_en FROM cupo_movimientos WHERE origen = 'Facturas' AND id_externo = $1`,
    [facturaId],
  );
  check(mov.rows[0]?.estado === 'Aprobado' && mov.rows[0]?.aprobado_en !== null, 'el registro propio quedó Aprobado', mov.rows);
  check((await saldoDe(cedula)).saldo === 19.75, 'aprobar no vuelve a descontar (saldo 19.75)');

  // ---------------------------------------------------------------- extra
  console.log('\n4) Extra: GasClub puede dejar saldo negativo');
  await db.query(
    `INSERT INTO sgr_gasclub_gastos (id, cedula, referencia, total, fecha)
     SELECT COALESCE(MAX(id), 0) + 1, $1, 'GC-NEG', 40.00, CURRENT_DATE FROM sgr_gasclub_gastos`,
    [cedula],
  );
  await call('POST', '/sincronizaciones/gasclub');
  const final = await saldoDe(cedula);
  check(final.saldo === -20.25, 'saldo 19.75 - 40 = -20.25', final.saldo);
  check(final.saldo === final.saldoCalculado, 'saldo materializado = acreditaciones - gastos', final);
  check(
    final.movimientos.every((m: any) => ['Cupo', 'Facturas', 'GasClub'].includes(m.origen)),
    'todo movimiento identifica su origen',
  );

  console.log(fallos === 0 ? '\nTodo OK ✅' : `\n${fallos} verificación(es) fallida(s) ❌`);
  await db.end();
  process.exitCode = fallos === 0 ? 0 : 1;
}

main().catch(async (err) => {
  console.error(err);
  await db.end().catch(() => undefined);
  process.exitCode = 1;
});
