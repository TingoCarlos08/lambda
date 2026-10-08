import { badRequest } from './http';
import { toCents } from './money';

const MAX_CENTS = 999_999_999_999; // DECIMAL(12,2)

export function requireString(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== 'string' || value.trim() === '') {
    throw badRequest(`El campo '${field}' es obligatorio y debe ser texto`);
  }
  return value.trim();
}

export function optionalString(body: Record<string, unknown>, field: string, maxLength: number): string | null {
  const value = body[field];
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw badRequest(`El campo '${field}' debe ser texto`);
  const text = value.trim();
  if (text.length > maxLength) throw badRequest(`El campo '${field}' admite máximo ${maxLength} caracteres`);
  return text === '' ? null : text;
}

export function validateCedula(value: string, field = 'cedula'): string {
  if (!/^\d{10}$/.test(value)) {
    throw badRequest(`El campo '${field}' debe tener exactamente 10 dígitos`);
  }
  return value;
}

/**
 * Monto con máximo 2 decimales. Acepta number (45.5) o string ("45.50").
 * Devuelve centavos.
 */
export function requireAmount(
  body: Record<string, unknown>,
  field: string,
  { allowZero }: { allowZero: boolean },
): number {
  const value = body[field];
  let text: string;
  if (typeof value === 'number' && Number.isFinite(value)) text = String(value);
  else if (typeof value === 'string') text = value.trim();
  else throw badRequest(`El campo '${field}' es obligatorio y debe ser numérico`);

  if (!/^\d+(\.\d{1,2})?$/.test(text)) {
    throw badRequest(`El campo '${field}' debe ser un número no negativo con máximo 2 decimales`);
  }
  const cents = toCents(text);
  if (cents > MAX_CENTS) throw badRequest(`El campo '${field}' excede el máximo permitido`);
  if (!allowZero && cents === 0) throw badRequest(`El campo '${field}' debe ser mayor que cero`);
  return cents;
}

export function optionalDate(body: Record<string, unknown>, field: string): string | null {
  const value = body[field];
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw badRequest(`El campo '${field}' debe tener formato YYYY-MM-DD`);
  }
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw badRequest(`El campo '${field}' no es una fecha válida`);
  }
  return value;
}
