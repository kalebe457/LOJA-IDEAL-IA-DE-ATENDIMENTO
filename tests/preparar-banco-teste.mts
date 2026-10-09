// Recria do zero o schema do banco de TESTES (loja_ideal_teste): apaga o schema public e aplica
// TODAS as migrations de sql/ (NNN_*.sql), em ordem. Roda antes das suítes (tests/run-all.mjs) e
// por `npm run test:db`. Sem nenhuma migration encontrada, aborta.
//
// TRAVA DUPLA, nada é executado se qualquer uma falhar:
//   1. o nome do banco é a constante BANCO abaixo (pedido de outro nome: aborta antes de conectar);
//   2. depois de conectar, current_database() precisa ser BANCO, ANTES de qualquer DROP ou CREATE.
// Se loja_ideal_teste não existir, é criado (CREATE DATABASE só com o nome da constante).
// Nunca usa DROP DATABASE. Nunca toca em loja_ideal (dado real), betgestor ou outro banco.
// Conexão: DB_HOST, DB_PORT, DB_USER e DB_PASSWORD do .env (DB_NAME do .env é IGNORADO).
import "dotenv/config";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import pg from "pg";

const BANCO = "loja_ideal_teste";

const PASTA_SQL = fileURLToPath(new URL("../sql/", import.meta.url));

const MIGRATIONS = readdirSync(PASTA_SQL).filter((arquivo) => /^\d{3}_.*\.sql$/.test(arquivo)).sort();

type Cliente = { query(texto: string): Promise<{ rows: any[] }>; end(): Promise<void> };

export type Conectar = (banco: string) => Promise<Cliente>;

async function conectarReal(banco: string): Promise<Cliente> {
  const cliente = new pg.Client({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: banco,
  });

  await cliente.connect();

  return cliente;
}

/**
 * Recria o schema de loja_ideal_teste. Lança "ABORTADO: ..." sem executar nada se o banco
 * pedido ou o conectado não for loja_ideal_teste.
 */
export async function prepararBancoDeTeste(nome: string = BANCO, conectar: Conectar = conectarReal): Promise<void> {
  // Trava 1: o nome.
  if (nome !== BANCO) {
    throw new Error(`ABORTADO: o preparo só roda em ${BANCO} (pedido: "${nome}"); nada foi executado.`);
  }

  if (MIGRATIONS.length === 0) {
    throw new Error("ABORTADO: nenhuma migration encontrada em sql/; nada foi executado.");
  }

  let cliente: Cliente;

  try {
    cliente = await conectar(BANCO);
  } catch (erro: unknown) {
    if ((erro as { code?: unknown } | null)?.code !== "3D000") {
      throw erro;
    }

    // Banco ainda não existe: cria (só com o nome da constante) pelo banco de manutenção.
    const manutencao = await conectar("postgres");

    try {
      await manutencao.query(`CREATE DATABASE ${BANCO}`);
    } finally {
      await manutencao.end();
    }

    cliente = await conectar(BANCO);
  }

  try {
    // Trava 2: o banco conectado, antes de qualquer DROP ou CREATE.
    const atual = (await cliente.query("SELECT current_database() AS db")).rows[0]?.db;

    if (atual !== BANCO) {
      throw new Error(`ABORTADO: conectado em "${atual}", não em ${BANCO}; nada foi executado.`);
    }

    await cliente.query("DROP SCHEMA IF EXISTS public CASCADE");

    await cliente.query("CREATE SCHEMA public");

    for (const arquivo of MIGRATIONS) {
      await cliente.query(readFileSync(PASTA_SQL + arquivo, "utf8"));
    }
  } finally {
    await cliente.end();
  }
}

// Execução direta (npm run test:db / run-all.mjs). O argumento opcional existe só para o teste
// da proteção: qualquer nome diferente de loja_ideal_teste aborta sem executar nada.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await prepararBancoDeTeste(process.argv[2] ?? BANCO);

    console.log(`[preparo] ${BANCO}: schema recriado (${MIGRATIONS.join(", ")}).`);
  } catch (erro: unknown) {
    const codigo = (erro as { code?: unknown } | null)?.code;

    console.log(
      erro instanceof Error && erro.message.startsWith("ABORTADO")
        ? `[preparo] ${erro.message}`
        : `[preparo] falha (${typeof codigo === "string" ? codigo : erro instanceof Error ? erro.name : "erro"}).`,
    );

    process.exitCode = 1;
  }
}
