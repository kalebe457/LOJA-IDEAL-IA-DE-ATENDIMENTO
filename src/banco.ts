import "dotenv/config";

import pg from "pg";

import { descreverErro } from "./logSeguro.js";

/*
 * Conexão com o PostgreSQL do sistema (banco loja_ideal).
 *
 * O Pool é criado só no PRIMEIRO uso (obterPool/consultar/
 * obterConexao): importar este módulo não conecta, não valida
 * e não derruba o backend.
 *
 * Usa somente DB_HOST, DB_PORT, DB_NAME, DB_USER e DB_PASSWORD.
 * Senha e string de conexão nunca vão para o log.
 */

const { Pool } = pg;

type ConfigBanco = {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
};

let pool: pg.Pool | null = null;

/**
 * Lê e valida as variáveis DB_*.
 *
 * Erros citam só o NOME da variável, nunca o valor.
 */
function lerConfigBanco(): ConfigBanco {
  const ausentes = ["DB_HOST", "DB_PORT", "DB_NAME", "DB_USER", "DB_PASSWORD"].filter(
    (nome) => (process.env[nome] ?? "").trim() === "",
  );

  if (ausentes.length > 0) {
    throw new Error(`[Banco] configuração ausente: ${ausentes.join(", ")}.`);
  }

  const porta = (process.env.DB_PORT ?? "").trim();

  if (!/^\d+$/.test(porta) || Number(porta) < 1 || Number(porta) > 65535) {
    throw new Error("[Banco] DB_PORT inválida: deve ser um inteiro entre 1 e 65535.");
  }

  return {
    host: (process.env.DB_HOST ?? "").trim(),
    port: Number(porta),
    database: (process.env.DB_NAME ?? "").trim(),
    user: (process.env.DB_USER ?? "").trim(),
    password: process.env.DB_PASSWORD ?? "",
  };
}

/**
 * Pool único do processo, criado no primeiro uso.
 */
export function obterPool(): pg.Pool {
  if (pool) {
    return pool;
  }

  const config = lerConfigBanco();

  pool = new Pool({
    ...config,

    max: 10,

    idleTimeoutMillis: 30_000,

    connectionTimeoutMillis: 5_000,
  });

  /*
   * Conexão ociosa perdida (banco reiniciado, rede caiu...).
   * Só registra: NÃO derruba o processo e não chama process.exit.
   * O Pool descarta o cliente e abre outro no próximo uso.
   */
  pool.on("error", (erro) => {
    console.error(`[Banco] erro em conexão ociosa do pool: ${descreverErro(erro)}`);
  });

  return pool;
}

/**
 * Executa uma query usando o Pool.
 */
export function consultar<R extends pg.QueryResultRow = pg.QueryResultRow>(
  texto: string,
  parametros?: unknown[],
): Promise<pg.QueryResult<R>> {
  return obterPool().query<R>(texto, parametros);
}

/**
 * Obtém uma conexão dedicada (para transações).
 *
 * Quem chama DEVE devolver com conexao.release().
 */
export function obterConexao(): Promise<pg.PoolClient> {
  return obterPool().connect();
}

/**
 * Encerra o Pool (desligamento do backend ou fim de testes).
 * Seguro chamar mais de uma vez.
 */
export async function encerrarBanco(): Promise<void> {
  if (!pool) {
    return;
  }

  const atual = pool;

  pool = null;

  await atual.end();
}
