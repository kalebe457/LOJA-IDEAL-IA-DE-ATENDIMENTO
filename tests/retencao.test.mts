// Retenção de dados (LGPD): rotina src/retencao.ts e script scripts/apagar-cliente.mts.
// Banco de testes; as linhas são criadas direto no banco com as datas manipuladas (relativas ao now()
// do PostgreSQL). Chats "meta:999:<telefone fictício 55919000012xx>", códigos "TST-RET-..",
// eventos "teste-ret-...", vendedor 990000000301. Sem servidor e sem rede.
// Banco de TESTES (loja_ideal_teste) fixado antes de qualquer import de src/; loja_ideal é dado real.
const { exigirBancoDeTeste } = await import(new URL("./banco-teste.mts", import.meta.url).href);
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const B = new URL("..", import.meta.url).href.replace(/\/$/, "");
const raiz = fileURLToPath(new URL("..", import.meta.url));

const logs: string[] = [];
const out = console.log.bind(console);
for (const k of ["log", "warn", "error"] as const) console[k] = (...a: unknown[]) => { logs.push(a.join(" ")); };

let falhas = 0, total = 0;
const ok = (c: boolean, t: string) => { total++; if (!c) falhas++; out(`${c ? "OK  " : "FAIL"} ${t}`); };

const banco = await import(B + "/src/banco.ts");
await exigirBancoDeTeste(banco.consultar);
const { executarRetencao, PRAZOS_RETENCAO } = await import(B + "/src/retencao.ts");
const { consultarRanking } = await import(B + "/src/persistenciaAssuncao.ts");
const q = banco.consultar;

const previos = Number((await q("SELECT count(*) n FROM atendimentos WHERE codigo LIKE 'TST-RET-%' OR chat_id LIKE 'meta:999:%'")).rows[0].n);
if (previos !== 0) { out(`ABORTADO: já existem ${previos} atendimentos de teste`); process.exit(1); }

const TEL = (n: number) => `55919000012${String(n).padStart(2, "0")}`;
const VENDEDOR = 990_000_000_301;
const vendedorId = (await q(
  "INSERT INTO vendedores (telegram_user_id, nome, telegram_chat_id, ativo) VALUES ($1, 'Teste Vendedor Retenção', $1, TRUE) RETURNING id", [VENDEDOR])).rows[0].id;

// Cria cliente + atendimento (com 2 mensagens). encerradoDias = null → aberto.
async function criar(n: number, codigo: string, encerradoDias: number | null, opcoes: { clienteDias?: number; assumido?: boolean } = {}) {
  const cliente = (await q(
    `INSERT INTO clientes (telefone, criado_em) VALUES ($1, now() - make_interval(days => $2))
     ON CONFLICT (telefone) DO UPDATE SET telefone = EXCLUDED.telefone RETURNING id`, [TEL(n), opcoes.clienteDias ?? 0])).rows[0].id;
  const enc = encerradoDias === null ? null : encerradoDias;
  const id = (await q(
    `INSERT INTO atendimentos (codigo, cliente_id, status, canal, chat_id, nome, produto, quantidade, observacoes,
       criado_em, ultima_atividade_em, encerrado_em,
       vendedor_id, assumido_em, dm_status, telegram_chat_id, telegram_message_id, resumo_enviado_em)
     VALUES ($1, $2, 'HUMANO', 'META', $3, 'Nome Teste', 'Cimento', '10 sacos', 'Obs teste',
       now() - make_interval(days => COALESCE($4::int, 0) + 1), now() - make_interval(days => COALESCE($4::int, 0)),
       CASE WHEN $4::int IS NULL THEN NULL ELSE now() - make_interval(days => $4::int) END,
       CASE WHEN $5::boolean THEN $6::bigint END, CASE WHEN $5::boolean THEN now() - make_interval(days => COALESCE($4::int, 0)) END,
       CASE WHEN $5::boolean THEN 'ENVIADA' END, -1009999999999, 1, now() - make_interval(days => COALESCE($4::int, 0)))
     RETURNING id`,
    [codigo, cliente, `meta:999:${TEL(n)}`, enc, opcoes.assumido === true, vendedorId])).rows[0].id;
  for (const [direcao, texto] of [["ENTRADA", "texto do cliente"], ["SAIDA", "resposta"]] as const) {
    await q("INSERT INTO mensagens (atendimento_id, direcao, canal, texto, criado_em) VALUES ($1, $2, 'META', $3, now() - make_interval(days => COALESCE($4::int, 0)))",
      [id, direcao, texto, enc]);
  }
  return id as string;
}
const nMensagens = async (id: string) => Number((await q("SELECT count(*) n FROM mensagens WHERE atendimento_id = $1", [id])).rows[0].n);
const linha = async (id: string) => (await q("SELECT * FROM atendimentos WHERE id = $1", [id])).rows[0];
const existeCliente = async (n: number) => Number((await q("SELECT count(*) n FROM clientes WHERE telefone = $1", [TEL(n)])).rows[0].n) === 1;

out(`== Prazos: mensagens ${PRAZOS_RETENCAO.mensagensDias} d | anonimizar ${PRAZOS_RETENCAO.anonimizarAtendimentoDias} d | clientes ${PRAZOS_RETENCAO.clienteDias} d | eventos ${PRAZOS_RETENCAO.eventosDias} d ==`);
const m61 = await criar(1, "TST-RET-01", 61);
const m59 = await criar(2, "TST-RET-02", 59);
const aberto = await criar(3, "TST-RET-03", null);
await q("UPDATE mensagens SET criado_em = now() - interval '400 days' WHERE atendimento_id = $1", [aberto]);
const a366 = await criar(4, "TST-RET-04", 366, { clienteDias: 400, assumido: true });
const a364 = await criar(5, "TST-RET-05", 364, { clienteDias: 400, assumido: true });
// Cliente antigo com atendimento recente: fica.
await criar(6, "TST-RET-06", 10, { clienteDias: 800 });
for (const [id, dias] of [["teste-ret-ev8", 8], ["teste-ret-ev6", 6]] as const) {
  await q("INSERT INTO eventos_processados (canal, mensagem_externa_id, recebido_em) VALUES ('META', $1, now() - make_interval(days => $2))", [id, dias]);
}
const rankingAntes = (await consultarRanking())?.find((r: { nome: string }) => r.nome === "Teste Vendedor Retenção");

const r1 = await executarRetencao();
ok(r1 !== null, `rotina rodou (${JSON.stringify(r1)})`);

out("\n== Mensagens ==");
ok((await nMensagens(m61)) === 0, "atendimento encerrado há 61 dias: mensagens apagadas");
ok((await nMensagens(m59)) === 2, "encerrado há 59 dias: mensagens ficam");
ok((await nMensagens(aberto)) === 2, "atendimento aberto: mensagens nunca somem (mesmo com 400 dias)");

out("\n== Atendimentos ==");
const l366 = await linha(a366), l364 = await linha(a364);
ok(l366.chat_id === "meta:anon:TST-RET-04" && l366.nome === null && l366.produto === null && l366.quantidade === null && l366.observacoes === null && l366.cliente_id === null,
  "encerrado há 1 ano + 1 dia: anonimizado (chat_id sem telefone, campos NULL, sem cliente)");
ok(l366.codigo === "TST-RET-04" && l366.status === "HUMANO" && l366.vendedor_id === vendedorId && l366.assumido_em !== null && l366.encerrado_em !== null,
  "mantém codigo, status, datas, vendedor_id e assumido_em");
const rankingDepois = (await consultarRanking())?.find((r: { nome: string }) => r.nome === "Teste Vendedor Retenção");
ok(rankingAntes?.total === 2 && rankingDepois?.total === 2, `continua contando no /ranking (total ${rankingAntes?.total} → ${rankingDepois?.total})`);
ok(l364.chat_id === `meta:999:${TEL(5)}` && l364.nome === "Nome Teste" && l364.cliente_id !== null, "encerrado há 364 dias: intacto");
ok((await linha(aberto)).nome === "Nome Teste", "atendimento aberto: intacto");

out("\n== Clientes e eventos ==");
ok(!(await existeCliente(4)), "cliente sem atividade há mais de 1 ano (atendimento anonimizado): apagado");
ok((await existeCliente(5)) && (await existeCliente(6)) && (await existeCliente(1)), "clientes com atendimento recente ou ainda não anonimizado: ficam");
const ev = (await q("SELECT mensagem_externa_id FROM eventos_processados WHERE mensagem_externa_id LIKE 'teste-ret-%' ORDER BY 1")).rows.map((r: { mensagem_externa_id: string }) => r.mensagem_externa_id);
ok(JSON.stringify(ev) === JSON.stringify(["teste-ret-ev6"]), "eventos: 8 dias some, 6 dias fica");

out("\n== Idempotência ==");
const foto = async () => JSON.stringify((await q(`SELECT (SELECT count(*) FROM mensagens) m, (SELECT count(*) FROM clientes) c, (SELECT count(*) FROM eventos_processados) e,
  (SELECT string_agg(codigo || ':' || chat_id || ':' || coalesce(nome, '-'), ',' ORDER BY codigo) FROM atendimentos) a`)).rows[0]);
const antes2 = await foto();
const r2 = await executarRetencao();
ok(r2 !== null && r2.mensagens === 0 && r2.atendimentos === 0 && r2.clientes === 0 && r2.eventos === 0 && (await foto()) === antes2,
  "segunda execução seguida: nada muda (todas as contagens 0)");
ok(logs.some((l) => /^\[Retenção\] mensagens apagadas: \d+ \| atendimentos anonimizados: \d+ \| clientes apagados: \d+ \| eventos apagados: \d+$/.test(l)), "log só com contagens");

out("\n== Banco fora ==");
const pool = banco.obterPool();
const connectOriginal = pool.connect.bind(pool);
(pool as any).connect = (...a: unknown[]) => (a.length === 0 ? Promise.reject(Object.assign(new Error("conexão recusada (simulada)"), { code: "ECONNREFUSED" })) : (connectOriginal as any)(...a));
const r3 = await executarRetencao();
(pool as any).connect = connectOriginal;
ok(r3 === null && logs.some((l) => l.startsWith("[Retenção] falha (ECONNREFUSED); nova tentativa no próximo ciclo.")), "só log com o código; tenta no próximo ciclo");

out("\n== Script apagar-cliente ==");
const script = (...args: string[]) => spawnSync(process.execPath, ["--import", "tsx", "scripts/apagar-cliente.mts", ...args], { cwd: raiz, encoding: "utf8", timeout: 60_000 });
const S1 = await criar(10, "TST-RET-10", 5);
const S2 = await criar(10, "TST-RET-11", 30);
const outro = await criar(11, "TST-RET-12", 5);
const simul = script(TEL(10));
ok(simul.status === 0 && simul.stdout.includes("SIMULAÇÃO") && (await existeCliente(10)) && (await nMensagens(S1)) === 2,
  "sem --confirmar: só mostra o plano, nada apagado");
await criar(12, "TST-RET-13", null);
const recusa = script(TEL(12), "--confirmar");
ok(recusa.status === 1 && recusa.stdout.includes("RECUSADO") && (await existeCliente(12)), "com atendimento aberto: recusa e não altera nada");
const exec = script(TEL(10), "--confirmar");
const ls1 = await linha(S1), ls2 = await linha(S2);
ok(exec.status === 0 && !(await existeCliente(10)) && (await nMensagens(S1)) === 0 && (await nMensagens(S2)) === 0 &&
   ls1.chat_id === "meta:anon:TST-RET-10" && ls2.chat_id === "meta:anon:TST-RET-11" && ls1.nome === null && ls1.cliente_id === null,
  `com --confirmar: mensagens apagadas, atendimentos anonimizados, cliente apagado (${exec.stdout.trim().replace(/^.*: /, "")})`);
ok((await existeCliente(11)) && (await nMensagens(outro)) === 2 && (await linha(outro)).nome === "Nome Teste", "nada de outro telefone foi tocado");
const saidaScript = simul.stdout + recusa.stdout + exec.stdout;
ok(!saidaScript.includes(TEL(10)) && !saidaScript.includes(TEL(12)) && saidaScript.includes("5591****1210"), "saída do script só com o telefone mascarado");
ok(script("123").status === 2, "telefone inválido: só a mensagem de uso");

out("\n== Limpeza ==");
await q("DELETE FROM mensagens WHERE atendimento_id IN (SELECT id FROM atendimentos WHERE codigo LIKE 'TST-RET-%')");
const apagadosAtd = (await q("DELETE FROM atendimentos WHERE codigo LIKE 'TST-RET-%'")).rowCount;
const apagadosCli = (await q("DELETE FROM clientes WHERE telefone LIKE '55919000012%'")).rowCount;
await q("DELETE FROM eventos_processados WHERE mensagem_externa_id LIKE 'teste-ret-%'");
await q("DELETE FROM vendedores WHERE telegram_user_id = $1", [VENDEDOR]);
const sobra = Number((await q("SELECT (SELECT count(*) FROM atendimentos WHERE codigo LIKE 'TST-RET-%') + (SELECT count(*) FROM clientes WHERE telefone LIKE '55919000012%') n")).rows[0].n);
ok(sobra === 0, `apagados: ${apagadosAtd} atendimentos, ${apagadosCli} clientes; restantes = ${sobra}`);
await banco.encerrarBanco();

out(falhas ? `\n${total} verificações | ${falhas} FALHA(S)` : `\n${total} verificações | TODOS OS TESTES PASSARAM`);
await new Promise((r) => setTimeout(r, 300));
process.exit(falhas ? 1 : 0);
