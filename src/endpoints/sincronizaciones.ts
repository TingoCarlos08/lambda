import { advisoryLock, withTransaction } from '../lib/db';
import { json } from '../lib/http';
import { toAmount, toCents, toDecimal } from '../lib/money';
import {
  ajustarSaldo,
  cerrarSincronizacion,
  iniciarSincronizacion,
  lockAllColaboradores,
  registrarMovimiento,
} from '../ledger';

interface Omitido {
  idExterno: number | null;
  cedula: string;
  motivo: string;
}

/**
 * Patrón común de ambas sincronizaciones (todo en UNA transacción):
 *  1. Advisory lock por tipo → nunca corren dos sincronizaciones del mismo tipo a la vez.
 *  2. Se bloquean los colaboradores registrados → ningún endpoint cambia saldos mientras tanto.
 *  3. Se leen las filas externas SOLO de esos colaboradores.
 *  4. Se cruzan contra CUPO_MOVIMIENTOS por (ORIGEN, ID_EXTERNO) → idempotencia.
 *  5. Se deja bitácora en CUPO_SINCRONIZACIONES.
 */

// ---------------------------------------------------------------------------
// 5. Sincronizar facturas — POST /sincronizaciones/facturas
// ---------------------------------------------------------------------------

interface SgrFacturaRow {
  id: number | null;
  cedula: string;
  numero_factura: string | null;
  ruc_proveedor: string | null;
  total: string | null;
  fecha: string | null;
  estado: string | null;
}

interface MovFacturaRow {
  id: string;
  cedula: string;
  id_externo: number;
  referencia: string | null;
  ruc_proveedor: string | null;
  monto: string;
  estado: string | null;
  fecha: string | null;
}

export async function sincronizarFacturas() {
  const resumen = await withTransaction(async (db) => {
    await advisoryLock(db, 'sincronizacion:facturas');
    const colaboradores = await lockAllColaboradores(db);
    const sincronizacionId = await iniciarSincronizacion(db, 'Facturas');
    const cedulas = [...colaboradores.keys()];

    const externas = await db.query<SgrFacturaRow>(
      `SELECT id, cedula, numero_factura, ruc_proveedor, total, fecha, estado
         FROM sgr_facturas
        WHERE cedula = ANY($1::varchar[])
        ORDER BY id`,
      [cedulas],
    );
    const propias = await db.query<MovFacturaRow>(
      `SELECT id, cedula, id_externo, referencia, ruc_proveedor, monto, estado, fecha
         FROM cupo_movimientos
        WHERE origen = 'Facturas' AND id_externo IS NOT NULL`,
    );
    const propiasPorId = new Map(propias.rows.map((m) => [m.id_externo, m]));

    const nuevos: unknown[] = [];
    const actualizados: unknown[] = [];
    const omitidos: Omitido[] = [];
    let sinCambios = 0;
    const vistos = new Set<number>();

    for (const f of externas.rows) {
      const colaborador = colaboradores.get(f.cedula)!;

      if (f.id === null) {
        omitidos.push({ idExterno: null, cedula: f.cedula, motivo: 'Fila sin ID en SGR_FACTURAS' });
        continue;
      }
      if (vistos.has(f.id)) {
        omitidos.push({ idExterno: f.id, cedula: f.cedula, motivo: 'ID duplicado en SGR_FACTURAS' });
        continue;
      }
      vistos.add(f.id);

      const totalCents = f.total === null ? null : toCents(f.total);
      if (totalCents === null || totalCents <= 0) {
        omitidos.push({ idExterno: f.id, cedula: f.cedula, motivo: 'Total nulo o no positivo' });
        continue;
      }

      const propia = propiasPorId.get(f.id);

      // Factura que existe en SGR_FACTURAS pero no en nuestras tablas (cargada fuera del
      // endpoint 4). Se registra para quedar alineados, aunque deje saldo negativo.
      if (!propia) {
        const mov = await registrarMovimiento(db, colaborador, {
          tipo: 'Gasto',
          origen: 'Facturas',
          montoCents: totalCents,
          idExterno: f.id,
          referencia: f.numero_factura,
          rucProveedor: f.ruc_proveedor,
          estado: f.estado,
          fecha: f.fecha,
          sincronizacionId,
          aprobado: f.estado === 'Aprobado',
        });
        nuevos.push({ facturaId: f.id, cedula: f.cedula, movimientoId: mov.id, estado: f.estado, total: toAmount(totalCents) });
        continue;
      }

      // La cédula es la identidad del dueño del gasto; no movemos gastos entre colaboradores.
      if (propia.cedula !== f.cedula) {
        omitidos.push({
          idExterno: f.id,
          cedula: f.cedula,
          motivo: `La cédula en SGR_FACTURAS (${f.cedula}) no coincide con la registrada (${propia.cedula})`,
        });
        continue;
      }

      // Existe en ambos lados: alinear campos con SGR_FACTURAS.
      const cambios: Record<string, { antes: unknown; despues: unknown }> = {};
      if (propia.estado !== f.estado) cambios.estado = { antes: propia.estado, despues: f.estado };
      if (propia.referencia !== f.numero_factura) cambios.numeroFactura = { antes: propia.referencia, despues: f.numero_factura };
      if (propia.ruc_proveedor !== f.ruc_proveedor) cambios.rucProveedor = { antes: propia.ruc_proveedor, despues: f.ruc_proveedor };
      if (propia.fecha !== f.fecha) cambios.fecha = { antes: propia.fecha, despues: f.fecha };
      const montoAnteriorCents = toCents(propia.monto);
      if (montoAnteriorCents !== totalCents) cambios.total = { antes: toAmount(montoAnteriorCents), despues: toAmount(totalCents) };

      if (Object.keys(cambios).length === 0) {
        sinCambios++;
        continue;
      }

      if (cambios.total) {
        // Si el gasto cambia de monto, el saldo se corrige por la diferencia.
        await ajustarSaldo(db, colaborador, montoAnteriorCents - totalCents);
      }
      await db.query(
        `UPDATE cupo_movimientos
            SET estado = $2::varchar, referencia = $3, ruc_proveedor = $4, fecha = $5, monto = $6,
                aprobado_en = CASE WHEN $2::varchar = 'Aprobado' AND estado IS DISTINCT FROM 'Aprobado' THEN now()
                                   WHEN $2::varchar = 'Aprobado' THEN aprobado_en
                                   ELSE NULL END,
                actualizado_en = now()
          WHERE id = $1`,
        [propia.id, f.estado, f.numero_factura, f.ruc_proveedor, f.fecha, toDecimal(totalCents)],
      );
      actualizados.push({ facturaId: f.id, cedula: f.cedula, movimientoId: Number(propia.id), cambios });
    }

    const resumen = {
      sincronizacionId,
      leidos: externas.rowCount ?? 0,
      nuevos: nuevos.length,
      actualizados: actualizados.length,
      sinCambios,
      omitidos: omitidos.length,
      detalle: { nuevos, actualizados, omitidos },
    };
    await cerrarSincronizacion(db, sincronizacionId, resumen);
    return resumen;
  });

  return json(200, resumen);
}

// ---------------------------------------------------------------------------
// 6. Sincronizar GasClub — POST /sincronizaciones/gasclub
// ---------------------------------------------------------------------------

interface GasClubRow {
  id: number | null;
  cedula: string;
  referencia: string | null;
  total: string | null;
  fecha: string | null;
}

export async function sincronizarGasClub() {
  const resumen = await withTransaction(async (db) => {
    await advisoryLock(db, 'sincronizacion:gasclub');
    const colaboradores = await lockAllColaboradores(db);
    const sincronizacionId = await iniciarSincronizacion(db, 'GasClub');
    const cedulas = [...colaboradores.keys()];

    const externas = await db.query<GasClubRow>(
      `SELECT id, cedula, referencia, total, fecha
         FROM sgr_gasclub_gastos
        WHERE cedula = ANY($1::varchar[])
        ORDER BY id`,
      [cedulas],
    );
    const yaSincronizados = await db.query<{ id_externo: number }>(
      `SELECT id_externo FROM cupo_movimientos WHERE origen = 'GasClub' AND id_externo IS NOT NULL`,
    );
    const vistos = new Set<number>(yaSincronizados.rows.map((r) => r.id_externo));

    const nuevos: unknown[] = [];
    const omitidos: Omitido[] = [];
    let sinCambios = 0;
    const procesadosEnEstaCorrida = new Set<number>();

    for (const g of externas.rows) {
      if (g.id === null) {
        omitidos.push({ idExterno: null, cedula: g.cedula, motivo: 'Fila sin ID en SGR_GASCLUB_GASTOS' });
        continue;
      }
      if (procesadosEnEstaCorrida.has(g.id)) {
        omitidos.push({ idExterno: g.id, cedula: g.cedula, motivo: 'ID duplicado en SGR_GASCLUB_GASTOS' });
        continue;
      }
      procesadosEnEstaCorrida.add(g.id);

      if (vistos.has(g.id)) {
        sinCambios++; // ya registrado en una corrida anterior
        continue;
      }

      const totalCents = g.total === null ? null : toCents(g.total);
      if (totalCents === null || totalCents <= 0) {
        omitidos.push({ idExterno: g.id, cedula: g.cedula, motivo: 'Total nulo o no positivo' });
        continue;
      }

      // El consumo ya ocurrió: se registra SIEMPRE, aunque el saldo quede negativo.
      const colaborador = colaboradores.get(g.cedula)!;
      const mov = await registrarMovimiento(db, colaborador, {
        tipo: 'Gasto',
        origen: 'GasClub',
        montoCents: totalCents,
        idExterno: g.id,
        referencia: g.referencia,
        fecha: g.fecha,
        sincronizacionId,
      });
      nuevos.push({
        gasclubId: g.id,
        referencia: g.referencia,
        cedula: g.cedula,
        movimientoId: mov.id,
        total: toAmount(totalCents),
        saldo: toAmount(mov.saldoPosteriorCents),
      });
    }

    const resumen = {
      sincronizacionId,
      leidos: externas.rowCount ?? 0,
      nuevos: nuevos.length,
      actualizados: 0,
      sinCambios,
      omitidos: omitidos.length,
      detalle: { nuevos, omitidos },
    };
    await cerrarSincronizacion(db, sincronizacionId, resumen);
    return resumen;
  });

  return json(200, resumen);
}
