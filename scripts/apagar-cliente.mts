// Apaga os dados pessoais de UM telefone (pedido do titular, LGPD).
//
// Uso:  node --import tsx scripts/apagar-cliente.mts <telefone>              (só mostra o que faria)
//       node --import tsx scripts/apagar-cliente.mts <telefone> --confirmar  (executa)
//
// O que faz, numa transação: apaga as mensagens dos atendimentos desse cliente, ANONIMIZA esses
// atendimentos (mesma anonimização da retenção: sem nome, produto, quantidade, observações e
// telefone; codigo, datas e vendedor ficam para as estatísticas) e apaga o cliente.
// Recusa se houver atendimento ABERTO desse telefone (espere encerrar, 20 min sem mensagens).
// Banco: o do .env (DB_*). Mostra só contagens e o telefone mascarado, nunca o telefone completo.
import { SQL_ANONIMIZAR } from "../src/retencao.js";
import { consultar, encerrarBanco, obterConexao } from "../src/banco.js";
import { descreverErro, mascararTelefone } from "../src/logSeguro.js";

const argumentos = process.argv.slice(2);
const confirmar = argumentos.includes("--confirmar");
const telefone = (argumentos.find((a) => !a.startsWith("--")) ?? "").replace(/\D/g, "");

async function principal(): Promise<number> {
  if (!/^\d{10,15}$/.test(telefone)) {
    console.log("Uso: scripts/apagar-cliente.mts <telefone com DDI e DDD, 10 a 15 dígitos> [--confirmar]");

    return 2;
  }

  const mascarado = mascararTelefone(telefone);

  const banco = (await consultar<{ db: string }>("SELECT current_database() AS db")).rows[0]?.db;

  const cliente = (await consultar<{ id: string }>("SELECT id FROM clientes WHERE telefone = $1", [telefone])).rows[0];

  if (!cliente) {
    console.log(`[apagar-cliente] banco ${banco}: nenhum cliente com o telefone ${mascarado}. Nada a fazer.`);

    return 0;
  }

  const contagem = (
    await consultar<{ abertos: string; encerrados: string; mensagens: string }>(
      `SELECT count(*) FILTER (WHERE a.encerrado_em IS NULL) AS abertos,
              count(*) FILTER (WHERE a.encerrado_em IS NOT NULL) AS encerrados,
              (SELECT count(*) FROM mensagens m JOIN atendimentos x ON x.id = m.atendimento_id WHERE x.cliente_id = $1) AS mensagens
         FROM atendimentos a WHERE a.cliente_id = $1`,
      [cliente.id],
    )
  ).rows[0];

  const abertos = Number(contagem?.abertos ?? 0);

  const encerrados = Number(contagem?.encerrados ?? 0);

  const mensagens = Number(contagem?.mensagens ?? 0);

  if (abertos > 0) {
    console.log(
      `[apagar-cliente] RECUSADO: o telefone ${mascarado} tem ${abertos} atendimento(s) aberto(s). Espere encerrar (20 min sem mensagens) e rode de novo. Nada foi alterado.`,
    );

    return 1;
  }

  const plano = `${mensagens} mensagem(ns) apagada(s), ${encerrados} atendimento(s) anonimizado(s), 1 cliente apagado`;

  if (!confirmar) {
    console.log(`[apagar-cliente] banco ${banco}, telefone ${mascarado}: SIMULAÇÃO, nada foi alterado. Seria: ${plano}. Para executar, rode de novo com --confirmar.`);

    return 0;
  }

  const conexao = await obterConexao();

  try {
    await conexao.query("BEGIN");

    await conexao.query("SET LOCAL statement_timeout = '30s'");

    // Trava a linha do cliente: nenhum atendimento novo dele entra no meio.
    await conexao.query("SELECT id FROM clientes WHERE id = $1 FOR UPDATE", [cliente.id]);

    const ids = (
      await conexao.query<{ id: string; aberto: boolean }>(
        "SELECT id, encerrado_em IS NULL AS aberto FROM atendimentos WHERE cliente_id = $1 FOR UPDATE",
        [cliente.id],
      )
    ).rows;

    if (ids.some((a) => a.aberto)) {
      await conexao.query("ROLLBACK");

      console.log(`[apagar-cliente] RECUSADO: um atendimento do telefone ${mascarado} foi aberto agora. Nada foi alterado.`);

      return 1;
    }

    const lista = ids.map((a) => a.id);

    const apagadas = (await conexao.query("DELETE FROM mensagens WHERE atendimento_id = ANY($1::bigint[])", [lista])).rowCount ?? 0;

    const anonimizados = (await conexao.query(SQL_ANONIMIZAR, [lista])).rowCount ?? 0;

    const clientes = (await conexao.query("DELETE FROM clientes WHERE id = $1", [cliente.id])).rowCount ?? 0;

    await conexao.query("COMMIT");

    console.log(
      `[apagar-cliente] banco ${banco}, telefone ${mascarado}: ${apagadas} mensagem(ns) apagada(s), ${anonimizados} atendimento(s) anonimizado(s), ${clientes} cliente apagado.`,
    );

    return 0;
  } catch (erro: unknown) {
    await conexao.query("ROLLBACK").catch(() => undefined);

    console.log(`[apagar-cliente] falha (${descreverErro(erro)}); nada foi alterado.`);

    return 1;
  } finally {
    conexao.release();
  }
}

let codigo = 1;

try {
  codigo = await principal();
} catch (erro: unknown) {
  console.log(`[apagar-cliente] falha (${descreverErro(erro)}); nada foi alterado.`);
} finally {
  await encerrarBanco();
}

process.exit(codigo);
