-- =====================================================================
-- Loja Ideal IA - 004: fechamento manual da loja (/fechar no Telegram)
--
-- Migration incremental (NÃO editar 001-003). Executar SOMENTE no banco
-- loja_ideal (e no loja_ideal_teste, pelo preparo dos testes). Roda em
-- uma transação.
--
-- Um dia inteiro (America/Belem) em que a loja não atende, marcado por um
-- administrador do grupo de vendedores com /fechar. A memória do backend
-- é a fonte de verdade; esta tabela só a recarrega na partida.
-- =====================================================================

BEGIN;

CREATE TABLE fechamentos (
    -- Dia fechado, no calendário de Belém.
    data        DATE         NOT NULL,

    -- Quem marcou (vendedores.id). NULL quando o administrador não está
    -- na tabela vendedores (nunca fez /start nem assumiu).
    criado_por  BIGINT,

    criado_em   TIMESTAMPTZ  NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT pk_fechamentos PRIMARY KEY (data),

    -- SET NULL: apagar um vendedor nunca é impedido por um fechamento.
    CONSTRAINT fk_fechamentos_vendedor
        FOREIGN KEY (criado_por) REFERENCES vendedores (id)
        ON DELETE SET NULL
);

COMMIT;
