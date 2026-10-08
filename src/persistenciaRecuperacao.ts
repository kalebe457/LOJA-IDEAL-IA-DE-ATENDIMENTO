import { obterConexao } from "./banco.js";

import type { EtapaTriagem, StatusAtendimento } from "./tipos.js";

/*
 * Leitura do banco na PARTIDA (Passo 5d).
 *
 * Única vez em que o banco é lido para montar a memória. Depois
 * disso a memória volta a ser a fonte de verdade.
 *
 * Uma transação curta (statement_timeout de 5 s):
 * 1. encerra os atendimentos abertos que passaram da inatividade
 *    (mesma regra da execução);
 * 2. lê as conversas a reconstruir: abertas, e assumidas com
 *    atividade recente (a IA continua calada para elas);
 * 3. lê as mensagens dessas conversas (histórico do Claude);
 * 4. lê os resumos publicados dentro do TTL (lock do Telegram),
 *    os resumos ainda não publicados e os vendedores.
 *
 * Só os chats do próprio número (meta:<phone_number_id>:...).
 * Lança em caso de erro: quem chama decide (sobe com memória vazia).
 */

const STATEMENT_TIMEOUT = "5s";

export type ConversaRecuperada = {
  atendimentoDbId: string;

  codigo: string;

  chatId: string;

  telefone: string;

  status: StatusAtendimento;

  /*
   * true = assumida por vendedor (IA calada).
   */
  assumida: boolean;

  etapaAtual: EtapaTriagem | null;

  perguntasEtapa: number;

  etapasPuladas: EtapaTriagem[];

  apresentacaoPendente: boolean;

  quantidadeNaoAplicavel: boolean;

  /*
   * Campos coletados; null = não informado.
   */
  nome: string | null;

  produto: string | null;

  quantidade: string | null;

  observacoes: string | null;

  ultimaAtividadeEm: number;

  /*
   * Histórico do atendimento em ordem (vazio fora da triagem).
   */
  historico: { direcao: "ENTRADA" | "SAIDA"; texto: string }[];

  /*
   * criado_em da última mensagem gravada (0 = nenhuma).
   */
  ultimaMensagemEm: number;
};

export type ResumoRecuperado = {
  codigo: string;

  chatId: string;

  telefone: string;

  nome: string | null;

  produto: string | null;

  quantidade: string | null;

  observacoes: string | null;

  telegramChatId: string | null;

  telegramMessageId: number | null;

  resumoEnviadoEm: number | null;

  assumidoEm: number | null;

  dmStatus: "ENVIANDO" | "ENVIADA" | "FALHOU" | null;

  vendedorUserId: string | null;

  vendedorNome: string | null;
};

export type VendedorRecuperado = {
  userId: string;

  nome: string;

  chatPrivadoId: number;
};

export type DadosRecuperacao = {
  encerradosPorInatividade: number;

  conversas: ConversaRecuperada[];

  /*
   * Resumos publicados dentro do TTL (inclusive encerrados).
   */
  resumosPublicados: ResumoRecuperado[];

  /*
   * Triagem concluída, sem vendedor e sem resumo publicado,
   * com atividade dentro do TTL.
   */
  resumosNaoPublicados: ResumoRecuperado[];

  vendedores: VendedorRecuperado[];
};

export type ParametrosRecuperacao = {
  phoneNumberId: string;

  /*
   * Relógio da aplicação (ms).
   */
  agora: number;

  inatividadeMs: number;

  /*
   * null = não lê nada do Telegram (TTL ou Telegram não
   * configurados).
   */
  ttlResumoMs: number | null;
};

const ms = (valor: Date | null): number | null => (valor ? valor.getTime() : null);

function paraResumo(linha: Record<string, any>): ResumoRecuperado {
  return {
    codigo: linha.codigo,
    chatId: linha.chat_id,
    telefone: linha.telefone,
    nome: linha.nome,
    produto: linha.produto,
    quantidade: linha.quantidade,
    observacoes: linha.observacoes,
    telegramChatId: linha.telegram_chat_id,
    telegramMessageId: linha.telegram_message_id === null ? null : Number(linha.telegram_message_id),
    resumoEnviadoEm: ms(linha.resumo_enviado_em),
    assumidoEm: ms(linha.assumido_em),
    dmStatus: linha.dm_status,
    vendedorUserId: linha.v_user,
    vendedorNome: linha.v_nome,
  };
}

const COLUNAS_RESUMO = `
  a.codigo, a.chat_id, c.telefone, a.nome, a.produto, a.quantidade, a.observacoes,
  a.telegram_chat_id, a.telegram_message_id, a.resumo_enviado_em, a.assumido_em, a.dm_status,
  v.telegram_user_id AS v_user, v.nome AS v_nome`;

export async function lerDadosRecuperacao(
  parametros: ParametrosRecuperacao,
): Promise<DadosRecuperacao> {
  const prefixo = `meta:${parametros.phoneNumberId}:%`;

  const limiteInatividade = (parametros.agora - parametros.inatividadeMs) / 1000;

  const conexao = await obterConexao();

  try {
    await conexao.query("BEGIN");

    await conexao.query(`SET LOCAL statement_timeout = '${STATEMENT_TIMEOUT}'`);

    const encerrados = await conexao.query(
      `UPDATE atendimentos SET encerrado_em = now(), atualizado_em = now()
        WHERE canal = 'META' AND chat_id LIKE $1 AND encerrado_em IS NULL
          AND ultima_atividade_em <= to_timestamp($2)`,
      [prefixo, limiteInatividade],
    );

    /*
     * Por chat, só o atendimento mais recente.
     */
    const conversas = await conexao.query(
      `SELECT DISTINCT ON (a.chat_id)
              a.id, a.codigo, a.chat_id, c.telefone, a.status, a.vendedor_id, a.encerrado_em,
              a.etapa_atual, a.perguntas_etapa, a.etapas_puladas, a.apresentacao_pendente,
              a.quantidade_nao_aplicavel, a.nome, a.produto, a.quantidade, a.observacoes,
              a.ultima_atividade_em
         FROM atendimentos a JOIN clientes c ON c.id = a.cliente_id
        WHERE a.canal = 'META' AND a.chat_id LIKE $1
          AND (a.encerrado_em IS NULL
               OR (a.vendedor_id IS NOT NULL AND a.ultima_atividade_em > to_timestamp($2)))
        ORDER BY a.chat_id, a.criado_em DESC, a.id DESC`,
      [prefixo, limiteInatividade],
    );

    const recuperadas: ConversaRecuperada[] = conversas.rows.map((linha) => ({
      atendimentoDbId: String(linha.id),
      codigo: linha.codigo,
      chatId: linha.chat_id,
      telefone: linha.telefone,
      status: linha.status,
      assumida: linha.vendedor_id !== null,
      etapaAtual: linha.etapa_atual,
      perguntasEtapa: Number(linha.perguntas_etapa),
      etapasPuladas: linha.etapas_puladas ?? [],
      apresentacaoPendente: linha.apresentacao_pendente,
      quantidadeNaoAplicavel: linha.quantidade_nao_aplicavel,
      nome: linha.nome,
      produto: linha.produto,
      quantidade: linha.quantidade,
      observacoes: linha.observacoes,
      ultimaAtividadeEm: linha.ultima_atividade_em.getTime(),
      historico: [],
      ultimaMensagemEm: 0,
    }));

    if (recuperadas.length > 0) {
      const porId = new Map(recuperadas.map((c) => [c.atendimentoDbId, c]));

      const mensagens = await conexao.query(
        `SELECT atendimento_id, direcao, texto, criado_em
           FROM mensagens WHERE atendimento_id = ANY($1::bigint[])
          ORDER BY atendimento_id, criado_em, id`,
        [[...porId.keys()]],
      );

      for (const m of mensagens.rows) {
        const conversa = porId.get(String(m.atendimento_id));

        if (!conversa) {
          continue;
        }

        conversa.ultimaMensagemEm = Math.max(conversa.ultimaMensagemEm, m.criado_em.getTime());

        /*
         * Histórico do Claude só importa durante a triagem.
         */
        if (conversa.status === "IA" && !conversa.assumida && typeof m.texto === "string") {
          conversa.historico.push({ direcao: m.direcao, texto: m.texto });
        }
      }
    }

    let resumosPublicados: ResumoRecuperado[] = [];

    let resumosNaoPublicados: ResumoRecuperado[] = [];

    let vendedores: VendedorRecuperado[] = [];

    if (parametros.ttlResumoMs !== null) {
      const limiteTtl = (parametros.agora - parametros.ttlResumoMs) / 1000;

      resumosPublicados = (
        await conexao.query(
          `SELECT ${COLUNAS_RESUMO}
             FROM atendimentos a JOIN clientes c ON c.id = a.cliente_id
             LEFT JOIN vendedores v ON v.id = a.vendedor_id
            WHERE a.canal = 'META' AND a.chat_id LIKE $1
              AND a.resumo_enviado_em IS NOT NULL AND a.resumo_enviado_em > to_timestamp($2)
            ORDER BY a.resumo_enviado_em`,
          [prefixo, limiteTtl],
        )
      ).rows.map(paraResumo);

      resumosNaoPublicados = (
        await conexao.query(
          `SELECT ${COLUNAS_RESUMO}
             FROM atendimentos a JOIN clientes c ON c.id = a.cliente_id
             LEFT JOIN vendedores v ON v.id = a.vendedor_id
            WHERE a.canal = 'META' AND a.chat_id LIKE $1
              AND a.status = 'HUMANO' AND a.vendedor_id IS NULL AND a.resumo_enviado_em IS NULL
              AND a.ultima_atividade_em > to_timestamp($2)
            ORDER BY a.ultima_atividade_em`,
          [prefixo, limiteTtl],
        )
      ).rows.map(paraResumo);

      vendedores = (
        await conexao.query(
          "SELECT telegram_user_id, nome, telegram_chat_id FROM vendedores WHERE ativo",
        )
      ).rows.map((v) => ({
        userId: String(v.telegram_user_id),
        nome: v.nome,
        chatPrivadoId: Number(v.telegram_chat_id),
      }));
    }

    await conexao.query("COMMIT");

    return {
      encerradosPorInatividade: encerrados.rowCount ?? 0,
      conversas: recuperadas,
      resumosPublicados,
      resumosNaoPublicados,
      vendedores,
    };
  } catch (erro: unknown) {
    await conexao.query("ROLLBACK").catch(() => undefined);

    throw erro;
  } finally {
    conexao.release();
  }
}
