/**
 * Los montos se manejan internamente en centavos (enteros) para evitar errores de
 * punto flotante. Postgres devuelve DECIMAL como string ('120.00', '-12.30').
 */
export function toCents(value: string | number): number {
  const text = typeof value === 'number' ? value.toFixed(2) : value.trim();
  const match = /^(-)?(\d+)(?:\.(\d{1,2}))?$/.exec(text);
  if (!match) throw new Error(`Monto inválido: ${value}`);
  const [, sign, whole, fraction = ''] = match;
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  return sign ? -cents : cents;
}

/** Centavos → string decimal apto para parámetros SQL ('12.30', '-5.00'). */
export function toDecimal(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

/** Centavos → number para respuestas JSON. */
export function toAmount(cents: number): number {
  return cents / 100;
}
