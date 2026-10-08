-- =====================================================================
-- Tablas propias del servicio de cupo vehicular.
--
-- Restricción del enunciado: NINGUNA restricción a nivel de BD
-- (sin PK, FK, UNIQUE, CHECK, NOT NULL, triggers ni procedimientos).
-- Los IDs se generan con secuencias (un DEFAULT no es una restricción)
-- y la unicidad/integridad se valida en los endpoints.
-- Los índices son NO únicos y existen solo por rendimiento.
-- =====================================================================

-- ---------------------------------------------------------------------
-- CUPO_COLABORADORES: colaboradores habilitados y su saldo actual.
-- SALDO es un acumulado materializado de CUPO_MOVIMIENTOS; siempre se
-- actualiza en la misma transacción que inserta/modifica un movimiento.
-- ---------------------------------------------------------------------
CREATE SEQUENCE CUPO_COLABORADORES_SEQ;

CREATE TABLE CUPO_COLABORADORES (
    ID              BIGINT        DEFAULT nextval('CUPO_COLABORADORES_SEQ'),
    CEDULA          VARCHAR(20),
    CUPO_MENSUAL    DECIMAL(12,2),
    SALDO           DECIMAL(12,2),
    CREADO_EN       TIMESTAMPTZ   DEFAULT now(),
    ACTUALIZADO_EN  TIMESTAMPTZ   DEFAULT now()
);

CREATE INDEX IX_CUPO_COLABORADORES_CEDULA ON CUPO_COLABORADORES (CEDULA);

-- ---------------------------------------------------------------------
-- CUPO_HISTORIAL: trazabilidad de cada cambio del cupo mensual.
-- La creación del colaborador también se registra (CUPO_ANTERIOR NULL).
-- ---------------------------------------------------------------------
CREATE SEQUENCE CUPO_HISTORIAL_SEQ;

CREATE TABLE CUPO_HISTORIAL (
    ID              BIGINT        DEFAULT nextval('CUPO_HISTORIAL_SEQ'),
    COLABORADOR_ID  BIGINT,
    CEDULA          VARCHAR(20),
    CUPO_ANTERIOR   DECIMAL(12,2),
    CUPO_NUEVO      DECIMAL(12,2),
    MOTIVO          VARCHAR(200),
    FECHA           TIMESTAMPTZ   DEFAULT now()
);

CREATE INDEX IX_CUPO_HISTORIAL_COLABORADOR ON CUPO_HISTORIAL (COLABORADOR_ID);

-- ---------------------------------------------------------------------
-- CUPO_MOVIMIENTOS: la cuenta corriente (libro mayor) del colaborador.
--   TIPO    'Acreditacion' (suma) | 'Gasto' (resta)
--   ORIGEN  'Cupo' (acreditación) | 'Facturas' | 'GasClub'
--   ID_EXTERNO  ID de la fila en SGR_FACTURAS o SGR_GASCLUB_GASTOS.
--               (ORIGEN, ID_EXTERNO) es la llave de idempotencia de las
--               sincronizaciones; se valida en código.
--   MONTO   siempre positivo; el signo lo da TIPO.
--   ESTADO  solo para facturas: 'Pendiente' | 'Aprobado'.
--   SALDO_ANTERIOR / SALDO_POSTERIOR: foto del saldo al registrar.
--
-- Invariante: CUPO_COLABORADORES.SALDO =
--   SUM(Acreditacion.MONTO) - SUM(Gasto.MONTO)
-- ---------------------------------------------------------------------
CREATE SEQUENCE CUPO_MOVIMIENTOS_SEQ;

CREATE TABLE CUPO_MOVIMIENTOS (
    ID                  BIGINT        DEFAULT nextval('CUPO_MOVIMIENTOS_SEQ'),
    COLABORADOR_ID      BIGINT,
    CEDULA              VARCHAR(20),
    TIPO                VARCHAR(15),
    ORIGEN              VARCHAR(15),
    ID_EXTERNO          INT,
    REFERENCIA          VARCHAR(30),   -- número de factura o referencia GasClub
    RUC_PROVEEDOR       VARCHAR(20),
    MONTO               DECIMAL(12,2),
    ESTADO              VARCHAR(15),
    FECHA               DATE,          -- fecha del documento / consumo
    SALDO_ANTERIOR      DECIMAL(12,2),
    SALDO_POSTERIOR     DECIMAL(12,2),
    SINCRONIZACION_ID   BIGINT,        -- sincronización que lo creó (NULL si vino por endpoint)
    APROBADO_EN         TIMESTAMPTZ,   -- cuándo la sincronización detectó la aprobación
    CREADO_EN           TIMESTAMPTZ   DEFAULT now(),
    ACTUALIZADO_EN      TIMESTAMPTZ   DEFAULT now()
);

CREATE INDEX IX_CUPO_MOVIMIENTOS_COLABORADOR ON CUPO_MOVIMIENTOS (COLABORADOR_ID);
CREATE INDEX IX_CUPO_MOVIMIENTOS_ORIGEN_EXT  ON CUPO_MOVIMIENTOS (ORIGEN, ID_EXTERNO);

-- ---------------------------------------------------------------------
-- CUPO_SINCRONIZACIONES: bitácora de cada ejecución de sincronización.
-- DETALLE guarda qué filas se crearon/actualizaron y qué cambió.
-- ---------------------------------------------------------------------
CREATE SEQUENCE CUPO_SINCRONIZACIONES_SEQ;

CREATE TABLE CUPO_SINCRONIZACIONES (
    ID              BIGINT        DEFAULT nextval('CUPO_SINCRONIZACIONES_SEQ'),
    TIPO            VARCHAR(15),  -- 'Facturas' | 'GasClub'
    INICIADO_EN     TIMESTAMPTZ   DEFAULT now(),
    FINALIZADO_EN   TIMESTAMPTZ,
    LEIDOS          INT,
    NUEVOS          INT,
    ACTUALIZADOS    INT,
    SIN_CAMBIOS     INT,
    DETALLE         JSONB
);
