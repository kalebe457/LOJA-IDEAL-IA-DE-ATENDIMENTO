// Logs sem dados pessoais: os fluxos principais rodam com dados "canário" fictícios e únicos
// (telefones, nome do cliente, marcador de texto, user_id e nomes de vendedores, phone_number_id),
// TODA a saída do processo (stdout e stderr) é capturada, e nenhum canário pode aparecer.
// Banco de testes, Meta/Telegram/Claude simulados, rede externa bloqueada.
// Banco de TESTES (loja_ideal_teste) fixado antes de qualquer import de src/; loja_ideal é dado real.
const { exigirBancoDeTeste } = await import(new URL("./banco-teste.mts", import.meta.url).href);
import { createHmac } from "node:crypto";

Object.assign(process.env, {
  PORT: "39884",
  META_APP_SECRET: "meta-secret-teste",
  META_ENVIO_ATIVO: "true",
  META_ACCESS_TOKEN: "meta-token-falso",
  META_PHONE_NUMBER_ID: "999",
  META_GRAPH_VERSION: "v26.0",
  TELEGRAM_BOT_TOKEN: "123456:TOKEN-FALSO",
  TELEGRAM_CHAT_ID: "-1009999999999",
  TELEGRAM_WEBHOOK_SECRET: "segredo-teste-logs",
  TELEGRAM_RESUMO_TTL_HORAS: "72",
  ANTHROPIC_API_KEY: "anthropic-falso",
});
const BASE = "http://127.0.0.1:39884";
const GRUPO = -1009999999999;

// ---- Canários (fictícios e únicos) ----
const MARCA = "CANARIO-7Q3";
const NOME_CLIENTE = "Zebedeu";
const TEL = { triagem: "5591966613579", fechada: "5591966624680", recusa: "5591966635791", claude: "5591966646802", banco: "5591966657913", dm: "5591966668024",
  recusa2: "5591966679135", recusa3: "5591966680246", sucesso: "5591966602468", fechadaFalha: "5591966691357" };
const VEND = { id: 990_000_000_777, nome: "Vendedor CANARIOVEND" };
const ADMIN = { id: 990_000_000_778, nome: "Admin CANARIOADM" };
const MEMBRO = { id: 990_000_000_779, nome: "Membro CANARIOMEM" };
const REDE = { id: 990_000_000_780, nome: "Rede CANARIOREDE" };
const PHONE_ID_CANARIO = "123456789098765";
const CANARIOS = [MARCA, NOME_CLIENTE, ...Object.values(TEL), ...[VEND, ADMIN, MEMBRO, REDE].flatMap((v) => [String(v.id), v.nome]), PHONE_ID_CANARIO];

// ---- Captura de TODA a saída; o resultado do teste sai pelo write original ----
const saida: string[] = [];
const escreverOut = process.stdout.write.bind(process.stdout);
const capturar = (pedaco: unknown) => { saida.push(typeof pedaco === "string" ? pedaco : Buffer.from(pedaco as Uint8Array).toString("utf8")); return true; };
(process.stdout as any).write = capturar;
(process.stderr as any).write = capturar;
const out = (texto: string) => escreverOut(texto + "\n");
let falhas = 0, total = 0;
const ok = (c: boolean, t: string) => { total++; if (!c) falhas++; out(`${c ? "OK  " : "FAIL"} ${t}`); };
const tudo = () => saida.join("");

// Relógio controlado: quarta 07/10/2026 10:00 em Belém (loja aberta).
const agoraReal = Date.now.bind(Date);
let desloc = Date.parse("2026-10-07T10:00:00-03:00") - agoraReal();
Date.now = () => agoraReal() + desloc;

// ---- Graph API e Bot API simuladas ----
let modoGraph: "aceita" | "recusa-eco" = "aceita";
let resp = 0;
const telegram: { metodo: string; corpo: any }[] = [];
const statusPorUsuario = new Map<number, string>([[ADMIN.id, "administrator"]]);
const falharDMComEco = new Set<number>();
let msgId = 6000;
const externas: string[] = [];
const fetchReal = globalThis.fetch;
(globalThis as any).fetch = async (url: any, init: any) => {
  const u = new URL(String(url));
  if (u.hostname === "127.0.0.1") return fetchReal(url, init);
  if (u.hostname === "graph.facebook.com") {
    const enviado = JSON.parse(init.body);
    if (modoGraph === "recusa-eco") {
      // Corpo de erro que ECOA o texto e o destinatário.
      return new Response(JSON.stringify({ error: { message: `(#100) Invalid parameter: ${enviado.text.body} to ${enviado.to} ${MARCA}`,
        type: `OAuthException ${MARCA}`, code: 100, error_subcode: `${MARCA}`, error_data: { details: `${MARCA} ${enviado.to}` }, fbtrace_id: `Abc ${MARCA}` } }),
        { status: 400, headers: { "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify({ messaging_product: "whatsapp", messages: [{ id: `wamid.teste-logs-resp-${++resp}` }] }), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  const m = /^\/bot[^/]+\/(\w+)$/.exec(u.pathname);
  if (u.hostname === "api.telegram.org" && m) {
    const corpo = JSON.parse(init.body);
    telegram.push({ metodo: m[1]!, corpo });
    const r = (o: any) => ({ status: o.ok ? 200 : 400, json: async () => o });
    if (m[1] === "getChatAdministrators") {
      return r({ ok: true, result: [{ status: "administrator", user: { id: ADMIN.id, is_bot: false, first_name: ADMIN.nome } }] });
    }
    if (m[1] === "getChatMember") {
      const s = statusPorUsuario.get(corpo.user_id) ?? "member";
      if (s === "REDE") throw Object.assign(new Error(`connect ECONNRESET ${MARCA} ${REDE.nome}`), { cause: { code: "ECONNRESET" } });
      return r({ ok: true, result: { status: s } });
    }
    if (m[1] === "sendMessage" && falharDMComEco.has(corpo.chat_id)) {
      return r({ ok: false, error_code: 403, description: `Forbidden: ${MARCA} ${String(corpo.text).slice(0, 80)}` });
    }
    if (m[1] === "sendMessage") return r({ ok: true, result: { message_id: msgId++, chat: { id: Number(corpo.chat_id) } } });
    return r({ ok: true, result: true });
  }
  externas.push(u.hostname);
  throw new Error("rede externa bloqueada no teste");
};

// Claude simulado: a resposta ECOA o texto do cliente; "pedido completo" preenche tudo com canários;
// em modo erro, lança com o texto do cliente na mensagem.
const B = new URL("..", import.meta.url).href.replace(/\/$/, "");
const { default: Anthropic } = await import(B + "/node_modules/@anthropic-ai/sdk/index.mjs");
let claudeFalha = false;
(Anthropic as any).Messages.prototype.parse = async function (params: any) {
  const ultimo = String(params.messages.at(-1).content);
  const texto = /Mensagem atual do cliente:\n([^\n]*)/.exec(ultimo)?.[1] ?? "";
  if (claudeFalha) throw new Error(`falhou ao processar "${texto}" de ${NOME_CLIENTE}`);
  const completo = texto.includes("pedido completo");
  return { model: "stub", usage: { input_tokens: 0, output_tokens: 0 }, parsed_output: { resposta: `Entendi: ${texto}`, status: "IA", quantidade_aplicavel: true,
    resumo: completo
      ? { nome: `${NOME_CLIENTE} ${MARCA}`, produto: `Cimento ${MARCA}`, quantidade: "10 sacos", observacoes: `Obs ${MARCA}` }
      : { nome: "Não informado", produto: "Não informado", quantidade: "Não informado", observacoes: "Não informado" } } };
};

const webhook = await import(B + "/src/webhook.ts");
const banco = await import(B + "/src/banco.ts");
await exigirBancoDeTeste(banco.consultar);
const T = await import(B + "/src/telegramBot.ts");
const alerta = await import(B + "/src/alertaEnvio.ts");
await webhook.iniciarWebhook();

const espera = (ms = 600) => new Promise((r) => setTimeout(r, ms));
let seq = 0;
async function postarMeta(corpo: string) {
  const sig = "sha256=" + createHmac("sha256", "meta-secret-teste").update(corpo).digest("hex");
  return fetchReal(BASE + "/meta/webhook", { method: "POST", headers: { "Content-Type": "application/json", "X-Hub-Signature-256": sig }, body: corpo });
}
async function mensagem(tel: string, texto: string) {
  await postarMeta(JSON.stringify({ object: "whatsapp_business_account", entry: [{ id: "1", changes: [{ field: "messages", value: {
    messaging_product: "whatsapp", metadata: { phone_number_id: "999" },
    messages: [{ id: `teste-logs-${++seq}`, from: tel, timestamp: String(Math.floor(Date.now() / 1000)), type: "text", text: { body: texto } }] } }] }] }));
  await espera();
}
let upd = 1;
const tg = async (u: unknown) => { await fetchReal(BASE + "/telegram/webhook", { method: "POST",
  headers: { "Content-Type": "application/json", "X-Telegram-Bot-Api-Secret-Token": "segredo-teste-logs" }, body: JSON.stringify(u) }); await espera(); };
const privado = (v: { id: number; nome: string }, texto: string) =>
  tg({ update_id: upd++, message: { message_id: 1, chat: { id: v.id, type: "private" }, from: { id: v.id, first_name: v.nome }, text: texto } });
const clique = (v: { id: number; nome: string }, codigo: string, msg: number) =>
  tg({ update_id: upd++, callback_query: { id: `cb-logs-${upd}`, from: { id: v.id, first_name: v.nome }, data: `assumir:${codigo}`, message: { message_id: msg, chat: { id: GRUPO, type: "supergroup" } } } });
const resumoDo = (codigo: string) => [...telegram].reverse().find((c) => c.metodo === "sendMessage" && String(c.corpo.chat_id) === String(GRUPO)
  && c.corpo.reply_markup?.inline_keyboard?.[0]?.[0]?.callback_data === `assumir:${codigo}`);
const codigoDe = (tel: string) => webhook.lerEstadoEspelhavel(`meta:999:${tel}`)?.codigo ?? "";
const pool = banco.obterPool();
const connectOriginal = pool.connect.bind(pool);

out("== Fluxos ==");
// 1. Triagem completa + resumo.
for (const t of [`oi ${MARCA}`, `${NOME_CLIENTE} ${MARCA}`, `cimento ${MARCA}`, "10 sacos", `entregar ${MARCA}`]) await mensagem(TEL.triagem, t);
const cod1 = codigoDe(TEL.triagem);
const resumo1 = resumoDo(cod1);
ok(!!resumo1 && String(resumo1.corpo.text).includes(NOME_CLIENTE), "triagem completa e resumo publicado (o resumo do grupo tem os dados; o log não)");

// 2. /start, assunção e DM.
await privado(VEND, "/start");
await clique(VEND, cod1, msgId - 2);
const msgResumo1 = telegram.findIndex((c) => c === resumo1);
void msgResumo1;
ok(telegram.some((c) => c.metodo === "sendMessage" && c.corpo.chat_id === VEND.id && String(c.corpo.text).includes(TEL.triagem)), "/start, assunção e DM com o telefone (só na DM)");

// 3. DM falhando com description que ecoa o texto.
await mensagem(TEL.dm, `pedido completo ${MARCA}`);
const codDm = codigoDe(TEL.dm);
falharDMComEco.add(VEND.id);
await clique(VEND, codDm, msgId - 1);
falharDMComEco.delete(VEND.id);
ok(tudo().includes(`DM de ${codDm} NÃO enviada`), "DM recusada pelo Telegram com description que ecoa o texto");

// 4. /ranking com sucesso e negado; /start com falha de rede (mensagem com canário).
await privado(ADMIN, "/ranking");
await privado(MEMBRO, "/ranking");
statusPorUsuario.set(REDE.id, "REDE");
await privado(REDE, "/start");
ok(tudo().includes("[Telegram] /ranking respondido") && tudo().includes("[Telegram] /ranking negado") && tudo().includes("getChatMember falhou | rede: ECONNRESET"),
  "/ranking com sucesso e negado; getChatMember com erro de rede");

// 5. Loja fechada.
desloc += 12 * 60 * 60_000;
await mensagem(TEL.fechada, `oi ${MARCA}`);
desloc -= 12 * 60 * 60_000;
ok(tudo().includes("Loja fechada: aviso enviado"), "loja fechada");

// 6. Meta recusando com corpo de erro que ecoa o texto e o destinatário.
modoGraph = "recusa-eco";
await mensagem(TEL.recusa, `oi ${MARCA}`);
modoGraph = "aceita";
ok(tudo().includes("HTTP 400 | code: 100 | subcode: - | type: - | fbtrace_id: -"), "Meta recusando (corpo de erro com eco): só campos técnicos saneados");

// 6b. Aviso de falha de envio: mais 2 falhas (3 seguidas) → alerta aos admins; depois um envio
//     aceito → "voltaram ao normal"; e o aviso de loja fechada falhando (conta para o alerta).
await privado(ADMIN, "/start");
modoGraph = "recusa-eco";
await mensagem(TEL.recusa2, `oi ${MARCA}`);
await mensagem(TEL.recusa3, `oi ${MARCA}`);
await alerta.aguardarAlertasParaTestes();
modoGraph = "aceita";
await mensagem(TEL.sucesso, `oi ${MARCA}`);
await alerta.aguardarAlertasParaTestes();
desloc += 12 * 60 * 60_000;
modoGraph = "recusa-eco";
await mensagem(TEL.fechadaFalha, `oi ${MARCA}`);
modoGraph = "aceita";
desloc -= 12 * 60 * 60_000;
await alerta.aguardarAlertasParaTestes();
const resumoAviso = resumoDo(codigoDe(TEL.recusa2));
ok(String(resumoAviso?.corpo.text ?? "").startsWith("⚠️ A IA não conseguiu responder") &&
   telegram.some((c) => c.metodo === "sendMessage" && c.corpo.chat_id === ADMIN.id && String(c.corpo.text).startsWith("⚠️ A IA não está conseguindo")) &&
   telegram.some((c) => c.metodo === "sendMessage" && c.corpo.chat_id === ADMIN.id && String(c.corpo.text).startsWith("✅ Os envios")) &&
   tudo().includes("[Alerta] ATENÇÃO: alerta geral de envio") && tudo().includes("Loja fechada: aviso não entregue"),
  "aviso no grupo, alerta geral aos admins, \"voltaram ao normal\" e loja fechada falhando");

// 7. Claude lançando erro com o texto na mensagem.
claudeFalha = true;
await mensagem(TEL.claude, `oi ${MARCA}`);
claudeFalha = false;
ok(tudo().includes("Falha na IA (") && tudo().includes("): Error"), "Claude lançando erro: só a classe do erro no log");

// 8. Banco falhando com o dado na mensagem do erro.
(pool as any).connect = (...a: unknown[]) => (a.length === 0
  ? Promise.reject(Object.assign(new Error(`invalid input syntax for type bigint: "${MARCA} ${TEL.banco}"`), { code: "22P02" }))
  : (connectOriginal as any)(...a));
await mensagem(TEL.banco, `oi ${MARCA}`);
(pool as any).connect = connectOriginal;
ok(tudo().includes("(22P02)"), "banco falhando: só o código do erro");

// 9. Notificação de status da Meta com phone_number_id e title canários.
await postarMeta(JSON.stringify({ object: "whatsapp_business_account", entry: [{ id: "1", changes: [{ field: "messages", value: {
  messaging_product: "whatsapp", metadata: { phone_number_id: PHONE_ID_CANARIO },
  statuses: [{ id: "wamid.teste-logs-status", status: "failed", errors: [{ code: 131026, title: `Undeliverable ${MARCA} ${NOME_CLIENTE}` }] }] } }] }] }));
await espera();
ok(tudo().includes("Status Meta recebido.") && tudo().includes("erro code: 131026"), "status da Meta: código do erro e phone_number_id mascarado");

// 10. Recuperação na partida (lê do banco os dados com canários).
webhook.redefinirEstadoWebhookParaTestes();
const rec = await webhook.recuperarNaPartida();
if (rec.ok) await T.reenviarPendenciasRecuperadas(rec.resumosNaoPublicados);
await espera();
ok(rec.ok && tudo().includes("[Recuperação] concluída"), "recuperação na partida");

out("\n== Nenhum canário na saída ==");
const texto = tudo();
for (const c of CANARIOS) ok(!texto.includes(c), `"${c.length > 12 ? c.slice(0, 4) + "…" : c}" ausente (${saida.length} escritas capturadas)`);
ok(texto.includes("5591****3579") && texto.includes("9900****0777") && texto.includes("1234****8765"), "telefone, user_id e phone_number_id aparecem só mascarados");
ok(externas.length === 0, `nenhuma chamada de rede externa (${externas.length})`);

out("\n== Limpeza ==");
await espera(500);
const ev = (await banco.consultar("DELETE FROM eventos_processados WHERE mensagem_externa_id LIKE 'teste-logs-%'")).rowCount;
const { limparEspelhoDeTeste } = await import(B + "/tests/limpeza-espelho.mts");
const espelho = await limparEspelhoDeTeste(banco.consultar);
ok(espelho.restantes === 0, `apagados: ${ev} eventos, ${espelho.atendimentos} atendimentos, ${espelho.clientes} clientes, ${espelho.vendedores} vendedores`);
await banco.encerrarBanco();

out(falhas ? `\n${total} verificações | ${falhas} FALHA(S)` : `\n${total} verificações | TODOS OS TESTES PASSARAM`);
if (falhas) {
  // Para diagnóstico: só as linhas da saída que contêm algum canário, com o canário trocado.
  for (const linha of tudo().split("\n").filter((l) => CANARIOS.some((c) => l.includes(c)))) {
    out("  vazou: " + CANARIOS.reduce((l, c) => l.split(c).join("<CANÁRIO>"), linha).slice(0, 220));
  }
}
await new Promise((r) => setTimeout(r, 300));
process.exit(falhas ? 1 : 0);
