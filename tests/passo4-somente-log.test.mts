// Passo 4: META_ENVIO_ATIVO=false — triagem completa sem enviar ao WhatsApp, sem desfazer etapas,
// com resumo no Telegram. Servidor real + banco real (IDs "teste-dedup-log-"); Claude e Telegram simulados.
import { createHmac } from "node:crypto";

Object.assign(process.env, {
  PORT: "39878", META_APP_SECRET: "meta-secret-teste", META_ENVIO_ATIVO: "false", META_ACCESS_TOKEN: "meta-token-falso",
  META_PHONE_NUMBER_ID: "999", META_GRAPH_VERSION: "v26.0",
  TELEGRAM_BOT_TOKEN: "123456:TOKEN-FALSO", TELEGRAM_CHAT_ID: "-1009999999999", TELEGRAM_WEBHOOK_SECRET: "segredo-teste",
  ANTHROPIC_API_KEY: "anthropic-falso",
});
const BASE = "http://127.0.0.1:39878";
const agoraReal = Date.now.bind(Date);
const desloc = Date.parse("2026-10-07T10:00:00-03:00") - agoraReal();
Date.now = () => agoraReal() + desloc;

const fetchReal = globalThis.fetch;
const telegram: { metodo: string; corpo: any }[] = [];
const outras: string[] = [];
(globalThis as any).fetch = async (url: any, init: any) => {
  const u = new URL(String(url));
  if (u.hostname === "127.0.0.1") return fetchReal(url, init);
  const m = /^\/bot[^/]+\/(\w+)$/.exec(u.pathname);
  if (u.hostname === "api.telegram.org" && m) {
    const corpo = JSON.parse(init.body);
    telegram.push({ metodo: m[1]!, corpo });
    return { status: 200, json: async () => ({ ok: true, result: m[1] === "sendMessage" ? { message_id: 1 } : true }) } as any;
  }
  outras.push(u.hostname); // graph.facebook.com aqui seria envio indevido
  throw new Error("rede externa bloqueada no teste");
};

const B = new URL("..", import.meta.url).href.replace(/\/$/, "");
const { default: Anthropic } = await import(B + "/node_modules/@anthropic-ai/sdk/index.mjs");
// O tamanho do histórico enviado ao Claude em cada chamada mostra se algo foi revertido.
const historicoPorChamada: number[] = [];
(Anthropic as any).Messages.prototype.parse = async function (params: any) {
  historicoPorChamada.push(params.messages.length);
  return { model: "stub", usage: { input_tokens: 0, output_tokens: 0 }, parsed_output: { resposta: "", status: "IA", quantidade_aplicavel: true,
    resumo: { nome: "Não informado", produto: "Não informado", quantidade: "Não informado", observacoes: "Não informado" } } };
};
const logs: string[] = [];
const out = console.log.bind(console);
for (const k of ["log", "warn", "error"] as const) console[k] = (...a: unknown[]) => { logs.push(a.join(" ")); };

const { iniciarWebhook } = await import(B + "/src/webhook.ts");
const banco = await import(B + "/src/banco.ts");
iniciarWebhook();
await new Promise((r) => setTimeout(r, 400));

let falhas = 0, total = 0;
const ok = (c: boolean, t: string) => { total++; if (!c) falhas++; out(`${c ? "OK  " : "FAIL"} ${t}`); };
let seq = 0;
async function cliente(texto: string) {
  const corpo = JSON.stringify({ object: "whatsapp_business_account", entry: [{ id: "1", changes: [{ field: "messages", value: {
    messaging_product: "whatsapp", metadata: { phone_number_id: "999" },
    messages: [{ id: `teste-dedup-log-${++seq}`, from: "5591900000030", timestamp: String(Math.floor(Date.now() / 1000)), type: "text", text: { body: texto } }] } }] }] });
  const sig = "sha256=" + createHmac("sha256", "meta-secret-teste").update(corpo).digest("hex");
  const r = await fetchReal(BASE + "/meta/webhook", { method: "POST", headers: { "Content-Type": "application/json", "X-Hub-Signature-256": sig }, body: corpo });
  await new Promise((res) => setTimeout(res, 400));
  return r.status;
}
const naoEnviadas = () => logs.filter((l) => l.includes("[Meta] resposta não enviada (META_ENVIO_ATIVO=false)")).length;

out("== Triagem completa com META_ENVIO_ATIVO=false ==");
const passos: [string, string][] = [
  ["oi", "pergunta o nome"],
  ["Ana", "nome → pergunta o produto"],
  ["cimento CP-II", "produto → pergunta a quantidade"],
  ["10 sacos", "quantidade → pergunta as observações"],
  ["não", "observações → encaminha para humano"],
];
for (let i = 0; i < passos.length; i++) {
  const st = await cliente(passos[i]![0]);
  ok(st === 200 && naoEnviadas() === i + 1, `mensagem ${i + 1} ("${passos[i]![0]}"): HTTP ${st}; ${passos[i]![1]}; resposta só no log (${naoEnviadas()})`);
}
ok(historicoPorChamada.join(",") === "1,3,5,7,9", `histórico do Claude só cresce (1,3,5,7,9 = nada revertido): ${historicoPorChamada.join(",")}`);
ok(!logs.some((l) => l.includes("resposta não entregue desfeita")) && !logs.some((l) => l.includes("não recebeu a resposta")),
  "nenhuma etapa desfeita e nenhum 'cliente não recebeu' (false do envio não é falha nesse modo)");
ok(logs.some((l) => l.includes("Status: HUMANO")) && logs.some((l) => l.includes("Atendimento transferido para humano")), "triagem chegou ao fim (HUMANO)");
const resumo = telegram.find((t) => t.metodo === "sendMessage" && t.corpo.chat_id === "-1009999999999");
ok(!!resumo && /Nome: Ana/.test(resumo.corpo.text) && /Produto: cimento CP-II/.test(resumo.corpo.text) && /Quantidade: 10 sacos/.test(resumo.corpo.text) && /Observações: Nenhuma observação adicional/.test(resumo.corpo.text),
  "resumo enviado ao Telegram com nome, produto, quantidade e observações");
ok(outras.length === 0, `nada enviado ao WhatsApp/Graph API nem a outro destino: ${outras.length}`);

const apagados = (await banco.consultar("DELETE FROM eventos_processados WHERE mensagem_externa_id LIKE 'teste-dedup-log-%'")).rowCount;
const restantes = Number((await banco.consultar("SELECT count(*) n FROM eventos_processados WHERE mensagem_externa_id LIKE 'teste-dedup-%'")).rows[0].n);
ok(apagados === 5 && restantes === 0, `limpeza: ${apagados} registros apagados; teste-dedup restantes = ${restantes}`);
await banco.encerrarBanco();
out(falhas ? `\n${total} verificações | ${falhas} FALHA(S)` : `\n${total} verificações | TODOS OS TESTES PASSARAM`);
await new Promise((r) => setTimeout(r, 300));
process.exit(falhas ? 1 : 0);
