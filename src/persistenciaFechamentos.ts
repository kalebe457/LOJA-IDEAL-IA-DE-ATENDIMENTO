import { consultar } from "./banco.js";

import { descreverErro } from "./logSeguro.js";

/*
 * Fechamentos manuais da loja no PostgreSQL (tabela fechamentos, sql/004).
 *
 * A memória (horarioFuncionamento.ts) é a fonte de verdade: o banco só a
 * recarrega na partida. Falha de banco nunca lança: só log com o código.
 * Comandos curtos (pool.query), com timeout próprio.
 */

const TIMEOUT_MS = 5_000;

function comTimeout<T>(promessa: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  return Promise.race([
    promessa,
    new Promise<T>((_, rejeitar) => {
      timer = setTimeout(() => rejeitar(Object.assign(new Error("timeout"), { code: "TIMEOUT" })), TIMEOUT_MS);
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * Fechamentos de "desde" (AAAA-MM-DD) em diante. null = falha de banco.
 */
export async function lerFechamentos(desde: string): Promise<string[] | null> {
  try {
    const resultado = await comTimeout(
      consultar<{ data: string }>(
        "SELECT to_char(data, 'YYYY-MM-DD') AS data FROM fechamentos WHERE data >= $1::date ORDER BY data",
        [desde],
      ),
    );

    return resultado.rows.map((linha) => linha.data);
  } catch (erro: unknown) {
    console.error(`[Loja] ATENÇÃO: fechamentos não carregados do banco (${descreverErro(erro)}); subindo sem fechamentos manuais.`);

    return null;
  }
}

/**
 * Grava o fechamento (idempotente). criado_por: o vendedor com esse
 * telegram_user_id, se existir.
 */
export async function gravarFechamento(data: string, telegramUserId: string): Promise<boolean> {
  try {
    await comTimeout(
      consultar(
        `INSERT INTO fechamentos (data, criado_por)
         VALUES ($1::date, (SELECT id FROM vendedores WHERE telegram_user_id = $2::bigint))
         ON CONFLICT (data) DO NOTHING`,
        [data, telegramUserId],
      ),
    );

    return true;
  } catch (erro: unknown) {
    console.error(`[Loja] falha ao gravar fechamento no banco (${descreverErro(erro)}); vale até o próximo reinício.`);

    return false;
  }
}

export async function apagarFechamento(data: string): Promise<boolean> {
  try {
    await comTimeout(consultar("DELETE FROM fechamentos WHERE data = $1::date", [data]));

    return true;
  } catch (erro: unknown) {
    console.error(`[Loja] falha ao remover fechamento do banco (${descreverErro(erro)}); pode voltar no próximo reinício.`);

    return false;
  }
}
