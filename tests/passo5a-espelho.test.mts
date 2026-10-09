// Passo 5a: cliente + atendimento espelhados no PostgreSQL (a memória continua sendo a verdade).
// Servidor real + banco de testes (loja_ideal_teste). Chat de teste: "meta:999:<telefone fictício 55919000005xx>",
// wamids "teste-5a-...". Claude, Telegram e Meta simulados; rede externa bloqueada.
// Banco de TESTES (loja_ideal_teste) fixado antes de qualquer import de src/; loja_ideal é dado real.
const { exigirBancoDeTeste } = await import(new URL("./banco-teste.mts", import.meta.url).href);
import { createHmac } from "node:crypto";

Object.assign(process.env, {
  PORT: "39879",
  META_APP_SECRET: "meta-secret-teste",
  META_ENVIO_ATIVO: "false",
  META_ACCESS_TOKEN: "meta-token-falso",
  META_PHONE_NUMBER_ID: "999",
  META_GRAPH_VERSION: "v26.0",
  TELEGRAM_BOT_TOKEN: "123456:TOKEN-FALSO",
  TELEGRAM_CHAT_ID: "-1009999999999",
  TELEGRAM_WEBHOOK_SECRET: "segredo-teste-5a",
  ANTHROPIC_API_KEY: "anthropic-falso",
});
const BASE = "http://127.0.0.1:39879";
const GRUPO = -1009999999999;

// Relógio controlado: quarta 07/10/2026 10:00 em Belém (loja aberta); "desloc" avança o tempo.
const agoraReal = Date.now.bind(Date);
let desloc = Date.parse("2026-10-07T10:00:00-03:00") - agoraReal();
Date.now = () => agoraReal() + desloc;

const fetchReal = globalThis.fetch;
const telegram: { metodo: string; corpo: any; id?: number }[] = [];
const externas: string[] = [];
let msgId = 700;
(globalThis as any).fetch = async (url: any, init: any) => {
  const u = new URL(String(url));
  if (u.hostname === "127.0.0.1") return fetchReal(url, init);
  const m = /^\/bot[^/]+\/(\w+)$/.exec(u.pathname);
  if (u.hostname === "api.telegram.org" && m) {
    const corpo = JSON.parse(init.body);
    const id = msgId++;
    telegram.push({ metodo: m[1]!, corpo, id });
    const result = m[1] === "sendMessage" ? { message_id: id } : m[1] === "getChatMember" ? { status: "member" } : true;
    return { status: 200, json: async () => ({ ok: true, result }) } as any;
  }
  externas.push(u.hostname);
  throw new Error("rede externa bloqueada no teste");
};

const B = new URL("..", import.meta.url).href.replace(/\/$/, "");
const { default: Anthropic } = await import(B + "/node_modules/@anthropic-ai/sdk/index.mjs");
let chamadasClaude = 0;
(Anthropic as any).Messages.prototype.parse = async function (params: any) {
  chamadasClaude++;
  const ultimo = String(params.messages.at(-1).content);
  const completo = ultimo.includes("pedido completo");
  return { model: "stub", usage: { input_tokens: 0, output_tokens: 0 }, parsed_output: { resposta: "", status: "IA", quantidade_aplicavel: true,
    resumo: completo
      ? { nome: "Cliente Teste 5a", produto: "Cimento", quantidade: "10 sacos", observacoes: "Nenhuma observação adicional." }
      : { nome: "Não informado", produto: "Não informado", quantidade: "Não informado", observacoes: "Não informado" } } };
};

const logs: string[] = [];
const out = console.log.bind(console);
for (const k of ["log", "warn", "error"] as const) console[k] = (...a: unknown[]) => { logs.push(a.join(" ")); };

const { iniciarWebhook } = await import(B + "/src/webhook.ts");
const banco = await import(B + "/src/banco.ts");
await exigirBancoDeTeste(banco.consultar);
iniciarWebhook();
await new Promise((r) => setTimeout(r, 400));

let falhas = 0, total = 0;
const ok = (c: boolean, t: string) => { total++; if (!c) falhas++; out(`${c ? "OK  " : "FAIL"} ${t}`); };
const espera = (ms = 500) => new Promise((r) => setTimeout(r, ms));

const TEL_A = "5591900000501", TEL_B = "5591900000502", TEL_C = "5591900000503", TEL_D = "5591900000504";
const chat = (tel: string) => `meta:999:${tel}`;
let seq = 0;
async function mensagem(tel: string, texto: string, wamid = `teste-5a-${++seq}`) {
  const corpo = JSON.stringify({ object: "whatsapp_business_account", entry: [{ id: "1", changes: [{ field: "messages", value: {
    messaging_product: "whatsapp", metadata: { phone_number_id: "999" },
    messages: [{ id: wamid, from: tel, timestamp: String(Math.floor(Date.now() / 1000)), type: "text", text: { body: texto } }] } }] }] });
  const sig = "sha256=" + createHmac("sha256", "meta-secret-teste").update(corpo).digest("hex");
  const r = await fetchReal(BASE + "/meta/webhook", { method: "POST", headers: { "Content-Type": "application/json", "X-Hub-Signature-256": sig }, body: corpo });
  await espera();
  return { status: r.status, wamid };
}
type Linha = { id: string; codigo: string; cliente_id: string; status: string; canal: string; chat_id: string; ultima_atividade_em: Date; encerrado_em: Date | null; telefone: string };
const linhas = async (tel: string): Promise<Linha[]> => (await banco.consultar(
  `SELECT a.id, a.codigo, a.cliente_id, a.status, a.canal, a.chat_id, a.ultima_atividade_em, a.encerrado_em, c.telefone
     FROM atendimentos a JOIN clientes c ON c.id = a.cliente_id WHERE a.chat_id = $1 ORDER BY a.id`, [chat(tel)])).rows;
// codigo do atendimento em memória: último "Mensagem recebida (Meta) | atendimento: ATD-..." deste chat.
const codigoEmMemoria = (tel: string) => {
  const final = tel.slice(-4);
  const l = [...logs].reverse().find((x) => x.startsWith("Mensagem recebida (Meta)") && x.includes(`****${final}`));
  return /atendimento: (ATD-[0-9A-F]{10})/.exec(l ?? "")?.[1] ?? "";
};

// Segurança: nada com o prefixo de teste antes de começar.
const previos = Number((await banco.consultar("SELECT count(*) n FROM atendimentos WHERE chat_id LIKE 'meta:999:%'")).rows[0].n);
if (previos !== 0) { out(`ABORTADO: já existem ${previos} atendimentos de teste (meta:999:)`); process.exit(1); }

out("== 1. Primeira mensagem ==");
await mensagem(TEL_A, "oi");
let la = await linhas(TEL_A);
const codA1 = codigoEmMemoria(TEL_A);
ok(la.length === 1 && la[0]!.telefone === TEL_A && la[0]!.encerrado_em === null, `1 cliente (${TEL_A.slice(0, 4)}****) e 1 atendimento aberto`);
ok(la[0]!.canal === "META" && la[0]!.chat_id === chat(TEL_A) && la[0]!.status === "IA" && la[0]!.codigo === codA1 && /^ATD-/.test(codA1),
  `canal META, chat_id da memória, status IA, codigo = o da memória (${codA1})`);

out("\n== 2. Segunda mensagem da mesma conversa ==");
const ativ1 = la[0]!.ultima_atividade_em.getTime();
const cliente1 = la[0]!.cliente_id;
desloc += 5_000;
await mensagem(TEL_A, "Ana");
la = await linhas(TEL_A);
ok(la.length === 1 && la[0]!.codigo === codA1 && la[0]!.cliente_id === cliente1, "mesmo atendimento e mesmo cliente");
ok(la[0]!.ultima_atividade_em.getTime() > ativ1, `ultima_atividade_em avançou (+${la[0]!.ultima_atividade_em.getTime() - ativ1} ms)`);

out("\n== 4. Inatividade (verificação periódica de 30 s) ==");
desloc += 21 * 60_000;
let encerrado = false;
for (let i = 0; i < 70 && !encerrado; i++) {
  await espera(500);
  encerrado = (await linhas(TEL_A))[0]!.encerrado_em !== null;
}
la = await linhas(TEL_A);
ok(encerrado && la[0]!.status === "IA", `após 21 min sem atividade: encerrado_em preenchido, status continua IA`);

out("\n== 5 e 3. Nova mensagem depois do encerramento; mesmo telefone ==");
await mensagem(TEL_A, "voltei");
la = await linhas(TEL_A);
const codA2 = codigoEmMemoria(TEL_A);
ok(la.length === 2 && la[0]!.codigo === codA1 && la[0]!.encerrado_em !== null && la[1]!.codigo === codA2 && la[1]!.encerrado_em === null && codA2 !== codA1,
  `atendimento novo aberto (${codA2}); o antigo (${codA1}) continua fechado`);
ok(la[0]!.cliente_id === la[1]!.cliente_id, "duas conversas do mesmo telefone → mesmo clientes.id");

out("\n== 6. Atendimento órfão (simula restart) ==");
const cli = (await banco.consultar("INSERT INTO clientes (telefone) VALUES ($1) ON CONFLICT (telefone) DO UPDATE SET telefone = EXCLUDED.telefone RETURNING id", [TEL_B])).rows[0].id;
await banco.consultar("INSERT INTO atendimentos (codigo, cliente_id, status, canal, chat_id) VALUES ('TESTE-5A-ORFAO', $1, 'IA', 'META', $2)", [cli, chat(TEL_B)]);
await mensagem(TEL_B, "oi");
const lb = await linhas(TEL_B);
const codB = codigoEmMemoria(TEL_B);
const orfao = lb.find((x) => x.codigo === "TESTE-5A-ORFAO");
const novoB = lb.find((x) => x.codigo === codB);
ok(!!orfao && orfao.encerrado_em !== null, "o órfão (outro codigo) foi encerrado");
ok(!!novoB && novoB.encerrado_em === null && novoB.cliente_id === cli && lb.length === 2, `nasceu o atendimento com o codigo da memória (${codB}), mesmo cliente`);

out("\n== 7. Assunção pelo Telegram ==");
await mensagem(TEL_C, "pedido completo");
const codC = codigoEmMemoria(TEL_C);
const resumo = telegram.find((t) => t.metodo === "sendMessage" && t.corpo.chat_id === String(GRUPO));
ok(!!resumo && (await linhas(TEL_C))[0]?.encerrado_em === null, "triagem concluída, resumo no Telegram; atendimento ainda aberto antes da assunção");
const tg = (u: unknown) => fetchReal(BASE + "/telegram/webhook", { method: "POST", headers: { "Content-Type": "application/json", "X-Telegram-Bot-Api-Secret-Token": "segredo-teste-5a" }, body: JSON.stringify(u) });
await tg({ update_id: 9001, message: { message_id: 1, chat: { id: 111, type: "private" }, from: { id: 111, first_name: "Vendedor" }, text: "/start" } });
await espera();
await tg({ update_id: 9002, callback_query: { id: "cb-5a", from: { id: 111, first_name: "Vendedor" }, data: `assumir:${codC}`, message: { message_id: resumo?.id, chat: { id: GRUPO, type: "supergroup" } } } });
await espera(800);
const lc = await linhas(TEL_C);
ok(logs.some((l) => l.includes(`Atendimento ${codC} assumido por vendedor via Telegram`)), "vendedor assumiu pelo fluxo do Telegram (simulado)");
// Desde o 5b o status acompanha a memória: triagem concluída = HUMANO.
ok(lc.length === 1 && lc[0]!.codigo === codC && lc[0]!.encerrado_em !== null && lc[0]!.status === "HUMANO", "linha do banco encerrada na assunção; status HUMANO (triagem concluída)");
await mensagem(TEL_C, "mais uma mensagem");
const lc2 = await linhas(TEL_C);
ok(lc2.length === 1 && lc2[0]!.encerrado_em !== null, "mensagem depois de assumido não reabre nem cria atendimento");

out("\n== 8. Banco falha na 1ª mensagem; volta na 2ª ==");
const pool = banco.obterPool();
const connectOriginal = pool.connect.bind(pool);
// Falha só nas conexões de transação (connect() sem argumentos = espelho). pool.query (dedup) segue funcionando.
(pool as any).connect = (...args: unknown[]) => (args.length === 0 ? Promise.reject(Object.assign(new Error("conexão recusada (simulada)"), { code: "ECONNREFUSED" })) : (connectOriginal as any)(...args));
const c0 = chamadasClaude;
const r8 = await mensagem(TEL_D, "oi");
(pool as any).connect = connectOriginal;
const senha = process.env.DB_PASSWORD ?? "";
ok(r8.status === 200 && chamadasClaude === c0 + 1, "HTTP 200 e a triagem continuou (Claude chamado) mesmo com o espelho falhando");
ok((await linhas(TEL_D)).length === 0 && logs.some((l) => l.includes("[Persistência] falha ao registrar atividade") && l.includes("ECONNREFUSED")) && (!senha || !logs.some((l) => l.includes(senha))),
  "nenhuma linha criada; erro logado curto (código), sem senha");
await mensagem(TEL_D, "Ana");
const ld = await linhas(TEL_D);
ok(ld.length === 1 && ld[0]!.encerrado_em === null && ld[0]!.codigo === codigoEmMemoria(TEL_D), "banco de volta: a 2ª mensagem criou a linha com o codigo da memória");

out("\n== 9. Mensagem duplicada (mesmo wamid) ==");
const antesDup = (await linhas(TEL_A)).length;
const c9 = chamadasClaude;
const primeira = await mensagem(TEL_A, "repetida");
await mensagem(TEL_A, "repetida", primeira.wamid);
ok((await linhas(TEL_A)).length === antesDup && chamadasClaude === c9 + 1, "o mesmo wamid não cria atendimento novo nem processa de novo");

out("\n== 5a.1: colisão de codigo com outro chat_id ==");
const TEL_E = "5591900000505", TEL_F = "5591900000506", TEL_G = "5591900000507";
const espelhoMod = await import(B + "/src/persistenciaAtendimento.ts");
const cliE = (await banco.consultar("INSERT INTO clientes (telefone) VALUES ($1) ON CONFLICT (telefone) DO UPDATE SET telefone = EXCLUDED.telefone RETURNING id", [TEL_E])).rows[0].id;
await banco.consultar("INSERT INTO atendimentos (codigo, cliente_id, status, canal, chat_id) VALUES ('ATD-TESTE5A001', $1, 'IA', 'META', $2)", [cliE, chat(TEL_E)]);
const antesColisao = (await linhas(TEL_E))[0]!;
const resColisao = await espelhoMod.registrarAtividadeAtendimento({ codigo: "ATD-TESTE5A001", chatId: chat(TEL_F), telefone: TEL_F, atividadeEm: Date.now() + 60_000, encerrado: true });
const depoisColisao = (await linhas(TEL_E))[0]!;
const clienteF = Number((await banco.consultar("SELECT count(*) n FROM clientes WHERE telefone = $1", [TEL_F])).rows[0].n);
ok(resColisao === false && logs.some((l) => l.includes("colisão de codigo ATD-TESTE5A001")), "colisão detectada e logada (retorno false)");
ok(depoisColisao.chat_id === chat(TEL_E) && depoisColisao.encerrado_em === null && depoisColisao.ultima_atividade_em.getTime() === antesColisao.ultima_atividade_em.getTime(),
  "linha existente (outro chat_id) NÃO foi sobrescrita: chat_id, atividade e encerramento intactos");
ok((await linhas(TEL_F)).length === 0 && clienteF === 0, "nada criado para o outro chat (transação desfeita, nem o cliente)");

out("\n== 5a.1: banco travado (statement_timeout de 5 s) ==");
await banco.consultar("INSERT INTO clientes (telefone) VALUES ($1) ON CONFLICT (telefone) DO NOTHING", [TEL_G]);
const trava = await banco.obterConexao();
await trava.query("BEGIN");
await trava.query("SELECT id FROM clientes WHERE telefone = $1 FOR UPDATE", [TEL_G]); // o espelho vai esperar este lock
const cG = chamadasClaude;
const t0 = Date.now();
await mensagem(TEL_G, "oi");
for (let i = 0; i < 40 && chamadasClaude === cG; i++) await espera(250);
const decorrido = Date.now() - t0;
await trava.query("ROLLBACK");
trava.release();
ok(chamadasClaude === cG + 1 && decorrido >= 4_500 && decorrido < 9_000, `espelho travado foi cancelado e a triagem seguiu (Claude chamado após ${(decorrido / 1000).toFixed(1)} s)`);
ok(logs.some((l) => l.includes("[Persistência] falha ao registrar atividade") && l.includes("57014")), "cancelamento por statement_timeout logado (57014), sem segredo");
ok((await linhas(TEL_G)).length === 0, "nenhuma linha meio gravada (transação desfeita)");

ok(externas.length === 0, `nenhuma chamada de rede externa (${externas.length})`);

out("\n== Limpeza ==");
await espera(500);
const ev = (await banco.consultar("DELETE FROM eventos_processados WHERE mensagem_externa_id LIKE 'teste-5a-%'")).rowCount;
const { limparEspelhoDeTeste } = await import(B + "/tests/limpeza-espelho.mts");
const espelho = await limparEspelhoDeTeste(banco.consultar);
// Clientes criados direto pelo teste e que ficaram sem atendimento.
await banco.consultar("DELETE FROM clientes WHERE telefone = ANY($1::varchar[]) AND NOT EXISTS (SELECT 1 FROM atendimentos a WHERE a.cliente_id = clientes.id)", [[TEL_E, TEL_F, TEL_G]]);
const sobra = Number((await banco.consultar("SELECT count(*) n FROM clientes WHERE telefone = ANY($1::varchar[])", [[TEL_A, TEL_B, TEL_C, TEL_D, TEL_E, TEL_F, TEL_G]])).rows[0].n);
ok(espelho.restantes === 0 && sobra === 0, `apagados: ${ev} eventos, ${espelho.atendimentos} atendimentos, ${espelho.clientes} clientes; restantes = ${espelho.restantes + sobra}`);
await banco.encerrarBanco();

out(falhas ? `\n${total} verificações | ${falhas} FALHA(S)` : `\n${total} verificações | TODOS OS TESTES PASSARAM`);
await new Promise((r) => setTimeout(r, 300));
process.exit(falhas ? 1 : 0);
