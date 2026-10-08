import { createHmac } from "node:crypto";

// Tudo falso e local: nenhuma chamada real a Meta, Telegram ou Anthropic.
Object.assign(process.env, {
  PORT: "39871",
  META_APP_SECRET: "meta-secret-teste",
  META_VERIFY_TOKEN: "verify-teste",
  META_ENVIO_ATIVO: "false",
  META_ACCESS_TOKEN: "meta-token-falso",
  TELEGRAM_BOT_TOKEN: "123456:TOKEN-FALSO",
  TELEGRAM_CHAT_ID: "-1009999999999",
  TELEGRAM_WEBHOOK_SECRET: "segredo-teste",
  ANTHROPIC_API_KEY: "anthropic-falso",
});
const BASE = "http://127.0.0.1:39871";

// Relógio: quarta 07/10/2026 10:00 em Belém (loja aberta).
const agoraReal = Date.now.bind(Date);
const deslocamento = Date.parse("2026-10-07T10:00:00-03:00") - agoraReal();
Date.now = () => agoraReal() + deslocamento;

// fetch: localhost passa; Telegram é simulado; qualquer outra coisa é registrada e falha.
const fetchReal = globalThis.fetch;
const telegram: { metodo: string; corpo: any }[] = [];
const externas: string[] = [];
let msgId = 500;
(globalThis as any).fetch = async (url: any, init: any) => {
  const u = String(url);
  if (u.startsWith("http://127.0.0.1")) return fetchReal(url, init);
  const m = /^https:\/\/api\.telegram\.org\/bot[^/]+\/(\w+)$/.exec(u);
  if (m) {
    const corpo = JSON.parse(init.body);
    const id = msgId++;
    telegram.push({ metodo: m[1], corpo, id } as any);
    // Passo 2: o vendedor deste teste está no grupo.
    const r = m[1] === "getChatMember" ? { ok: true, result: { status: "member" } }
      : m[1] === "sendMessage" ? { ok: true, result: { message_id: id, chat: { id: corpo.chat_id } } } : { ok: true, result: true };
    return { status: 200, json: async () => r } as any;
  }
  externas.push(u);
  throw new Error("rede bloqueada no teste");
};

const B = new URL("..", import.meta.url).href.replace(/\/$/, "");
const { default: Anthropic } = await import(B + "/node_modules/@anthropic-ai/sdk/index.mjs");
let chamadasClaude = 0;
(Anthropic as any).Messages.prototype.parse = async function () {
  chamadasClaude++;
  return { model: "stub", usage: { input_tokens: 0, output_tokens: 0 }, parsed_output: { resposta: "", status: "IA", quantidade_aplicavel: true,
    resumo: { nome: "João", produto: "Cimento CP-II", quantidade: "10 sacos", observacoes: "Nenhuma observação adicional." } } };
};

const logReal = console.log;
console.log = () => {};
console.error = () => {};
const { iniciarWebhook } = await import(B + "/src/webhook.ts");
iniciarWebhook();
await new Promise((r) => setTimeout(r, 300));

let falhas = 0;
const ok = (c: boolean, t: string) => { if (!c) falhas++; logReal(`${c ? "OK  " : "FAIL"} ${t}`); };
const espera = (ms = 300) => new Promise((r) => setTimeout(r, ms));

async function mensagemMeta(texto: string, wamid: string) {
  const corpo = JSON.stringify({ object: "whatsapp_business_account", entry: [{ id: "1", changes: [{ field: "messages", value: {
    messaging_product: "whatsapp", metadata: { phone_number_id: "999" },
    messages: [{ id: wamid, from: "5591988887777", timestamp: String(Math.floor(Date.now() / 1000)), type: "text", text: { body: texto } }] } }] }] });
  const assinatura = "sha256=" + createHmac("sha256", "meta-secret-teste").update(corpo).digest("hex");
  return fetchReal(BASE + "/meta/webhook", { method: "POST", headers: { "Content-Type": "application/json", "X-Hub-Signature-256": assinatura }, body: corpo });
}
const updateTelegram = (update: any, segredo = "segredo-teste") =>
  fetchReal(BASE + "/telegram/webhook", { method: "POST", headers: { "Content-Type": "application/json", "X-Telegram-Bot-Api-Secret-Token": segredo }, body: JSON.stringify(update) });

logReal("== Rota POST /telegram/webhook ==");
ok((await updateTelegram({ update_id: 1 }, "errado")).status === 401, "segredo errado → 401");
ok((await fetchReal(BASE + "/telegram/webhook", { method: "POST", body: "{}" })).status === 401, "sem header de segredo → 401");
ok((await fetchReal(BASE + "/telegram/webhook")).status === 405, "GET → 405");
ok((await fetchReal(BASE + "/telegram/webhook", { method: "POST", headers: { "X-Telegram-Bot-Api-Secret-Token": "segredo-teste" }, body: "não é json" })).status === 400, "JSON inválido → 400");
const r200 = await updateTelegram({ update_id: 2, message: { message_id: 1, chat: { id: 111, type: "private" }, from: { id: 111, first_name: "Carlos" }, text: "/start" } });
ok(r200.status === 200, "/start válido → 200");
await espera();
ok(telegram.some((c) => c.metodo === "sendMessage" && c.corpo.chat_id === 111), "vendedor Carlos registrado pelo /start via rota");

logReal("\n== Triagem completa → resumo no Telegram ==");
ok((await mensagemMeta("Sou João, quero 10 sacos de cimento CP-II, sem observações", "teste-dedup-e2e-A1")).status === 200, "mensagem do cliente aceita pela rota da Meta");
await espera(800);
const resumoGrupo = telegram.filter((c) => c.metodo === "sendMessage" && c.corpo.chat_id === "-1009999999999");
ok(resumoGrupo.length === 1 && resumoGrupo[0]!.corpo.text.startsWith("📋 NOVO ATENDIMENTO"), "um resumo enviado ao grupo do Telegram");
const callbackData: string = resumoGrupo[0]?.corpo.reply_markup.inline_keyboard[0][0].callback_data;

logReal("\n== Vendedor assume pelo webhook ==");
await updateTelegram({ update_id: 3, callback_query: { id: "cb1", from: { id: 111, first_name: "Carlos" }, data: callbackData,
  message: { message_id: (resumoGrupo[0] as any)?.id, chat: { id: -1009999999999, type: "supergroup" } } } });
await espera(500);
ok(telegram.some((c) => c.metodo === "sendMessage" && c.corpo.chat_id === 111 && c.corpo.reply_markup?.inline_keyboard[0][0].url === "https://wa.me/5591988887777"), "DM com wa.me enviada ao vencedor");
ok(telegram.some((c) => c.metodo === "editMessageText" && c.corpo.text.includes("Vendedor: Carlos")), "mensagem do grupo editada para ASSUMIDO");

logReal("\n== 17. Atendimento HUMANO impede nova resposta da IA ==");
const antes = chamadasClaude;
await mensagemMeta("Oi, alguém aí?", "teste-dedup-e2e-A2");
await espera(500);
ok(chamadasClaude === antes, `Claude não foi chamado depois de assumido (chamadas: ${antes} → ${chamadasClaude})`);
ok(telegram.filter((c) => c.metodo === "sendMessage" && c.corpo.chat_id === "-1009999999999").length === 1, "nenhum segundo resumo no grupo");

ok(externas.length === 0, `nenhuma chamada de rede fora do mock (${externas.length})`);
{ const bancoE2E = await import(B + "/src/banco.ts"); const apagados = (await bancoE2E.consultar("DELETE FROM eventos_processados WHERE mensagem_externa_id LIKE 'teste-dedup-e2e-%'")).rowCount; logReal(`limpeza: ${apagados} registro(s) teste-dedup-e2e- apagados`);
  const { limparEspelhoDeTeste } = await import(B + "/tests/limpeza-espelho.mts");
  const espelho = await limparEspelhoDeTeste(bancoE2E.consultar);
  ok(espelho.restantes === 0, `espelho: ${espelho.atendimentos} atendimento(s) e ${espelho.clientes} cliente(s) de teste apagados; restantes = ${espelho.restantes}`);
  await bancoE2E.encerrarBanco(); }
logReal(falhas ? `\n${falhas} FALHA(S)` : "\nTODOS OS TESTES PASSARAM");
process.exit(falhas ? 1 : 0);
