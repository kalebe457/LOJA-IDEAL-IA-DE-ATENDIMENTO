// Passo 5d: reinício REAL. O backend roda num processo filho (tests/processo-backend-teste.mts), com
// Meta, Telegram e Claude simulados e banco real (loja_ideal). O filho é morto com SIGKILL (no Windows,
// TerminateProcess: sem shutdown limpo) e outro sobe no lugar, fazendo a recuperação na partida.
// Chats "meta:999:<telefone fictício 55919000010xx>", wamids "teste-5d-r-...".
import { spawn, type ChildProcess } from "node:child_process";
import { createHmac } from "node:crypto";
import { fileURLToPath } from "node:url";

const PORTA = 39883;
const BASE = `http://127.0.0.1:${PORTA}`;
const GRUPO = "-1009999999999";
const raiz = fileURLToPath(new URL("..", import.meta.url));
const B = new URL("..", import.meta.url).href.replace(/\/$/, "");

// O mesmo relógio para o pai e os filhos: quarta 07/10/2026 10:00 em Belém (loja aberta).
const agoraReal = Date.now.bind(Date);
const desloc = Date.parse("2026-10-07T10:00:00-03:00") - agoraReal();
Date.now = () => agoraReal() + desloc;

const out = console.log.bind(console);
let falhas = 0, total = 0;
const ok = (c: boolean, t: string) => { total++; if (!c) falhas++; out(`${c ? "OK  " : "FAIL"} ${t}`); };
const espera = (ms: number) => new Promise((r) => setTimeout(r, ms));

const banco = await import(B + "/src/banco.ts");
const previos = Number((await banco.consultar("SELECT count(*) n FROM atendimentos WHERE chat_id LIKE 'meta:999:%'")).rows[0].n);
if (previos !== 0) { out(`ABORTADO: já existem ${previos} atendimentos de teste (meta:999:)`); process.exit(1); }

type Evento = { tipo: string; dado: string; filho: number };
const eventos: Evento[] = [];
let nFilho = 0;

function subir(extra: Record<string, string> = {}): { filho: ChildProcess; id: number; ouvindo: Promise<number> } {
  const id = ++nFilho;
  const filho = spawn(process.execPath, ["--import", "tsx", "tests/processo-backend-teste.mts"], {
    cwd: raiz,
    env: { ...process.env, PORT: String(PORTA), TESTE_DESLOC_MS: String(desloc), TESTE_MSG_ID_INICIAL: String(id * 1000), ...extra },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const inicio = Date.now();
  let resto = "";
  let avisar: (ms: number) => void = () => undefined;
  const ouvindo = new Promise<number>((r) => { avisar = r; });
  filho.stdout!.on("data", (bloco: Buffer) => {
    resto += bloco.toString("utf8");
    const linhas = resto.split("\n");
    resto = linhas.pop() ?? "";
    for (const linha of linhas) {
      const m = /^@@(\w+) (.*)$/.exec(linha);
      if (!m) continue;
      eventos.push({ tipo: m[1]!, dado: m[2]!, filho: id });
      if (m[1] === "LOG" && m[2]!.startsWith("Backend ouvindo")) avisar(Date.now() - inicio);
    }
  });
  filho.stderr!.on("data", () => undefined);
  return { filho, id, ouvindo };
}

async function matar(filho: ChildProcess) {
  const fim = new Promise((r) => filho.once("exit", r));
  filho.kill("SIGKILL");
  await fim;
}

let seq = 0;
function corpoMeta(tel: string, texto: string, wamid = `teste-5d-r-${++seq}`) {
  const corpo = JSON.stringify({ object: "whatsapp_business_account", entry: [{ id: "1", changes: [{ field: "messages", value: {
    messaging_product: "whatsapp", metadata: { phone_number_id: "999" },
    messages: [{ id: wamid, from: tel, timestamp: String(Math.floor(Date.now() / 1000)), type: "text", text: { body: texto } }] } }] }] });
  return { corpo, sig: "sha256=" + createHmac("sha256", "meta-secret-teste").update(corpo).digest("hex") };
}
async function postar(c: { corpo: string; sig: string }): Promise<number | string> {
  try {
    const r = await fetch(BASE + "/meta/webhook", { method: "POST", headers: { "Content-Type": "application/json", "X-Hub-Signature-256": c.sig }, body: c.corpo });
    return r.status;
  } catch (erro: any) {
    return erro?.cause?.code ?? "erro";
  }
}
async function mensagem(tel: string, texto: string) {
  const s = await postar(corpoMeta(tel, texto));
  await espera(700);
  return s;
}
const logsDo = (id: number) => eventos.filter((e) => e.filho === id && e.tipo === "LOG").map((e) => e.dado);
const chat = (tel: string) => `meta:999:${tel}`;

out("== Reinício real com SIGKILL no meio da triagem ==");
const TEL = "5591900001001";
const p1 = subir();
await p1.ouvindo;
for (const t of ["oi", "Ana"]) ok((await mensagem(TEL, t)) === 200, `1º processo: "${t}" aceito`);
const atd1 = (await banco.consultar("SELECT codigo, etapa_atual FROM atendimentos WHERE chat_id = $1", [chat(TEL)])).rows[0];
ok(atd1?.etapa_atual === "produto", "triagem no meio (etapa produto)");
await matar(p1.filho);
ok(p1.filho.killed && p1.filho.exitCode !== 0, `1º processo morto com SIGKILL (exit ${p1.filho.exitCode ?? p1.filho.signalCode})`);

const p2 = subir();
await p2.ouvindo;
const rec2 = logsDo(p2.id).find((l) => l.startsWith("[Recuperação] concluída")) ?? "";
ok(/conversas recuperadas: 1 \|/.test(rec2), `2º processo recuperou a conversa antes de ouvir (${rec2.replace("[Recuperação] concluída | ", "")})`);
for (const t of ["cimento", "10 sacos", "entregar amanhã"]) ok((await mensagem(TEL, t)) === 200, `2º processo: "${t}" aceito`);
await espera(800);

const atds = (await banco.consultar("SELECT codigo, status, etapa_atual, nome, produto, quantidade, observacoes FROM atendimentos WHERE chat_id = $1", [chat(TEL)])).rows;
ok(atds.length === 1 && atds[0].codigo === atd1.codigo, `mesmo codigo nos dois processos (${atd1.codigo})`);
ok(atds[0].status === "HUMANO" && atds[0].nome === "Ana" && atds[0].produto === "cimento" && atds[0].quantidade === "10 sacos" && atds[0].observacoes === "entregar amanhã",
  "triagem concluída com os 4 campos (nada recomeçou)");
const msgs: { direcao: string; texto: string; mensagem_externa_id: string | null }[] = (await banco.consultar(
  `SELECT m.direcao, m.texto, m.mensagem_externa_id FROM mensagens m JOIN atendimentos a ON a.id = m.atendimento_id
    WHERE a.chat_id = $1 ORDER BY m.criado_em, m.id`, [chat(TEL)])).rows;
ok(msgs.map((m) => (m.direcao === "ENTRADA" ? "E" : "S")).join("") === "ESESESESES", `ENTRADA/SAIDA sem buraco nem duplicata (${msgs.length} mensagens)`);
ok(new Set(msgs.map((m) => m.mensagem_externa_id)).size === msgs.length, "nenhum wamid repetido");
ok(msgs.filter((m) => m.direcao === "SAIDA" && String(m.texto).startsWith("Olá!")).length === 1 && String(msgs[1]?.texto).startsWith("Olá!"),
  "apresentação só na 1ª resposta (sem reapresentação depois do reinício)");
const claude2 = eventos.filter((e) => e.filho === p2.id && e.tipo === "CLAUDE").map((e) => Number(e.dado));
ok(claude2[0] === 5, `o Claude do 2º processo recebeu o histórico recuperado (4 mensagens + a atual = ${claude2[0]})`);
const resumos = eventos.filter((e) => e.tipo === "TG").map((e) => JSON.parse(e.dado))
  .filter((c) => c.metodo === "sendMessage" && String(c.corpo.chat_id) === GRUPO && c.corpo.reply_markup?.inline_keyboard?.[0]?.[0]?.callback_data === `assumir:${atd1.codigo}`);
ok(resumos.length === 1, `resumo publicado uma vez (${resumos.length})`);
await matar(p2.filho);

out("\n== Webhook durante a recuperação (recuperação lenta: statement_timeout) ==");
// Um atendimento aberto e inativo, travado por outra conexão: o UPDATE da recuperação espera e é cancelado.
const TEL_L = "5591900001002";
const cli = (await banco.consultar("INSERT INTO clientes (telefone) VALUES ($1) ON CONFLICT (telefone) DO UPDATE SET telefone = EXCLUDED.telefone RETURNING id", [TEL_L])).rows[0].id;
await banco.consultar(
  "INSERT INTO atendimentos (codigo, cliente_id, status, canal, chat_id, ultima_atividade_em) VALUES ('ATD-TESTE5D001', $1, 'IA', 'META', $2, to_timestamp($3))",
  [cli, chat(TEL_L), (Date.now() - 60 * 60_000) / 1000]);
const trava = await banco.obterConexao();
await trava.query("BEGIN");
await trava.query("SELECT id FROM atendimentos WHERE codigo = 'ATD-TESTE5D001' FOR UPDATE");
const p3 = subir();
const TEL_W = "5591900001003";
const durante = corpoMeta(TEL_W, "oi");
await espera(1500);
const tentativa = await postar(durante);
const ouvindoEm = await p3.ouvindo;
await trava.query("ROLLBACK");
trava.release();
const rec3 = logsDo(p3.id);
ok(tentativa === "ECONNREFUSED", `durante a recuperação o webhook não é aceito (${tentativa}); a Meta reentrega`);
ok(rec3.some((l) => l.includes("ATENÇÃO: banco indisponível na partida (57014)")) && ouvindoEm >= 4_500 && ouvindoEm < 30_000,
  `recuperação lenta cancelada; ouvindo depois de ${(ouvindoEm / 1000).toFixed(1)} s (< 30 s), com a memória vazia`);
ok(!eventos.some((e) => e.filho === p3.id && e.tipo === "CLAUDE"), "nada processado antes do listen");
ok((await postar(durante)) === 200, "reentrega (mesmo wamid) aceita depois do listen");
await espera(800);
ok(eventos.filter((e) => e.filho === p3.id && e.tipo === "CLAUDE").length === 1, "processada uma única vez");
await matar(p3.filho);

out("\n== Banco fora na partida ==");
const p4 = subir({ TESTE_BANCO_FORA: "1" });
const ouvindo4 = await Promise.race([p4.ouvindo, espera(40_000).then(() => -1)]);
ok(ouvindo4 >= 0 && logsDo(p4.id).some((l) => l.includes("ATENÇÃO: banco indisponível na partida (ECONNREFUSED)")),
  `sobe mesmo com o banco fora (aviso em destaque com o código), em ${(ouvindo4 / 1000).toFixed(1)} s`);
const health = await fetch(BASE + "/health").then((r) => r.status).catch(() => 0);
ok(health === 200 && (await mensagem("5591900001004", "oi")) === 200, "aceita webhook (health 200; mensagem aceita)");
await matar(p4.filho);

const senha = process.env.DB_PASSWORD ?? "";
ok(!senha || !eventos.some((e) => e.dado.includes(senha)), "nenhum log com a senha do banco");
ok(!eventos.some((e) => e.tipo === "LOG" && e.dado.includes("rede externa bloqueada")), "nenhuma chamada de rede externa");

out("\n== Limpeza ==");
const ev = (await banco.consultar("DELETE FROM eventos_processados WHERE mensagem_externa_id LIKE 'teste-5d-r-%'")).rowCount;
const { limparEspelhoDeTeste } = await import(B + "/tests/limpeza-espelho.mts");
const espelho = await limparEspelhoDeTeste(banco.consultar);
ok(espelho.restantes === 0, `apagados: ${ev} eventos, ${espelho.atendimentos} atendimentos, ${espelho.clientes} clientes; restantes = ${espelho.restantes}`);
await banco.encerrarBanco();

out(falhas ? `\n${total} verificações | ${falhas} FALHA(S)` : `\n${total} verificações | TODOS OS TESTES PASSARAM`);
await espera(300);
process.exit(falhas ? 1 : 0);
