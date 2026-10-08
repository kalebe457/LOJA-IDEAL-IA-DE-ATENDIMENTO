// Rota POST /telegram/webhook no servidor REAL do projeto, numa porta própria.
// Credenciais FALSAS definidas antes dos imports (o dotenv não sobrescreve).
// Toda chamada de rede externa é bloqueada e contada: nada sai para o Telegram.
Object.assign(process.env, {
  PORT: "39872",
  TELEGRAM_WEBHOOK_SECRET: "segredo-falso-rota_teste",
  TELEGRAM_BOT_TOKEN: "123456:TOKEN-FALSO",
  TELEGRAM_CHAT_ID: "-1009999999999",
  META_APP_SECRET: "meta-secret-teste",
  META_ACCESS_TOKEN: "meta-token-falso",
  META_ENVIO_ATIVO: "false",
  ANTHROPIC_API_KEY: "anthropic-falso",
});
const BASE = "http://127.0.0.1:39872";

const fetchReal = globalThis.fetch;
const externas: string[] = [];
(globalThis as any).fetch = async (url: any, init: any) => {
  const u = String(url);
  if (u.startsWith("http://127.0.0.1")) return fetchReal(url, init);
  externas.push(new URL(u).host);
  throw new Error("rede externa bloqueada no teste");
};

const B = new URL("..", import.meta.url).href.replace(/\/$/, "");
const logReal = console.log;
console.log = () => {};
console.error = () => {};
const { iniciarWebhook } = await import(B + "/src/webhook.ts");

const segredo = "segredo-falso-rota_teste";

iniciarWebhook();
await new Promise((r) => setTimeout(r, 300));

let falhas = 0;
const ok = (c: boolean, t: string) => { if (!c) falhas++; logReal(`${c ? "OK  " : "FAIL"} ${t}`); };

ok(process.env.TELEGRAM_WEBHOOK_SECRET === segredo, "o servidor usa o segredo falso do teste (não o do .env)");

// Update válido que não gera nenhuma chamada ao Telegram: mensagem comum no grupo (ignorada).
const update = JSON.stringify({ update_id: 1, message: { message_id: 1, chat: { id: -1009999999999, type: "supergroup" }, from: { id: 1, first_name: "Teste" }, text: "teste local" } });
const post = (headers: Record<string, string>, body = update) =>
  fetchReal(BASE + "/telegram/webhook", { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body });

const r1 = await post({ "X-Telegram-Bot-Api-Secret-Token": segredo });
ok(r1.status === 200, `secret correto → HTTP ${r1.status}`);
const r2 = await post({ "X-Telegram-Bot-Api-Secret-Token": segredo + "x" });
ok(r2.status === 401, `secret errado → HTTP ${r2.status}`);
const r3 = await post({});
ok(r3.status === 401, `secret ausente → HTTP ${r3.status}`);
const r4 = await fetchReal(BASE + "/telegram/webhook");
ok(r4.status === 405, `método GET → HTTP ${r4.status}`);
const r5 = await post({ "X-Telegram-Bot-Api-Secret-Token": segredo }, "isto não é json");
ok(r5.status === 400, `JSON inválido → HTTP ${r5.status}`);
const r6 = await post({ "X-Telegram-Bot-Api-Secret-Token": "" });
ok(r6.status === 401, `secret vazio → HTTP ${r6.status}`);

await new Promise((r) => setTimeout(r, 300));
ok(externas.length === 0, `nenhuma chamada externa (Telegram/Meta/Anthropic): ${externas.length}`);

logReal(falhas ? `\n${falhas} FALHA(S)` : "\nTODOS OS TESTES PASSARAM");
process.exit(falhas ? 1 : 0);
