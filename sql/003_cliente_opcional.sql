-- =====================================================================
-- Loja Ideal IA - 003: atendimento anonimizado sem cliente (retenção)
--
-- Migration incremental sobre a 002 (já aplicada; NÃO editar 001/002).
-- Executar SOMENTE no banco loja_ideal (e no loja_ideal_teste, pelo
-- preparo dos testes). Roda em uma transação.
--
-- Retenção de dados (LGPD): 1 ano depois de encerrado, o atendimento é
-- ANONIMIZADO (sem nome, produto, quantidade, observações e telefone no
-- chat_id) e deixa de apontar para o cliente, para que o cliente possa
-- ser apagado. O atendimento continua existindo (codigo, status, datas,
-- vendedor_id, assumido_em) para as estatísticas e o /ranking.
--
-- A FK fk_atendimentos_cliente continua ON DELETE RESTRICT: enquanto um
-- atendimento apontar para o cliente, o cliente não pode ser apagado.
-- =====================================================================

BEGIN;

ALTER TABLE atendimentos
    ALTER COLUMN cliente_id DROP NOT NULL;

COMMIT;
