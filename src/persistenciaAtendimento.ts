import { obterConexao } from "./banco.js";

import type { EstadoTriagem, ResumoCliente, StatusAtendimento } from "./tipos.js";

/*
 * Espelho no PostgreSQL dos atendimentos (Passos 5a e 5b).
 *
 * A MEMÓRIA continua sendo a fonte de verdade da conversa. O banco
 * registra: cliente, atendimento (codigo = o mesmo da memória),
 * última atividade, encerramento (5a), estado da triagem e
 * mensagens ENTRADA/SAIDA (5b).
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

/*
 * Tempo máximo de cada comando do espelho. Banco travado (lock,
 * lentidão) vira erro e cai no "loga e segue".
 */
const STATEMENT_TIMEOUT = "5s";

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

type Conexao = Awaited<ReturnType<typeof obterConexao>>;

/**
 * Dentro de uma transação aberta:
 * 1. encerra qualquer atendimento META aberto do mesmo chat_id com
 *    OUTRO codigo (resto de restart ou de falha anterior);
 * 2. cria ou reutiliza o cliente pelo telefone;
 * 3. cria o atendimento com o codigo da memória ou, se já existe,
 *    atualiza só a última atividade (nunca reabre um encerrado).
 *
 * Devolve o id do atendimento, ou null em colisão de codigo
 * (já logada; quem chamou desfaz a transação).
 */
async function gravarAtividade(
  conexao: Conexao,
  dados: AtividadeAtendimento,
): Promise<string | null> {
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

  /*
   * Só atualiza a linha existente se ela for do MESMO chat_id.
   * Colisão de codigo com outro chat: nada é retornado e a
   * transação inteira é desfeita (a linha alheia fica intacta).
   */
  const atendimento = await conexao.query<{ id: string }>(
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
       atualizado_em = now()
     WHERE atendimentos.chat_id = EXCLUDED.chat_id
     RETURNING id`,
    [dados.codigo, cliente.rows[0]?.id, dados.chatId, dados.atividadeEm, dados.encerrado],
  );

  const id = atendimento.rows[0]?.id;

  if (atendimento.rowCount !== 1 || id === undefined) {
    console.error(
      `[Persistência] colisão de codigo ${dados.codigo}: já existe em outro chat; nada alterado.`,
    );

    return null;
  }

  return id;
}

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
 * Numa transação curta, só gravarAtividade (antes da IA).
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

  let conexao: Conexao | null = null;

  try {
    conexao = await obterConexao();

    await conexao.query("BEGIN");

    await conexao.query(`SET LOCAL statement_timeout = '${STATEMENT_TIMEOUT}'`);

    if ((await gravarAtividade(conexao, dados)) === null) {
      await conexao.query("ROLLBACK");

      return false;
    }

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
  let conexao: Awaited<ReturnType<typeof obterConexao>> | null = null;

  try {
    conexao = await obterConexao();

    await conexao.query("BEGIN");

    await conexao.query(`SET LOCAL statement_timeout = '${STATEMENT_TIMEOUT}'`);

    await conexao.query(
      `UPDATE atendimentos
          SET encerrado_em = now(), atualizado_em = now()
        WHERE codigo = $1 AND encerrado_em IS NULL`,
      [codigo],
    );

    await conexao.query("COMMIT");

    return true;
  } catch (erro: unknown) {
    if (conexao) {
      await conexao.query("ROLLBACK").catch(() => undefined);
    }

    console.error(
      `[Persistência] falha ao registrar encerramento do atendimento ${codigo} (${descreverErro(erro)}).`,
    );

    return false;
  } finally {
    conexao?.release();
  }
}

/*
 * Mensagem do espelho (tabela mensagens). em = momento em ms.
 */
export type MensagemEspelho = {
  /*
   * wamid da Meta; null quando não houver (resposta em modo
   * somente log).
   */
  wamid: string | null;

  texto: string;

  em: number;
};

export type MensagemProcessada = AtividadeAtendimento & {
  status: StatusAtendimento;

  triagem: EstadoTriagem;

  /*
   * Campos coletados ("Não informado" vira NULL no banco).
   */
  resumo: Pick<ResumoCliente, "nome" | "produto" | "quantidade" | "observacoes">;

  /*
   * Mensagem do cliente (ENTRADA).
   */
  entrada: MensagemEspelho;

  /*
   * Resposta aceita pela Meta, ou registrada em modo somente
   * log (SAIDA). null quando não houve resposta entregue.
   */
  saida: MensagemEspelho | null;
};

function valorOuNulo(valor: string): string | null {
  const limpo = valor.trim();

  return limpo === "" || limpo === "Não informado" ? null : limpo;
}

/**
 * Espelha o estado da memória depois de uma mensagem processada
 * (Passo 5b): atividade, status, estado da triagem, campos
 * coletados e as mensagens ENTRADA/SAIDA.
 *
 * Uma única transação curta: ou tudo é gravado, ou nada. Sempre
 * grava o estado FINAL (já depois de um eventual desfazer), então
 * o banco nunca guarda etapa avançada nem resposta não entregue.
 * Mensagem com wamid já gravado é ignorada (sem duplicata).
 */
export async function registrarMensagemProcessada(
  dados: MensagemProcessada,
): Promise<boolean> {
  if (!TELEFONE_VALIDO.test(dados.telefone)) {
    console.warn(
      `[Persistência] mensagem do atendimento ${dados.codigo} não espelhada: telefone fora do formato (10 a 15 dígitos).`,
    );

    return false;
  }

  let conexao: Conexao | null = null;

  try {
    conexao = await obterConexao();

    await conexao.query("BEGIN");

    await conexao.query(`SET LOCAL statement_timeout = '${STATEMENT_TIMEOUT}'`);

    const atendimentoId = await gravarAtividade(conexao, dados);

    if (atendimentoId === null) {
      await conexao.query("ROLLBACK");

      return false;
    }

    const { triagem, resumo } = dados;

    await conexao.query(
      `UPDATE atendimentos SET
         status = $2,
         etapa_atual = $3,
         perguntas_etapa = $4,
         etapas_puladas = $5::text[],
         apresentacao_pendente = $6,
         quantidade_nao_aplicavel = $7,
         nome = $8,
         produto = $9,
         quantidade = $10,
         observacoes = $11,
         atualizado_em = now()
       WHERE id = $1`,
      [
        atendimentoId,
        dados.status,
        triagem.etapaAtual,
        triagem.perguntasEtapa,
        triagem.etapasPuladas,
        triagem.apresentacaoPendente,
        triagem.quantidadeNaoAplicavel,
        valorOuNulo(resumo.nome),
        valorOuNulo(resumo.produto),
        valorOuNulo(resumo.quantidade),
        valorOuNulo(resumo.observacoes),
      ],
    );

    const mensagens: ["ENTRADA" | "SAIDA", MensagemEspelho][] = [["ENTRADA", dados.entrada]];

    if (dados.saida) {
      mensagens.push(["SAIDA", dados.saida]);
    }

    for (const [direcao, mensagem] of mensagens) {
      await conexao.query(
        `INSERT INTO mensagens
           (atendimento_id, direcao, canal, mensagem_externa_id, texto, criado_em)
         VALUES ($1, $2, 'META', $3, $4, to_timestamp($5::double precision / 1000))
         ON CONFLICT (canal, mensagem_externa_id) DO NOTHING`,
        [atendimentoId, direcao, mensagem.wamid, mensagem.texto, mensagem.em],
      );
    }

    await conexao.query("COMMIT");

    return true;
  } catch (erro: unknown) {
    if (conexao) {
      await conexao.query("ROLLBACK").catch(() => undefined);
    }

    console.error(
      `[Persistência] falha ao espelhar mensagem do atendimento ${dados.codigo} (${descreverErro(erro)}); atendimento segue em memória.`,
    );

    return false;
  } finally {
    conexao?.release();
  }
}
