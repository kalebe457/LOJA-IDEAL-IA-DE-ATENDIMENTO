// Fechamento manual da loja pelo Telegram: /fechar [DD/MM], /abrir [DD/MM], /fechamentos.
// Servidor real + banco de testes. Meta, Telegram e Claude simulados; rede externa bloqueada.
// Chats "meta:999:<telefone fictício 55919000013xx>", wamids "teste-fech-...", admin/membro 9900000004xx.
// Banco de TESTES (loja_ideal_teste) fixado antes de qualquer import de src/; loja_ideal é dado real.
const { exigirBancoDeTeste } = await import(new URL("./banco-teste.mts", import.meta.url).href);
import { createHmac } from "node:crypto";

Object.assign(process.env, {
  PORT: "39886",
  META_APP_SECRET: "meta-secret-teste",
  META_ENVIO_ATIVO: "true",
  META_ACCESS_TOKEN: "meta-token-falso",
  META_PHONE_NUMBER_ID: "999",
  META_GRAPH_VERSION: "v26.0",
  TELEGRAM_BOT_TOKEN: "123456:TOKEN-FALSO",
  TELEGRAM_CHAT_ID: "-1009999999999",
  TELEGRAM_WEBHOOK_SECRET: "segredo-teste-fech",
  TELEGRAM_RESUMO_TTL_HORAS: "72",
  ANTHROPIC_API_KEY: "anthropic-falso",
});
const BASE = "http://127.0.0.1:39886";
const GRUPO = -1009999999999;
const ADMIN = { id: 990_000_000_401, nome: "Teste Admin Fechamento" };
const MEMBRO = { id: 990_000_000_402, nome: "Teste Membro Fechamento" };

// Relógio controlado (Belém = UTC-3): começa quarta 07/10/2026 10:00.
const agoraReal = Date.now.bind(Date);
let desloc = 0;
const relogio = (iso: string) => { desloc = Date.parse(iso) - agoraReal(); };
relogio("2026-10-07T10:00:00-03:00");
Date.now = () => agoraReal() + desloc;

// ---- Graph API e Bot API simuladas ----
const enviadosWhatsApp: { to: string; texto: string }[] = [];
let resp = 0;
const telegram: { metodo: string; corpo: any }[] = [];
const externas: string[] = [];
const fetchReal = globalThis.fetch;
(globalThis as any).fetch = async (url: any, init: any) => {
  const u = new URL(String(url));
  if (u.hostname === "127.0.0.1") return fetchReal(url, init);
  if (u.hostname === "graph.facebook.com") {
    const corpo = JSON.parse(init.body);
    enviadosWhatsApp.push({ to: corpo.to, texto: corpo.text.body });
    return new Response(JSON.stringify({ messaging_product: "whatsapp", messages: [{ id: `wamid.teste-fech-resp-${++resp}` }] }), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  const m = /^\/bot[^/]+\/(\w+)$/.exec(u.pathname);
  if (u.hostname === "api.telegram.org" && m) {
    const corpo = JSON.parse(init.body);
    telegram.push({ metodo: m[1]!, corpo });
    const r = (o: any) => ({ status: o.ok ? 200 : 400, json: async () => o });
    if (m[1] === "getChatMember") return r({ ok: true, result: { status: corpo.user_id === ADMIN.id ? "administrator" : "member" } });
    if (m[1] === "sendMessage") return r({ ok: true, result: { message_id: 1, chat: { id: Number(corpo.chat_id) } } });
    return r({ ok: true, result: true });
  }
  externas.push(u.hostname);
  throw new Error("rede externa bloqueada no teste");
};

const B = new URL("..", import.meta.url).href.replace(/\/$/, "");
const { default: Anthropic } = await import(B + "/node_modules/@anthropic-ai/sdk/index.mjs");
(Anthropic as any).Messages.prototype.parse = async function () {
  return { model: "stub", usage: { input_tokens: 0, output_tokens: 0 }, parsed_output: { resposta: "", status: "IA", quantidade_aplicavel: true,
    resumo: { nome: "Não informado", produto: "Não informado", quantidade: "Não informado", observacoes: "Não informado" } } };
};

const logs: string[] = [];
const out = console.log.bind(console);
for (const k of ["log", "warn", "error"] as const) console[k] = (...a: unknown[]) => { logs.push(a.join(" ")); };

const webhook = await import(B + "/src/webhook.ts");
const banco = await import(B + "/src/banco.ts");
await exigirBancoDeTeste(banco.consultar);
const { MENSAGEM_LOJA_FECHADA } = await import(B + "/src/horarioFuncionamento.ts");

let falhas = 0, total = 0;
const ok = (c: boolean, t: string) => { total++; if (!c) falhas++; out(`${c ? "OK  " : "FAIL"} ${t}`); };
const espera = (ms = 600) => new Promise((r) => setTimeout(r, ms));
const chat = (tel: string) => `meta:999:${tel}`;
const TEL = (n: number) => `55919000013${String(n).padStart(2, "0")}`;

const previos = Number((await banco.consultar("SELECT (SELECT count(*) FROM atendimentos WHERE chat_id LIKE 'meta:999:%') + (SELECT count(*) FROM fechamentos) n")).rows[0].n);
if (previos !== 0) { out(`ABORTADO: já existem ${previos} registros de teste`); process.exit(1); }

await webhook.iniciarWebhook();

let seq = 0;
async function mensagem(tel: string, texto: string) {
  const corpo = JSON.stringify({ object: "whatsapp_business_account", entry: [{ id: "1", changes: [{ field: "messages", value: {
    messaging_product: "whatsapp", metadata: { phone_number_id: "999" },
    messages: [{ id: `teste-fech-${++seq}`, from: tel, timestamp: String(Math.floor(Date.now() / 1000)), type: "text", text: { body: texto } }] } }] }] });
  const sig = "sha256=" + createHmac("sha256", "meta-secret-teste").update(corpo).digest("hex");
  await fetchReal(BASE + "/meta/webhook", { method: "POST", headers: { "Content-Type": "application/json", "X-Hub-Signature-256": sig }, body: corpo });
  await espera();
}
let upd = 1;
async function comando(v: { id: number; nome: string }, texto: string, tipoChat: "private" | "supergroup" = "private") {
  const antes = telegram.length;
  await fetchReal(BASE + "/telegram/webhook", { method: "POST", headers: { "Content-Type": "application/json", "X-Telegram-Bot-Api-Secret-Token": "segredo-teste-fech" },
    body: JSON.stringify({ update_id: upd++, message: { message_id: 1, chat: { id: tipoChat === "private" ? v.id : GRUPO, type: tipoChat }, from: { id: v.id, first_name: v.nome }, text: texto } }) });
  await espera();
  return { resposta: telegram.slice(antes).filter((c) => c.metodo === "sendMessage" && c.corpo.chat_id === v.id).at(-1)?.corpo.text as string | undefined, chamadas: telegram.length - antes };
}
const recebeu = (tel: string) => enviadosWhatsApp.filter((e) => e.to === tel).map((e) => e.texto);
const atendimentos = async (tel: string) => Number((await banco.consultar("SELECT count(*) n FROM atendimentos WHERE chat_id = $1", [chat(tel)])).rows[0].n);
const paraGrupo = () => telegram.filter((c) => c.metodo === "sendMessage" && String(c.corpo.chat_id) === String(GRUPO)).length;
const datasNoBanco = async () => (await banco.consultar("SELECT to_char(data, 'YYYY-MM-DD') d FROM fechamentos ORDER BY data")).rows.map((r: { d: string }) => r.d).join(",");

out("== /fechar (hoje) ==");
await mensagem(TEL(1), "oi"); // conversa já em andamento antes do fechamento
const f1 = await comando(ADMIN, "/fechar");
ok(f1.resposta === "Loja marcada como fechada em quarta, 07/10. Quem mandar mensagem recebe o aviso de loja fechada.", `resposta: "${f1.resposta}"`);
ok((await datasNoBanco()) === "2026-10-07" && logs.some((l) => l === "[Loja] fechamento manual em 07/10 por admin 9900****0401"), "gravado no banco; log com o admin mascarado, sem nome");
const grupo0 = paraGrupo();
await mensagem(TEL(2), "oi");
await mensagem(TEL(2), "tem cimento?");
ok(JSON.stringify(recebeu(TEL(2))) === JSON.stringify([MENSAGEM_LOJA_FECHADA]), "cliente novo: exatamente a mensagem de loja fechada, uma vez por período");
ok((await atendimentos(TEL(2))) === 0 && webhook.lerEstadoEspelhavel(chat(TEL(2))) === null && paraGrupo() === grupo0, "nenhum atendimento criado e nada no grupo");
await mensagem(TEL(1), "Ana");
ok(recebeu(TEL(1)).length === 2 && !recebeu(TEL(1)).includes(MENSAGEM_LOJA_FECHADA), "conversa que já estava em andamento continua (mesma regra do horário)");

out("\n== /abrir ==");
const a1 = await comando(ADMIN, "/abrir");
ok(a1.resposta === "Fechamento de quarta, 07/10 removido. A loja segue o horário normal nesse dia." && (await datasNoBanco()) === "", `resposta: "${a1.resposta}"`);
await mensagem(TEL(3), "oi");
ok(recebeu(TEL(3))[0]?.startsWith("Olá!") === true && (await atendimentos(TEL(3))) === 1, "volta a atender normalmente");
ok((await comando(ADMIN, "/abrir")).resposta === "Não havia fechamento marcado em quarta, 07/10.", "/abrir sem fechamento: avisa que não havia");

out("\n== /fechar 25/12 ==");
const f2 = await comando(ADMIN, "/fechar 25/12");
ok(f2.resposta === "Loja marcada como fechada em sexta, 25/12. Quem mandar mensagem recebe o aviso de loja fechada.", `resposta: "${f2.resposta}"`);
relogio("2026-12-24T10:00:00-03:00");
await mensagem(TEL(4), "oi");
ok(recebeu(TEL(4))[0]?.startsWith("Olá!") === true, "24/12 (quinta): atende");
relogio("2026-12-25T10:00:00-03:00");
await mensagem(TEL(5), "oi");
ok(JSON.stringify(recebeu(TEL(5))) === JSON.stringify([MENSAGEM_LOJA_FECHADA]) && (await atendimentos(TEL(5))) === 0, "25/12 (sexta, fechado): aviso de loja fechada");
relogio("2026-12-26T10:00:00-03:00");
await mensagem(TEL(6), "oi");
ok(recebeu(TEL(6))[0]?.startsWith("Olá!") === true, "26/12 (sábado): atende (o fechamento acabou à meia-noite)");

out("\n== Reinício com fechamento gravado ==");
relogio("2026-12-25T10:00:00-03:00");
await banco.consultar("INSERT INTO fechamentos (data) VALUES ('2026-12-01')"); // passado: não volta
webhook.redefinirEstadoWebhookParaTestes();
await webhook.recuperarNaPartida();
await mensagem(TEL(7), "oi");
ok(JSON.stringify(recebeu(TEL(7))) === JSON.stringify([MENSAGEM_LOJA_FECHADA]) && logs.some((l) => l === "[Loja] fechamentos manuais carregados: 1"),
  "depois do reinício continua fechado (só os fechamentos de hoje em diante voltam)");

out("\n== Permissão ==");
relogio("2026-10-07T10:00:00-03:00");
const m1 = await comando(MEMBRO, "/fechar 20/10");
ok(m1.resposta === "Esse comando é só para administradores do grupo." && !(await datasNoBanco()).includes("2026-10-20"), "membro comum: negação e nada gravado");
const g1 = await comando(ADMIN, "/fechar 21/10", "supergroup");
ok(g1.chamadas === 0 && !(await datasNoBanco()).includes("2026-10-21"), "no grupo: ignorado (nenhuma chamada à Bot API)");

out("\n== Datas ==");
for (const ruim of ["/fechar 31/02", "/fechar 00/13", "/fechar amanhã", "/abrir 32/01"]) {
  const r = await comando(ADMIN, ruim);
  ok(r.resposta?.startsWith("Data inválida.") === true, `${ruim}: erro curto`);
}
const f3 = await comando(ADMIN, "/fechar 01/01");
ok(f3.resposta === "Loja marcada como fechada em sexta, 01/01/2027. Quem mandar mensagem recebe o aviso de loja fechada.", `data que já passou neste ano vira o próximo: "${f3.resposta}"`);

out("\n== /fechamentos ==");
const l1 = await comando(ADMIN, "/fechamentos");
ok(l1.resposta === "Fechamentos marcados (a loja não atende o dia inteiro):\n• sexta, 25/12\n• sexta, 01/01/2027", `lista de hoje em diante, em ordem: ${JSON.stringify(l1.resposta)}`);
await comando(ADMIN, "/abrir 25/12");
await comando(ADMIN, "/abrir 01/01");
ok((await comando(ADMIN, "/fechamentos")).resposta === "Nenhum fechamento marcado de hoje em diante.", "sem fechamentos: mensagem própria");

out("\n== Banco fora na partida ==");
await comando(ADMIN, "/fechar 30/10");
const pool = banco.obterPool();
const queryOriginal = pool.query.bind(pool);
(pool as any).query = () => Promise.reject(Object.assign(new Error("conexão recusada (simulada)"), { code: "ECONNREFUSED" }));
webhook.redefinirEstadoWebhookParaTestes();
await webhook.recuperarNaPartida();
(pool as any).query = queryOriginal;
ok(logs.some((l) => l.includes("[Loja] ATENÇÃO: fechamentos não carregados do banco (ECONNREFUSED)")) && (await comando(ADMIN, "/fechamentos")).resposta === "Nenhum fechamento marcado de hoje em diante.",
  "sobe sem fechamentos e loga em destaque");

ok(externas.length === 0, `nenhuma chamada de rede externa (${externas.length})`);

out("\n== Limpeza ==");
await espera(500);
const fe = (await banco.consultar("DELETE FROM fechamentos")).rowCount;
const ev = (await banco.consultar("DELETE FROM eventos_processados WHERE mensagem_externa_id LIKE 'teste-fech-%'")).rowCount;
const { limparEspelhoDeTeste } = await import(B + "/tests/limpeza-espelho.mts");
const espelho = await limparEspelhoDeTeste(banco.consultar);
ok(espelho.restantes === 0, `apagados: ${fe} fechamentos, ${ev} eventos, ${espelho.atendimentos} atendimentos, ${espelho.clientes} clientes`);
await banco.encerrarBanco();

out(falhas ? `\n${total} verificações | ${falhas} FALHA(S)` : `\n${total} verificações | TODOS OS TESTES PASSARAM`);
await new Promise((r) => setTimeout(r, 300));
process.exit(falhas ? 1 : 0);
