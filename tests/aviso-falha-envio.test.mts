// Aviso quando a resposta não chega ao cliente (Bloco 2, item 2).
// a) Por atendimento: a resposta dada como não entregue (depois do retry) passa o atendimento para
//    HUMANO e publica o resumo com o aviso ⚠️ e o botão ASSUMIR (telefone só mascarado no grupo).
// b) Geral: 3 falhas seguidas em até 10 min, ou erro 190 (token), alertam no PRIVADO os
//    administradores do grupo registrados (/start); no máximo 1 alerta a cada 30 min; depois de um
//    alerta, o primeiro envio aceito avisa que voltou ao normal.
// Servidor real + banco de testes. Meta, Telegram e Claude simulados; rede externa bloqueada.
// Chats "meta:999:<telefone fictício 55919000011xx>", wamids "teste-aviso-...", vendedores 9900000002xx.
// Banco de TESTES (loja_ideal_teste) fixado antes de qualquer import de src/; loja_ideal é dado real.
const { exigirBancoDeTeste } = await import(new URL("./banco-teste.mts", import.meta.url).href);
import { createHmac } from "node:crypto";

Object.assign(process.env, {
  PORT: "39885",
  META_APP_SECRET: "meta-secret-teste",
  META_ENVIO_ATIVO: "true",
  META_ACCESS_TOKEN: "meta-token-falso",
  META_PHONE_NUMBER_ID: "999",
  META_GRAPH_VERSION: "v26.0",
  TELEGRAM_BOT_TOKEN: "123456:TOKEN-FALSO",
  TELEGRAM_CHAT_ID: "-1009999999999",
  TELEGRAM_WEBHOOK_SECRET: "segredo-teste-aviso",
  TELEGRAM_RESUMO_TTL_HORAS: "72",
  ANTHROPIC_API_KEY: "anthropic-falso",
});
const BASE = "http://127.0.0.1:39885";
const GRUPO = -1009999999999;
const AVISO = "⚠️ A IA não conseguiu responder este cliente. Assuma e fale com ele pelo WhatsApp.";
const ALERTA = "⚠️ A IA não está conseguindo enviar mensagens no WhatsApp.";
const NORMAL = "✅ Os envios pelo WhatsApp voltaram ao normal.";

// Pessoas fictícias. Chat privado = user_id.
const VEND = { id: 990_000_000_201, nome: "Teste Vendedor Aviso" };
const ADMIN1 = { id: 990_000_000_202, nome: "Teste Admin Um" };
const CRIADOR = { id: 990_000_000_203, nome: "Teste Criador" };
const ADMIN_SEM_START = { id: 990_000_000_204, nome: "Teste Admin Sem Start" };
const BOT_ADMIN = { id: 990_000_000_205, nome: "Teste Bot" };

// Relógio controlado: quarta 07/10/2026 10:00 em Belém (loja aberta).
const agoraReal = Date.now.bind(Date);
let desloc = Date.parse("2026-10-07T10:00:00-03:00") - agoraReal();
Date.now = () => agoraReal() + desloc;

// ---- Graph API simulada ----
let modoGraph: "aceita" | "recusa" | "token" = "aceita";
let envios = 0, resp = 0;
// ---- Bot API simulada ----
type Chamada = { metodo: string; corpo: any };
const telegram: Chamada[] = [];
let administradores = [ADMIN1, CRIADOR, ADMIN_SEM_START, BOT_ADMIN];
let telegramFora = false;
let msgId = 7000;
const externas: string[] = [];
const fetchReal = globalThis.fetch;
(globalThis as any).fetch = async (url: any, init: any) => {
  const u = new URL(String(url));
  if (u.hostname === "127.0.0.1") return fetchReal(url, init);
  if (u.hostname === "graph.facebook.com") {
    envios++;
    if (modoGraph === "aceita") {
      return new Response(JSON.stringify({ messaging_product: "whatsapp", messages: [{ id: `wamid.teste-aviso-resp-${++resp}` }] }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    const code = modoGraph === "token" ? 190 : 100;
    return new Response(JSON.stringify({ error: { code, type: "OAuthException", message: "recusado (simulado)" } }), { status: 400, headers: { "Content-Type": "application/json" } });
  }
  const m = /^\/bot[^/]+\/(\w+)$/.exec(u.pathname);
  if (u.hostname === "api.telegram.org" && m) {
    const corpo = JSON.parse(init.body);
    telegram.push({ metodo: m[1]!, corpo });
    const r = (o: any) => ({ status: o.ok ? 200 : 400, json: async () => o });
    if (m[1] === "getChatAdministrators") {
      if (telegramFora) return r({ ok: false, error_code: 502, description: "Bad Gateway" });
      return r({ ok: true, result: administradores.map((a) => ({
        status: a === CRIADOR ? "creator" : "administrator", user: { id: a.id, is_bot: a === BOT_ADMIN, first_name: a.nome } })) });
    }
    if (m[1] === "getChatMember") {
      const admin = [ADMIN1, CRIADOR, ADMIN_SEM_START].some((a) => a.id === corpo.user_id);
      return r({ ok: true, result: { status: admin ? "administrator" : "member" } });
    }
    if (m[1] === "sendMessage") return r({ ok: true, result: { message_id: msgId++, chat: { id: Number(corpo.chat_id) } } });
    return r({ ok: true, result: true });
  }
  externas.push(u.hostname);
  throw new Error("rede externa bloqueada no teste");
};

// Claude simulado: "pedido completo" preenche os 4 campos (triagem concluída numa mensagem).
const B = new URL("..", import.meta.url).href.replace(/\/$/, "");
const { default: Anthropic } = await import(B + "/node_modules/@anthropic-ai/sdk/index.mjs");
(Anthropic as any).Messages.prototype.parse = async function (params: any) {
  const completo = String(params.messages.at(-1).content).includes("pedido completo");
  return { model: "stub", usage: { input_tokens: 0, output_tokens: 0 }, parsed_output: { resposta: "", status: "IA", quantidade_aplicavel: true,
    resumo: completo
      ? { nome: "Cliente Teste Aviso", produto: "Cimento", quantidade: "10 sacos", observacoes: "Nenhuma observação adicional." }
      : { nome: "Não informado", produto: "Não informado", quantidade: "Não informado", observacoes: "Não informado" } } };
};

const logs: string[] = [];
const out = console.log.bind(console);
for (const k of ["log", "warn", "error"] as const) console[k] = (...a: unknown[]) => { logs.push(a.join(" ")); };

const webhook = await import(B + "/src/webhook.ts");
const banco = await import(B + "/src/banco.ts");
await exigirBancoDeTeste(banco.consultar);
const alerta = await import(B + "/src/alertaEnvio.ts");
await webhook.iniciarWebhook();

let falhas = 0, total = 0;
const ok = (c: boolean, t: string) => { total++; if (!c) falhas++; out(`${c ? "OK  " : "FAIL"} ${t}`); };
const espera = (ms = 600) => new Promise((r) => setTimeout(r, ms));
const chat = (tel: string) => `meta:999:${tel}`;
const TEL = (n: number) => `55919000011${String(n).padStart(2, "0")}`;

// Segurança: nada de teste antes de começar.
const previos = Number((await banco.consultar("SELECT count(*) n FROM atendimentos WHERE chat_id LIKE 'meta:999:%'")).rows[0].n);
if (previos !== 0) { out(`ABORTADO: já existem ${previos} atendimentos de teste (meta:999:)`); process.exit(1); }

let seq = 0;
async function mensagem(tel: string, texto: string) {
  const corpo = JSON.stringify({ object: "whatsapp_business_account", entry: [{ id: "1", changes: [{ field: "messages", value: {
    messaging_product: "whatsapp", metadata: { phone_number_id: "999" },
    messages: [{ id: `teste-aviso-${++seq}`, from: tel, timestamp: String(Math.floor(Date.now() / 1000)), type: "text", text: { body: texto } }] } }] }] });
  const sig = "sha256=" + createHmac("sha256", "meta-secret-teste").update(corpo).digest("hex");
  await fetchReal(BASE + "/meta/webhook", { method: "POST", headers: { "Content-Type": "application/json", "X-Hub-Signature-256": sig }, body: corpo });
  await espera();
  await alerta.aguardarAlertasParaTestes();
}
let upd = 1;
const tg = async (u: unknown) => { await fetchReal(BASE + "/telegram/webhook", { method: "POST",
  headers: { "Content-Type": "application/json", "X-Telegram-Bot-Api-Secret-Token": "segredo-teste-aviso" }, body: JSON.stringify(u) }); await espera(); };
const start = (v: { id: number; nome: string }) => tg({ update_id: upd++, message: { message_id: 1, chat: { id: v.id, type: "private" }, from: { id: v.id, first_name: v.nome }, text: "/start" } });
const clique = (v: { id: number; nome: string }, codigo: string, msg: number) =>
  tg({ update_id: upd++, callback_query: { id: `cb-aviso-${upd}`, from: { id: v.id, first_name: v.nome }, data: `assumir:${codigo}`, message: { message_id: msg, chat: { id: GRUPO, type: "supergroup" } } } });
const resumosDo = (codigo: string) => telegram.filter((c) => c.metodo === "sendMessage" && String(c.corpo.chat_id) === String(GRUPO)
  && c.corpo.reply_markup?.inline_keyboard?.[0]?.[0]?.callback_data === `assumir:${codigo}`);
const paraGrupo = () => telegram.filter((c) => c.metodo === "sendMessage" && String(c.corpo.chat_id) === String(GRUPO));
const privadosCom = (texto: string) => telegram.filter((c) => c.metodo === "sendMessage" && String(c.corpo.text).startsWith(texto));
const destinos = (lista: Chamada[]) => lista.map((c) => c.corpo.chat_id).sort().join(",");
const status = async (tel: string) => (await banco.consultar("SELECT status FROM atendimentos WHERE chat_id = $1 ORDER BY id DESC LIMIT 1", [chat(tel)])).rows[0]?.status;
const codigoDe = (tel: string) => webhook.lerEstadoEspelhavel(chat(tel))?.codigo ?? "";

for (const v of [VEND, ADMIN1, CRIADOR]) await start(v);

out("== a) Falha antes do resumo ==");
modoGraph = "recusa";
await mensagem(TEL(1), "oi");
modoGraph = "aceita";
const cod1 = codigoDe(TEL(1));
const r1 = resumosDo(cod1);
const texto1 = String(r1[0]?.corpo.text ?? "");
ok(webhook.lerEstadoEspelhavel(chat(TEL(1)))?.status === "HUMANO" && (await status(TEL(1))) === "HUMANO", "atendimento passou para HUMANO (memória e banco)");
ok(r1.length === 1 && texto1.startsWith(AVISO) && r1[0]!.corpo.reply_markup.inline_keyboard[0][0].text.includes("ASSUMIR"),
  "resumo publicado com o aviso ⚠️ no topo e o botão ASSUMIR");
ok(!texto1.includes(TEL(1)) && texto1.includes("5591****1101") && /Nome: Não informado/.test(texto1) && /Produto: Não informado/.test(texto1),
  "telefone só mascarado no grupo; campos não coletados como \"Não informado\"");
await clique(VEND, cod1, r1[0] ? msgId - 1 : -1);
const dm1 = telegram.filter((c) => c.metodo === "sendMessage" && c.corpo.chat_id === VEND.id && String(c.corpo.text).startsWith("🔒")).at(-1);
ok(dm1?.corpo.reply_markup?.inline_keyboard?.[0]?.[0]?.url === `https://wa.me/${TEL(1)}` && String(dm1?.corpo.text).includes(TEL(1)),
  "assumir funciona; a DM traz o telefone completo e o wa.me");

out("\n== Um aviso por atendimento ==");
const envios1 = envios;
await mensagem(TEL(1), "alguém aí?");
ok(envios === envios1 && resumosDo(cod1).length === 1, "nova mensagem do mesmo cliente: a IA não responde e nenhum novo aviso");
modoGraph = "recusa";
await mensagem(TEL(2), "pedido completo");
modoGraph = "aceita";
const r2 = resumosDo(codigoDe(TEL(2)));
ok(r2.length === 1 && String(r2[0]!.corpo.text).startsWith(AVISO),
  "triagem concluída cuja resposta final falhou: UM resumo, já com o aviso (não dois)");
// Telefone mascarado também no resumo normal.
await mensagem(TEL(3), "pedido completo");
const r3 = String(resumosDo(codigoDe(TEL(3)))[0]?.corpo.text ?? "");
ok(r3.startsWith("📋 NOVO ATENDIMENTO") && !r3.includes(TEL(3)) && r3.includes("5591****1103"), "resumo normal (sem falha): sem aviso, telefone mascarado");

out("\n== b) 3 falhas seguidas → alerta aos administradores registrados ==");
alerta.redefinirAlertaEnvioParaTestes();
const alertas0 = privadosCom(ALERTA).length;
const grupo0 = paraGrupo().filter((c) => String(c.corpo.text).startsWith(ALERTA)).length;
modoGraph = "recusa";
await mensagem(TEL(4), "oi");
await mensagem(TEL(5), "oi");
ok(privadosCom(ALERTA).length === alertas0, "2 falhas: ainda sem alerta");
await mensagem(TEL(6), "oi");
modoGraph = "aceita";
const alertasB = privadosCom(ALERTA).slice(alertas0);
ok(destinos(alertasB) === [ADMIN1.id, CRIADOR.id].sort().join(","), "3ª falha: alerta no privado do admin e do criador registrados");
ok(String(alertasB[0]?.corpo.text).includes("Motivo provável: erro na API da Meta.") && String(alertasB[0]?.corpo.text).includes("Os atendimentos afetados foram para o grupo."),
  "texto com o motivo provável (erro na API da Meta)");
ok(paraGrupo().filter((c) => String(c.corpo.text).startsWith(ALERTA)).length === grupo0 && !alertasB.some((c) => [VEND.id, ADMIN_SEM_START.id, BOT_ADMIN.id].includes(c.corpo.chat_id)),
  "nenhum alerta no grupo, nem para membro comum, admin sem /start ou bot");
ok(!alertasB.some((c) => /5591|Cliente Teste|ATD-/.test(String(c.corpo.text))), "nenhum dado de cliente no alerta");

out("\n== Erro 190, intervalo de 30 min e \"voltaram ao normal\" ==");
alerta.redefinirAlertaEnvioParaTestes();
const alertas1 = privadosCom(ALERTA).length;
modoGraph = "token";
await mensagem(TEL(7), "oi");
const alertaToken = privadosCom(ALERTA).slice(alertas1);
ok(alertaToken.length === 2 && String(alertaToken[0]!.corpo.text).includes("Motivo provável: token da Meta expirado ou inválido."), "erro 190: alerta imediato com o motivo \"token\"");
modoGraph = "recusa";
desloc += 5 * 60_000;
for (const n of [8, 9, 10]) await mensagem(TEL(n), "oi");
ok(privadosCom(ALERTA).length === alertas1 + 2 && logs.some((l) => l.includes("alerta geral já enviado há menos de 30 min")), "mais 3 falhas em 5 min: o alerta não se repete antes de 30 min");
modoGraph = "aceita";
const normal0 = privadosCom(NORMAL).length;
await mensagem(TEL(11), "oi");
const normais = privadosCom(NORMAL).slice(normal0);
ok(destinos(normais) === [ADMIN1.id, CRIADOR.id].sort().join(","), "primeiro envio aceito depois do alerta: \"voltaram ao normal\" aos mesmos admins");
await mensagem(TEL(12), "oi");
ok(privadosCom(NORMAL).length === normal0 + 2, "o \"voltaram ao normal\" sai uma vez só");
desloc += 31 * 60_000;
modoGraph = "recusa";
for (const n of [13, 14, 15]) await mensagem(TEL(n), "oi");
modoGraph = "aceita";
ok(privadosCom(ALERTA).length === alertas1 + 4, "depois de 30 min, novas 3 falhas seguidas alertam de novo");

out("\n== Nenhum administrador alcançável / Telegram fora ==");
alerta.redefinirAlertaEnvioParaTestes();
administradores = [ADMIN_SEM_START, BOT_ADMIN];
const total0 = privadosCom(ALERTA).length, grupo1 = paraGrupo().length;
modoGraph = "token";
await mensagem(TEL(16), "oi");
ok(privadosCom(ALERTA).length === total0 && logs.some((l) => l.includes("[Alerta] ATENÇÃO: nenhum administrador alcançável")),
  "nenhum admin registrado: só log em destaque");
ok(paraGrupo().length === grupo1 + 1 && !paraGrupo().slice(grupo1).some((c) => String(c.corpo.text).startsWith(ALERTA)), "nada de alerta no grupo (só o resumo do atendimento)");
alerta.redefinirAlertaEnvioParaTestes();
administradores = [ADMIN1, CRIADOR];
telegramFora = true;
await mensagem(TEL(17), "oi");
telegramFora = false;
modoGraph = "aceita";
ok(privadosCom(ALERTA).length === total0 && logs.some((l) => l.includes("[Alerta] ATENÇÃO: administradores do grupo não consultados")), "Telegram fora: só log");

out("\n== Loja fechada falhando: sem atendimento, conta para o alerta ==");
alerta.redefinirAlertaEnvioParaTestes();
const alertas2 = privadosCom(ALERTA).length;
desloc += 12 * 60 * 60_000; // 22:00 e pouco em Belém
modoGraph = "recusa";
for (const n of [18, 19, 20]) await mensagem(TEL(n), "oi");
modoGraph = "aceita";
const atdFechada = Number((await banco.consultar("SELECT count(*) n FROM atendimentos WHERE chat_id = ANY($1::varchar[])", [[18, 19, 20].map((n) => chat(TEL(n)))])).rows[0].n);
ok(atdFechada === 0 && [18, 19, 20].every((n) => webhook.lerEstadoEspelhavel(chat(TEL(n))) === null), "nenhum atendimento criado (nem memória nem banco)");
ok(privadosCom(ALERTA).length === alertas2 + 2, "3 avisos de loja fechada falhando: alerta geral aos admins");
desloc -= 12 * 60 * 60_000;

ok(externas.length === 0, `nenhuma chamada de rede externa (${externas.length})`);
const senha = process.env.DB_PASSWORD ?? "";
ok(!senha || !logs.some((l) => l.includes(senha)), "nenhum log com a senha do banco");

out("\n== Limpeza ==");
await espera(500);
const ev = (await banco.consultar("DELETE FROM eventos_processados WHERE mensagem_externa_id LIKE 'teste-aviso-%'")).rowCount;
const { limparEspelhoDeTeste } = await import(B + "/tests/limpeza-espelho.mts");
const espelho = await limparEspelhoDeTeste(banco.consultar);
const sobraV = Number((await banco.consultar("SELECT count(*) n FROM vendedores WHERE telegram_user_id BETWEEN 990000000000 AND 990000999999")).rows[0].n);
ok(espelho.restantes === 0 && sobraV === 0,
  `apagados: ${ev} eventos, ${espelho.atendimentos} atendimentos, ${espelho.clientes} clientes, ${espelho.vendedores} vendedores; restantes = ${espelho.restantes + sobraV}`);
await banco.encerrarBanco();

out(falhas ? `\n${total} verificações | ${falhas} FALHA(S)` : `\n${total} verificações | TODOS OS TESTES PASSARAM`);
await new Promise((r) => setTimeout(r, 300));
process.exit(falhas ? 1 : 0);
