import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { advisoryLock, withClient, withTransaction } from '../lib/db';
import { conflict, json, notFound, parseBody, unprocessable } from '../lib/http';
import { toAmount, toCents, toDecimal } from '../lib/money';
import { optionalString, requireAmount, requireString, validateCedula } from '../lib/validation';
import { findColaborador, lockColaborador, registrarMovimiento } from '../ledger';

/** 1. Crear colaborador — POST /colaboradores { cedula, cupoMensual } */
export async function crearColaborador(event: APIGatewayProxyEventV2) {
  const body = parseBody(event);
  const cedula = validateCedula(requireString(body, 'cedula'));
  const cupoCents = requireAmount(body, 'cupoMensual', { allowZero: true });

  const colaborador = await withTransaction(async (db) => {
    // Sin UNIQUE en BD: el advisory lock serializa altas concurrentes de la misma cédula.
    await advisoryLock(db, `colaborador:${cedula}`);
    if (await findColaborador(db, cedula)) {
      throw conflict(`Ya existe un colaborador con cédula ${cedula}`);
    }

    const { rows } = await db.query<{ id: string; creado_en: Date }>(
      `INSERT INTO cupo_colaboradores (cedula, cupo_mensual, saldo)
       VALUES ($1, $2, 0)
       RETURNING id, creado_en`,
      [cedula, toDecimal(cupoCents)],
    );
    const id = Number(rows[0].id);

    await db.query(
      `INSERT INTO cupo_historial (colaborador_id, cedula, cupo_anterior, cupo_nuevo, motivo)
       VALUES ($1, $2, NULL, $3, 'Creación del colaborador')`,
      [id, cedula, toDecimal(cupoCents)],
    );

    return { id, cedula, cupoMensual: toAmount(cupoCents), saldo: 0, creadoEn: rows[0].creado_en };
  });

  return json(201, colaborador);
}

/** 2. Actualizar cupo — PATCH /colaboradores/{cedula}/cupo { cupoMensual, motivo? } */
export async function actualizarCupo(event: APIGatewayProxyEventV2, params: Record<string, string>) {
  const cedula = validateCedula(params.cedula);
  const body = parseBody(event);
  const cupoNuevoCents = requireAmount(body, 'cupoMensual', { allowZero: true });
  const motivo = optionalString(body, 'motivo', 200);

  const result = await withTransaction(async (db) => {
    const colaborador = await lockColaborador(db, cedula);
    const cupoAnteriorCents = colaborador.cupoCents;

    if (cupoAnteriorCents === cupoNuevoCents) {
      return { cambiado: false, colaborador, cupoAnteriorCents, historialId: null as number | null };
    }

    // El saldo NO se toca: solo cambia el cupo que se usará en próximas acreditaciones.
    await db.query(
      `UPDATE cupo_colaboradores SET cupo_mensual = $2, actualizado_en = now() WHERE id = $1`,
      [colaborador.id, toDecimal(cupoNuevoCents)],
    );
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO cupo_historial (colaborador_id, cedula, cupo_anterior, cupo_nuevo, motivo)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [colaborador.id, cedula, toDecimal(cupoAnteriorCents), toDecimal(cupoNuevoCents), motivo],
    );
    return { cambiado: true, colaborador, cupoAnteriorCents, historialId: Number(rows[0].id) };
  });

  return json(200, {
    cedula,
    cambiado: result.cambiado,
    cupoAnterior: toAmount(result.cupoAnteriorCents),
    cupoNuevo: toAmount(cupoNuevoCents),
    saldo: toAmount(result.colaborador.saldoCents),
    historialId: result.historialId,
    mensaje: result.cambiado ? 'Cupo actualizado' : 'El cupo ya tenía ese valor; no se registró cambio',
  });
}

/** 3. Acreditar cupo — POST /colaboradores/{cedula}/acreditaciones */
export async function acreditarCupo(_event: APIGatewayProxyEventV2, params: Record<string, string>) {
  const cedula = validateCedula(params.cedula);

  const result = await withTransaction(async (db) => {
    const colaborador = await lockColaborador(db, cedula);
    if (colaborador.cupoCents <= 0) {
      throw unprocessable('CUPO_CERO', 'El colaborador tiene cupo mensual 0; no hay nada que acreditar');
    }
    const mov = await registrarMovimiento(db, colaborador, {
      tipo: 'Acreditacion',
      origen: 'Cupo',
      montoCents: colaborador.cupoCents,
    });
    return { colaborador, mov };
  });

  return json(201, {
    cedula,
    movimientoId: result.mov.id,
    montoAcreditado: toAmount(result.colaborador.cupoCents),
    saldoAnterior: toAmount(result.mov.saldoAnteriorCents),
    saldo: toAmount(result.mov.saldoPosteriorCents),
  });
}

/** Extra (no pedido): GET /colaboradores/{cedula} — saldo, historial de cupo y movimientos. */
export async function consultarColaborador(_event: APIGatewayProxyEventV2, params: Record<string, string>) {
  const cedula = validateCedula(params.cedula);

  return withClient(async (db) => {
    const colaborador = await findColaborador(db, cedula);
    if (!colaborador) throw notFound(`No existe un colaborador registrado con cédula ${cedula}`);

    const movimientos = await db.query(
      `SELECT id, tipo, origen, id_externo, referencia, ruc_proveedor, monto, estado, fecha,
              saldo_anterior, saldo_posterior, sincronizacion_id, aprobado_en, creado_en
         FROM cupo_movimientos
        WHERE colaborador_id = $1
        ORDER BY id`,
      [colaborador.id],
    );
    const historial = await db.query(
      `SELECT id, cupo_anterior, cupo_nuevo, motivo, fecha
         FROM cupo_historial
        WHERE colaborador_id = $1
        ORDER BY id`,
      [colaborador.id],
    );

    // Saldo recalculado desde el libro: debe coincidir con el saldo materializado.
    const saldoCalculadoCents = movimientos.rows.reduce(
      (acc, m) => acc + (m.tipo === 'Acreditacion' ? 1 : -1) * toCents(m.monto),
      0,
    );

    return json(200, {
      cedula,
      cupoMensual: toAmount(colaborador.cupoCents),
      saldo: toAmount(colaborador.saldoCents),
      saldoCalculado: toAmount(saldoCalculadoCents),
      historialCupo: historial.rows,
      movimientos: movimientos.rows,
    });
  });
}
