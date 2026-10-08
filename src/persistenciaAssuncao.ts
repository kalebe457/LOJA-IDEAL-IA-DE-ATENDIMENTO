import { obterConexao } from "./banco.js";

/*
 * Assunção pelo Telegram no PostgreSQL (Passo 5c).
 *
 * A MEMÓRIA continua sendo a fonte de verdade; o banco registra o
 * resumo publicado, quem assumiu e a DM, e é um SEGUNDO portão contra
 * assunção dupla (o UPDATE só vale se ainda não houver vendedor).
 *
 * Mesmas regras do espelho: transação curta, statement_timeout de
 * 5 s, falha de banco só gera log curto (código do erro, sem dados
 * pessoais nem segredos). Nenhuma função lança.
 */

const STATEMENT_TIMEOUT = "5s";

type Conexao = Awaited<ReturnType<typeof obterConexao>>;

function descreverErro(erro: unknown): string {
  const codigo = (erro as { code?: unknown } | null)?.code;

  if (typeof codigo === "string") {
    return codigo;
  }

  return erro instanceof Error ? erro.name : "erro desconhecido";
}

/**
 * Executa fn numa transação curta. Erro: ROLLBACK, log e
 * devolve { ok: false, codigo }. confirmar(valor) = false
 * desfaz a transação sem ser erro.
 */
async function emTransacao<T>(
  rotulo: string,
  fn: (conexao: Conexao) => Promise<T>,
  confirmar: (valor: T) => boolean = () => true,
): Promise<{ ok: true; valor: T } | { ok: false; codigo: string }> {
  let conexao: Conexao | null = null;

  try {
    conexao = await obterConexao();

    await conexao.query("BEGIN");

    await conexao.query(`SET LOCAL statement_timeout = '${STATEMENT_TIMEOUT}'`);

    const valor = await fn(conexao);

    await conexao.query(confirmar(valor) ? "COMMIT" : "ROLLBACK");

    return { ok: true, valor };
  } catch (erro: unknown) {
    if (conexao) {
      await conexao.query("ROLLBACK").catch(() => undefined);
    }

    const codigo = descreverErro(erro);

    console.error(`[Persistência] falha ao ${rotulo} (${codigo}).`);

    return { ok: false, codigo };
  } finally {
    conexao?.release();
  }
}

/**
 * Resumo publicado (ou republicado) no grupo: grava a mensagem
 * que está valendo.
 */
export async function registrarResumoPublicado(
  codigo: string,
  telegramChatId: number | string,
  telegramMessageId: number,
): Promise<boolean> {
  const resultado = await emTransacao(
    `registrar o resumo publicado de ${codigo}`,
    (conexao) =>
      conexao.query(
        `UPDATE atendimentos
            SET telegram_chat_id = $2, telegram_message_id = $3,
                resumo_enviado_em = now(), atualizado_em = now()
          WHERE codigo = $1`,
        [codigo, String(telegramChatId), telegramMessageId],
      ),
  );

  if (resultado.ok && resultado.valor.rowCount === 0) {
    console.warn(
      `[Persistência] resumo de ${codigo} publicado, mas o atendimento não está no banco.`,
    );
  }

  return resultado.ok && resultado.valor.rowCount === 1;
}

export type DadosAssuncao = {
  codigo: string;

  telegramUserId: string;

  /*
   * Nome atual do vendedor no Telegram.
   */
  nome: string;

  /*
   * Chat privado do vendedor com o bot (DM).
   */
  chatPrivadoId: number;

  /*
   * Mensagem do resumo onde houve o clique (vindos do callback).
   */
  telegramChatId: number | string;

  telegramMessageId: number;
};

/*
 * - "assumido": o banco registrou este vendedor;
 * - "ja_por_voce": o banco já tinha ESTE vendedor;
 * - "ja_por_outro": o banco já tinha OUTRO vendedor (o banco vence);
 * - "sem_linha": o atendimento não está no banco (espelho falhou);
 * - "erro": falha de banco (já logada com o código).
 */
export type ResultadoAssuncaoBanco =
  | "assumido"
  | "ja_por_voce"
  | "ja_por_outro"
  | "sem_linha"
  | "erro";

/**
 * Numa transação: upsert do vendedor pelo telegram_user_id e um
 * UPDATE condicional do atendimento (só se ainda sem vendedor).
 * Só confirma em "assumido" e "ja_por_voce".
 */
export async function registrarAssuncao(
  dados: DadosAssuncao,
): Promise<ResultadoAssuncaoBanco> {
  const resultado = await emTransacao(
    `registrar a assunção de ${dados.codigo}`,
    async (conexao): Promise<ResultadoAssuncaoBanco> => {
      const vendedor = await conexao.query<{ id: string }>(
        `INSERT INTO vendedores (telegram_user_id, nome, telegram_chat_id, ativo)
         VALUES ($1, $2, $3, TRUE)
         ON CONFLICT (telegram_user_id) DO UPDATE SET
           nome = EXCLUDED.nome,
           telegram_chat_id = EXCLUDED.telegram_chat_id,
           ativo = TRUE,
           atualizado_em = now()
         RETURNING id`,
        [dados.telegramUserId, dados.nome, dados.chatPrivadoId],
      );

      const vendedorId = vendedor.rows[0]?.id;

      const atualizado = await conexao.query(
        `UPDATE atendimentos SET
           vendedor_id = $2,
           assumido_em = now(),
           status = 'HUMANO',
           encerrado_em = COALESCE(encerrado_em, now()),
           dm_status = 'ENVIANDO',
           telegram_chat_id = COALESCE(telegram_chat_id, $3),
           telegram_message_id = COALESCE(telegram_message_id, $4),
           resumo_enviado_em = COALESCE(resumo_enviado_em, now()),
           atualizado_em = now()
         WHERE codigo = $1 AND vendedor_id IS NULL
         RETURNING id`,
        [dados.codigo, vendedorId, String(dados.telegramChatId), dados.telegramMessageId],
      );

      if (atualizado.rowCount === 1) {
        return "assumido";
      }

      const atual = await conexao.query<{ vendedor_id: string | null }>(
        "SELECT vendedor_id FROM atendimentos WHERE codigo = $1",
        [dados.codigo],
      );

      const linha = atual.rows[0];

      if (!linha) {
        return "sem_linha";
      }

      return linha.vendedor_id === vendedorId ? "ja_por_voce" : "ja_por_outro";
    },
    /*
     * Sem linha ou com outro vendedor: nada é gravado
     * (nem o vendedor, que ficaria sem atendimento).
     */
    (valor) => valor === "assumido" || valor === "ja_por_voce",
  );

  return resultado.ok ? resultado.valor : "erro";
}

/**
 * Resultado da DM ao vencedor. Só altera atendimento já assumido
 * no banco (respeita chk_atendimentos_dm_vendedor).
 */
export async function registrarDmStatus(
  codigo: string,
  status: "ENVIADA" | "FALHOU",
): Promise<boolean> {
  const resultado = await emTransacao(
    `registrar a DM de ${codigo}`,
    (conexao) =>
      conexao.query(
        `UPDATE atendimentos SET dm_status = $2, atualizado_em = now()
          WHERE codigo = $1 AND vendedor_id IS NOT NULL`,
        [codigo, status],
      ),
  );

  return resultado.ok;
}

export type LinhaRanking = {
  nome: string;

  mes: number;

  total: number;
};

/**
 * Atendimentos assumidos por vendedor: no mês atual
 * (America/Belem) e no total. null = falha de banco.
 */
export async function consultarRanking(): Promise<LinhaRanking[] | null> {
  const resultado = await emTransacao("consultar o ranking", (conexao) =>
    conexao.query<{ nome: string; mes: string; total: string }>(
      `SELECT v.nome,
              count(*) FILTER (
                WHERE a.assumido_em >= date_trunc('month', now() AT TIME ZONE 'America/Belem')
                                       AT TIME ZONE 'America/Belem'
              ) AS mes,
              count(*) AS total
         FROM vendedores v
         JOIN atendimentos a ON a.vendedor_id = v.id
        GROUP BY v.id, v.nome
        ORDER BY mes DESC, total DESC, v.nome`,
    ),
  );

  if (!resultado.ok) {
    return null;
  }

  return resultado.valor.rows.map((linha) => ({
    nome: linha.nome,
    mes: Number(linha.mes),
    total: Number(linha.total),
  }));
}
