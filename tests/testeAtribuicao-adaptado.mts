// Nenhuma chamada de rede: qualquer fetch neste teste é um erro.
(globalThis as any).fetch = async (url: unknown) => { throw new Error("rede bloqueada no teste: " + String(url)); };
// Raiz do projeto, derivada deste arquivo (funciona em Windows e Linux).
const B = new URL("..", import.meta.url).href.replace(/\/$/, "");
// Etapa 5.1 ADAPTADA à API atual do lock (Passo 2): identidade = user_id do Telegram,
// autorização e normalizador passados explicitamente (sem valores padrão).
// Origem: os 31 testes da etapa 5.1 (lock por telefone). 20 adaptados aqui;
// 11 aposentadas (T3b, T11 x2, T12 x8) por testarem a autorização/normalização por
// telefone que foi removida. + 3 testes NOVOS (N1-N3) para a API atual.
const logs: string[] = [];
const out = console.log.bind(console);
for (const nivel of ["log", "warn", "error"] as const) {
  console[nivel] = (...a: unknown[]) => { logs.push(`${nivel}: ${a.join(" ")}`); };
}

const M = await import(B + "/src/atendimentoVendedor.ts");
const { RegistroAtendimentosVendedor, ResultadoAssumir: R, EstadoAtendimento: E } = M;

let falhas = 0, total = 0;
const ok = (c: boolean, m: string) => { total++; if (!c) falhas++; out(`>>> ${c ? "PASSOU" : "FALHOU"} | ${m}`); };
const H = 60 * 60 * 1000;

// Mesmo critério de identidade do telegramBot.ts (user_id como string de dígitos).
const norm = (v: unknown): string =>
  typeof v === "number" && Number.isSafeInteger(v) && v > 0 ? String(v)
  : typeof v === "string" && /^\d{1,20}$/.test(v) ? v : "";

const VENDEDORES = Array.from({ length: 10 }, (_, i) => String(900000000 + i)); // user_ids
const autorizados = new Set(VENDEDORES);
let agora = 1_000_000;
const novo = (op: Record<string, unknown> = {}) =>
  new RegistroAtendimentosVendedor({ agora: () => agora, vendedoresAutorizados: () => autorizados, normalizarVendedor: norm, ...op });
const contar = (rs: { resultado: string }[], r: string) => rs.filter((x) => x.resultado === r).length;
const jitter = () => new Promise<void>((res) => (Math.random() < 0.5 ? setTimeout(res, Math.random() * 3) : setImmediate(res)));

out("### Concorrência");
{
  const reg = novo(); reg.registrarPendente("ATD-000001", "meta:P:5591900000001");
  const rs = await Promise.all(VENDEDORES.slice(0, 2).map(async (v) => reg.tentarAssumir("ATD-000001", v)));
  ok(contar(rs, R.ASSUMIDO) === 1 && contar(rs, R.JA_ASSUMIDO_POR_OUTRO) === 1, `T1 2 vendedores: ${rs.map((r) => r.resultado).join(", ")}`);
}
{
  const reg = novo(); reg.registrarPendente("ATD-000002", "meta:P:5591900000002");
  const rs = await Promise.all(VENDEDORES.map(async (v) => reg.tentarAssumir("ATD-000002", v)));
  const iv = rs.findIndex((r) => r.resultado === R.ASSUMIDO);
  ok(contar(rs, R.ASSUMIDO) === 1 && contar(rs, R.JA_ASSUMIDO_POR_OUTRO) === 9 && reg.obter("ATD-000002")?.responsavel === VENDEDORES[iv],
    `T2 10 vendedores: 1 assumido, ${contar(rs, R.JA_ASSUMIDO_POR_OUTRO)} por outro, responsável = vencedor`);
}
{
  let todasCertas = true; const vencedores = new Set<string>();
  for (let rep = 0; rep < 50; rep++) {
    const reg = novo(); reg.registrarPendente("ATD-000003", "meta:P:5591900000003");
    const rs = await Promise.all(VENDEDORES.map(async (v) => { await jitter(); await jitter(); return { v, r: reg.tentarAssumir("ATD-000003", v) }; }));
    const ganhos = rs.filter((x) => x.r.resultado === R.ASSUMIDO);
    if (ganhos.length !== 1 || reg.obter("ATD-000003")?.responsavel !== ganhos[0]!.v) todasCertas = false;
    if (ganhos[0]) vencedores.add(ganhos[0].v);
  }
  ok(todasCertas, `T2b 50 repetições com atrasos aleatórios: sempre exatamente 1 vencedor (vencedores distintos: ${vencedores.size})`);
}
{
  const estado = new Map<string, string | null>([["ATD-QUEBRADO", null]]);
  const quebrado = async (v: string) => { const atual = estado.get("ATD-QUEBRADO"); await Promise.resolve(); if (atual === null) { estado.set("ATD-QUEBRADO", v); return R.ASSUMIDO; } return R.JA_ASSUMIDO_POR_OUTRO; };
  const rs = await Promise.all(VENDEDORES.map((v) => quebrado(v)));
  const n = rs.filter((r) => r === R.ASSUMIDO).length;
  ok(n > 1, `CONTROLE com await no meio: ${n} "vencedores" (o teste detecta a corrida quando ela existe)`);
}
{
  const reg = novo(); reg.registrarPendente("ATD-00000A", "c:A"); reg.registrarPendente("ATD-00000B", "c:B");
  const rs = await Promise.all(VENDEDORES.flatMap((v) => [
    (async () => { await jitter(); return { id: "A", r: reg.tentarAssumir("ATD-00000A", v) }; })(),
    (async () => { await jitter(); return { id: "B", r: reg.tentarAssumir("ATD-00000B", v) }; })(),
  ]));
  const a = rs.filter((x) => x.id === "A" && x.r.resultado === R.ASSUMIDO).length;
  const b = rs.filter((x) => x.id === "B" && x.r.resultado === R.ASSUMIDO).length;
  ok(a === 1 && b === 1, `T8 dois atendimentos disputados ao mesmo tempo: A=${a} vencedor, B=${b} vencedor`);
}

out("\n### Regras de resultado");
{
  const reg = novo(); reg.registrarPendente("ATD-000010", "c:10");
  const r1 = reg.tentarAssumir("ATD-000010", VENDEDORES[0]); const r2 = reg.tentarAssumir("ATD-000010", VENDEDORES[0]);
  ok(r1.resultado === R.ASSUMIDO && r2.resultado === R.JA_ASSUMIDO_POR_VOCE, `T3 mesmo vendedor 2x: ${r1.resultado}, ${r2.resultado}`);
  const r4 = reg.tentarAssumir("ATD-000010", VENDEDORES[1]);
  ok(r4.resultado === R.JA_ASSUMIDO_POR_OUTRO && !("chatId" in r4) && reg.obter("ATD-000010")?.responsavel === VENDEDORES[0],
    `T4 segundo vendedor: ${r4.resultado}, sem chatId no retorno, responsável inalterado`);
}
{
  const reg = novo(); reg.registrarPendente("ATD-000011", "c:11");
  const intruso = "123456789";
  const a = reg.tentarAssumir("ATD-000011", intruso); const b = reg.tentarAssumir("ATD-FFFFFF", intruso);
  ok(a.resultado === R.VENDEDOR_NAO_AUTORIZADO && b.resultado === R.VENDEDOR_NAO_AUTORIZADO && reg.obter("ATD-000011")?.estado === E.PENDENTE,
    `T5 não autorizado: existente=${a.resultado}, inexistente=${b.resultado} (não revela se existe), estado continua pendente`);
  const c = reg.tentarAssumir("ATD-000011", ""), d = reg.tentarAssumir("ATD-000011", undefined), e = reg.tentarAssumir("ATD-000011", null);
  ok([c, d, e].every((x) => x.resultado === R.VENDEDOR_NAO_AUTORIZADO), `vendedor vazio/undefined/null: ${c.resultado}, ${d.resultado}, ${e.resultado}`);
  ok(reg.tentarAssumir("ATD-ABCDEF", VENDEDORES[0]).resultado === R.INEXISTENTE_OU_EXPIRADO, "T6 atendimento inexistente: inexistente_ou_expirado");
}

out("\n### Expiração (relógio injetável, TTLs configuráveis)");
{
  agora = 1_000_000;
  const reg = novo({ ttlPendenteMs: 2 * H, ttlAssumidoMs: 5 * H });
  reg.registrarPendente("ATD-000020", "c:20");
  agora += 2 * H - 1; const vivo = reg.obter("ATD-000020") !== null;
  agora += 1; const r = reg.tentarAssumir("ATD-000020", VENDEDORES[0]);
  ok(vivo && r.resultado === R.INEXISTENTE_OU_EXPIRADO && reg.tamanho() === 0, `T7 pendente: válido em 2h-1ms, expirado em 2h (${r.resultado}), entrada removida`);
  agora = 1_000_000; reg.registrarPendente("ATD-000021", "c:21");
  agora += 1 * H; reg.tentarAssumir("ATD-000021", VENDEDORES[0]);
  agora += 5 * H - 1; const dentro = reg.tentarAssumir("ATD-000021", VENDEDORES[1]);
  agora += 1; const fora = reg.tentarAssumir("ATD-000021", VENDEDORES[1]);
  ok(dentro.resultado === R.JA_ASSUMIDO_POR_OUTRO && fora.resultado === R.INEXISTENTE_OU_EXPIRADO,
    `T7b assumido: dentro do TTL (conta de assumidoEm) = ${dentro.resultado}, fora = ${fora.resultado}`);
}

out("\n### Registro, cópia, índice por chatId e teto");
{
  agora = 1_000_000; const reg = novo();
  reg.registrarPendente("ATD-000030", "c:30"); reg.tentarAssumir("ATD-000030", VENDEDORES[2]);
  const repetido = reg.registrarPendente("ATD-000030", "c:30");
  ok(repetido === false && reg.obter("ATD-000030")?.responsavel === VENDEDORES[2], "T9 registrar de novo depois de assumido: nada muda");
  const copia = reg.obter("ATD-000030")!;
  copia.responsavel = "999"; copia.estado = E.PENDENTE; copia.chatId = "x";
  const real = reg.obter("ATD-000030")!;
  ok(real.responsavel === VENDEDORES[2] && real.estado === E.ASSUMIDO && real.chatId === "c:30", "obter() devolve cópia: alterar o retorno não muda o estado");
  const n0 = reg.tamanho();
  const v1 = reg.registrarPendente("", "c:x"), v2 = reg.registrarPendente("ATD-000031", ""), v3 = reg.registrarPendente(undefined as never, undefined as never);
  ok(!v1 && !v2 && !v3 && reg.tamanho() === n0, "registrarPendente com atendimentoId/chatId vazio: rejeitado, sem lançar erro, sem criar entrada");
}
{
  agora = 1_000_000; const reg = novo({ ttlPendenteMs: 1 * H, ttlAssumidoMs: 1 * H, maxItens: 3 });
  reg.registrarPendente("ATD-000040", "chat:1");
  const pend = reg.chatTemAtendimentoAtivo("chat:1");
  reg.tentarAssumir("ATD-000040", VENDEDORES[0]);
  const assum = reg.chatTemAtendimentoAtivo("chat:1");
  const outro = reg.chatTemAtendimentoAtivo("chat:nenhum");
  agora += 1 * H; const expirou = reg.chatTemAtendimentoAtivo("chat:1");
  ok(pend && assum && !outro && !expirou, `índice por chatId: pendente=${pend}, assumido=${assum}, chat sem atendimento=${outro}, depois de expirar=${expirou}`);
  agora = 5_000_000;
  reg.registrarPendente("ATD-000041", "chat:2"); reg.registrarPendente("ATD-000042", "chat:3");
  reg.registrarPendente("ATD-000043", "chat:3"); reg.registrarPendente("ATD-000044", "chat:4");
  ok(reg.tamanho() === 3 && reg.obter("ATD-000041") === null && !reg.chatTemAtendimentoAtivo("chat:2") && reg.chatTemAtendimentoAtivo("chat:3") && reg.chatTemAtendimentoAtivo("chat:4"),
    "T10 teto 3 com 4 registros: o mais antigo sai do registro e do índice; chat com 2 atendimentos continua ativo");
}

out("\n### Logs (T13)");
{
  const reg = novo(); reg.registrarPendente("ATD-000060", "meta:PNID:5591900000060");
  reg.tentarAssumir("ATD-000060", VENDEDORES[3]); reg.tentarAssumir("<script>alert(1)</script>", VENDEDORES[3]);
  const tentativa = logs.find((l) => l.includes("ATD-000060") && l.includes("resultado: assumido")) ?? "";
  ok(tentativa.includes("vendedor: 9000****0003"), `formato: ${tentativa.replace(/^log: /, "")}`);
  ok(logs.some((l) => l.includes("atendimento: formato inválido")) && !logs.some((l) => l.includes("<script>")), "atendimentoId fora do formato não é reproduzido no log");
  const ids = [...VENDEDORES, "5591900000060", "123456789"];
  const vazou = logs.filter((l) => ids.some((t) => l.includes(t)) || l.includes("meta:PNID"));
  ok(vazou.length === 0, `nenhum log com identidade completa ou chatId (${vazou.length} encontrados em ${logs.length} linhas)`);
}

out("\n### NOVOS para a API atual");
{
  const reg = novo(); reg.registrarPendente("ATD-000070", "c:70");
  const a = reg.tentarAssumir("ATD-000070", Number(VENDEDORES[4])); const b = reg.tentarAssumir("ATD-000070", VENDEDORES[4]);
  ok(a.resultado === R.ASSUMIDO && b.resultado === R.JA_ASSUMIDO_POR_VOCE && reg.obter("ATD-000070")?.responsavel === VENDEDORES[4],
    `N1 mesma identidade como number e string = mesmo vendedor (substitui T3b): ${a.resultado}, ${b.resultado}`);
}
{
  const dinamico = new Set(VENDEDORES);
  const reg = new RegistroAtendimentosVendedor({ agora: () => agora, vendedoresAutorizados: () => dinamico, normalizarVendedor: norm });
  reg.registrarPendente("ATD-000071", "c:71");
  dinamico.delete(VENDEDORES[5]!);
  const r = reg.tentarAssumir("ATD-000071", VENDEDORES[5]);
  const s = reg.tentarAssumir("ATD-000071", VENDEDORES[6]);
  ok(r.resultado === R.VENDEDOR_NAO_AUTORIZADO && s.resultado === R.ASSUMIDO,
    `N2 autorização lida a cada tentativa: removido do conjunto = ${r.resultado}; outro autorizado = ${s.resultado} (substitui T11)`);
}
{
  const reg = novo(); reg.registrarPendente("ATD-000072", "c:72");
  const invalidos = ["12a", "-1", "1.5", " 900000007", "+900000007", 0, -5, 1.5];
  const rs = invalidos.map((v) => reg.tentarAssumir("ATD-000072", v as never).resultado);
  ok(rs.every((x) => x === R.VENDEDOR_NAO_AUTORIZADO) && reg.obter("ATD-000072")?.estado === E.PENDENTE,
    `N3 identidades malformadas rejeitadas pelo normalizador e atendimento intacto (substitui T12): ${invalidos.length} casos`);
}

out(`\n===== ${total} VERIFICAÇÕES | FALHAS: ${falhas} =====`);
process.exit(falhas ? 1 : 0);
