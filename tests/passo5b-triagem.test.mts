// Passo 5b: estado da triagem e mensagens espelhados no PostgreSQL (a memória continua sendo a verdade).
// Servidor real + banco de testes (loja_ideal_teste). Chat de teste: "meta:999:<telefone fictício 55919000006xx>",
// wamids "teste-5b-...". Claude, Telegram e Graph API simulados; rede externa bloqueada.
// Banco de TESTES (loja_ideal_teste) fixado antes de qualquer import de src/; loja_ideal é dado real.
const { exigirBancoDeTeste } = await import(new URL("./banco-teste.mts", import.meta.url).href);
import { createHmac } from "node:crypto";

Object.assign(process.env, {
  PORT: "39880",
  META_APP_SECRET: "meta-secret-teste",
  META_ENVIO_ATIVO: "true",
  META_ACCESS_TOKEN: "meta-token-falso",
  META_PHONE_NUMBER_ID: "999",
  META_GRAPH_VERSION: "v26.0",
  TELEGRAM_BOT_TOKEN: "123456:TOKEN-FALSO",
  TELEGRAM_CHAT_ID: "-1009999999999",
  TELEGRAM_WEBHOOK_SECRET: "segredo-teste-5b",
  ANTHROPIC_API_KEY: "anthropic-falso",
});
const BASE = "http://127.0.0.1:39880";

// Relógio controlado: quarta 07/10/2026 10:00 em Belém (loja aberta).
const agoraReal = Date.now.bind(Date);
let desloc = Date.parse("2026-10-07T10:00:00-03:00") - agoraReal();
Date.now = () => agoraReal() + desloc;

// Graph API simulada: aceita (devolve wamid) ou recusa com erro permanente (131047, sem retry).
let graphAceita = true;
let envios = 0;
let resp = 0;
const fetchReal = globalThis.fetch;
const externas: string[] = [];
(globalThis as any).fetch = async (url: any, init: any) => {
  const u = new URL(String(url));
  if (u.hostname === "127.0.0.1") return fetchReal(url, init);
  if (u.hostname === "graph.facebook.com") {
    envios++;
    if (!graphAceita) {
      return new Response(JSON.stringify({ error: { code: 131047, message: "recusado (simulado)" } }), { status: 400, headers: { "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify({ messaging_product: "whatsapp", messages: [{ id: `wamid.teste-5b-resp-${++resp}` }] }), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  const m = /^\/bot[^/]+\/(\w+)$/.exec(u.pathname);
  if (u.hostname === "api.telegram.org" && m) {
    return { status: 200, json: async () => ({ ok: true, result: m[1] === "sendMessage" ? { message_id: 1 } : true }) } as any;
  }
  externas.push(u.hostname);
  throw new Error("rede externa bloqueada no teste");
};

// Claude simulado: nunca preenche campos; o fallback determinístico da triagem usa o texto do cliente.
const B = new URL("..", import.meta.url).href.replace(/\/$/, "");
const { default: Anthropic } = await import(B + "/node_modules/@anthropic-ai/sdk/index.mjs");
let qtdAplicavel = true;
let chamadasClaude = 0;
let claudeFalha = false;
(Anthropic as any).Messages.prototype.parse = async function () {
  chamadasClaude++;
  if (claudeFalha) throw new Error("Claude indisponível (simulado)");
  return { model: "stub", usage: { input_tokens: 0, output_tokens: 0 }, parsed_output: { resposta: "", status: "IA", quantidade_aplicavel: qtdAplicavel,
    resumo: { nome: "Não informado", produto: "Não informado", quantidade: "Não informado", observacoes: "Não informado" } } };
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
const espera = (ms = 500) => new Promise((r) => setTimeout(r, ms));
const chat = (tel: string) => `meta:999:${tel}`;

let seq = 0;
async function mensagem(tel: string, texto: string, wamid = `teste-5b-${++seq}`) {
  const corpo = JSON.stringify({ object: "whatsapp_business_account", entry: [{ id: "1", changes: [{ field: "messages", value: {
    messaging_product: "whatsapp", metadata: { phone_number_id: "999" },
    messages: [{ id: wamid, from: tel, timestamp: String(Math.floor(Date.now() / 1000)), type: "text", text: { body: texto } }] } }] }] });
  const sig = "sha256=" + createHmac("sha256", "meta-secret-teste").update(corpo).digest("hex");
  const r = await fetchReal(BASE + "/meta/webhook", { method: "POST", headers: { "Content-Type": "application/json", "X-Hub-Signature-256": sig }, body: corpo });
  await espera();
  return { status: r.status, wamid };
}

type Atd = { id: string; codigo: string; status: string; etapa_atual: string | null; perguntas_etapa: number; etapas_puladas: string[];
  apresentacao_pendente: boolean; quantidade_nao_aplicavel: boolean; nome: string | null; produto: string | null; quantidade: string | null;
  observacoes: string | null; atualizado_em: Date };
type Msg = { direcao: string; mensagem_externa_id: string | null; texto: string; criado_em: Date };
const atendimento = async (tel: string): Promise<Atd | undefined> =>
  (await banco.consultar("SELECT * FROM atendimentos WHERE chat_id = $1 ORDER BY id DESC LIMIT 1", [chat(tel)])).rows[0];
const mensagens = async (tel: string): Promise<Msg[]> => (await banco.consultar(
  `SELECT m.direcao, m.mensagem_externa_id, m.texto, m.criado_em FROM mensagens m JOIN atendimentos a ON a.id = m.atendimento_id
    WHERE a.chat_id = $1 ORDER BY m.criado_em, m.id`, [chat(tel)])).rows;
const direcoes = (ms: Msg[]) => ms.map((m) => (m.direcao === "ENTRADA" ? "E" : "S")).join("");

// Memória × banco: o mesmo codigo, status, estado da triagem e campos ("Não informado" = NULL).
async function comparar(tel: string, rotulo: string) {
  const mem = webhook.lerEstadoEspelhavel(chat(tel));
  const db = await atendimento(tel);
  const campo = (v: string | null) => v ?? "Não informado";
  const difs: string[] = [];
  if (!mem || !db) difs.push(`memória=${!!mem} banco=${!!db}`);
  else {
    const pares: [string, unknown, unknown][] = [
      ["codigo", db.codigo, mem.codigo], ["status", db.status, mem.status],
      ["etapa_atual", db.etapa_atual, mem.triagem.etapaAtual], ["perguntas_etapa", db.perguntas_etapa, mem.triagem.perguntasEtapa],
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

// Segurança: nada com o prefixo de teste antes de começar.
const previos = Number((await banco.consultar("SELECT count(*) n FROM atendimentos WHERE chat_id LIKE 'meta:999:%'")).rows[0].n);
if (previos !== 0) { out(`ABORTADO: já existem ${previos} atendimentos de teste (meta:999:)`); process.exit(1); }

const TEL_A = "5591900000601", TEL_B = "5591900000602", TEL_C = "5591900000603", TEL_D = "5591900000604", TEL_E = "5591900000605";

out("== 1, 5 e 8. Triagem completa (Meta aceitando); memória × banco a cada mensagem ==");
for (const texto of ["oi", "Ana", "cimento", "10 sacos", "entregar de manhã"]) {
  await mensagem(TEL_A, texto);
  await comparar(TEL_A, `depois de "${texto}"`);
}
const a = (await atendimento(TEL_A))!;
ok(a.status === "HUMANO" && a.nome === "Ana" && a.produto === "cimento" && a.quantidade === "10 sacos" && a.observacoes === "entregar de manhã",
  "banco: status HUMANO e os 4 campos coletados");
ok(a.etapa_atual === null && a.perguntas_etapa === 0 && a.etapas_puladas.length === 0 && !a.apresentacao_pendente && !a.quantidade_nao_aplicavel,
  "banco: sem etapa pendente, nenhuma pulada, apresentação entregue");
let ma = await mensagens(TEL_A);
ok(direcoes(ma) === "ESESESESES", `mensagens alternadas ENTRADA/SAIDA (${direcoes(ma)})`);
ok(ma.every((m, i) => i === 0 || m.criado_em.getTime() > ma[i - 1]!.criado_em.getTime()), "criado_em estritamente crescente");
ok(ma.filter((m) => m.direcao === "ENTRADA").every((m) => /^teste-5b-/.test(m.mensagem_externa_id ?? "")) &&
   ma.filter((m) => m.direcao === "SAIDA").every((m) => /^wamid\.teste-5b-resp-/.test(m.mensagem_externa_id ?? "")),
  "ENTRADA com o wamid recebido; SAIDA com o wamid devolvido pela Meta");
ok(ma[0]!.texto === "oi" && ma[1]!.texto.startsWith("Olá!") && ma[9]!.texto.includes("vendedor"), "textos gravados (apresentação na 1ª SAIDA; encaminhamento na última)");

await mensagem(TEL_A, "mais uma coisa");
ma = await mensagens(TEL_A);
ok(direcoes(ma) === "ESESESESESE" && (await atendimento(TEL_A))!.status === "HUMANO", "depois de HUMANO: só ENTRADA (IA não responde), status continua HUMANO");
await comparar(TEL_A, "depois de mensagem em HUMANO");

out("\n== 6. Duplicata não grava mensagem duas vezes ==");
const dup = await mensagem(TEL_A, "repetida");
await mensagem(TEL_A, "repetida", dup.wamid);
const nDup = (await mensagens(TEL_A)).filter((m) => m.mensagem_externa_id === dup.wamid).length;
ok(nDup === 1, `reentrega do mesmo wamid pela rota: ${nDup} linha`);
const persist = await import(B + "/src/persistenciaAtendimento.ts");
const mem = webhook.lerEstadoEspelhavel(chat(TEL_A))!;
const dados = { codigo: mem.codigo, chatId: chat(TEL_A), telefone: TEL_A, atividadeEm: Date.now(), encerrado: false, status: mem.status,
  triagem: mem.triagem, resumo: mem.resumo, entrada: { wamid: dup.wamid, texto: "repetida", em: Date.now() }, saida: null };
const r1 = await persist.registrarMensagemProcessada(dados);
const nDup2 = (await mensagens(TEL_A)).filter((m) => m.mensagem_externa_id === dup.wamid).length;
ok(r1 && nDup2 === 1, `espelho chamado de novo com o mesmo wamid: continua ${nDup2} linha (ON CONFLICT)`);

out("\n== 2. Etapas puladas: \"não sei\", quantidade não aplicável, limite de 2 perguntas ==");
await mensagem(TEL_B, "oi");
await comparar(TEL_B, "depois de \"oi\"");
await mensagem(TEL_B, "não sei");
await comparar(TEL_B, "depois de \"não sei\" (nome)");
qtdAplicavel = false;
await mensagem(TEL_B, "telha");
qtdAplicavel = true;
await comparar(TEL_B, "depois de \"telha\" (quantidade não aplicável)");
let b = (await atendimento(TEL_B))!;
ok(b.etapa_atual === "observacoes" && b.perguntas_etapa === 1 && JSON.stringify(b.etapas_puladas) === '["nome","quantidade"]' && b.quantidade_nao_aplicavel,
  `banco: puladas ${JSON.stringify(b.etapas_puladas)}, quantidade não aplicável, observações perguntada 1x`);
await mensagem(TEL_B, "ok");
b = (await atendimento(TEL_B))!;
ok(b.etapa_atual === "observacoes" && b.perguntas_etapa === 2, "\"ok\" não responde: observações perguntada pela 2ª vez (perguntas_etapa = 2)");
await comparar(TEL_B, "depois do 1º \"ok\"");
await mensagem(TEL_B, "ok");
await comparar(TEL_B, "depois do 2º \"ok\" (limite)");
b = (await atendimento(TEL_B))!;
ok(b.status === "HUMANO" && b.etapa_atual === null && b.perguntas_etapa === 0 && JSON.stringify(b.etapas_puladas) === '["nome","quantidade","observacoes"]' &&
   b.nome === null && b.produto === "telha" && b.quantidade === null && b.observacoes === null,
  "banco: observações pulada pelo limite; triagem concluída (HUMANO), campos não informados = NULL");

out("\n== 3. Envio recusado pela Meta → nem memória nem banco avançam ==");
graphAceita = false;
await mensagem(TEL_C, "oi");
let c = (await atendimento(TEL_C))!;
let mc = await mensagens(TEL_C);
ok(c.etapa_atual === null && c.perguntas_etapa === 0 && c.apresentacao_pendente && direcoes(mc) === "E",
  "1ª resposta recusada: sem etapa, 0 perguntas, apresentação pendente, só a ENTRADA");
await comparar(TEL_C, "depois da recusa da 1ª resposta");
graphAceita = true;
await mensagem(TEL_C, "oi de novo");
c = (await atendimento(TEL_C))!;
ok(c.etapa_atual === "nome" && c.perguntas_etapa === 1 && !c.apresentacao_pendente && direcoes(await mensagens(TEL_C)) === "EES", "Meta volta a aceitar: nome perguntado, SAIDA gravada");
graphAceita = false;
await mensagem(TEL_C, "Bia");
c = (await atendimento(TEL_C))!;
mc = await mensagens(TEL_C);
ok(c.nome === "Bia" && c.etapa_atual === null && c.perguntas_etapa === 0 && direcoes(mc) === "EESE",
  "pergunta do produto recusada: nome mantido, produto não ficou perguntado, sem SAIDA nova");
await comparar(TEL_C, "depois da recusa da pergunta do produto");
graphAceita = true;

out("\n== 4. META_ENVIO_ATIVO=false → triagem avança e as SAIDAs são gravadas ==");
process.env.META_ENVIO_ATIVO = "false";
const envios0 = envios;
await mensagem(TEL_D, "oi");
await mensagem(TEL_D, "Caio");
process.env.META_ENVIO_ATIVO = "true";
const d = (await atendimento(TEL_D))!;
const md = await mensagens(TEL_D);
ok(envios === envios0, "nenhuma chamada à Graph API");
ok(d.nome === "Caio" && d.etapa_atual === "produto" && d.perguntas_etapa === 1 && direcoes(md) === "ESES" &&
   md.filter((m) => m.direcao === "SAIDA").every((m) => m.mensagem_externa_id === null),
  "triagem avançou (produto perguntado); SAIDAs gravadas sem wamid");
await comparar(TEL_D, "em modo somente log");

out("\n== 7. Banco falha no meio da transação → triagem segue, sem estado pela metade ==");
await mensagem(TEL_E, "oi");
const antes = (await atendimento(TEL_E))!;
const nAntes = (await mensagens(TEL_E)).length;
const pool = banco.obterPool();
const connectOriginal = pool.connect.bind(pool);
// Só a conexão de transação (connect() sem argumentos) e só o INSERT em mensagens falha;
// o UPDATE do estado já executado na mesma transação precisa ser desfeito.
(pool as any).connect = async (...args: unknown[]) => {
  if (args.length > 0) return (connectOriginal as any)(...args);
  const cliente = await connectOriginal();
  return new Proxy(cliente, { get(alvo: any, prop) {
    if (prop === "query") return (sql: unknown, ...resto: unknown[]) => typeof sql === "string" && sql.includes("INSERT INTO mensagens")
      ? Promise.reject(Object.assign(new Error("falha simulada"), { code: "57P01" })) : alvo.query(sql, ...resto);
    const v = alvo[prop]; return typeof v === "function" ? v.bind(alvo) : v;
  } });
};
const c7 = chamadasClaude;
const envios7 = envios;
await mensagem(TEL_E, "Davi");
(pool as any).connect = connectOriginal;
const depois = (await atendimento(TEL_E))!;
ok(chamadasClaude === c7 + 1 && envios === envios7 + 1, "triagem seguiu: Claude chamado e resposta enviada");
ok(depois.nome === antes.nome && depois.etapa_atual === antes.etapa_atual && depois.perguntas_etapa === antes.perguntas_etapa &&
   (await mensagens(TEL_E)).length === nAntes, "banco sem estado pela metade: estado anterior intacto e nenhuma mensagem gravada");
ok(logs.some((l) => l.includes("[Persistência] falha ao espelhar mensagem") && l.includes("57P01")), "falha logada curta (código)");
await mensagem(TEL_E, "areia");
const e = (await atendimento(TEL_E))!;
ok(e.nome === "Davi" && e.produto === "areia" && e.etapa_atual === "quantidade", "banco de volta: a mensagem seguinte grava o estado completo da memória");
await comparar(TEL_E, "depois da recuperação");

out("\n== 5b.1: nome com 300 caracteres (emoji no corte) ==");
const TEL_F = "5591900000606";
// O emoji é o 150º caractere: cortar por unidade UTF-16 partiria o par substituto.
const nomeLongo = "A".repeat(149) + "😀" + "C".repeat(150);
const nomeEsperado = "A".repeat(149) + "😀";
ok(Array.from(nomeLongo).length === 300 && nomeLongo.length === 301, "nome de teste: 300 caracteres (301 unidades UTF-16)");
await mensagem(TEL_F, "oi");
await mensagem(TEL_F, nomeLongo);
const f1 = (await banco.consultar("SELECT nome, char_length(nome) n, etapa_atual FROM atendimentos WHERE chat_id = $1", [chat(TEL_F)])).rows[0];
const memF = webhook.lerEstadoEspelhavel(chat(TEL_F));
ok(memF?.resumo.nome === nomeEsperado && f1?.nome === nomeEsperado && f1?.n === 150, `memória e banco com o mesmo nome de 150 caracteres (emoji inteiro no fim)`);
await comparar(TEL_F, "depois do nome longo");
await mensagem(TEL_F, "areia");
const f2 = (await atendimento(TEL_F))!;
ok(f2.produto === "areia" && f2.etapa_atual === "quantidade" && direcoes(await mensagens(TEL_F)) === "ESESES", "mensagem seguinte espelhada normalmente (produto, etapa, ENTRADA/SAIDA)");
await comparar(TEL_F, "depois da mensagem seguinte");

out("\n== 5b.1: Claude lançando erro ==");
const TEL_G = "5591900000607", TEL_H = "5591900000608";
await mensagem(TEL_G, "oi");
const g0 = (await atendimento(TEL_G))!;
claudeFalha = true;
await mensagem(TEL_G, "Gil");
const g1 = (await atendimento(TEL_G))!;
const mg = await mensagens(TEL_G);
ok(direcoes(mg) === "ESES" && mg[2]!.texto === "Gil" && mg[3]!.texto.startsWith("Tive uma instabilidade") && /^wamid\.teste-5b-resp-/.test(mg[3]!.mensagem_externa_id ?? ""),
  "Meta aceitando: ENTRADA gravada e a resposta de instabilidade (realmente enviada) como SAIDA, com wamid");
ok(g1.etapa_atual === g0.etapa_atual && g1.perguntas_etapa === g0.perguntas_etapa && g1.nome === null && g1.status === "HUMANO" && (g1.observacoes ?? "").includes("Falha técnica"),
  "estado da triagem intacto (mesma etapa e perguntas, nome não preenchido); status HUMANO com a nota de falha");
await comparar(TEL_G, "depois do erro do Claude (Meta aceitando)");
claudeFalha = false;
await mensagem(TEL_H, "oi");
claudeFalha = true;
graphAceita = false;
await mensagem(TEL_H, "Hugo");
graphAceita = true;
claudeFalha = false;
const mh = await mensagens(TEL_H);
ok(direcoes(mh) === "ESE" && mh[2]!.texto === "Hugo", "Meta recusando: ENTRADA gravada, nenhuma SAIDA");
await comparar(TEL_H, "depois do erro do Claude (Meta recusando)");

out("\n== 5b.1: loja fechada (não espelhada: não existe atendimento) ==");
desloc += 12 * 60 * 60_000; // quarta 22:00 em Belém
const TEL_I = "5591900000609", TEL_J = "5591900000610";
const enviosI = envios;
await mensagem(TEL_I, "oi, estão abertos?");
graphAceita = false;
await mensagem(TEL_J, "oi, estão abertos?");
graphAceita = true;
const nadaGravado = async (tel: string) =>
  Number((await banco.consultar("SELECT count(*) n FROM atendimentos WHERE chat_id = $1", [chat(tel)])).rows[0].n) === 0 &&
  (await mensagens(tel)).length === 0 && webhook.lerEstadoEspelhavel(chat(tel)) === null;
ok(envios === enviosI + 2 && logs.some((l) => l.startsWith("Loja fechada: aviso enviado")), "aviso de loja fechada enviado (aceito num chat, recusado no outro)");
ok((await nadaGravado(TEL_I)) && (await nadaGravado(TEL_J)), "memória sem conversa e banco sem atendimento nem mensagens (memória × banco iguais)");
desloc -= 12 * 60 * 60_000;

ok(externas.length === 0, `nenhuma chamada de rede externa (${externas.length})`);
const senha = process.env.DB_PASSWORD ?? "";
ok(!senha || !logs.some((l) => l.includes(senha)), "nenhum log com a senha do banco");

out("\n== Limpeza ==");
await espera(500);
const ev = (await banco.consultar("DELETE FROM eventos_processados WHERE mensagem_externa_id LIKE 'teste-5b-%'")).rowCount;
const { limparEspelhoDeTeste } = await import(B + "/tests/limpeza-espelho.mts");
const espelho = await limparEspelhoDeTeste(banco.consultar);
const sobraMsg = Number((await banco.consultar("SELECT count(*) n FROM mensagens WHERE mensagem_externa_id LIKE 'teste-5b-%' OR mensagem_externa_id LIKE 'wamid.teste-5b-%'")).rows[0].n);
ok(espelho.restantes === 0 && sobraMsg === 0, `apagados: ${ev} eventos, ${espelho.atendimentos} atendimentos, ${espelho.clientes} clientes; restantes = ${espelho.restantes + sobraMsg}`);
await banco.encerrarBanco();

out(falhas ? `\n${total} verificações | ${falhas} FALHA(S)` : `\n${total} verificações | TODOS OS TESTES PASSARAM`);
await new Promise((r) => setTimeout(r, 300));
process.exit(falhas ? 1 : 0);
