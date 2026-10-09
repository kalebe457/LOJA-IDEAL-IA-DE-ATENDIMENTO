// Passo 5d: recuperação na partida. Servidor real + banco de testes (loja_ideal_teste). O "reinício" é simulado
// zerando a memória (redefinirEstadoWebhookParaTestes) e chamando a mesma recuperação da partida.
// A partida de verdade (ordem listen × recuperação, banco fora, SIGKILL) está em passo5d-reinicio.test.mts.
// Chats "meta:999:<telefone fictício 55919000009xx>", wamids "teste-5d-...", vendedores 990000000101+.
// Claude, Meta e Telegram simulados; rede externa bloqueada.
// Banco de TESTES (loja_ideal_teste) fixado antes de qualquer import de src/; loja_ideal é dado real.
const { exigirBancoDeTeste } = await import(new URL("./banco-teste.mts", import.meta.url).href);
import { createHmac } from "node:crypto";

Object.assign(process.env, {
  PORT: "39882",
  META_APP_SECRET: "meta-secret-teste",
  META_ENVIO_ATIVO: "true",
  META_ACCESS_TOKEN: "meta-token-falso",
  META_PHONE_NUMBER_ID: "999",
  META_GRAPH_VERSION: "v26.0",
  TELEGRAM_BOT_TOKEN: "123456:TOKEN-FALSO",
  TELEGRAM_CHAT_ID: "-1009999999999",
  TELEGRAM_WEBHOOK_SECRET: "segredo-teste-5d",
  TELEGRAM_RESUMO_TTL_HORAS: "72",
  ANTHROPIC_API_KEY: "anthropic-falso",
});
const BASE = "http://127.0.0.1:39882";
const GRUPO = -1009999999999;
const V1 = 990_000_000_101, V2 = 990_000_000_102;

// Relógio controlado: quarta 07/10/2026 10:00 em Belém (loja aberta).
const agoraReal = Date.now.bind(Date);
const desloc = Date.parse("2026-10-07T10:00:00-03:00") - agoraReal();
Date.now = () => agoraReal() + desloc;

// ---- Graph API e Bot API simuladas ----
let graphAceita = true;
let resp = 0;
type Chamada = { metodo: string; corpo: any; ok?: boolean };
const telegram: Chamada[] = [];
let falharResumo = false;
const falharDM = new Set<number>();
const statusPorUsuario = new Map<number, string>(); // padrão: member
let msgId = 8000;
const externas: string[] = [];
const fetchReal = globalThis.fetch;
(globalThis as any).fetch = async (url: any, init: any) => {
  const u = new URL(String(url));
  if (u.hostname === "127.0.0.1") return fetchReal(url, init);
  if (u.hostname === "graph.facebook.com") {
    if (!graphAceita) return new Response(JSON.stringify({ error: { code: 131047, message: "recusado (simulado)" } }), { status: 400, headers: { "Content-Type": "application/json" } });
    return new Response(JSON.stringify({ messaging_product: "whatsapp", messages: [{ id: `wamid.teste-5d-resp-${++resp}` }] }), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  const m = /^\/bot[^/]+\/(\w+)$/.exec(u.pathname);
  if (u.hostname === "api.telegram.org" && m) {
    const corpo = JSON.parse(init.body);
    telegram.push({ metodo: m[1]!, corpo });
    const r = (o: any) => ({ status: o.ok ? 200 : 400, json: async () => o });
    if (m[1] === "getChatMember") return r({ ok: true, result: { status: statusPorUsuario.get(corpo.user_id) ?? "member" } });
    if (m[1] === "sendMessage") {
      if ((String(corpo.chat_id) === String(GRUPO) && falharResumo) || falharDM.has(corpo.chat_id)) {
        telegram.at(-1)!.ok = false;
        return r({ ok: false, error_code: 403, description: "falha simulada" });
      }
      telegram.at(-1)!.ok = true;
      return r({ ok: true, result: { message_id: msgId++, chat: { id: Number(corpo.chat_id) } } });
    }
    return r({ ok: true, result: true });
  }
  externas.push(u.hostname);
  throw new Error("rede externa bloqueada no teste");
};

// Claude simulado: não preenche campos (a triagem usa o texto do cliente); "pedido completo" preenche tudo.
const B = new URL("..", import.meta.url).href.replace(/\/$/, "");
const { default: Anthropic } = await import(B + "/node_modules/@anthropic-ai/sdk/index.mjs");
let qtdAplicavel = true;
const chamadasClaude: any[][] = [];
(Anthropic as any).Messages.prototype.parse = async function (params: any) {
  chamadasClaude.push(params.messages);
  const completo = String(params.messages.at(-1).content).includes("pedido completo");
  return { model: "stub", usage: { input_tokens: 0, output_tokens: 0 }, parsed_output: { resposta: "", status: "IA", quantidade_aplicavel: qtdAplicavel,
    resumo: completo
      ? { nome: "Cliente Teste 5d", produto: "Cimento", quantidade: "10 sacos", observacoes: "Nenhuma observação adicional." }
      : { nome: "Não informado", produto: "Não informado", quantidade: "Não informado", observacoes: "Não informado" } } };
};

const logs: string[] = [];
const out = console.log.bind(console);
for (const k of ["log", "warn", "error"] as const) console[k] = (...a: unknown[]) => { logs.push(a.join(" ")); };

const webhook = await import(B + "/src/webhook.ts");
const banco = await import(B + "/src/banco.ts");
await exigirBancoDeTeste(banco.consultar);
const T = await import(B + "/src/telegramBot.ts");

let falhas = 0, total = 0;
const ok = (c: boolean, t: string) => { total++; if (!c) falhas++; out(`${c ? "OK  " : "FAIL"} ${t}`); };
const espera = (ms = 600) => new Promise((r) => setTimeout(r, ms));
const chat = (tel: string) => `meta:999:${tel}`;

// Segurança: nada de teste antes de começar.
const previos = Number((await banco.consultar("SELECT (SELECT count(*) FROM atendimentos WHERE chat_id LIKE 'meta:999:%') + (SELECT count(*) FROM vendedores WHERE telegram_user_id BETWEEN 990000000000 AND 990000999999) n")).rows[0].n);
if (previos !== 0) { out(`ABORTADO: já existem ${previos} registros de teste`); process.exit(1); }

await webhook.iniciarWebhook();

let seq = 0;
async function mensagem(tel: string, texto: string) {
  const corpo = JSON.stringify({ object: "whatsapp_business_account", entry: [{ id: "1", changes: [{ field: "messages", value: {
    messaging_product: "whatsapp", metadata: { phone_number_id: "999" },
    messages: [{ id: `teste-5d-${++seq}`, from: tel, timestamp: String(Math.floor(Date.now() / 1000)), type: "text", text: { body: texto } }] } }] }] });
  const sig = "sha256=" + createHmac("sha256", "meta-secret-teste").update(corpo).digest("hex");
  const r = await fetchReal(BASE + "/meta/webhook", { method: "POST", headers: { "Content-Type": "application/json", "X-Hub-Signature-256": sig }, body: corpo });
  await espera();
  return r.status;
}
let upd = 1;
const tg = (u: unknown) => fetchReal(BASE + "/telegram/webhook", { method: "POST",
  headers: { "Content-Type": "application/json", "X-Telegram-Bot-Api-Secret-Token": "segredo-teste-5d" }, body: JSON.stringify(u) });
const start = async (id: number, nome: string) => { await tg({ update_id: upd++, message: { message_id: 1, chat: { id, type: "private" }, from: { id, first_name: nome }, text: "/start" } }); await espera(); };
let cb = 0;
async function clique(id: number, nome: string, codigo: string, msg: number) {
  const cbId = `cb-5d-${++cb}`;
  await tg({ update_id: upd++, callback_query: { id: cbId, from: { id, first_name: nome }, data: `assumir:${codigo}`, message: { message_id: msg, chat: { id: GRUPO, type: "supergroup" } } } });
  await espera(800);
  return telegram.find((c) => c.metodo === "answerCallbackQuery" && c.corpo.callback_query_id === cbId)?.corpo.text as string | undefined;
}
// Só as publicações aceitas (a tentativa que falhou não conta).
const resumoDo = (codigo: string) => telegram.filter((c) => c.metodo === "sendMessage" && c.ok === true && String(c.corpo.chat_id) === String(GRUPO)
  && c.corpo.reply_markup?.inline_keyboard?.[0]?.[0]?.callback_data === `assumir:${codigo}`);
const dmsPara = (id: number) => telegram.filter((c) => c.metodo === "sendMessage" && c.corpo.chat_id === id && String(c.corpo.text).startsWith("🔒"));
async function novoAtendimentoCompleto(tel: string) {
  await mensagem(tel, "pedido completo");
  const codigo = webhook.lerEstadoEspelhavel(chat(tel))?.codigo ?? "";
  return { codigo, msg: resumoDo(codigo).length ? msgId - 1 : -1 };
}
type Atd = { codigo: string; status: string; etapa_atual: string | null; perguntas_etapa: number; etapas_puladas: string[]; apresentacao_pendente: boolean;
  quantidade_nao_aplicavel: boolean; nome: string | null; produto: string | null; quantidade: string | null; observacoes: string | null;
  encerrado_em: Date | null; telegram_message_id: string | null; dm_status: string | null; v_user: string | null };
const atendimento = async (codigo: string): Promise<Atd | undefined> => (await banco.consultar(
  `SELECT a.*, v.telegram_user_id v_user FROM atendimentos a LEFT JOIN vendedores v ON v.id = a.vendedor_id WHERE a.codigo = $1`, [codigo])).rows[0];
const saidas = async (codigo: string): Promise<string[]> => (await banco.consultar(
  `SELECT m.texto FROM mensagens m JOIN atendimentos a ON a.id = m.atendimento_id WHERE a.codigo = $1 AND m.direcao = 'SAIDA' ORDER BY m.criado_em, m.id`, [codigo])).rows.map((r: { texto: string }) => r.texto);

// Memória × banco (mesma comparação do 5b).
async function comparar(tel: string, rotulo: string) {
  const mem = webhook.lerEstadoEspelhavel(chat(tel));
  const db = mem ? await atendimento(mem.codigo) : undefined;
  const campo = (v: string | null) => v ?? "Não informado";
  const difs: string[] = [];
  if (!mem || !db) difs.push(`memória=${!!mem} banco=${!!db}`);
  else {
    const pares: [string, unknown, unknown][] = [
      ["status", db.status, mem.status], ["etapa_atual", db.etapa_atual, mem.triagem.etapaAtual], ["perguntas_etapa", db.perguntas_etapa, mem.triagem.perguntasEtapa],
      ["etapas_puladas", JSON.stringify(db.etapas_puladas), JSON.stringify(mem.triagem.etapasPuladas)],
      ["apresentacao_pendente", db.apresentacao_pendente, mem.triagem.apresentacaoPendente],
      ["quantidade_nao_aplicavel", db.quantidade_nao_aplicavel, mem.triagem.quantidadeNaoAplicavel],
      ["nome", campo(db.nome), mem.resumo.nome], ["produto", campo(db.produto), mem.resumo.produto],
      ["quantidade", campo(db.quantidade), mem.resumo.quantidade], ["observacoes", campo(db.observacoes), mem.resumo.observacoes],
    ];
    for (const [nome, b, m] of pares) if (b !== m) difs.push(`${nome}: banco=${String(b)} memória=${String(m)}`);
  }
  ok(difs.length === 0, `memória × banco ${rotulo}${difs.length ? " → " + difs.join("; ") : ""}`);
}

// Reinício simulado: memória zerada + a recuperação da partida + pendências (como iniciarWebhook faz).
async function reiniciar() {
  webhook.redefinirEstadoWebhookParaTestes();
  const r = await webhook.recuperarNaPartida();
  if (r.ok) await T.reenviarPendenciasRecuperadas(r.resumosNaoPublicados);
  await espera(300);
  return r;
}

const TEL = (n: number) => `55919000009${String(n).padStart(2, "0")}`;

out("== Preparação antes do reinício ==");
// (1) triagem no meio: nome preenchido, quantidade pulada (não aplicável), etapa produto.
await mensagem(TEL(1), "oi");
qtdAplicavel = false;
await mensagem(TEL(1), "Ana");
qtdAplicavel = true;
const memAntes1 = JSON.stringify(webhook.lerEstadoEspelhavel(chat(TEL(1))));
const cod1 = webhook.lerEstadoEspelhavel(chat(TEL(1)))!.codigo;
await comparar(TEL(1), "antes do reinício (triagem no meio)");
// (2) apresentação pendente: a 1ª resposta não foi entregue.
graphAceita = false;
await mensagem(TEL(2), "oi");
graphAceita = true;
// (4) inativo: aberto, mas com a última atividade há 25 min.
await mensagem(TEL(4), "oi");
const cod4 = webhook.lerEstadoEspelhavel(chat(TEL(4)))!.codigo;
await banco.consultar("UPDATE atendimentos SET ultima_atividade_em = to_timestamp($2) WHERE codigo = $1", [cod4, (Date.now() - 25 * 60_000) / 1000]);
// (6) já assumido antes do reinício (V1).
await start(V1, "Teste Vendedor Um");
await start(V2, "Teste Vendedor Dois");
const E = await novoAtendimentoCompleto(TEL(6));
ok((await clique(V1, "Teste Vendedor Um", E.codigo, E.msg))?.startsWith("Atendimento assumido!") === true, "(6) V1 assumiu antes do reinício");
// (5) resumo publicado e pendente.
const D = await novoAtendimentoCompleto(TEL(5));
// (7) HUMANO sem resumo publicado.
falharResumo = true;
const F = await novoAtendimentoCompleto(TEL(7));
falharResumo = false;
ok(F.msg === -1 && (await atendimento(F.codigo))?.telegram_message_id === null, "(7) resumo não publicado antes do reinício");
// (8) DM FALHOU e DM ENVIANDO (caiu no meio).
const G = await novoAtendimentoCompleto(TEL(8));
falharDM.add(V1);
await clique(V1, "Teste Vendedor Um", G.codigo, G.msg);
falharDM.delete(V1);
const H = await novoAtendimentoCompleto(TEL(9));
await clique(V1, "Teste Vendedor Um", H.codigo, H.msg);
await banco.consultar("UPDATE atendimentos SET dm_status = 'ENVIANDO' WHERE codigo = $1", [H.codigo]);
ok((await atendimento(G.codigo))?.dm_status === "FALHOU" && (await atendimento(H.codigo))?.dm_status === "ENVIANDO", "(8) dm_status FALHOU e ENVIANDO antes do reinício");
// (9) resumo pendente; depois do reinício o banco passa a ter ESTE vendedor com a DM FALHOU.
const I = await novoAtendimentoCompleto(TEL(10));
// (10) fora do TTL do lock (resumo de 25 h atrás).
const J = await novoAtendimentoCompleto(TEL(11));
await banco.consultar("UPDATE atendimentos SET resumo_enviado_em = to_timestamp($2) WHERE codigo = $1", [J.codigo, (Date.now() - 25 * 3_600_000) / 1000]);

out("\n== Reinício ==");
const dmsV1Antes = dmsPara(V1).length;
const r1 = await reiniciar();
ok(r1.ok && logs.some((l) => l.startsWith("[Recuperação] concluída")), "recuperação concluída");
const logRec = [...logs].reverse().find((l) => l.startsWith("[Recuperação] concluída")) ?? "";
ok(!/5591|meta:|Ana|Cliente/.test(logRec), `log da recuperação só com contagens (${logRec.replace("[Recuperação] concluída | ", "")})`);

out("\n== (1) Triagem no meio ==");
ok(JSON.stringify(webhook.lerEstadoEspelhavel(chat(TEL(1)))) === memAntes1, "memória depois do reinício = memória antes do reinício");
await comparar(TEL(1), "depois do reinício");
const n1 = chamadasClaude.length;
await mensagem(TEL(1), "cimento");
const hist = chamadasClaude[n1]!;
const s1 = await saidas(cod1);
ok(webhook.lerEstadoEspelhavel(chat(TEL(1)))?.codigo === cod1 && s1.at(-1) === "Tem alguma observação que você gostaria de acrescentar para o vendedor?",
  "próxima mensagem continua da etapa certa (produto → observações), mesmo codigo, sem reapresentar");
await comparar(TEL(1), "depois da mensagem seguinte");

out("\n== (3) Histórico recuperado ==");
const esperado = ["user:oi", `assistant:${s1[0]}`, "user:Ana", `assistant:${s1[1]}`];
const recebido = hist.slice(0, -1).map((m: any) => `${m.role}:${m.content}`);
ok(JSON.stringify(recebido) === JSON.stringify(esperado), `histórico enviado ao Claude = ENTRADA/SAIDA do atendimento, em ordem (${recebido.length} mensagens + a atual)`);

out("\n== (2) Apresentação pendente ==");
ok(webhook.lerEstadoEspelhavel(chat(TEL(2)))?.triagem.apresentacaoPendente === true, "continua pendente depois do reinício");
await mensagem(TEL(2), "oi de novo");
const cod2 = webhook.lerEstadoEspelhavel(chat(TEL(2)))!.codigo;
ok((await saidas(cod2))[0]?.startsWith("Olá!") === true, "a próxima resposta traz a apresentação");

out("\n== (4) Inativo ==");
const a4 = await atendimento(cod4);
ok(a4?.encerrado_em !== null && webhook.lerEstadoEspelhavel(chat(TEL(4))) === null, "encerrado na partida e não reconstruído");
const n4 = chamadasClaude.length;
await mensagem(TEL(4), "oi");
const novo4 = webhook.lerEstadoEspelhavel(chat(TEL(4)))?.codigo;
ok(!!novo4 && novo4 !== cod4 && chamadasClaude[n4]!.length === 1 && (await saidas(novo4!))[0]?.startsWith("Olá!") === true,
  "nova mensagem abre atendimento novo (codigo novo, sem histórico antigo, com apresentação)");

out("\n== (5) Resumo publicado e pendente ==");
// V2 nunca assumiu: não está em vendedores e precisa do /start de novo depois do reinício.
await start(V2, "Teste Vendedor Dois");
const r5 = await clique(V1, "Teste Vendedor Um", D.codigo, D.msg);
const r5b = await clique(V2, "Teste Vendedor Dois", D.codigo, D.msg);
ok(r5?.startsWith("Atendimento assumido!") === true && (await atendimento(D.codigo))?.v_user === String(V1), "clique depois da recuperação assume (V1 voltou do banco de vendedores)");
ok(r5b === "Este atendimento já foi assumido por outro vendedor (Teste Vendedor Um).", `outro clique: "${r5b}"`);

out("\n== (6) Já assumido antes do reinício ==");
const r6 = await clique(V2, "Teste Vendedor Dois", E.codigo, E.msg);
ok(r6 === "Este atendimento já foi assumido por outro vendedor (Teste Vendedor Um).", `clique de outro vendedor: "${r6}"`);

out("\n== (7) HUMANO sem resumo publicado ==");
ok(resumoDo(F.codigo).length === 1 && (await atendimento(F.codigo))?.telegram_message_id !== null, "resumo publicado depois da recuperação (uma vez) e gravado no banco");

out("\n== (8) DM ENVIANDO e FALHOU ==");
const dmsNovas = dmsPara(V1).slice(dmsV1Antes);
ok(dmsNovas.length >= 2 && (await atendimento(G.codigo))?.dm_status === "ENVIADA" && (await atendimento(H.codigo))?.dm_status === "ENVIADA",
  `DMs reenviadas depois da recuperação (${dmsNovas.length}); dm_status ENVIADA nas duas`);

out("\n== (9) Banco já tem ESTE vendedor com a DM FALHOU ==");
const v1Id = (await banco.consultar("SELECT id FROM vendedores WHERE telegram_user_id = $1", [V1])).rows[0].id;
await banco.consultar("UPDATE atendimentos SET vendedor_id = $2, assumido_em = now(), status = 'HUMANO', encerrado_em = COALESCE(encerrado_em, now()), dm_status = 'FALHOU' WHERE codigo = $1", [I.codigo, v1Id]);
const dms9 = dmsPara(V1).length;
const r9 = await clique(V1, "Teste Vendedor Um", I.codigo, I.msg);
ok(r9 === "Você já assumiu este atendimento." && dmsPara(V1).length === dms9 + 1 && (await atendimento(I.codigo))?.dm_status === "ENVIADA",
  "responde \"já assumiu\", reenvia a DM e o dm_status vira ENVIADA");

out("\n== (10) Fora do TTL ==");
const r10 = await clique(V1, "Teste Vendedor Um", J.codigo, J.msg);
ok(r10 === "Este atendimento não está mais disponível." && (await atendimento(J.codigo))?.v_user === null, "resumo de 25 h atrás não voltou para o lock (clique indisponível)");

out("\n== (11) Banco fora na recuperação ==");
const pool = banco.obterPool();
const connectOriginal = pool.connect.bind(pool);
(pool as any).connect = (...a: unknown[]) => (a.length === 0 ? Promise.reject(Object.assign(new Error("conexão recusada (simulada)"), { code: "ECONNREFUSED" })) : (connectOriginal as any)(...a));
const r11 = await reiniciar();
(pool as any).connect = connectOriginal;
ok(!r11.ok && webhook.lerEstadoEspelhavel(chat(TEL(1))) === null && logs.some((l) => l.includes("ATENÇÃO: banco indisponível na partida (ECONNREFUSED)")),
  "memória vazia, aviso em destaque com o código");
ok((await mensagem(TEL(12), "oi")) === 200 && !!webhook.lerEstadoEspelhavel(chat(TEL(12))), "webhook aceito e processado depois");

out("\n== (12) Recuperação lenta (statement_timeout) ==");
await reiniciar();
await mensagem(TEL(13), "oi");
const cod13 = webhook.lerEstadoEspelhavel(chat(TEL(13)))!.codigo;
await banco.consultar("UPDATE atendimentos SET ultima_atividade_em = to_timestamp($2) WHERE codigo = $1", [cod13, (Date.now() - 25 * 60_000) / 1000]);
const trava = await banco.obterConexao();
await trava.query("BEGIN");
await trava.query("SELECT id FROM atendimentos WHERE codigo = $1 FOR UPDATE", [cod13]);
const t0 = Date.now();
const r12 = await reiniciar();
const dt = Date.now() - t0;
await trava.query("ROLLBACK");
trava.release();
ok(!r12.ok && dt >= 4_500 && dt < 30_000 && logs.some((l) => l.includes("ATENÇÃO: banco indisponível na partida (57014)")),
  `recuperação cancelada pelo statement_timeout em ${(dt / 1000).toFixed(1)} s (< 30 s); sobe com memória vazia`);

out("\n== 5d.1: /start grava em vendedores ==");
const V3 = 990_000_000_103, V4 = 990_000_000_104, V5 = 990_000_000_105;
const linhaVendedor = async (id: number) =>
  (await banco.consultar("SELECT nome, telegram_chat_id, ativo FROM vendedores WHERE telegram_user_id = $1", [id])).rows[0];
await start(V3, "Teste Vendedor Tres");
const lv3 = await linhaVendedor(V3);
ok(lv3?.nome === "Teste Vendedor Tres" && lv3?.telegram_chat_id === String(V3) && lv3?.ativo === true, "/start aceito grava o vendedor (nome, chat privado, ativo)");
const K = await novoAtendimentoCompleto(TEL(14));
await reiniciar();
const rK = await clique(V3, "Teste Vendedor Tres", K.codigo, K.msg);
ok(rK?.startsWith("Atendimento assumido!") === true && (await atendimento(K.codigo))?.v_user === String(V3),
  "vendedor que só fez /start volta na partida e assume sem novo /start");

(pool as any).connect = (...a: unknown[]) => (a.length === 0 ? Promise.reject(Object.assign(new Error("conexão recusada (simulada)"), { code: "ECONNREFUSED" })) : (connectOriginal as any)(...a));
await start(V4, "Teste Vendedor Quatro");
(pool as any).connect = connectOriginal;
const logFalha = logs.find((l) => l.includes("falha ao registrar o vendedor do /start"));
ok((await linhaVendedor(V4)) === undefined && logFalha === "[Persistência] falha ao registrar o vendedor do /start (ECONNREFUSED).",
  "/start com banco fora: nada gravado; log só com o código");
const L = await novoAtendimentoCompleto(TEL(15));
ok((await clique(V4, "Teste Vendedor Quatro", L.codigo, L.msg))?.startsWith("Atendimento assumido!") === true, "o /start continuou valendo pela memória (assume)");

statusPorUsuario.set(V5, "left");
await start(V5, "Teste Fora");
const ultimaV5 = telegram.filter((c) => c.metodo === "sendMessage" && c.corpo.chat_id === V5).at(-1)?.corpo.text;
ok((await linhaVendedor(V5)) === undefined && ultimaV5 === "Você não faz parte da equipe de vendedores da Loja Ideal.", "/start recusado não grava em vendedores");

statusPorUsuario.set(V3, "administrator");
await tg({ update_id: upd++, message: { message_id: 1, chat: { id: V3, type: "private" }, from: { id: V3, first_name: "Teste Vendedor Tres" }, text: "/ranking" } });
await espera();
const logRanking = [...logs].reverse().find((l) => l.startsWith("[Telegram] /ranking respondido")) ?? "";
ok(/^\[Telegram\] \/ranking respondido \((\d+ vendedores|vazio)\)$/.test(logRanking) && !logRanking.includes("Teste") && !logRanking.includes(String(V3)),
  `/ranking com sucesso gera o log novo, sem nome nem ID ("${logRanking}")`);

ok(externas.length === 0, `nenhuma chamada de rede externa (${externas.length})`);
const senha = process.env.DB_PASSWORD ?? "";
ok(!senha || !logs.some((l) => l.includes(senha)), "nenhum log com a senha do banco");

out("\n== Limpeza ==");
await espera(500);
const ev = (await banco.consultar("DELETE FROM eventos_processados WHERE mensagem_externa_id LIKE 'teste-5d-%'")).rowCount;
const { limparEspelhoDeTeste } = await import(B + "/tests/limpeza-espelho.mts");
const espelho = await limparEspelhoDeTeste(banco.consultar);
const sobraV = Number((await banco.consultar("SELECT count(*) n FROM vendedores WHERE telegram_user_id BETWEEN 990000000000 AND 990000999999")).rows[0].n);
ok(espelho.restantes === 0 && sobraV === 0,
  `apagados: ${ev} eventos, ${espelho.atendimentos} atendimentos, ${espelho.clientes} clientes, ${espelho.vendedores} vendedores; restantes = ${espelho.restantes + sobraV}`);
await banco.encerrarBanco();

out(falhas ? `\n${total} verificações | ${falhas} FALHA(S)` : `\n${total} verificações | TODOS OS TESTES PASSARAM`);
await new Promise((r) => setTimeout(r, 300));
process.exit(falhas ? 1 : 0);
