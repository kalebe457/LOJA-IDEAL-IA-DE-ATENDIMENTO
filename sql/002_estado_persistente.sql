-- =====================================================================
-- Loja Ideal IA - 002: estado persistente do MVP
--
-- Migration incremental sobre o 001 (já aplicado; NÃO editar o 001).
-- Executar SOMENTE no banco loja_ideal, com um usuário dono das
-- tabelas (por enquanto, postgres). Roda em uma transação: se
-- qualquer comando falhar, nada é alterado.
--
-- Pressupõe atendimentos VAZIA: canal e chat_id entram NOT NULL sem
-- default. Com linhas existentes, a migration falha inteira.
--
-- Escopo: somente o estado do MVP atual (WhatsApp -> triagem -> resumo
-- -> Telegram -> vendedor assume). Nada de produtos, estoque, preços,
-- pedidos, CRM, campanhas, marketing ou ERP.
--
-- Regras de tempo (inatividade de 20 min, validade do resumo para
-- assumir e para o retry) são da APLICAÇÃO: nenhum intervalo fixo aqui.
--
-- Sem triggers, enums, functions, procedures ou views.
-- atualizado_em e ultima_atividade_em são mantidos pela aplicação.
-- FKs continuam ON DELETE RESTRICT (definidas no 001): sem CASCADE.
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- 1. Padronização de nomes em clientes e vendedores
-- ---------------------------------------------------------------------
ALTER TABLE clientes   RENAME COLUMN created_at TO criado_em;
ALTER TABLE clientes   RENAME COLUMN updated_at TO atualizado_em;

ALTER TABLE vendedores RENAME COLUMN created_at TO criado_em;
ALTER TABLE vendedores RENAME COLUMN updated_at TO atualizado_em;

-- ---------------------------------------------------------------------
-- 2. clientes.telefone
--
-- Continua NOT NULL e UNIQUE (001). Aqui só o formato: 10 a 15 dígitos.
-- A forma canônica (inclusive o 9º dígito) é responsabilidade da
-- aplicação. Contato do OpenWA só com @lid, sem telefone real, NÃO é
-- persistido (decisão do MVP; OpenWA é só demonstração).
-- ---------------------------------------------------------------------
ALTER TABLE clientes
    ADD CONSTRAINT chk_clientes_telefone_digitos
        CHECK (telefone ~ '^[0-9]{10,15}$');

-- ---------------------------------------------------------------------
-- 3. vendedores.ativo: seguro por padrão
--
-- A autorização de verdade vem da lista VENDEDORES_AUTORIZADOS da
-- aplicação; ativo é uma condição adicional na assunção.
-- ---------------------------------------------------------------------
ALTER TABLE vendedores
    ALTER COLUMN ativo SET DEFAULT FALSE;

-- ---------------------------------------------------------------------
-- 4. atendimentos: conversa, estado exato da triagem, atividade,
--    encerramento e fluxo do Telegram
-- ---------------------------------------------------------------------
ALTER TABLE atendimentos
    -- Conversa: identificador EXATO usado pelo backend.
    --   Meta:   meta:<phone_number_id>:<wa_id>
    --   OpenWA: ...@c.us / ...@lid
    ADD COLUMN canal                    VARCHAR(20)  NOT NULL,
    ADD COLUMN chat_id                  VARCHAR(100) NOT NULL,

    -- Triagem: etapas concluídas SEM valor ("não sei", limite de
    -- perguntas, quantidade não aplicável). Concluídas = campos
    -- preenchidos + etapas_puladas.
    ADD COLUMN etapas_puladas           TEXT[]       NOT NULL DEFAULT '{}',

    -- A linha nasce com um atendimento novo: apresentação ainda pendente.
    ADD COLUMN apresentacao_pendente    BOOLEAN      NOT NULL DEFAULT TRUE,

    ADD COLUMN quantidade_nao_aplicavel BOOLEAN      NOT NULL DEFAULT FALSE,

    -- Última atividade relevante da conversa (mensagem do cliente,
    -- resposta entregue, mensagem manual da loja). Base da inatividade
    -- e do retry do resumo. Não é atualizado_em.
    ADD COLUMN ultima_atividade_em      TIMESTAMPTZ  NOT NULL DEFAULT CURRENT_TIMESTAMP,

    -- NULL = atendimento ativo; preenchido = encerrado.
    -- status continua só IA / HUMANO.
    ADD COLUMN encerrado_em             TIMESTAMPTZ,

    -- Telegram: chat e mensagem do resumo publicado no grupo.
    ADD COLUMN telegram_chat_id         BIGINT,
    ADD COLUMN telegram_message_id      BIGINT,
    ADD COLUMN resumo_enviado_em        TIMESTAMPTZ,

    -- DM privada ao vendedor que assumiu.
    ADD COLUMN dm_status                VARCHAR(10),

    ADD CONSTRAINT chk_atendimentos_canal
        CHECK (canal IN ('META', 'OPENWA')),

    ADD CONSTRAINT chk_atendimentos_chat_id_canal
        CHECK ((canal = 'META') = (chat_id LIKE 'meta:%')),

    -- Somente as 4 etapas atuais (mesmas de chk_atendimentos_etapa_atual).
    ADD CONSTRAINT chk_atendimentos_etapas_puladas
        CHECK (etapas_puladas <@ ARRAY['nome', 'produto', 'quantidade', 'observacoes']::TEXT[]),

    -- Resumo publicado: chat, mensagem e horário andam juntos.
    ADD CONSTRAINT chk_atendimentos_resumo_telegram
        CHECK ((telegram_chat_id IS NULL) = (telegram_message_id IS NULL)
           AND (telegram_message_id IS NULL) = (resumo_enviado_em IS NULL)),

    ADD CONSTRAINT chk_atendimentos_dm_status
        CHECK (dm_status IS NULL OR dm_status IN ('ENVIANDO', 'ENVIADA', 'FALHOU')),

    -- DM só existe depois que um vendedor assumiu (e sempre existe).
    ADD CONSTRAINT chk_atendimentos_dm_vendedor
        CHECK ((dm_status IS NULL) = (vendedor_id IS NULL)),

    -- Assunção só acontece pelo botão do resumo publicado no Telegram.
    ADD CONSTRAINT chk_atendimentos_assuncao_telegram
        CHECK (vendedor_id IS NULL OR telegram_message_id IS NOT NULL),

    -- Atendimento assumido nunca fica ativo para a IA.
    ADD CONSTRAINT chk_atendimentos_assumido_encerrado
        CHECK (vendedor_id IS NULL OR encerrado_em IS NOT NULL);

-- Localizar atendimentos (inclusive encerrados) de uma conversa.
CREATE INDEX idx_atendimentos_canal_chat_id
    ON atendimentos (canal, chat_id);

-- No máximo UM atendimento ativo por conversa (canal + chat_id).
CREATE UNIQUE INDEX uq_atendimentos_conversa_ativa
    ON atendimentos (canal, chat_id)
    WHERE encerrado_em IS NULL;

-- ---------------------------------------------------------------------
-- 5. eventos_processados: deduplicação técnica dos webhooks
--
-- "Já processei este evento?" Independe de atendimento: registra também
-- eventos descartados antes de existir atendimento. O histórico da
-- conversa continua em mensagens. Evento sem ID externo não é
-- registrado (processado normalmente, como hoje).
-- Limpeza futura (~7 dias) ainda não implementada.
-- ---------------------------------------------------------------------
CREATE TABLE eventos_processados (
    id                   BIGSERIAL    NOT NULL,
    canal                VARCHAR(20)  NOT NULL,
    mensagem_externa_id  VARCHAR(150) NOT NULL,
    recebido_em          TIMESTAMPTZ  NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT pk_eventos_processados PRIMARY KEY (id),

    CONSTRAINT chk_eventos_processados_canal
        CHECK (canal IN ('META', 'OPENWA')),

    CONSTRAINT uq_eventos_processados_canal_externa
        UNIQUE (canal, mensagem_externa_id)
);

CREATE INDEX idx_eventos_processados_recebido_em
    ON eventos_processados (recebido_em);

COMMIT;
