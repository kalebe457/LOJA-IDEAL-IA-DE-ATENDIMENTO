// Banco de TESTES (loja_ideal_teste) fixado antes de qualquer import de src/; loja_ideal é dado real.
const { exigirBancoDeTeste } = await import(new URL("./banco-teste.mts", import.meta.url).href);
process.env.TELEGRAM_BOT_TOKEN = "123456:TOKEN-FALSO-DE-TESTE";
process.env.TELEGRAM_CHAT_ID = "-1009999999999";
process.env.TELEGRAM_WEBHOOK_SECRET = "segredo-de-teste";
const GRUPO = -1009999999999;

// ---- Mock da Bot API: nenhuma chamada real sai daqui ----
type Chamada = { metodo: string; corpo: any };
let chamadas: Chamada[] = [];
let proximoMsgId = 100;
let falharDMPara = new Set<number>();
(globalThis as any).fetch = async (url: string, init: any) => {
  const m = /^https:\/\/api\.telegram\.org\/bot[^/]+\/(\w+)$/.exec(String(url));
  if (!m) throw new Error("chamada inesperada fora do Telegram: " + url);
  const corpo = JSON.parse(init.body);
  chamadas.push({ metodo: m[1]!, corpo });
  await new Promise((r) => setTimeout(r, 5)); // simula latência
  const json = (o: any) => ({ status: o.ok ? 200 : 403, json: async () => o });
  // Passo 2: todos os usuários deste teste estão no grupo (a autorização por grupo tem teste próprio).
  if (m[1] === "getChatMember") return json({ ok: true, result: { status: "member" } });
  if (m[1] === "sendMessage" && falharDMPara.has(corpo.chat_id))
    return json({ ok: false, error_code: 403, description: "Forbidden: bot was blocked by the user" });
  if (m[1] === "sendMessage") return json({ ok: true, result: { message_id: proximoMsgId++, chat: { id: corpo.chat_id } } });
  return json({ ok: true, result: true });
};

const B = new URL("..", import.meta.url).href.replace(/\/$/, "");
const T = await import(B + "/src/telegramBot.ts");
// Desde o 5d.1 o /start aceito grava em vendedores: marca o início para apagar só o que esta execução criou.
const banco = await import(B + "/src/banco.ts");
await exigirBancoDeTeste(banco.consultar);
const limpeza = await import(B + "/tests/limpeza-espelho.mts");
const inicio = await limpeza.inicioDaExecucao(banco.consultar);
const logReal = console.log;
console.log = () => {};
const erros: string[] = [];
console.error = (...a: any[]) => erros.push(a.join(" "));

let falhas = 0;
const ok = (c: boolean, t: string) => { if (!c) falhas++; logReal(`${c ? "OK  " : "FAIL"} ${t}`); };
const de = (metodo: string) => chamadas.filter((c) => c.metodo === metodo);
const respostas = () => de("answerCallbackQuery").map((c) => c.corpo.text as string);
const dmsPara = (id: number) => de("sendMessage").filter((c) => c.corpo.chat_id === id && String(c.corpo.text).startsWith("🔒"));
let upd = 1;
const idsStart = new Set<number>();
const start = (id: number, nome: string) => (idsStart.add(id), T.processarUpdateTelegram({ update_id: upd++, message: { message_id: 1, chat: { id, type: "private" }, from: { id, first_name: nome }, text: "/start" } }));
const clique = (userId: number, atd: string, msgId: number, chat = GRUPO, cbId = `cb${upd}`) =>
  T.processarUpdateTelegram({ update_id: upd++, callback_query: { id: cbId, from: { id: userId, first_name: "x" }, data: `assumir:${atd}`, message: { message_id: msgId, chat: { id: chat, type: "supergroup" } } } });
const resumo = (tel = "5591988887777") => ({ nome: "João", telefone: tel, produto: "Cimento CP-II", quantidade: "10 sacos", observacoes: "Nenhuma observação adicional." });
let humanos: string[] = [];
function reset() { T.redefinirEstadoTelegramParaTestes(); T.definirAoAssumirAtendimento((id: string) => humanos.push(id)); chamadas = []; humanos = []; falharDMPara = new Set(); }
async function novoResumo(atd: string, tel?: string) { await T.enviarResumoTelegram(atd, `meta:1:${tel ?? "5591988887777"}`, resumo(tel)); return proximoMsgId - 1; }

// Vendedores: Carlos (111), Maria (222), Ana (333, nunca fez /start). Chat privado = user_id.
const CARLOS = 111, MARIA = 222, ANA = 333;

logReal("== 3. /start no privado ==");
reset(); await start(CARLOS, "Carlos");
ok(de("sendMessage").some((c) => c.corpo.chat_id === CARLOS && /registrado/.test(c.corpo.text)), "/start privado registra e confirma no privado");
await T.processarUpdateTelegram({ update_id: upd++, message: { message_id: 2, chat: { id: GRUPO, type: "supergroup" }, from: { id: ANA, first_name: "Ana" }, text: "/start@LojaIdealAtendimentoBot" } });
ok(!de("sendMessage").some((c) => c.corpo.chat_id === GRUPO), "/start no GRUPO não registra nem responde");

logReal("\n== Resumo no grupo ==");
const msgA = await novoResumo("ATD-0000AAAAAA");
const envio = de("sendMessage").find((c) => c.corpo.chat_id === "-1009999999999")!;
const cbData = envio.corpo.reply_markup.inline_keyboard[0][0].callback_data;
ok(envio.corpo.text.startsWith("📋 NOVO ATENDIMENTO") && /Produto: Cimento CP-II/.test(envio.corpo.text), "resumo no formato pedido");
ok(!envio.corpo.text.includes("ATD-") && !envio.corpo.text.includes("meta:") && !envio.corpo.text.includes("wa.me"), "resumo sem ATD, chatId ou link");
ok(cbData === "assumir:ATD-0000AAAAAA" && Buffer.byteLength(cbData) <= 64, `callback_data "${cbData}" (${Buffer.byteLength(cbData)} bytes, sem dados pessoais)`);

logReal("\n== 12. Resumo duplicado ==");
const antes = de("sendMessage").length;
await T.enviarResumoTelegram("ATD-0000AAAAAA", "meta:1:5591988887777", resumo());
ok(de("sendMessage").length === antes, "segundo envio do mesmo atendimento é ignorado");

logReal("\n== 6. Vendedor NÃO registrado tenta assumir ==");
await clique(ANA, "ATD-0000AAAAAA", msgA);
ok(respostas().at(-1) === "Antes de assumir um atendimento, abra @LojaIdealAtendimentoBot no privado e envie /start.", "responde com a orientação de /start");
ok(de("editMessageText").length === 0 && humanos.length === 0 && dmsPara(ANA).length === 0, "não editou o grupo, não marcou HUMANO, sem link (lock não adquirido)");

logReal("\n== 4/5. Vendedor registrado assume ==");
await clique(CARLOS, "ATD-0000AAAAAA", msgA);
ok(humanos.join() === "ATD-0000AAAAAA", "atendimento marcado como HUMANO (gancho chamado uma vez)");
ok(/assumido/i.test(respostas().at(-1)!), `callback respondido: "${respostas().at(-1)}"`);
const dm = dmsPara(CARLOS);
ok(dm.length === 1 && dm[0]!.corpo.reply_markup.inline_keyboard[0][0].url === "https://wa.me/5591988887777", "UMA DM ao vencedor com botão URL ABRIR WHATSAPP → https://wa.me/5591988887777");
ok(/Cliente: João/.test(dm[0]!.corpo.text) && /Telefone: 5591988887777/.test(dm[0]!.corpo.text), "DM com os dados do cliente");
const ed = de("editMessageText").at(-1)!;
ok(ed.corpo.message_id === msgA && ed.corpo.text === "🔒 ATENDIMENTO ASSUMIDO\n\nVendedor: Carlos", `grupo editado: ${JSON.stringify(ed.corpo.text)}`);

logReal("\n== 15. Grupo sem botão depois de assumido ==");
ok(de("editMessageText").every((c) => !("reply_markup" in c.corpo)) && !/5591/.test(ed.corpo.text), "edição sem reply_markup (botão removido) e sem telefone");

logReal("\n== 9. Segundo clique do mesmo vendedor ==");
let total = de("sendMessage").length;
await clique(CARLOS, "ATD-0000AAAAAA", msgA);
ok(respostas().at(-1) === "Você já assumiu este atendimento." && de("sendMessage").length === total, "responde 'você já assumiu' sem nova DM");

logReal("\n== 8. Outro vendedor depois ==");
await start(MARIA, "Maria");
total = de("sendMessage").length;
await clique(MARIA, "ATD-0000AAAAAA", msgA);
ok(respostas().at(-1) === "Este atendimento já foi assumido por outro vendedor (Carlos).", `responde: "${respostas().at(-1)}"`);
ok(de("sendMessage").length === total && humanos.length === 1, "sem DM para Maria; responsável e status inalterados");

logReal("\n== 7/8. Dois vendedores ao mesmo tempo ==");
reset(); await start(CARLOS, "Carlos"); await start(MARIA, "Maria");
const msgB = await novoResumo("ATD-0000BBBBBB");
await Promise.all([clique(CARLOS, "ATD-0000BBBBBB", msgB), clique(MARIA, "ATD-0000BBBBBB", msgB)]);
const dmsB = de("sendMessage").filter((c) => String(c.corpo.text).startsWith("🔒"));
ok(dmsB.length === 1 && humanos.length === 1, `exatamente um venceu (DM só para ${dmsB[0]?.corpo.chat_id === CARLOS ? "Carlos" : "Maria"}); o outro recebeu: "${respostas().find((t) => /outro vendedor/.test(t))}"`);

logReal("\n== 11. Callback duplicado ==");
reset(); await start(CARLOS, "Carlos");
const msgC = await novoResumo("ATD-0000CCCCCC");
await Promise.all([clique(CARLOS, "ATD-0000CCCCCC", msgC, GRUPO, "cb-repetido"), clique(CARLOS, "ATD-0000CCCCCC", msgC, GRUPO, "cb-repetido")]);
await T.processarUpdateTelegram({ update_id: 5000, callback_query: { id: "cb-novo", from: { id: CARLOS }, data: "assumir:ATD-0000CCCCCC", message: { message_id: msgC, chat: { id: GRUPO } } } });
await T.processarUpdateTelegram({ update_id: 5000, callback_query: { id: "cb-novo2", from: { id: CARLOS }, data: "assumir:ATD-0000CCCCCC", message: { message_id: msgC, chat: { id: GRUPO } } } });
ok(dmsPara(CARLOS).length === 1 && humanos.length === 1 && de("answerCallbackQuery").length === 2, "mesmo callback_query.id e mesmo update_id processados uma vez só; uma DM");

logReal("\n== 10. Atendimento inexistente / clique inválido ==");
await clique(CARLOS, "ATD-0000FFFFFF", msgC);
ok(respostas().at(-1) === "Este atendimento não está mais disponível.", "ATD inexistente → 'não está mais disponível'");
reset(); await start(CARLOS, "Carlos");
const msgD = await novoResumo("ATD-0000DDDDDD");
chamadas = [];
await clique(CARLOS, "ATD-0000DDDDDD", msgD + 999);
ok(respostas().at(-1) === "Este atendimento não está mais disponível." && humanos.length === 0, "message_id diferente do resumo enviado pelo bot → recusado");
await clique(CARLOS, "ATD-0000DDDDDD", msgD, -999);
ok(respostas().at(-1) === "Este atendimento não está mais disponível." && humanos.length === 0, "callback de outro chat → recusado");
await T.processarUpdateTelegram({ update_id: upd++, callback_query: { id: "x1", from: { id: CARLOS }, data: "assumir:5591988887777", message: { message_id: msgD, chat: { id: GRUPO } } } });
ok(humanos.length === 0 && de("sendMessage").length === 0, "callback_data fora do formato → recusado, sem DM");

logReal("\n== 13. Geração do wa.me ==");
ok(T.gerarLinkWhatsApp("+55 (91) 98888-7777") === "https://wa.me/5591988887777", "+55 (91) 98888-7777 → https://wa.me/5591988887777");
ok(T.gerarLinkWhatsApp("559188887777") === "https://wa.me/559188887777", "wa_id sem o 9 → mantido como veio");
ok(T.gerarLinkWhatsApp("Não informado") === null, "'Não informado' → sem link");
reset(); await start(CARLOS, "Carlos");
const msgE = await novoResumo("ATD-0000EEEEEE", "Não informado");
await clique(CARLOS, "ATD-0000EEEEEE", msgE);
const dmE = dmsPara(CARLOS)[0];
ok(!!dmE && !dmE.corpo.reply_markup && /indisponível/.test(dmE.corpo.text), "telefone inválido → DM sem botão, com aviso");

logReal("\n== 16. Falha na DM depois do lock ==");
reset(); await start(CARLOS, "Carlos"); await start(MARIA, "Maria");
const msgF = await novoResumo("ATD-00000F0F0F");
falharDMPara.add(CARLOS);
await clique(CARLOS, "ATD-00000F0F0F", msgF);
const edF = de("editMessageText").at(-1)!;
ok(humanos.join() === "ATD-00000F0F0F", "lock mantido e atendimento HUMANO mesmo com a DM falhando");
ok(/Vendedor: Carlos/.test(edF.corpo.text) && /erro ao enviar a mensagem privada/.test(edF.corpo.text), "grupo avisa que foi assumido e que a DM falhou");
ok(erros.some((e) => /DM de ATD-00000F0F0F NÃO enviada/.test(e)) && !erros.some((e) => e.includes("TOKEN-FALSO")), "erro registrado no log, sem token");
await clique(MARIA, "ATD-00000F0F0F", msgF);
ok(dmsPara(MARIA).length === 0, "Maria clicando depois NÃO recebe o link");
falharDMPara.clear();
await start(MARIA, "Maria");
ok(dmsPara(MARIA).length === 0, "/start da Maria NÃO dispara reenvio para ela");
await start(CARLOS, "Carlos");
const reenvio = dmsPara(CARLOS);
ok(reenvio.length === 2 && reenvio[1]!.corpo.reply_markup.inline_keyboard[0][0].url.includes("wa.me"), "/start do Carlos (vencedor) reenvia a DM com sucesso");
ok(de("editMessageText").at(-1)!.corpo.text === "🔒 ATENDIMENTO ASSUMIDO\n\nVendedor: Carlos", "aviso de erro removido do grupo após o reenvio");

logReal("\n== 14. wa.me só na DM do vencedor (todas as chamadas desta bateria) ==");
const comLink = chamadas.filter((c) => JSON.stringify(c.corpo).includes("wa.me"));
ok(comLink.length > 0 && comLink.every((c) => c.metodo === "sendMessage" && c.corpo.chat_id === CARLOS), `${comLink.length} chamada(s) com wa.me, todas para o chat privado do vencedor`);

logReal("\n== Segredo do webhook ==");
ok(T.segredoWebhookTelegramValido("segredo-de-teste") === true, "header correto aceito");
ok(T.segredoWebhookTelegramValido("errado") === false && T.segredoWebhookTelegramValido(undefined) === false, "header errado/ausente recusado");
process.env.TELEGRAM_WEBHOOK_SECRET = "";
ok(T.segredoWebhookTelegramValido("qualquer") === false, "sem TELEGRAM_WEBHOOK_SECRET configurado → tudo recusado");

const vendedoresApagados = await limpeza.limparVendedoresDeTeste(banco.consultar, [...idsStart], inicio);
logReal(`limpeza: ${vendedoresApagados} vendedor(es) de teste apagado(s)`);
await banco.encerrarBanco();
logReal(falhas ? `\n${falhas} FALHA(S)` : "\nTODOS OS TESTES PASSARAM");
process.exit(falhas ? 1 : 0);
