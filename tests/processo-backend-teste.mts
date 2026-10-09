// Auxiliar dos testes (NÃO é uma suíte): o backend de verdade (iniciarWebhook, com a recuperação na
// partida) num PROCESSO FILHO, com Meta, Telegram e Claude simulados e rede externa bloqueada.
// Usado por passo5d-reinicio.test.mts, que mata este processo com SIGKILL e sobe outro.
//
// Comunicação com o pai pelo stdout, uma linha por evento:
//   "@@LOG <texto>"      logs do backend
//   "@@TG <json>"        chamada à Bot API simulada ({ metodo, corpo, ok })
//   "@@GRAPH <json>"     envio à Graph API simulada ({ wamid })
//   "@@CLAUDE <n>"       chamada ao Claude simulado (n = tamanho do histórico recebido)
// Variáveis: PORT, TESTE_DESLOC_MS (relógio igual ao do pai), TESTE_BANCO_FORA=1 (conexões de
// transação recusadas: a recuperação falha; a deduplicação continua funcionando).
// Banco de TESTES (loja_ideal_teste) fixado antes de qualquer import de src/; loja_ideal é dado real.
const { exigirBancoDeTeste } = await import(new URL("./banco-teste.mts", import.meta.url).href);

Object.assign(process.env, {
  META_APP_SECRET: "meta-secret-teste",
  META_ENVIO_ATIVO: "true",
  META_ACCESS_TOKEN: "meta-token-falso",
  META_PHONE_NUMBER_ID: "999",
  META_GRAPH_VERSION: "v26.0",
  TELEGRAM_BOT_TOKEN: "123456:TOKEN-FALSO",
  TELEGRAM_CHAT_ID: "-1009999999999",
  TELEGRAM_WEBHOOK_SECRET: "segredo-teste-5d-filho",
  TELEGRAM_RESUMO_TTL_HORAS: "72",
  ANTHROPIC_API_KEY: "anthropic-falso",
});

const emitir = (tipo: string, dado: unknown) =>
  process.stdout.write(`@@${tipo} ${typeof dado === "string" ? dado.replace(/\n/g, "\\n") : JSON.stringify(dado)}\n`);

const agoraReal = Date.now.bind(Date);
const desloc = Number(process.env.TESTE_DESLOC_MS ?? "0");
Date.now = () => agoraReal() + desloc;

let resp = 0;
let msgId = Number(process.env.TESTE_MSG_ID_INICIAL ?? "9000");
(globalThis as any).fetch = async (url: any, init: any) => {
  const u = new URL(String(url));
  if (u.hostname === "graph.facebook.com") {
    const wamid = `wamid.teste-5d-filho-${process.pid}-${++resp}`;
    emitir("GRAPH", { wamid });
    return new Response(JSON.stringify({ messaging_product: "whatsapp", messages: [{ id: wamid }] }), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  const m = /^\/bot[^/]+\/(\w+)$/.exec(u.pathname);
  if (u.hostname === "api.telegram.org" && m) {
    const corpo = JSON.parse(init.body);
    const r = (o: any) => ({ status: o.ok ? 200 : 400, json: async () => o });
    emitir("TG", { metodo: m[1], corpo, ok: true });
    if (m[1] === "getChatMember") return r({ ok: true, result: { status: "member" } });
    if (m[1] === "sendMessage") return r({ ok: true, result: { message_id: msgId++, chat: { id: Number(corpo.chat_id) } } });
    return r({ ok: true, result: true });
  }
  throw new Error(`rede externa bloqueada no teste: ${u.hostname}`);
};

const B = new URL("..", import.meta.url).href.replace(/\/$/, "");
const { default: Anthropic } = await import(B + "/node_modules/@anthropic-ai/sdk/index.mjs");
(Anthropic as any).Messages.prototype.parse = async function (params: any) {
  emitir("CLAUDE", String(params.messages.length));
  return { model: "stub", usage: { input_tokens: 0, output_tokens: 0 }, parsed_output: { resposta: "", status: "IA", quantidade_aplicavel: true,
    resumo: { nome: "Não informado", produto: "Não informado", quantidade: "Não informado", observacoes: "Não informado" } } };
};

for (const k of ["log", "warn", "error"] as const) console[k] = (...a: unknown[]) => emitir("LOG", a.map(String).join(" "));

if (process.env.TESTE_BANCO_FORA === "1") {
  const banco = await import(B + "/src/banco.ts");
  const pool = banco.obterPool();
  const connectOriginal = pool.connect.bind(pool);
  (pool as any).connect = (...a: unknown[]) =>
    a.length === 0 ? Promise.reject(Object.assign(new Error("conexão recusada (simulada)"), { code: "ECONNREFUSED" })) : (connectOriginal as any)(...a);
}

await exigirBancoDeTeste((await import(B + "/src/banco.ts")).consultar);
const { iniciarWebhook } = await import(B + "/src/webhook.ts");
await iniciarWebhook();
