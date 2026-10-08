// Passo 3: ordem das mensagens do MESMO POST da Meta. Servidor real + banco real, IDs "teste-dedup-".
import { createHmac } from "node:crypto";

Object.assign(process.env, {
  PORT: "39876", META_APP_SECRET: "meta-secret-teste", META_ENVIO_ATIVO: "false", META_ACCESS_TOKEN: "meta-token-falso",
  TELEGRAM_BOT_TOKEN: "", TELEGRAM_CHAT_ID: "", ANTHROPIC_API_KEY: "anthropic-falso",
});
const BASE = "http://127.0.0.1:39876";
const agoraReal = Date.now.bind(Date);
const desloc = Date.parse("2026-10-07T10:00:00-03:00") - agoraReal();
Date.now = () => agoraReal() + desloc;
const fetchReal = globalThis.fetch;
(globalThis as any).fetch = async (url: any, init: any) => {
  if (String(url).startsWith("http://127.0.0.1")) return fetchReal(url, init);
  throw new Error("rede externa bloqueada no teste");
};

const B = new URL("..", import.meta.url).href.replace(/\/$/, "");
const { default: Anthropic } = await import(B + "/node_modules/@anthropic-ai/sdk/index.mjs");
// Linha do tempo observável: início e fim de cada chamada ao Claude, com o texto da mensagem.
const linhaDoTempo: string[] = [];
(Anthropic as any).Messages.prototype.parse = async function (params: any) {
  const ultimo = String(params.messages.at(-1).content);
  const texto = /Mensagem atual do cliente:\n(.*)\n/.exec(ultimo)?.[1] ?? "?";
  linhaDoTempo.push(`início ${texto}`);
  // A PRIMEIRA mensagem demora; se a ordem não fosse preservada, a segunda terminaria antes.
  await new Promise((r) => setTimeout(r, texto === "primeira" ? 600 : 0));
  linhaDoTempo.push(`fim ${texto}`);
  return { model: "stub", usage: { input_tokens: 0, output_tokens: 0 }, parsed_output: { resposta: "", status: "IA", quantidade_aplicavel: true,
    resumo: { nome: "Não informado", produto: "Não informado", quantidade: "Não informado", observacoes: "Não informado" } } };
};
const out = console.log.bind(console);
for (const n of ["log", "warn", "error"] as const) console[n] = () => {};

const { iniciarWebhook } = await import(B + "/src/webhook.ts");
const banco = await import(B + "/src/banco.ts");
iniciarWebhook();
await new Promise((r) => setTimeout(r, 400));

let falhas = 0, total = 0;
const ok = (c: boolean, t: string) => { total++; if (!c) falhas++; out(`${c ? "OK  " : "FAIL"} ${t}`); };
const seg = String(Math.floor(Date.now() / 1000));
const mensagem = (id: string, texto: string) => ({ id, from: "5591900000099", timestamp: seg, type: "text", text: { body: texto } });

const corpo = JSON.stringify({ object: "whatsapp_business_account", entry: [{ id: "1", changes: [{ field: "messages", value: {
  messaging_product: "whatsapp", metadata: { phone_number_id: "999" },
  messages: [mensagem("teste-dedup-msg-1", "primeira"), mensagem("teste-dedup-msg-2", "segunda")] } }] }] });
const sig = "sha256=" + createHmac("sha256", "meta-secret-teste").update(corpo).digest("hex");

out("== Mesmo cliente, duas mensagens no MESMO POST ==");
const r = await fetchReal(BASE + "/meta/webhook", { method: "POST", headers: { "Content-Type": "application/json", "X-Hub-Signature-256": sig }, body: corpo });
await new Promise((res) => setTimeout(res, 1500));

const ids = (await banco.consultar("SELECT mensagem_externa_id FROM eventos_processados WHERE mensagem_externa_id IN ('teste-dedup-msg-1','teste-dedup-msg-2') ORDER BY id")).rows.map((x: any) => x.mensagem_externa_id);
ok(r.status === 200, `HTTP ${r.status}`);
ok(ids.join(",") === "teste-dedup-msg-1,teste-dedup-msg-2", `registro em eventos_processados na ordem do payload (por id): ${ids.join(" → ")}`);
ok(linhaDoTempo.join(" | ") === "início primeira | fim primeira | início segunda | fim segunda",
  `msg-1 → msg-2 (a segunda só começa depois de a primeira, lenta, terminar): ${linhaDoTempo.join(" | ")}`);

const apagados = (await banco.consultar("DELETE FROM eventos_processados WHERE mensagem_externa_id IN ('teste-dedup-msg-1','teste-dedup-msg-2')")).rowCount;
const restantes = Number((await banco.consultar("SELECT count(*) n FROM eventos_processados WHERE mensagem_externa_id LIKE 'teste-dedup-%'")).rows[0].n);
ok(apagados === 2 && restantes === 0, `limpeza: ${apagados} registros apagados; teste-dedup restantes = ${restantes}`);
await banco.encerrarBanco();
out(falhas ? `\n${total} verificações | ${falhas} FALHA(S)` : `\n${total} verificações | TODOS OS TESTES PASSARAM`);
process.exit(falhas ? 1 : 0);
