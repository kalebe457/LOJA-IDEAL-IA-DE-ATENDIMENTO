// Raiz do projeto, derivada deste arquivo (funciona em Windows e Linux).
const B = new URL("..", import.meta.url).href.replace(/\/$/, "");
// Passo 2: autorização pelo grupo (getChatMember). Bot API SIMULADA; nada real é enviado.
process.env.TELEGRAM_BOT_TOKEN = "123456:TOKEN-FALSO";
process.env.TELEGRAM_CHAT_ID = "-1009999999999";
process.env.TELEGRAM_WEBHOOK_SECRET = "segredo-teste";
const GRUPO = -1009999999999;
const FORA = "Você não faz parte da equipe de vendedores da Loja Ideal.";
const ERRO_MSG = "Não consegui verificar sua participação na equipe agora. Tente novamente em instantes.";

type Chamada = { metodo: string; corpo: any };
let chamadas: Chamada[] = [];
let msgId = 100;
// status por user_id. Especiais: ERRO (ok:false), REDE (fetch lança), INESPERADO (ok:true sem status), TRAVA (só responde ao abort).
const statusPorUsuario = new Map<number, string>();
(globalThis as any).fetch = async (url: string, init: any) => {
  const m = /^https:\/\/api\.telegram\.org\/bot[^/]+\/(\w+)$/.exec(String(url));
  if (!m) throw new Error("chamada inesperada: " + url);
  const corpo = JSON.parse(init.body);
  chamadas.push({ metodo: m[1]!, corpo });
  const json = (o: any) => ({ status: o.ok ? 200 : 400, json: async () => o });
  if (m[1] === "getChatMember") {
    const s = statusPorUsuario.get(corpo.user_id) ?? "left";
    if (s === "REDE") throw new Error("ECONNRESET");
    if (s === "ERRO") return json({ ok: false, error_code: 400, description: "Bad Request: PARTICIPANT_ID_INVALID" });
    if (s === "INESPERADO") return json({ ok: true, result: { user: { id: corpo.user_id } } });
    if (s === "TRAVA") return new Promise((_, rej) => init.signal?.addEventListener("abort", () => rej(init.signal.reason)));
    return json({ ok: true, result: { status: s, user: { id: corpo.user_id } } });
  }
  if (m[1] === "sendMessage") return json({ ok: true, result: { message_id: msgId++, chat: { id: corpo.chat_id } } });
  return json({ ok: true, result: true });
};

const T = await import(B + "/src/telegramBot.ts");
// Desde o 5d.1 o /start aceito grava em vendedores: marca o início para apagar só o que esta execução criou.
const banco = await import(B + "/src/banco.ts");
const limpeza = await import(B + "/tests/limpeza-espelho.mts");
const inicio = await limpeza.inicioDaExecucao(banco.consultar);
const logReal = console.log; const logs: string[] = [];
console.log = (...a: any[]) => logs.push(a.join(" "));
console.error = (...a: any[]) => logs.push(a.join(" "));

let falhas = 0, total = 0;
const ok = (c: boolean, t: string) => { total++; if (!c) falhas++; logReal(`${c ? "OK  " : "FAIL"} ${t}`); };
const de = (metodo: string) => chamadas.filter((c) => c.metodo === metodo);
const ultimaResposta = () => de("answerCallbackQuery").at(-1)?.corpo;
const ultimaPara = (id: number) => de("sendMessage").filter((c) => c.corpo.chat_id === id).at(-1)?.corpo.text;
const registrou = (id: number) => de("sendMessage").some((c) => c.corpo.chat_id === id && /registrado/.test(c.corpo.text));
const dmsPara = (id: number) => de("sendMessage").filter((c) => c.corpo.chat_id === id && String(c.corpo.text).startsWith("🔒"));
let upd = 1;
const idsStart = new Set<number>();
const start = (id: number) => (idsStart.add(id), T.processarUpdateTelegram({ update_id: upd++, message: { message_id: 1, chat: { id, type: "private" }, from: { id, first_name: `U${id}` }, text: "/start" } }));
const clique = (id: number, atd: string, msg: number) => T.processarUpdateTelegram({ update_id: upd++, callback_query: { id: `cb${upd}`, from: { id, first_name: `U${id}` }, data: `assumir:${atd}`, message: { message_id: msg, chat: { id: GRUPO, type: "supergroup" } } } });
let humanos: string[] = [];
function reset() { T.redefinirEstadoTelegramParaTestes(); T.definirAoAssumirAtendimento((id: string) => humanos.push(id)); chamadas = []; humanos = []; statusPorUsuario.clear(); }
async function resumo(atd: string) { await T.enviarResumoTelegram(atd, "meta:1:5591988887777", { nome: "C", telefone: "5591988887777", produto: "P", quantidade: "1", observacoes: "-" }); return msgId - 1; }
// Rejeição não pode mexer no atendimento: nenhuma edição do grupo, nenhuma DM, nenhum HUMANO.
const intacto = () => de("editMessageText").length === 0 && humanos.length === 0 && de("sendMessage").every((c) => !String(c.corpo.text).startsWith("🔒"));

logReal("== /start: autorizados (member, administrator, creator) ==");
for (const st of ["member", "administrator", "creator"]) {
  reset(); statusPorUsuario.set(10, st);
  await start(10);
  const g = de("getChatMember")[0]?.corpo;
  ok(g?.chat_id === "-1009999999999" && g?.user_id === 10 && registrou(10), `"${st}" → /start aceito (getChatMember no grupo configurado, registro enviado)`);
}

logReal("\n== /start: fora da equipe (restricted, left, kicked, status desconhecido) ==");
for (const st of ["restricted", "left", "kicked", "status_novo_qualquer"]) {
  reset(); statusPorUsuario.set(20, st);
  await start(20);
  ok(ultimaPara(20) === FORA && !registrou(20), `"${st}" → mensagem exata de não pertencimento, sem registro`);
}
ok(logs.some((l) => l.includes("user_id 20") && l.includes("status_novo_qualquer")) && !logs.some((l) => l.includes("TOKEN-FALSO")), "log com user_id e status; sem token");

logReal("\n== /start: erro técnico (API, rede, resposta inesperada) ==");
for (const st of ["ERRO", "REDE", "INESPERADO"]) {
  reset(); statusPorUsuario.set(30, st);
  await start(30);
  ok(ultimaPara(30) === ERRO_MSG && !registrou(30), `${st} → mensagem exata de verificação, sem registro`);
}

logReal("\n== ASSUMIR: autorizados seguem para o lock, com getChatMember ANTES ==");
for (const st of ["member", "administrator", "creator"]) {
  reset(); statusPorUsuario.set(40, st); await start(40);
  const msg = await resumo("ATD-0000AAAAAA");
  const antes = chamadas.length;
  await clique(40, "ATD-0000AAAAAA", msg);
  const seq = chamadas.slice(antes).map((c) => c.metodo);
  ok(seq[0] === "getChatMember" && humanos.join() === "ATD-0000AAAAAA" && dmsPara(40).length === 1, `"${st}" → ${seq.join(" → ")}`);
}

logReal("\n== ASSUMIR: fora da equipe é rejeitado antes do lock ==");
for (const st of ["restricted", "left", "kicked"]) {
  reset(); statusPorUsuario.set(50, "member"); await start(50);
  const msg = await resumo("ATD-0000BBBBBB");
  statusPorUsuario.set(50, st); // removido/restrito DEPOIS do /start
  const antes = chamadas.length;
  await clique(50, "ATD-0000BBBBBB", msg);
  const seq = chamadas.slice(antes).map((c) => c.metodo).join(" → ");
  ok(ultimaResposta()?.text === FORA && ultimaResposta()?.show_alert === true && intacto() && seq === "getChatMember → answerCallbackQuery",
    `membro que virou "${st}" após o /start → mensagem exata, atendimento intacto (${seq})`);
}
reset(); statusPorUsuario.set(50, "member"); statusPorUsuario.set(51, "member"); await start(50); await start(51);
const msgR = await resumo("ATD-00000B0B0B");
statusPorUsuario.set(50, "kicked");
await clique(50, "ATD-00000B0B0B", msgR);
await clique(51, "ATD-00000B0B0B", msgR);
ok(humanos.join() === "ATD-00000B0B0B" && dmsPara(51).length === 1 && dmsPara(50).length === 0, "depois da rejeição, um membro assume normalmente (atendimento estava intacto)");

logReal("\n== ASSUMIR: erro técnico não libera ==");
for (const st of ["ERRO", "REDE", "INESPERADO"]) {
  reset(); statusPorUsuario.set(60, "member"); await start(60);
  const msg = await resumo("ATD-0000CCCCCC");
  statusPorUsuario.set(60, st);
  await clique(60, "ATD-0000CCCCCC", msg);
  ok(ultimaResposta()?.text === ERRO_MSG && ultimaResposta()?.show_alert === true && intacto(), `${st} → mensagem exata de verificação, sem lock, sem DM, atendimento intacto`);
}
reset(); statusPorUsuario.set(61, "member"); await start(61);
const msgT = await resumo("ATD-00000C0C0C");
statusPorUsuario.set(61, "TRAVA");
// O timer de AbortSignal.timeout é unref: no backend real o servidor HTTP mantém o
// processo vivo; aqui um intervalo faz esse papel durante o teste.
const manterVivo = setInterval(() => undefined, 1_000);
const t0 = Date.now();
await clique(61, "ATD-00000C0C0C", msgT);
const dt = Date.now() - t0;
clearInterval(manterVivo);
ok(ultimaResposta()?.text === ERRO_MSG && intacto() && dt >= 4_500 && dt < 8_000, `timeout: API presa → callback respondido em ${(dt / 1000).toFixed(1)} s com a mensagem de verificação (não fica travado)`);

logReal("\n== Registro ==");
reset(); statusPorUsuario.set(70, "member"); await start(70);
statusPorUsuario.set(70, "left"); await start(70);
statusPorUsuario.set(70, "member");
const msgG = await resumo("ATD-00000A0A0A");
await clique(70, "ATD-00000A0A0A", msgG);
ok(ultimaResposta()?.text.startsWith("Antes de assumir um atendimento") && humanos.length === 0, "/start rejeitado (fora da equipe) remove o registro anterior");
reset(); statusPorUsuario.set(71, "member"); await start(71);
statusPorUsuario.set(71, "ERRO"); await start(71);
statusPorUsuario.set(71, "member");
const msgH = await resumo("ATD-00000D0D0D");
await clique(71, "ATD-00000D0D0D", msgH);
ok(humanos.join() === "ATD-00000D0D0D", "/start com erro técnico NÃO apaga o registro anterior (não dá para saber)");
reset(); statusPorUsuario.set(72, "member");
const msgF = await resumo("ATD-00000F0F0F");
await clique(72, "ATD-00000F0F0F", msgF);
ok(ultimaResposta()?.text === "Antes de assumir um atendimento, abra @LojaIdealAtendimentoBot no privado e envie /start." && humanos.length === 0,
  "no grupo mas sem /start → orientação de /start no privado, sem lock");

const vendedoresApagados = await limpeza.limparVendedoresDeTeste(banco.consultar, [...idsStart], inicio);
logReal(`limpeza: ${vendedoresApagados} vendedor(es) de teste apagado(s)`);
await banco.encerrarBanco();
logReal(falhas ? `\n${total} verificações | ${falhas} FALHA(S)` : `\n${total} verificações | TODOS OS TESTES PASSARAM`);
process.exit(falhas ? 1 : 0);
