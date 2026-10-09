// Passo 5c: assunção gravada no banco (segundo portão) + /ranking.
// Servidor real + banco de testes (loja_ideal_teste). Chats de teste "meta:999:<telefone fictício 55919000007xx>",
// wamids "teste-5c-...", vendedores com telegram_user_id na faixa FICTÍCIA 990000000001.. (limpeza-espelho.mts).
// Claude, Meta e Telegram simulados (sem getUpdates, sem chamadas reais); rede externa bloqueada.
// Banco de TESTES (loja_ideal_teste) fixado antes de qualquer import de src/; loja_ideal é dado real.
const { exigirBancoDeTeste } = await import(new URL("./banco-teste.mts", import.meta.url).href);
import { createHmac } from "node:crypto";

Object.assign(process.env, {
  PORT: "39881",
  META_APP_SECRET: "meta-secret-teste",
  META_ENVIO_ATIVO: "false",
  META_ACCESS_TOKEN: "meta-token-falso",
  META_PHONE_NUMBER_ID: "999",
  META_GRAPH_VERSION: "v26.0",
  TELEGRAM_BOT_TOKEN: "123456:TOKEN-FALSO",
  TELEGRAM_CHAT_ID: "-1009999999999",
  TELEGRAM_WEBHOOK_SECRET: "segredo-teste-5c",
  ANTHROPIC_API_KEY: "anthropic-falso",
});
const BASE = "http://127.0.0.1:39881";
const GRUPO = -1009999999999;

// Relógio controlado: quarta 07/10/2026 10:00 em Belém (loja aberta).
const agoraReal = Date.now.bind(Date);
const desloc = Date.parse("2026-10-07T10:00:00-03:00") - agoraReal();
Date.now = () => agoraReal() + desloc;

// Vendedores fictícios (chat privado = user_id).
const V1 = 990_000_000_001, V2 = 990_000_000_002, ADMIN = 990_000_000_003, MEMBRO = 990_000_000_004, OUTRO = 990_000_000_009;

// ---- Bot API simulada ----
type Chamada = { metodo: string; corpo: any };
const telegram: Chamada[] = [];
const statusPorUsuario = new Map<number, string>([[V1, "member"], [V2, "member"], [ADMIN, "administrator"], [MEMBRO, "member"]]);
let falharResumo = false;
const falharDM = new Set<number>();
let msgId = 5000;
const externas: string[] = [];
const fetchReal = globalThis.fetch;
(globalThis as any).fetch = async (url: any, init: any) => {
  const u = new URL(String(url));
  if (u.hostname === "127.0.0.1") return fetchReal(url, init);
  const m = /^\/bot[^/]+\/(\w+)$/.exec(u.pathname);
  if (u.hostname === "api.telegram.org" && m) {
    const corpo = JSON.parse(init.body);
    telegram.push({ metodo: m[1]!, corpo });
    const resp = (o: any) => ({ status: o.ok ? 200 : 400, json: async () => o });
    if (m[1] === "getChatMember") {
      const s = statusPorUsuario.get(corpo.user_id) ?? "left";
      return s === "ERRO" ? resp({ ok: false, error_code: 400, description: "erro simulado" }) : resp({ ok: true, result: { status: s } });
    }
    if (m[1] === "sendMessage") {
      if ((String(corpo.chat_id) === String(GRUPO) && falharResumo) || falharDM.has(corpo.chat_id)) {
        return resp({ ok: false, error_code: 403, description: "falha simulada" });
      }
      return resp({ ok: true, result: { message_id: msgId++, chat: { id: Number(corpo.chat_id) } } });
    }
    return resp({ ok: true, result: true });
  }
  externas.push(u.hostname);
  throw new Error("rede externa bloqueada no teste");
};

// Claude simulado: "pedido completo" preenche os 4 campos → triagem concluída → resumo no grupo.
const B = new URL("..", import.meta.url).href.replace(/\/$/, "");
const { default: Anthropic } = await import(B + "/node_modules/@anthropic-ai/sdk/index.mjs");
(Anthropic as any).Messages.prototype.parse = async function () {
  return { model: "stub", usage: { input_tokens: 0, output_tokens: 0 }, parsed_output: { resposta: "", status: "IA", quantidade_aplicavel: true,
    resumo: { nome: "Cliente Teste 5c", produto: "Cimento", quantidade: "10 sacos", observacoes: "Nenhuma observação adicional." } } };
};

const logs: string[] = [];
const out = console.log.bind(console);
for (const k of ["log", "warn", "error"] as const) console[k] = (...a: unknown[]) => { logs.push(a.join(" ")); };

const webhook = await import(B + "/src/webhook.ts");
const banco = await import(B + "/src/banco.ts");
await exigirBancoDeTeste(banco.consultar);
webhook.iniciarWebhook();
await new Promise((r) => setTimeout(r, 400));

let falhas = 0, total = 0;
const ok = (c: boolean, t: string) => { total++; if (!c) falhas++; out(`${c ? "OK  " : "FAIL"} ${t}`); };
const espera = (ms = 600) => new Promise((r) => setTimeout(r, ms));
const chat = (tel: string) => `meta:999:${tel}`;

let seq = 0;
async function mensagem(tel: string, texto: string) {
  const corpo = JSON.stringify({ object: "whatsapp_business_account", entry: [{ id: "1", changes: [{ field: "messages", value: {
    messaging_product: "whatsapp", metadata: { phone_number_id: "999" },
    messages: [{ id: `teste-5c-${++seq}`, from: tel, timestamp: String(Math.floor(Date.now() / 1000)), type: "text", text: { body: texto } }] } }] }] });
  const sig = "sha256=" + createHmac("sha256", "meta-secret-teste").update(corpo).digest("hex");
  await fetchReal(BASE + "/meta/webhook", { method: "POST", headers: { "Content-Type": "application/json", "X-Hub-Signature-256": sig }, body: corpo });
  await espera();
}
// Triagem concluída numa mensagem; devolve codigo e message_id do resumo no grupo.
async function novoAtendimento(tel: string) {
  await mensagem(tel, "pedido completo");
  const codigo = webhook.lerEstadoEspelhavel(chat(tel))?.codigo ?? "";
  const resumo = [...telegram].reverse().find((c) => c.metodo === "sendMessage" && String(c.corpo.chat_id) === String(GRUPO)
    && c.corpo.reply_markup?.inline_keyboard?.[0]?.[0]?.callback_data === `assumir:${codigo}`);
  return { codigo, msg: msgId - 1, publicado: !!resumo && !falharResumo };
}
let upd = 1;
const tg = (u: unknown) => fetchReal(BASE + "/telegram/webhook", { method: "POST",
  headers: { "Content-Type": "application/json", "X-Telegram-Bot-Api-Secret-Token": "segredo-teste-5c" }, body: JSON.stringify(u) });
const privado = async (id: number, nome: string, texto: string) => {
  await tg({ update_id: upd++, message: { message_id: 1, chat: { id, type: "private" }, from: { id, first_name: nome }, text: texto } });
  await espera();
};
let cb = 0;
async function clique(id: number, nome: string, codigo: string, msg: number, aguardar = 800) {
  const cbId = `cb-5c-${++cb}`;
  await tg({ update_id: upd++, callback_query: { id: cbId, from: { id, first_name: nome }, data: `assumir:${codigo}`, message: { message_id: msg, chat: { id: GRUPO, type: "supergroup" } } } });
  await espera(aguardar);
  return cbId;
}
const respostaDo = (cbId: string) => telegram.find((c) => c.metodo === "answerCallbackQuery" && c.corpo.callback_query_id === cbId)?.corpo;
const ultimaPara = (id: number) => telegram.filter((c) => c.metodo === "sendMessage" && c.corpo.chat_id === id).at(-1)?.corpo.text as string | undefined;
type Linha = { codigo: string; status: string; vendedor_id: string | null; assumido_em: Date | null; encerrado_em: Date | null; dm_status: string | null;
  telegram_chat_id: string | null; telegram_message_id: string | null; resumo_enviado_em: Date | null; v_user: string | null; v_nome: string | null;
  v_chat: string | null; v_ativo: boolean | null };
const linha = async (codigo: string): Promise<Linha | undefined> => (await banco.consultar(
  `SELECT a.codigo, a.status, a.vendedor_id, a.assumido_em, a.encerrado_em, a.dm_status, a.telegram_chat_id, a.telegram_message_id, a.resumo_enviado_em,
          v.telegram_user_id v_user, v.nome v_nome, v.telegram_chat_id v_chat, v.ativo v_ativo
     FROM atendimentos a LEFT JOIN vendedores v ON v.id = a.vendedor_id WHERE a.codigo = $1`, [codigo])).rows[0];
const assumidoNaMemoria = (codigo: string) => logs.some((l) => l.includes(`Atendimento ${codigo} assumido por vendedor via Telegram`));
const pool = banco.obterPool();
const connectOriginal = pool.connect.bind(pool);
const bancoFora = () => { (pool as any).connect = (...a: unknown[]) => (a.length === 0 ? Promise.reject(Object.assign(new Error("conexão recusada (simulada)"), { code: "ECONNREFUSED" })) : (connectOriginal as any)(...a)); };
const bancoVolta = () => { (pool as any).connect = connectOriginal; };

// Segurança: nada de teste antes de começar.
const previos = Number((await banco.consultar("SELECT (SELECT count(*) FROM atendimentos WHERE chat_id LIKE 'meta:999:%') + (SELECT count(*) FROM vendedores WHERE telegram_user_id BETWEEN 990000000000 AND 990000999999) n")).rows[0].n);
if (previos !== 0) { out(`ABORTADO: já existem ${previos} registros de teste`); process.exit(1); }

out("== /ranking sem nenhuma assunção ==");
const assumidosNoBanco = Number((await banco.consultar("SELECT count(*) n FROM atendimentos WHERE vendedor_id IS NOT NULL")).rows[0].n);
if (assumidosNoBanco === 0) {
  await privado(ADMIN, "Teste Admin", "/ranking");
  ok(ultimaPara(ADMIN) === "Nenhum atendimento assumido ainda.", "banco sem assunções → \"Nenhum atendimento assumido ainda.\"");
} else out("(pulado: o banco já tem assunções fora dos testes)");

for (const [id, nome] of [[V1, "Teste Vendedor Um"], [V2, "Teste Vendedor Dois"]] as const) await privado(id, nome, "/start");

out("\n== 1. Resumo publicado ==");
const A = await novoAtendimento("5591900000701");
let la = await linha(A.codigo);
ok(A.publicado && la?.telegram_chat_id === String(GRUPO) && la?.telegram_message_id === String(A.msg) && la?.resumo_enviado_em !== null,
  "telegram_chat_id, telegram_message_id e resumo_enviado_em gravados");
falharResumo = true;
const Rb = await novoAtendimento("5591900000702");
falharResumo = false;
const antesRetry = await linha(Rb.codigo);
const T = await import(B + "/src/telegramBot.ts");
await T.reenviarResumosTelegramPendentes();
const depoisRetry = await linha(Rb.codigo);
ok(antesRetry?.telegram_message_id === null && depoisRetry?.telegram_message_id === String(msgId - 1) && depoisRetry?.resumo_enviado_em !== null,
  "envio falhou → nada gravado; retry publicado → grava a mensagem que está valendo");
const espelhoAss = await import(B + "/src/persistenciaAssuncao.ts");
await espelhoAss.registrarResumoPublicado(Rb.codigo, GRUPO, 777777);
ok((await linha(Rb.codigo))?.telegram_message_id === "777777", "republicação atualiza telegram_message_id");

out("\n== 2. Assunção normal ==");
const c2 = await clique(V1, "Teste Vendedor Um", A.codigo, A.msg);
la = await linha(A.codigo);
ok(respostaDo(c2)?.text.startsWith("Atendimento assumido!") && assumidoNaMemoria(A.codigo), "resposta de assumido; memória marcada (HUMANO)");
ok(la?.v_user === String(V1) && la?.v_nome === "Teste Vendedor Um" && la?.v_chat === String(V1) && la?.v_ativo === true,
  "vendedor criado (telegram_user_id, nome, chat privado, ativo)");
ok(la?.status === "HUMANO" && la?.assumido_em !== null && la?.encerrado_em !== null && la?.dm_status === "ENVIADA",
  "atendimento: vendedor_id, assumido_em, status HUMANO, encerrado_em, dm_status ENVIADA (CHECKs respeitados)");

out("\n== 3. DM falhando ==");
const C = await novoAtendimento("5591900000703");
falharDM.add(V1);
await clique(V1, "Teste Vendedor Um", C.codigo, C.msg);
falharDM.delete(V1);
const lc = await linha(C.codigo);
ok(lc?.v_user === String(V1) && lc?.dm_status === "FALHOU" && assumidoNaMemoria(C.codigo), "dm_status FALHOU e a assunção continua válida");

out("\n== 4. Mesmo vendedor clicando duas vezes ==");
const D = await novoAtendimento("5591900000704");
await clique(V1, "Teste Vendedor Um", D.codigo, D.msg);
const c4 = await clique(V1, "Teste Vendedor Um", D.codigo, D.msg);
const nV1 = Number((await banco.consultar("SELECT count(*) n FROM vendedores WHERE telegram_user_id = $1", [V1])).rows[0].n);
ok(respostaDo(c4)?.text === "Você já assumiu este atendimento." && nV1 === 1 && (await linha(D.codigo))?.v_user === String(V1),
  "segundo clique: \"já assumiu\"; uma linha só em vendedores");

out("\n== 5. Dois vendedores ao mesmo tempo ==");
const E = await novoAtendimento("5591900000705");
const [e1, e2] = await Promise.all([clique(V1, "Teste Vendedor Um", E.codigo, E.msg), clique(V2, "Teste Vendedor Dois", E.codigo, E.msg)]);
const venc = [[V1, e1], [V2, e2]].filter(([, id]) => respostaDo(String(id))?.text.startsWith("Atendimento assumido!"));
const perd = [[V1, e1], [V2, e2]].filter(([, id]) => respostaDo(String(id))?.text.startsWith("Este atendimento já foi assumido"));
ok(venc.length === 1 && perd.length === 1 && (await linha(E.codigo))?.v_user === String(venc[0]![0]),
  `um vence (user ${String(venc[0]?.[0]).slice(-1)}), o outro recebe "já assumido"; o banco mostra o vencedor`);

out("\n== 6. Banco já com OUTRO vendedor (simula pós-reinício) ==");
const F = await novoAtendimento("5591900000706");
const outro = (await banco.consultar("INSERT INTO vendedores (telegram_user_id, nome, telegram_chat_id, ativo) VALUES ($1, 'Teste Outro', $1, TRUE) RETURNING id", [OUTRO])).rows[0].id;
await banco.consultar("UPDATE atendimentos SET vendedor_id = $2, assumido_em = now(), status = 'HUMANO', encerrado_em = COALESCE(encerrado_em, now()), dm_status = 'ENVIADA' WHERE codigo = $1", [F.codigo, outro]);
const dmsAntes = telegram.filter((c) => c.metodo === "sendMessage" && c.corpo.chat_id === V1).length;
const c6 = await clique(V1, "Teste Vendedor Um", F.codigo, F.msg);
const lf = await linha(F.codigo);
ok(respostaDo(c6)?.text === "Este atendimento já foi assumido por outro vendedor." && respostaDo(c6)?.show_alert === true, "resposta \"já assumido\" (alerta)");
ok(!assumidoNaMemoria(F.codigo) && telegram.filter((c) => c.metodo === "sendMessage" && c.corpo.chat_id === V1).length === dmsAntes &&
   !telegram.some((c) => c.metodo === "editMessageText" && c.corpo.message_id === F.msg), "memória NÃO marcada: sem HUMANO, sem DM, grupo não editado");
ok(lf?.v_user === String(OUTRO) && logs.some((l) => l.includes(`${F.codigo}: o banco já registra outro vendedor`)), "banco continua com o outro vendedor; recusa logada");

out("\n== 7a. Banco fora no clique ==");
const G = await novoAtendimento("5591900000707");
bancoFora();
const c7 = await clique(V1, "Teste Vendedor Um", G.codigo, G.msg);
bancoVolta();
const c7b = await clique(V2, "Teste Vendedor Dois", G.codigo, G.msg);
ok(respostaDo(c7)?.text.startsWith("Atendimento assumido!") && assumidoNaMemoria(G.codigo), "assunção segue pela memória");
ok(respostaDo(c7b)?.text.startsWith("Este atendimento já foi assumido por outro vendedor"), "lock em memória consistente: o 2º vendedor recebe \"já assumido\" (nada travado)");
ok(logs.some((l) => l.includes(`falha ao registrar a assunção de ${G.codigo} (ECONNREFUSED)`)) && (await linha(G.codigo))?.vendedor_id === null,
  "erro logado só com o código; nada gravado no banco");

out("\n== 7b. Banco travado (statement_timeout) ==");
const H = await novoAtendimento("5591900000708");
const trava = await banco.obterConexao();
await trava.query("BEGIN");
await trava.query("SELECT id FROM atendimentos WHERE codigo = $1 FOR UPDATE", [H.codigo]);
const t0 = Date.now();
const c7c = await clique(V2, "Teste Vendedor Dois", H.codigo, H.msg, 100);
for (let i = 0; i < 80 && !respostaDo(c7c); i++) await espera(250);
const dt = Date.now() - t0;
await espera(6_000); // a gravação da DM também espera o lock e cai no timeout
await trava.query("ROLLBACK");
trava.release();
ok(respostaDo(c7c)?.text.startsWith("Atendimento assumido!") && dt >= 4_500 && dt < 9_000 && assumidoNaMemoria(H.codigo),
  `assunção segue pela memória depois do timeout (${(dt / 1000).toFixed(1)} s)`);
ok(logs.some((l) => l.includes(`falha ao registrar a assunção de ${H.codigo} (57014)`)) && (await linha(H.codigo))?.vendedor_id === null,
  "timeout logado (57014); nada gravado pela metade");

out("\n== 8. Linha inexistente no banco ==");
bancoFora();
await mensagem("5591900000709", "pedido completo"); // espelho falha: a linha nunca nasce
bancoVolta();
const codI = webhook.lerEstadoEspelhavel(chat("5591900000709"))?.codigo ?? "";
const c8 = await clique(V1, "Teste Vendedor Um", codI, msgId - 1);
ok(respostaDo(c8)?.text.startsWith("Atendimento assumido!") && assumidoNaMemoria(codI) && (await linha(codI)) === undefined,
  "assunção segue pela memória; nada criado no banco");

out("\n== 9. Passo 1 falhou: a assunção grava os IDs do Telegram do callback ==");
const J = await novoAtendimento("5591900000710");
await banco.consultar("UPDATE atendimentos SET telegram_chat_id = NULL, telegram_message_id = NULL, resumo_enviado_em = NULL WHERE codigo = $1", [J.codigo]);
await clique(V1, "Teste Vendedor Um", J.codigo, J.msg);
const lj = await linha(J.codigo);
ok(lj?.v_user === String(V1) && lj?.telegram_chat_id === String(GRUPO) && lj?.telegram_message_id === String(J.msg) && lj?.resumo_enviado_em !== null,
  "vendedor gravado e telegram_chat_id/message_id/resumo_enviado_em vindos do callback");

out("\n== 10. Nome do vendedor mudou no Telegram ==");
const K = await novoAtendimento("5591900000711");
await clique(V1, "Teste Vendedor Um Renomeado", K.codigo, K.msg);
const nomeV1 = (await banco.consultar("SELECT nome FROM vendedores WHERE telegram_user_id = $1", [V1])).rows[0]?.nome;
ok(nomeV1 === "Teste Vendedor Um Renomeado", "vendedores.nome atualizado com o nome atual do Telegram");

out("\n== 11. /ranking ==");
// Um atendimento do V1 assumido no mês anterior (America/Belem).
await banco.consultar(`UPDATE atendimentos SET assumido_em = (date_trunc('month', now() AT TIME ZONE 'America/Belem') AT TIME ZONE 'America/Belem') - interval '1 day' WHERE codigo = $1`, [A.codigo]);
const contagem = async (user: number) => (await banco.consultar(
  `SELECT count(*) FILTER (WHERE a.assumido_em >= date_trunc('month', now() AT TIME ZONE 'America/Belem') AT TIME ZONE 'America/Belem') mes, count(*) total
     FROM atendimentos a JOIN vendedores v ON v.id = a.vendedor_id WHERE v.telegram_user_id = $1`, [user])).rows[0];
const cV1 = await contagem(V1), cOutro = await contagem(OUTRO);
await privado(ADMIN, "Teste Admin", "/ranking");
const texto = ultimaPara(ADMIN) ?? "";
const lin = texto.split("\n");
const iV1 = lin.findIndex((l) => l.endsWith(`Teste Vendedor Um Renomeado: ${cV1.mes} no mês | ${cV1.total} no total`));
const iOutro = lin.findIndex((l) => l.endsWith(`Teste Outro: ${cOutro.mes} no mês | ${cOutro.total} no total`));
ok(texto.startsWith("🏆 ATENDIMENTOS ASSUMIDOS") && iV1 > 0 && iOutro > 0 && Number(cV1.total) - Number(cV1.mes) === 1,
  `admin no privado: contagem certa (V1 = ${cV1.mes} no mês, ${cV1.total} no total; 1 no mês anterior)`);
ok(iV1 < iOutro, "ordem decrescente do mês");
ok(!/meta:|ATD-|55919/.test(texto), "texto sem telefone de cliente nem código de atendimento");
await privado(MEMBRO, "Teste Membro", "/ranking");
ok(ultimaPara(MEMBRO) === "Esse comando é só para administradores do grupo.", "membro comum: negação");
const antesGrupo = telegram.length;
await tg({ update_id: upd++, message: { message_id: 2, chat: { id: GRUPO, type: "supergroup" }, from: { id: ADMIN, first_name: "Teste Admin" }, text: "/ranking" } });
await espera();
ok(telegram.length === antesGrupo, "no grupo: nenhuma chamada à Bot API (comando ignorado)");
statusPorUsuario.set(ADMIN, "ERRO");
await privado(ADMIN, "Teste Admin", "/ranking");
statusPorUsuario.set(ADMIN, "administrator");
ok(ultimaPara(ADMIN) === "Não consegui verificar sua participação na equipe agora. Tente novamente em instantes.", "getChatMember com erro: mensagem de erro técnico");
bancoFora();
await privado(ADMIN, "Teste Admin", "/ranking");
bancoVolta();
ok(ultimaPara(ADMIN) === "Não consegui consultar agora. Tente de novo em instantes.", "banco fora: mensagem de erro do ranking");
ok(!telegram.some((c) => c.metodo === "setMyCommands" || c.metodo === "getUpdates"), "sem setMyCommands nem getUpdates");

ok(externas.length === 0, `nenhuma chamada de rede externa (${externas.length})`);
const senha = process.env.DB_PASSWORD ?? "";
ok(!senha || !logs.some((l) => l.includes(senha)), "nenhum log com a senha do banco");

out("\n== Limpeza ==");
await espera(500);
const ev = (await banco.consultar("DELETE FROM eventos_processados WHERE mensagem_externa_id LIKE 'teste-5c-%'")).rowCount;
const { limparEspelhoDeTeste } = await import(B + "/tests/limpeza-espelho.mts");
const espelho = await limparEspelhoDeTeste(banco.consultar);
const sobraV = Number((await banco.consultar("SELECT count(*) n FROM vendedores WHERE telegram_user_id BETWEEN 990000000000 AND 990000999999")).rows[0].n);
ok(espelho.restantes === 0 && sobraV === 0,
  `apagados: ${ev} eventos, ${espelho.atendimentos} atendimentos, ${espelho.clientes} clientes, ${espelho.vendedores} vendedores; restantes = ${espelho.restantes + sobraV}`);
await banco.encerrarBanco();

out(falhas ? `\n${total} verificações | ${falhas} FALHA(S)` : `\n${total} verificações | TODOS OS TESTES PASSARAM`);
await new Promise((r) => setTimeout(r, 300));
process.exit(falhas ? 1 : 0);
