-- =====================================================================
-- Loja Ideal IA - schema inicial do MVP
--
-- Banco do NOSSO sistema (não é o banco/ERP da loja).
-- Persiste: clientes, vendedores (Telegram), atendimentos e mensagens.
--
-- Executar no banco loja_ideal. Roda inteiro em uma transação:
-- se qualquer comando falhar, nada é criado.
--
-- Sem triggers: updated_at / atualizado_em são atualizados pela aplicação.
-- Sem ON DELETE CASCADE: apagar cliente/vendedor/atendimento com histórico
-- é bloqueado pelas FKs (RESTRICT), preservando o histórico.
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- clientes: identificados pelo telefone do WhatsApp
-- ---------------------------------------------------------------------
CREATE TABLE clientes (
    id          BIGSERIAL    NOT NULL,
    telefone    VARCHAR(20)  NOT NULL,
    nome        VARCHAR(150),
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at  TIMESTAMPTZ  NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT pk_clientes PRIMARY KEY (id),
    CONSTRAINT uq_clientes_telefone UNIQUE (telefone)
);

-- ---------------------------------------------------------------------
-- vendedores: registrados pelo /start no privado do bot do Telegram.
-- Sem telefone do vendedor; a identidade é o telegram_user_id.
-- ---------------------------------------------------------------------
CREATE TABLE vendedores (
    id                BIGSERIAL    NOT NULL,
    telegram_user_id  BIGINT       NOT NULL,
    nome              VARCHAR(150) NOT NULL,
    telegram_chat_id  BIGINT       NOT NULL,
    ativo             BOOLEAN      NOT NULL DEFAULT TRUE,
    created_at        TIMESTAMPTZ  NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at        TIMESTAMPTZ  NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT pk_vendedores PRIMARY KEY (id),
    CONSTRAINT uq_vendedores_telegram_user_id UNIQUE (telegram_user_id)
);

-- ---------------------------------------------------------------------
-- atendimentos: estado da triagem, dados coletados e assunção.
--
-- status HUMANO com vendedor_id NULL é válido (cliente pediu humano,
-- triagem concluída ou falha da IA, antes de um vendedor assumir).
-- vendedor_id só é preenchido quando um vendedor assume.
-- ---------------------------------------------------------------------
CREATE TABLE atendimentos (
    id               BIGSERIAL    NOT NULL,
    codigo           VARCHAR(20)  NOT NULL,
    cliente_id       BIGINT       NOT NULL,
    status           VARCHAR(20)  NOT NULL,
    etapa_atual      VARCHAR(30),
    nome             VARCHAR(150),
    produto          TEXT,
    quantidade       TEXT,
    observacoes      TEXT,
    perguntas_etapa  INTEGER      NOT NULL DEFAULT 0,
    vendedor_id      BIGINT,
    criado_em        TIMESTAMPTZ  NOT NULL DEFAULT CURRENT_TIMESTAMP,
    atualizado_em    TIMESTAMPTZ  NOT NULL DEFAULT CURRENT_TIMESTAMP,
    assumido_em      TIMESTAMPTZ,

    CONSTRAINT pk_atendimentos PRIMARY KEY (id),
    CONSTRAINT uq_atendimentos_codigo UNIQUE (codigo),

    CONSTRAINT fk_atendimentos_cliente
        FOREIGN KEY (cliente_id) REFERENCES clientes (id)
        ON DELETE RESTRICT,

    CONSTRAINT fk_atendimentos_vendedor
        FOREIGN KEY (vendedor_id) REFERENCES vendedores (id)
        ON DELETE RESTRICT,

    -- Estados de src/tipos.ts (StatusAtendimento).
    CONSTRAINT chk_atendimentos_status
        CHECK (status IN ('IA', 'HUMANO')),

    -- Etapas de src/iaClaude.ts (ORDEM_ETAPAS). NULL = sem etapa ativa.
    CONSTRAINT chk_atendimentos_etapa_atual
        CHECK (etapa_atual IS NULL
               OR etapa_atual IN ('nome', 'produto', 'quantidade', 'observacoes')),

    -- MAX_PERGUNTAS_POR_ETAPA = 2 em src/iaClaude.ts.
    CONSTRAINT chk_atendimentos_perguntas_etapa
        CHECK (perguntas_etapa BETWEEN 0 AND 2),

    -- Quem assumiu e quando andam juntos.
    CONSTRAINT chk_atendimentos_assuncao
        CHECK ((vendedor_id IS NULL) = (assumido_em IS NULL))
);

CREATE INDEX idx_atendimentos_cliente_id  ON atendimentos (cliente_id);
CREATE INDEX idx_atendimentos_vendedor_id ON atendimentos (vendedor_id);
CREATE INDEX idx_atendimentos_status      ON atendimentos (status);

-- ---------------------------------------------------------------------
-- mensagens: histórico mínimo da conversa do CLIENTE e deduplicação
-- persistente. Telegram (canal interno dos vendedores) não entra aqui.
-- ---------------------------------------------------------------------
CREATE TABLE mensagens (
    id                   BIGSERIAL    NOT NULL,
    atendimento_id       BIGINT       NOT NULL,
    direcao              VARCHAR(10)  NOT NULL,
    canal                VARCHAR(20)  NOT NULL,
    mensagem_externa_id  VARCHAR(150),
    texto                TEXT,
    criado_em            TIMESTAMPTZ  NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT pk_mensagens PRIMARY KEY (id),

    CONSTRAINT fk_mensagens_atendimento
        FOREIGN KEY (atendimento_id) REFERENCES atendimentos (id)
        ON DELETE RESTRICT,

    CONSTRAINT chk_mensagens_direcao
        CHECK (direcao IN ('ENTRADA', 'SAIDA')),

    -- Canais de conversa existentes hoje. Novo canal = ALTER desta CHECK.
    CONSTRAINT chk_mensagens_canal
        CHECK (canal IN ('META', 'OPENWA')),

    -- Deduplicação por canal. NULLs não colidem (mensagens sem ID externo).
    CONSTRAINT uq_mensagens_canal_externa
        UNIQUE (canal, mensagem_externa_id)
);

-- Histórico de um atendimento em ordem cronológica.
CREATE INDEX idx_mensagens_atendimento_criado_em
    ON mensagens (atendimento_id, criado_em);

COMMIT;
