-- =====================================================================
-- Tablas entregadas por el enunciado (sin cambios de estructura).
-- =====================================================================

CREATE TABLE SGR_FACTURAS (
    ID              INT,
    CEDULA          VARCHAR(20),
    NUMERO_FACTURA  VARCHAR(30),
    RUC_PROVEEDOR   VARCHAR(20),
    TOTAL           DECIMAL(12,2),
    FECHA           DATE,
    ESTADO          VARCHAR(15)   -- 'Pendiente' | 'Aprobado'
);

CREATE TABLE SGR_GASCLUB_GASTOS (
    ID          INT,
    CEDULA      VARCHAR(20),
    REFERENCIA  VARCHAR(30),      -- código del consumo en GasClub
    TOTAL       DECIMAL(12,2),
    FECHA       DATE
);
