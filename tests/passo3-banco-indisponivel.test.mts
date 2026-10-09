// Passo 3 — Caso 7: banco indisponível SIMULADO (pool deste processo aponta para porta inválida).
// O PostgreSQL real não é desligado nem tocado.
// Banco de TESTES (loja_ideal_teste) fixado antes de qualquer import de src/; loja_ideal é dado real.
await import(new URL("./banco-teste.mts", import.meta.url).href);
import { createHmac } from "node:crypto";

Object.assign(process.env, {
  PORT: "39875",
  DB_PORT: "1",
  META_APP_SECRET: "meta-secret-teste",
  META_ENVIO_ATIVO: "false",
  META_ACCESS_TOKEN: "meta-token-falso",
  TELEGRAM_BOT_TOKEN: "",
  TELEGRAM_CHAT_ID: "",
  ANTHROPIC_API_KEY: "anthropic-falso",
});
const BASE = "http://127.0.0.1:39875";
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
let chamadasClaude = 0;
(Anthropic as any).Messages.prototype.parse = async function () { chamadasClaude++; throw new Error("não deveria ser chamado"); };

const logs: string[] = [];
const out = console.log.bind(console);
for (const n of ["log", "warn", "error"] as const) console[n] = (...a: unknown[]) => { logs.push(a.join(" ")); };

const { iniciarWebhook } = await import(B + "/src/webhook.ts");
const dedup = await import(B + "/src/eventosProcessados.ts");
iniciarWebhook();
await new Promise((r) => setTimeout(r, 400));

let falhas = 0, total = 0;
const ok = (c: boolean, t: string) => { total++; if (!c) falhas++; out(`${c ? "OK  " : "FAIL"} ${t}`); };
const assinar = (corpo: string, s: string) => "sha256=" + createHmac("sha256", s).update(corpo).digest("hex");
const seg = () => String(Math.floor(Date.now() / 1000));

out("== Caso 7: banco indisponível (simulado) ==");
let lancou: string | null = null;
try { await dedup.registrarEventoRecebido("META", "teste-dedup-semdb"); } catch (e) { lancou = (e as { code?: string }).code ?? (e as Error).name; }
ok(lancou !== null, `registrarEventoRecebido LANÇA erro (${lancou}); não devolve "duplicado"`);

const corpoMeta = JSON.stringify({ object: "whatsapp_business_account", entry: [{ id: "1", changes: [{ field: "messages", value: {
  messaging_product: "whatsapp", metadata: { phone_number_id: "999" }, messages: [{ id: "teste-dedup-semdb", from: "5591900000001", timestamp: seg(), type: "text", text: { body: "oi" } }] } }] }] });
for (let tentativa = 1; tentativa <= 2; tentativa++) {
  const r = await fetchReal(BASE + "/meta/webhook", { method: "POST", headers: { "Content-Type": "application/json", "X-Hub-Signature-256": assinar(corpoMeta, "meta-secret-teste") }, body: corpoMeta });
  await new Promise((res) => setTimeout(res, 300));
  ok(r.status === 503, `Meta, tentativa ${tentativa}: HTTP ${r.status} (5xx para a Meta reenviar; não é 200)`);
}
ok(chamadasClaude === 0, "mensagem da Meta NÃO processada (Claude não chamado)");

ok(logs.filter((l) => l.includes("falha ao registrar em eventos_processados")).length === 2 && !logs.some((l) => l.includes("duplicada ignorada")),
  "2 falhas (as 2 tentativas da Meta) registradas no log como falha técnica; nenhuma tratada como duplicata");
ok(!logs.some((l) => l.includes("Mensagem recebida (")), "nenhuma mensagem entrou no núcleo de atendimento");
const senha = process.env.DB_PASSWORD ?? "";
ok(!senha || !logs.some((l) => l.includes(senha)), "logs sem a senha do banco");

out(falhas ? `\n${total} verificações | ${falhas} FALHA(S)` : `\n${total} verificações | TODOS OS TESTES PASSARAM`);
process.exit(falhas ? 1 : 0);
