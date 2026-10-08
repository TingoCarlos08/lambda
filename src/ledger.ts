import type { Db } from './lib/db';
import { notFound } from './lib/http';
import { toCents, toDecimal } from './lib/money';

export type TipoMovimiento = 'Acreditacion' | 'Gasto';
export type OrigenMovimiento = 'Cupo' | 'Facturas' | 'GasClub';

export interface Colaborador {
  id: number;
  cedula: string;
  cupoCents: number;
  saldoCents: number;
}

interface ColaboradorRow {
  id: string;
  cedula: string;
  cupo_mensual: string;
  saldo: string;
}

const mapColaborador = (row: ColaboradorRow): Colaborador => ({
  id: Number(row.id),
  cedula: row.cedula,
  cupoCents: toCents(row.cupo_mensual),
  saldoCents: toCents(row.saldo),
});

export async function findColaborador(db: Db, cedula: string): Promise<Colaborador | null> {
  const { rows } = await db.query<ColaboradorRow>(
    `SELECT id, cedula, cupo_mensual, saldo
       FROM cupo_colaboradores
      WHERE cedula = $1
      ORDER BY id
      LIMIT 1`,
    [cedula],
  );
  return rows[0] ? mapColaborador(rows[0]) : null;
}

/**
 * Obtiene el colaborador bloqueando su fila (SELECT ... FOR UPDATE) hasta el fin de la
 * transacción. Toda operación que cambie el saldo debe pasar por aquí primero, así dos
 * operaciones concurrentes sobre el mismo colaborador se serializan.
 */
export async function lockColaborador(db: Db, cedula: string): Promise<Colaborador> {
  const { rows } = await db.query<ColaboradorRow>(
    `SELECT id, cedula, cupo_mensual, saldo
       FROM cupo_colaboradores
      WHERE cedula = $1
      ORDER BY id
      LIMIT 1
        FOR UPDATE`,
    [cedula],
  );
  if (!rows[0]) throw notFound(`No existe un colaborador registrado con cédula ${cedula}`);
  return mapColaborador(rows[0]);
}

/** Bloquea a todos los colaboradores registrados (orden por id para evitar deadlocks). */
export async function lockAllColaboradores(db: Db): Promise<Map<string, Colaborador>> {
  const { rows } = await db.query<ColaboradorRow>(
    `SELECT id, cedula, cupo_mensual, saldo
       FROM cupo_colaboradores
      ORDER BY id
        FOR UPDATE`,
  );
  const byCedula = new Map<string, Colaborador>();
  for (const row of rows) {
    if (!byCedula.has(row.cedula)) byCedula.set(row.cedula, mapColaborador(row));
  }
  return byCedula;
}

export interface NuevoMovimiento {
  tipo: TipoMovimiento;
  origen: OrigenMovimiento;
  montoCents: number;
  idExterno?: number | null;
  referencia?: string | null;
  rucProveedor?: string | null;
  estado?: string | null;
  fecha?: string | null;
  sincronizacionId?: number | null;
  aprobado?: boolean;
}

export interface MovimientoRegistrado {
  id: number;
  saldoAnteriorCents: number;
  saldoPosteriorCents: number;
}

/**
 * Registra un movimiento y actualiza el saldo del colaborador en la misma transacción.
 * Precondición: el colaborador fue bloqueado con lockColaborador / lockAllColaboradores.
 * Muta colaborador.saldoCents para que el llamador vea el saldo actualizado.
 */
export async function registrarMovimiento(
  db: Db,
  colaborador: Colaborador,
  mov: NuevoMovimiento,
): Promise<MovimientoRegistrado> {
  const delta = mov.tipo === 'Acreditacion' ? mov.montoCents : -mov.montoCents;

  const updated = await db.query<{ saldo: string }>(
    `UPDATE cupo_colaboradores
        SET saldo = saldo + $2, actualizado_en = now()
      WHERE id = $1
  RETURNING saldo`,
    [colaborador.id, toDecimal(delta)],
  );
  const saldoPosteriorCents = toCents(updated.rows[0].saldo);
  const saldoAnteriorCents = saldoPosteriorCents - delta;

  const inserted = await db.query<{ id: string }>(
    `INSERT INTO cupo_movimientos
       (colaborador_id, cedula, tipo, origen, id_externo, referencia, ruc_proveedor, monto, estado,
        fecha, saldo_anterior, saldo_posterior, sincronizacion_id, aprobado_en)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9,
             COALESCE($10::date, CURRENT_DATE), $11, $12, $13, CASE WHEN $14 THEN now() END)
     RETURNING id`,
    [
      colaborador.id,
      colaborador.cedula,
      mov.tipo,
      mov.origen,
      mov.idExterno ?? null,
      mov.referencia ?? null,
      mov.rucProveedor ?? null,
      toDecimal(mov.montoCents),
      mov.estado ?? null,
      mov.fecha ?? null,
      toDecimal(saldoAnteriorCents),
      toDecimal(saldoPosteriorCents),
      mov.sincronizacionId ?? null,
      mov.aprobado ?? false,
    ],
  );

  colaborador.saldoCents = saldoPosteriorCents;
  return { id: Number(inserted.rows[0].id), saldoAnteriorCents, saldoPosteriorCents };
}

/** Ajusta el saldo sin crear un movimiento nuevo (corrección del monto de un movimiento existente). */
export async function ajustarSaldo(db: Db, colaborador: Colaborador, deltaCents: number): Promise<void> {
  const updated = await db.query<{ saldo: string }>(
    `UPDATE cupo_colaboradores
        SET saldo = saldo + $2, actualizado_en = now()
      WHERE id = $1
  RETURNING saldo`,
    [colaborador.id, toDecimal(deltaCents)],
  );
  colaborador.saldoCents = toCents(updated.rows[0].saldo);
}

/** Abre el registro de una sincronización y devuelve su id. */
export async function iniciarSincronizacion(db: Db, tipo: 'Facturas' | 'GasClub'): Promise<number> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO cupo_sincronizaciones (tipo) VALUES ($1) RETURNING id`,
    [tipo],
  );
  return Number(rows[0].id);
}

export interface ResumenSincronizacion {
  leidos: number;
  nuevos: number;
  actualizados: number;
  sinCambios: number;
  detalle: unknown;
}

export async function cerrarSincronizacion(db: Db, id: number, r: ResumenSincronizacion): Promise<void> {
  await db.query(
    `UPDATE cupo_sincronizaciones
        SET finalizado_en = now(), leidos = $2, nuevos = $3, actualizados = $4, sin_cambios = $5, detalle = $6
      WHERE id = $1`,
    [id, r.leidos, r.nuevos, r.actualizados, r.sinCambios, JSON.stringify(r.detalle)],
  );
}
