// Passo 4: sem WHATSAPP_PROVIDER, o envio ao cliente sai SÓ pela Cloud API (Graph API simulada).
// Servidor real + banco real (loja_ideal), IDs "teste-dedup-p4-".
import { createHmac } from "node:crypto";

delete process.env.WHATSAPP_PROVIDER;
Object.assign(process.env, {
  PORT: "39877", META_APP_SECRET: "meta-secret-teste", META_ENVIO_ATIVO: "true", META_ACCESS_TOKEN: "meta-token-falso",
  // Fictício e igual ao phone_number_id da conversa de teste: enviarTextoMeta recusa ids diferentes.
  META_PHONE_NUMBER_ID: "999", META_GRAPH_VERSION: "v26.0",
  TELEGRAM_BOT_TOKEN: "", TELEGRAM_CHAT_ID: "", ANTHROPIC_API_KEY: "anthropic-falso",
});
const BASE = "http://127.0.0.1:39877";
const agoraReal = Date.now.bind(Date);
const desloc = Date.parse("2026-10-07T10:00:00-03:00") - agoraReal();
Date.now = () => agoraReal() + desloc;

const fetchReal = globalThis.fetch;
const graph: { metodo: string; caminho: string; corpo: any; auth: string }[] = [];
const outras: string[] = [];
let n = 0;
(globalThis as any).fetch = async (url: any, init: any) => {
  const u = new URL(String(url));
  if (u.hostname === "127.0.0.1") return fetchReal(url, init);
  if (u.hostname === "graph.facebook.com") {
    graph.push({ metodo: init?.method ?? "GET", caminho: u.pathname, corpo: init?.body ? JSON.parse(init.body) : null, auth: String(init?.headers?.Authorization ?? init?.headers?.authorization ?? "") });
    return new Response(JSON.stringify({ messaging_product: "whatsapp", contacts: [{ wa_id: "5591900000020" }], messages: [{ id: `wamid.teste-dedup-p4-resp-${++n}` }] }), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  outras.push(u.hostname);
  throw new Error("rede externa bloqueada no teste");
};

const B = new URL("..", import.meta.url).href.replace(/\/$/, "");
const { default: Anthropic } = await import(B + "/node_modules/@anthropic-ai/sdk/index.mjs");
(Anthropic as any).Messages.prototype.parse = async function () {
  return { model: "stub", usage: { input_tokens: 0, output_tokens: 0 }, parsed_output: { resposta: "", status: "IA", quantidade_aplicavel: true,
    resumo: { nome: "Não informado", produto: "Não informado", quantidade: "Não informado", observacoes: "Não informado" } } };
};
const out = console.log.bind(console);
for (const k of ["log", "warn", "error"] as const) console[k] = () => {};

const { iniciarWebhook } = await import(B + "/src/webhook.ts");
const banco = await import(B + "/src/banco.ts");
iniciarWebhook();
await new Promise((r) => setTimeout(r, 400));

let falhas = 0, total = 0;
const ok = (c: boolean, t: string) => { total++; if (!c) falhas++; out(`${c ? "OK  " : "FAIL"} ${t}`); };
const corpo = JSON.stringify({ object: "whatsapp_business_account", entry: [{ id: "1", changes: [{ field: "messages", value: {
  messaging_product: "whatsapp", metadata: { phone_number_id: "999" },
  messages: [{ id: "teste-dedup-p4-1", from: "5591900000020", timestamp: String(Math.floor(Date.now() / 1000)), type: "text", text: { body: "oi" } }] } }] }] });
const sig = "sha256=" + createHmac("sha256", "meta-secret-teste").update(corpo).digest("hex");

out("== Envio sem WHATSAPP_PROVIDER ==");
ok(process.env.WHATSAPP_PROVIDER === undefined, "WHATSAPP_PROVIDER não definido no processo");
const r = await fetchReal(BASE + "/meta/webhook", { method: "POST", headers: { "Content-Type": "application/json", "X-Hub-Signature-256": sig }, body: corpo });
await new Promise((res) => setTimeout(res, 1000));
const envio = graph.find((g) => g.metodo === "POST" && g.caminho.endsWith("/999/messages"));
ok(r.status === 200, `mensagem recebida pela rota da Meta: HTTP ${r.status}`);
ok(!!envio && envio.corpo?.messaging_product === "whatsapp" && envio.corpo?.to === "5591900000020" && envio.corpo?.type === "text",
  `resposta ao cliente enviada pela Cloud API: POST ${envio?.caminho} (to=559190****0020, type=${envio?.corpo?.type})`);
ok(!!envio && envio.auth.startsWith("Bearer "), "envio autenticado com Bearer (token do teste, não exibido)");
ok(outras.length === 0, `nenhum outro destino de rede (OpenWA ou outro): ${outras.length}`);

out("\n== Rotas ==");
for (const [metodo, caminho] of [["POST", "/openwa/webhook"], ["GET", "/openwa/webhook"]] as const) {
  const x = await fetchReal(BASE + caminho, { method: metodo, ...(metodo === "POST" ? { body: "{}" } : {}) });
  ok(x.status === 404, `${metodo} ${caminho} → HTTP ${x.status}`);
}
const health = await fetchReal(BASE + "/health");
ok(health.status === 200, `GET /health → HTTP ${health.status}`);

const apagados = (await banco.consultar("DELETE FROM eventos_processados WHERE mensagem_externa_id LIKE 'teste-dedup-p4-%'")).rowCount;
const restantes = Number((await banco.consultar("SELECT count(*) n FROM eventos_processados WHERE mensagem_externa_id LIKE 'teste-dedup-%'")).rows[0].n);
ok(apagados === 1 && restantes === 0, `limpeza: ${apagados} registro apagado; teste-dedup restantes = ${restantes}`);
const { limparEspelhoDeTeste } = await import(B + "/tests/limpeza-espelho.mts");
const espelho = await limparEspelhoDeTeste(banco.consultar);
ok(espelho.restantes === 0, `espelho: ${espelho.atendimentos} atendimento(s) e ${espelho.clientes} cliente(s) de teste apagados; restantes = ${espelho.restantes}`);
await banco.encerrarBanco();
out(falhas ? `\n${total} verificações | ${falhas} FALHA(S)` : `\n${total} verificações | TODOS OS TESTES PASSARAM`);
await new Promise((r) => setTimeout(r, 300)); // deixa as conexões fecharem antes de sair (evita assert do libuv no Windows)
process.exit(falhas ? 1 : 0);
