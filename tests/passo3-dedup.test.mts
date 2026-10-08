// Passo 3: deduplicação persistente. Servidor REAL + banco REAL (loja_ideal), IDs "teste-dedup-".
// Claude, Telegram e envio OpenWA simulados; Meta em modo só-log. Nenhuma credencial nova.
import { createHmac } from "node:crypto";

Object.assign(process.env, {
  PORT: "39874",
  META_APP_SECRET: "meta-secret-teste",
  META_ENVIO_ATIVO: "false",
  META_ACCESS_TOKEN: "meta-token-falso",
  TELEGRAM_BOT_TOKEN: "",
  TELEGRAM_CHAT_ID: "",
  ANTHROPIC_API_KEY: "anthropic-falso",
});
const BASE = "http://127.0.0.1:39874";

// Relógio: quarta 07/10/2026 10:00 em Belém (loja aberta).
const agoraReal = Date.now.bind(Date);
const desloc = Date.parse("2026-10-07T10:00:00-03:00") - agoraReal();
Date.now = () => agoraReal() + desloc;

const fetchReal = globalThis.fetch;
const externas: string[] = [];
(globalThis as any).fetch = async (url: any, init: any) => {
  const u = String(url);
  if (u.startsWith("http://127.0.0.1")) return fetchReal(url, init);
  externas.push(new URL(u).host);
  throw new Error("rede externa bloqueada no teste");
};

const B = new URL("..", import.meta.url).href.replace(/\/$/, "");
const { default: Anthropic } = await import(B + "/node_modules/@anthropic-ai/sdk/index.mjs");
let chamadasClaude = 0;
(Anthropic as any).Messages.prototype.parse = async function () {
  chamadasClaude++;
  return { model: "stub", usage: { input_tokens: 0, output_tokens: 0 }, parsed_output: { resposta: "", status: "IA", quantidade_aplicavel: true,
    resumo: { nome: "Não informado", produto: "Não informado", quantidade: "Não informado", observacoes: "Não informado" } } };
};

const logs: string[] = [];
const out = console.log.bind(console);
for (const n of ["log", "warn", "error"] as const) console[n] = (...a: unknown[]) => { logs.push(a.join(" ")); };

const { iniciarWebhook } = await import(B + "/src/webhook.ts");
const banco = await import(B + "/src/banco.ts");
const dedup = await import(B + "/src/eventosProcessados.ts");
iniciarWebhook();
await new Promise((r) => setTimeout(r, 400));

let falhas = 0, total = 0;
const ok = (c: boolean, t: string) => { total++; if (!c) falhas++; out(`${c ? "OK  " : "FAIL"} ${t}`); };
const espera = (ms = 400) => new Promise((r) => setTimeout(r, ms));
const linhas = async (canal: string, id: string) => Number((await banco.consultar("SELECT count(*) n FROM eventos_processados WHERE canal=$1 AND mensagem_externa_id=$2", [canal, id])).rows[0].n);
const seg = () => String(Math.floor(Date.now() / 1000));

const postMeta = (obj: unknown) => {
  const corpo = JSON.stringify(obj);
  const sig = "sha256=" + createHmac("sha256", "meta-secret-teste").update(corpo).digest("hex");
  return fetchReal(BASE + "/meta/webhook", { method: "POST", headers: { "Content-Type": "application/json", "X-Hub-Signature-256": sig }, body: corpo });
};
const msgMeta = (id: string, from = "5591900000001", ts = seg()) => ({ object: "whatsapp_business_account", entry: [{ id: "1", changes: [{ field: "messages", value: {
  messaging_product: "whatsapp", metadata: { phone_number_id: "999" }, messages: [{ id, from, timestamp: ts, type: "text", text: { body: "oi" } }] } }] }] });
const statusMeta = (id: string, status: string) => ({ object: "whatsapp_business_account", entry: [{ id: "1", changes: [{ field: "messages", value: {
  messaging_product: "whatsapp", metadata: { phone_number_id: "999" }, statuses: [{ id, status, timestamp: seg(), recipient_id: "5591900000001" }] } }] }] });
// Segurança: nada com o prefixo antes de começar.
const antes = Number((await banco.consultar("SELECT count(*) n FROM eventos_processados WHERE mensagem_externa_id LIKE 'teste-dedup-%'")).rows[0].n);
const totalAntes = Number((await banco.consultar("SELECT count(*) n FROM eventos_processados")).rows[0].n);
if (antes !== 0) { out(`ABORTADO: já existem ${antes} registros 'teste-dedup-'`); process.exit(1); }

out("== Caso 1: primeira ocorrência (Meta) ==");
let c0 = chamadasClaude;
let r = await postMeta(msgMeta("teste-dedup-1"));
await espera();
ok(r.status === 200 && (await linhas("META", "teste-dedup-1")) === 1, `HTTP ${r.status}; INSERT em eventos_processados (1 linha)`);
ok(chamadasClaude === c0 + 1, `processamento continuou (Claude chamado ${chamadasClaude - c0}x)`);

out("\n== Caso 2: duplicata ==");
c0 = chamadasClaude;
r = await postMeta(msgMeta("teste-dedup-1"));
await espera();
ok(r.status === 200 && (await linhas("META", "teste-dedup-1")) === 1, `HTTP ${r.status}; continua 1 linha (conflito na restrição única)`);
ok(chamadasClaude === c0 && logs.some((l) => l.includes("[Dedup] META: mensagem duplicada ignorada")), "não processado de novo (Claude não chamado; log de duplicata)");

out("\n== Caso 3: mesmo ID em canais diferentes ==");
c0 = chamadasClaude;
const rm = await postMeta(msgMeta("teste-dedup-X", "5591900000003"));
// OpenWA não existe mais no backend: o canal é testado só no nível da persistência.
const ro = await dedup.registrarEventoRecebido("OPENWA", "teste-dedup-X");
await espera(800);
ok(rm.status === 200 && ro === "novo" && (await linhas("META", "teste-dedup-X")) === 1 && (await linhas("OPENWA", "teste-dedup-X")) === 1, "META + teste-dedup-X (webhook) e OPENWA + teste-dedup-X (persistência): duas linhas distintas, o segundo é 'novo'");
ok(chamadasClaude === c0 + 1, `a mensagem da Meta foi processada (Claude ${chamadasClaude - c0}x)`);

out("\n== Caso 4: IDs diferentes no mesmo canal ==");
c0 = chamadasClaude;
await postMeta(msgMeta("teste-dedup-a1", "5591900000005"));
await postMeta(msgMeta("teste-dedup-a2", "5591900000006"));
await espera(800);
ok((await linhas("META", "teste-dedup-a1")) === 1 && (await linhas("META", "teste-dedup-a2")) === 1 && chamadasClaude === c0 + 2, `teste-dedup-a1 e -a2 registrados e processados (Claude ${chamadasClaude - c0}x)`);

out("\n== Caso 5: concorrência ==");
c0 = chamadasClaude;
const rs = await Promise.all([postMeta(msgMeta("teste-dedup-conc", "5591900000007")), postMeta(msgMeta("teste-dedup-conc", "5591900000007"))]);
await espera(800);
ok(rs.every((x) => x.status === 200) && (await linhas("META", "teste-dedup-conc")) === 1 && chamadasClaude === c0 + 1,
  `2 POSTs simultâneos pelo webhook: 1 linha, 1 processamento (Claude ${chamadasClaude - c0}x)`);
const resultados = await Promise.all(Array.from({ length: 20 }, () => dedup.registrarEventoRecebido("OPENWA", "teste-dedup-rajada")));
ok(resultados.filter((x: string) => x === "novo").length === 1 && resultados.filter((x: string) => x === "duplicado").length === 19 && (await linhas("OPENWA", "teste-dedup-rajada")) === 1,
  "20 registros simultâneos do mesmo ID (pool): exatamente 1 'novo' e 19 'duplicado'");

out("\n== Caso 6: recebido e depois descartado ==");
c0 = chamadasClaude;
const umaHoraAtras = String(Math.floor(Date.now() / 1000) - 3600);
r = await postMeta(msgMeta("teste-dedup-velha", "5591900000008", umaHoraAtras));
await espera();
ok(r.status === 200 && (await linhas("META", "teste-dedup-velha")) === 1 && chamadasClaude === c0 && logs.some((l) => l.includes("Evento antigo ignorado")),
  "mensagem da Meta com 1 h: descartada pelo filtro de 20 min, mas registrada em eventos_processados");
const dupAntes = logs.filter((l) => l.includes("[Dedup] META: mensagem duplicada ignorada")).length;
r = await postMeta(msgMeta("teste-dedup-velha", "5591900000008", umaHoraAtras));
await espera();
ok(r.status === 200 && logs.filter((l) => l.includes("[Dedup] META: mensagem duplicada ignorada")).length === dupAntes + 1 && (await linhas("META", "teste-dedup-velha")) === 1, "segunda chegada do mesmo ID → duplicata");

out("\n== Caso 8: statuses[] com o mesmo wamid ==");
c0 = chamadasClaude;
await postMeta(msgMeta("teste-dedup-status", "5591900000009"));
await espera();
ok((await linhas("META", "teste-dedup-status")) === 1, "messages[] com wamid X registrado em eventos_processados");
const dedupAntes = logs.filter((l) => l.includes("[Dedup]")).length;
for (const st of ["sent", "delivered", "read"]) {
  r = await postMeta(statusMeta("teste-dedup-status", st));
  await espera(200);
  ok(r.status === 200 && logs.some((l) => l.includes(`[Meta] status ${st}`) && l.includes("teste-dedup-status")), `statuses[] "${st}" com o mesmo wamid → HTTP 200, tratado pelo fluxo atual (log de status)`);
}
ok(logs.filter((l) => l.includes("[Dedup]")).length === dedupAntes && (await linhas("META", "teste-dedup-status")) === 1, "nenhum status tratado como duplicata; continua 1 linha (status não entra em eventos_processados)");
const misto = msgMeta("teste-dedup-misto", "5591900000010") as any;
misto.entry[0].changes[0].value.statuses = [{ id: "teste-dedup-status", status: "delivered", timestamp: seg(), recipient_id: "5591900000009" }];
const nStatus = logs.filter((l) => l.includes("[Meta] status delivered")).length;
c0 = chamadasClaude;
r = await postMeta(misto);
await espera();
ok(r.status === 200 && chamadasClaude === c0 + 1 && logs.filter((l) => l.includes("[Meta] status delivered")).length === nStatus + 1,
  "payload com messages[] novo + statuses[]: a mensagem é processada e o status segue o fluxo atual");

out("\n== OpenWA removido ==");
const rOw = await fetchReal(BASE + "/openwa/webhook", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
ok(rOw.status === 404, `POST /openwa/webhook → HTTP ${rOw.status} (rota não existe mais)`);

ok(externas.length === 0, `nenhuma chamada de rede externa (${externas.length})`);

// ---------- Limpeza ----------
out("\n== Limpeza ==");
const apagados = (await banco.consultar("DELETE FROM eventos_processados WHERE mensagem_externa_id LIKE 'teste-dedup-%'")).rowCount;
const depois = Number((await banco.consultar("SELECT count(*) n FROM eventos_processados")).rows[0].n);
ok(depois === totalAntes, `${apagados} registros 'teste-dedup-' apagados; total na tabela voltou a ${depois} (era ${totalAntes})`);
const outras = (await banco.consultar("SELECT (SELECT count(*) FROM clientes)+(SELECT count(*) FROM vendedores)+(SELECT count(*) FROM atendimentos)+(SELECT count(*) FROM mensagens) n")).rows[0].n;
ok(Number(outras) === 0, `nenhuma linha criada em clientes/vendedores/atendimentos/mensagens (${outras})`);
await banco.encerrarBanco();

out(falhas ? `\n${total} verificações | ${falhas} FALHA(S)` : `\n${total} verificações | TODOS OS TESTES PASSARAM`);
process.exit(falhas ? 1 : 0);
