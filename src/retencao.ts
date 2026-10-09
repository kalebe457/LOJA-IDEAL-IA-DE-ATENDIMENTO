import { obterConexao } from "./banco.js";

import { descreverErro } from "./logSeguro.js";

/*
 * Retenção de dados (LGPD). ÚNICO lugar com os prazos; documentados no
 * CLAUDE.md (vão para a política de privacidade).
 *
 * Só dados de atendimentos JÁ ENCERRADOS; atendimento aberto nunca é
 * tocado. Vendedores não são tocados.
 */
export const PRAZOS_RETENCAO = {
  /*
   * Texto da conversa (mensagens ENTRADA e SAIDA): apagado depois de
   * tantos dias do encerramento do atendimento.
   */
  mensagensDias: 60,

  /*
   * Atendimento ANONIMIZADO depois de tantos dias do encerramento:
   * nome, produto, quantidade e observações viram NULL, o chat_id
   * perde o telefone (meta:anon:<codigo>) e o atendimento deixa de
   * apontar para o cliente. Ficam codigo, status, datas, vendedor e
   * assunção (estatísticas e /ranking).
   */
  anonimizarAtendimentoDias: 365,

  /*
   * Cliente apagado quando nenhum atendimento aponta mais para ele
   * (todos anonimizados) e foi criado há mais de tantos dias.
   */
  clienteDias: 365,

  /*
   * Deduplicação de webhooks (eventos_processados): só o wamid.
   */
  eventosDias: 7,
} as const;

/*
 * Linhas por lote: transações curtas, sem travar o banco.
 */
const LOTE = 500;

/*
 * Teto de lotes por etapa num ciclo (o resto fica para o próximo).
 */
const MAX_LOTES = 200;

const STATEMENT_TIMEOUT = "5s";

const INTERVALO_MS = 24 * 60 * 60 * 1000;

type Conexao = Awaited<ReturnType<typeof obterConexao>>;

/*
 * Anonimização de UM conjunto de atendimentos (ids), já encerrados.
 * Usada pela rotina e pelo script do titular (scripts/apagar-cliente.mts).
 */
export const SQL_ANONIMIZAR = `
  UPDATE atendimentos SET
    nome = NULL,
    produto = NULL,
    quantidade = NULL,
    observacoes = NULL,
    chat_id = 'meta:anon:' || codigo,
    cliente_id = NULL,
    atualizado_em = now()
  WHERE id = ANY($1::bigint[]) AND encerrado_em IS NOT NULL AND canal = 'META'`;

/*
 * Cada etapa: SELECT de até LOTE ids + a ação sobre esses ids.
 */
const ETAPAS = [
  {
    nome: "mensagens",
    selecionar: `
      SELECT m.id FROM mensagens m JOIN atendimentos a ON a.id = m.atendimento_id
       WHERE a.encerrado_em IS NOT NULL
         AND a.encerrado_em < now() - make_interval(days => ${PRAZOS_RETENCAO.mensagensDias})
       LIMIT ${LOTE}`,
    agir: "DELETE FROM mensagens WHERE id = ANY($1::bigint[])",
  },
  {
    nome: "atendimentos",
    selecionar: `
      SELECT id FROM atendimentos
       WHERE canal = 'META' AND encerrado_em IS NOT NULL
         AND encerrado_em < now() - make_interval(days => ${PRAZOS_RETENCAO.anonimizarAtendimentoDias})
         AND (cliente_id IS NOT NULL OR chat_id NOT LIKE 'meta:anon:%'
              OR nome IS NOT NULL OR produto IS NOT NULL OR quantidade IS NOT NULL OR observacoes IS NOT NULL)
       LIMIT ${LOTE}`,
    agir: SQL_ANONIMIZAR,
  },
  {
    nome: "clientes",
    selecionar: `
      SELECT c.id FROM clientes c
       WHERE c.criado_em < now() - make_interval(days => ${PRAZOS_RETENCAO.clienteDias})
         AND NOT EXISTS (SELECT 1 FROM atendimentos a WHERE a.cliente_id = c.id)
       LIMIT ${LOTE}`,
    agir: "DELETE FROM clientes WHERE id = ANY($1::bigint[])",
  },
  {
    nome: "eventos",
    selecionar: `
      SELECT id FROM eventos_processados
       WHERE recebido_em < now() - make_interval(days => ${PRAZOS_RETENCAO.eventosDias})
       LIMIT ${LOTE}`,
    agir: "DELETE FROM eventos_processados WHERE id = ANY($1::bigint[])",
  },
] as const;

export type ResultadoRetencao = {
  mensagens: number;
  atendimentos: number;
  clientes: number;
  eventos: number;
};

async function lote(conexao: Conexao, selecionar: string, agir: string): Promise<number> {
  await conexao.query("BEGIN");

  try {
    await conexao.query(`SET LOCAL statement_timeout = '${STATEMENT_TIMEOUT}'`);

    const ids = (await conexao.query<{ id: string }>(selecionar)).rows.map((linha) => linha.id);

    const afetadas = ids.length > 0 ? ((await conexao.query(agir, [ids])).rowCount ?? 0) : 0;

    await conexao.query("COMMIT");

    return afetadas;
  } catch (erro: unknown) {
    await conexao.query("ROLLBACK").catch(() => undefined);

    throw erro;
  }
}

let rodando = false;

/**
 * Um ciclo da retenção, em lotes. Idempotente. Nunca lança: falha de
 * banco só gera log (com o código) e o resto fica para o próximo ciclo.
 * As etapas rodam em ordem; se uma falha, as seguintes esperam o
 * próximo ciclo (a anonimização nunca roda antes de apagar o texto).
 */
export async function executarRetencao(): Promise<ResultadoRetencao | null> {
  if (rodando) {
    return null;
  }

  rodando = true;

  const resultado: ResultadoRetencao = { mensagens: 0, atendimentos: 0, clientes: 0, eventos: 0 };

  let conexao: Conexao | null = null;

  try {
    conexao = await obterConexao();

    for (const etapa of ETAPAS) {
      for (let i = 0; i < MAX_LOTES; i++) {
        const afetadas = await lote(conexao, etapa.selecionar, etapa.agir);

        resultado[etapa.nome] += afetadas;

        if (afetadas < LOTE) {
          break;
        }
      }
    }

    console.log(
      [
        `[Retenção] mensagens apagadas: ${resultado.mensagens}`,
        `atendimentos anonimizados: ${resultado.atendimentos}`,
        `clientes apagados: ${resultado.clientes}`,
        `eventos apagados: ${resultado.eventos}`,
      ].join(" | "),
    );

    return resultado;
  } catch (erro: unknown) {
    console.error(
      `[Retenção] falha (${descreverErro(erro)}); nova tentativa no próximo ciclo. Feito até aqui: mensagens ${resultado.mensagens}, atendimentos ${resultado.atendimentos}, clientes ${resultado.clientes}, eventos ${resultado.eventos}.`,
    );

    return null;
  } finally {
    conexao?.release();

    rodando = false;
  }
}

/**
 * Na partida (sem bloquear) e depois a cada 24 h.
 */
export function agendarRetencao(): void {
  void executarRetencao();

  setInterval(() => {
    void executarRetencao();
  }, INTERVALO_MS).unref();
}
