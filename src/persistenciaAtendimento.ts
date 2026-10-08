import { consultar, obterConexao } from "./banco.js";

/*
 * Espelho no PostgreSQL da existência dos atendimentos (Passo 5a).
 *
 * A MEMÓRIA continua sendo a fonte de verdade da conversa. O banco
 * registra só: cliente, atendimento (codigo = o mesmo da memória),
 * última atividade e encerramento.
 *
 * O banco segue a memória pelo CODIGO: nunca associa uma conversa a um
 * atendimento com outro codigo. Gravações idempotentes pelo codigo.
 *
 * Falha de banco aqui NÃO interrompe o atendimento: as funções nunca
 * lançam; registram um log curto (sem senha, sem connection string,
 * sem o objeto de erro) e devolvem false.
 */

/*
 * Mesmo formato do CHECK chk_clientes_telefone_digitos.
 */
const TELEFONE_VALIDO = /^[0-9]{10,15}$/;

export type AtividadeAtendimento = {
  /*
   * codigo do atendimento (o mesmo da conversa em memória).
   */
  codigo: string;

  /*
   * chatId exato da conversa (meta:<phone_number_id>:<wa_id>).
   */
  chatId: string;

  /*
   * Telefone já normalizado (só dígitos).
   */
  telefone: string;

  /*
   * Momento da mensagem do cliente (ms).
   */
  atividadeEm: number;

  /*
   * A conversa já foi assumida? Então a linha, se precisar
   * ser criada agora, já nasce encerrada.
   */
  encerrado: boolean;
};

function descreverErro(erro: unknown): string {
  const codigo = (erro as { code?: unknown } | null)?.code;

  if (typeof codigo === "string") {
    return codigo;
  }

  return erro instanceof Error ? erro.name : "erro desconhecido";
}

/**
 * Registra uma mensagem do cliente no espelho do atendimento.
 *
 * Numa transação curta:
 * 1. encerra qualquer atendimento META aberto do mesmo chat_id com
 *    OUTRO codigo (resto de restart ou de falha anterior);
 * 2. cria ou reutiliza o cliente pelo telefone;
 * 3. cria o atendimento com o codigo da memória ou, se já existe,
 *    atualiza só a última atividade (nunca reabre um encerrado).
 *
 * A primeira chamada de uma conversa cria a linha; se ela falhar,
 * a próxima mensagem cria.
 */
export async function registrarAtividadeAtendimento(
  dados: AtividadeAtendimento,
): Promise<boolean> {
  if (!TELEFONE_VALIDO.test(dados.telefone)) {
    console.warn(
      `[Persistência] atendimento ${dados.codigo} não espelhado: telefone fora do formato (10 a 15 dígitos).`,
    );

    return false;
  }

  let conexao: Awaited<ReturnType<typeof obterConexao>> | null = null;

  try {
    conexao = await obterConexao();

    await conexao.query("BEGIN");

    await conexao.query(
      `UPDATE atendimentos
          SET encerrado_em = now(), atualizado_em = now()
        WHERE canal = 'META' AND chat_id = $1 AND codigo <> $2
          AND encerrado_em IS NULL`,
      [dados.chatId, dados.codigo],
    );

    const cliente = await conexao.query<{ id: string }>(
      `INSERT INTO clientes (telefone)
       VALUES ($1)
       ON CONFLICT (telefone) DO UPDATE SET telefone = EXCLUDED.telefone
       RETURNING id`,
      [dados.telefone],
    );

    await conexao.query(
      `INSERT INTO atendimentos
         (codigo, cliente_id, status, canal, chat_id, ultima_atividade_em, encerrado_em)
       VALUES
         ($1, $2, 'IA', 'META', $3, to_timestamp($4::double precision / 1000),
          CASE WHEN $5::boolean THEN now() END)
       ON CONFLICT (codigo) DO UPDATE SET
         ultima_atividade_em = GREATEST(atendimentos.ultima_atividade_em, EXCLUDED.ultima_atividade_em),
         encerrado_em = CASE WHEN $5::boolean
                             THEN COALESCE(atendimentos.encerrado_em, now())
                             ELSE atendimentos.encerrado_em END,
         atualizado_em = now()`,
      [dados.codigo, cliente.rows[0]?.id, dados.chatId, dados.atividadeEm, dados.encerrado],
    );

    await conexao.query("COMMIT");

    return true;
  } catch (erro: unknown) {
    if (conexao) {
      await conexao.query("ROLLBACK").catch(() => undefined);
    }

    console.error(
      `[Persistência] falha ao registrar atividade do atendimento ${dados.codigo} (${descreverErro(erro)}); atendimento segue em memória.`,
    );

    return false;
  } finally {
    conexao?.release();
  }
}

/**
 * Marca o atendimento como encerrado no espelho.
 *
 * Idempotente: só altera se ainda estiver aberto.
 */
export async function registrarEncerramentoAtendimento(codigo: string): Promise<boolean> {
  try {
    await consultar(
      `UPDATE atendimentos
          SET encerrado_em = now(), atualizado_em = now()
        WHERE codigo = $1 AND encerrado_em IS NULL`,
      [codigo],
    );

    return true;
  } catch (erro: unknown) {
    console.error(
      `[Persistência] falha ao registrar encerramento do atendimento ${codigo} (${descreverErro(erro)}).`,
    );

    return false;
  }
}
