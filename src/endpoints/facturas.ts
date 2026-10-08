import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { withTransaction } from '../lib/db';
import { badRequest, conflict, json, parseBody, unprocessable } from '../lib/http';
import { toAmount, toDecimal } from '../lib/money';
import { optionalDate, requireAmount, requireString, validateCedula } from '../lib/validation';
import { lockColaborador, registrarMovimiento } from '../ledger';

/**
 * 4. Registrar factura — POST /facturas
 *    { cedula, numeroFactura, rucProveedor, total, fecha? }
 *
 * Inserta la factura en SGR_FACTURAS (Pendiente) y su gasto en CUPO_MOVIMIENTOS en una sola
 * transacción. El gasto descuenta saldo desde que se registra, aunque esté Pendiente: como no
 * existen rechazos, toda factura registrada terminará aprobada y así evitamos que se registren
 * varias facturas que en conjunto superen el saldo.
 */
export async function registrarFactura(event: APIGatewayProxyEventV2) {
  const body = parseBody(event);
  const cedula = validateCedula(requireString(body, 'cedula'));
  const numeroFactura = requireString(body, 'numeroFactura');
  const rucProveedor = requireString(body, 'rucProveedor');
  const totalCents = requireAmount(body, 'total', { allowZero: false });
  const fecha = optionalDate(body, 'fecha');

  if (!/^\d{3}-\d{3}-\d{9}$/.test(numeroFactura)) {
    throw badRequest("El campo 'numeroFactura' debe tener el formato 001-001-000000123");
  }
  if (!/^\d{13}$/.test(rucProveedor)) {
    throw badRequest("El campo 'rucProveedor' debe tener exactamente 13 dígitos");
  }

  const result = await withTransaction(async (db) => {
    // 1) Colaborador debe existir; su fila queda bloqueada hasta el COMMIT.
    const colaborador = await lockColaborador(db, cedula);

    // 2) El total no puede superar el saldo disponible.
    if (totalCents > colaborador.saldoCents) {
      throw unprocessable('SALDO_INSUFICIENTE', 'El total de la factura supera el saldo disponible', {
        saldoDisponible: toAmount(colaborador.saldoCents),
        total: toAmount(totalCents),
      });
    }

    // 3) SGR_FACTURAS no tiene PK ni UNIQUE: bloqueamos la tabla contra inserciones
    //    concurrentes para calcular el siguiente ID y validar duplicados sin carreras.
    //    Las lecturas no se bloquean; escrituras externas (p. ej. el UPDATE de aprobación)
    //    solo esperan lo que dura esta transacción.
    await db.query('LOCK TABLE sgr_facturas IN SHARE ROW EXCLUSIVE MODE');

    const duplicada = await db.query(
      `SELECT id FROM sgr_facturas WHERE numero_factura = $1 AND ruc_proveedor = $2 LIMIT 1`,
      [numeroFactura, rucProveedor],
    );
    if (duplicada.rowCount) {
      throw conflict(
        `La factura ${numeroFactura} del proveedor ${rucProveedor} ya está registrada (ID ${duplicada.rows[0].id})`,
      );
    }

    const { rows } = await db.query<{ id: number; fecha: string }>(
      `INSERT INTO sgr_facturas (id, cedula, numero_factura, ruc_proveedor, total, fecha, estado)
       SELECT COALESCE(MAX(id), 0) + 1, $1, $2, $3, $4, COALESCE($5::date, CURRENT_DATE), 'Pendiente'
         FROM sgr_facturas
       RETURNING id, fecha`,
      [cedula, numeroFactura, rucProveedor, toDecimal(totalCents), fecha],
    );
    const factura = rows[0];

    // 4) Registro propio, también Pendiente, enlazado por ID_EXTERNO.
    const mov = await registrarMovimiento(db, colaborador, {
      tipo: 'Gasto',
      origen: 'Facturas',
      montoCents: totalCents,
      idExterno: factura.id,
      referencia: numeroFactura,
      rucProveedor,
      estado: 'Pendiente',
      fecha: factura.fecha,
    });

    return { factura, mov };
  });

  return json(201, {
    facturaId: result.factura.id,
    movimientoId: result.mov.id,
    cedula,
    numeroFactura,
    rucProveedor,
    total: toAmount(totalCents),
    fecha: result.factura.fecha,
    estado: 'Pendiente',
    saldoAnterior: toAmount(result.mov.saldoAnteriorCents),
    saldo: toAmount(result.mov.saldoPosteriorCents),
  });
}
