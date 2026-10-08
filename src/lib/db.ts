import { Pool, PoolClient, types } from 'pg';

// DATE (OID 1082) se devuelve como texto 'YYYY-MM-DD' para no sufrir conversiones de zona horaria.
types.setTypeParser(1082, (v) => v);

// El pool vive fuera del handler para reutilizarse entre invocaciones de la lambda.
const pool = new Pool({
  host: process.env.PGHOST ?? 'localhost',
  port: Number(process.env.PGPORT ?? 5432),
  user: process.env.PGUSER ?? 'cupo',
  password: process.env.PGPASSWORD ?? 'cupo',
  database: process.env.PGDATABASE ?? 'cupo',
  max: 5,
});

// Una conexión inactiva que se cae (p. ej. reinicio de Postgres) emite 'error' en el pool;
// sin este listener el proceso terminaría. El pool descarta esa conexión y abre otra.
pool.on('error', (err) => console.error('Conexión inactiva de Postgres falló', err.message));

export type Db = PoolClient;

export async function withTransaction<T>(fn: (db: Db) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

export async function withClient<T>(fn: (db: Db) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

/**
 * Lock lógico a nivel de transacción. Reemplaza lo que haría un UNIQUE o una PK:
 * serializa operaciones sobre la misma llave (p. ej. crear dos veces la misma cédula,
 * o ejecutar dos sincronizaciones a la vez). Se libera solo al terminar la transacción.
 */
export async function advisoryLock(db: Db, key: string): Promise<void> {
  await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [key]);
}

export async function closePool(): Promise<void> {
  await pool.end();
}
