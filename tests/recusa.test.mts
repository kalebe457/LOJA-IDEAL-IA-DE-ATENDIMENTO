// Nenhuma chamada de rede: qualquer fetch neste teste é um erro.
(globalThis as any).fetch = async (url: unknown) => { throw new Error("rede bloqueada no teste: " + String(url)); };
process.env.ANTHROPIC_API_KEY = "teste-sem-rede"; // sempre falsa, antes dos imports
const B = new URL("..", import.meta.url).href.replace(/\/$/, "");
const { default: Anthropic } = await import(B + "/node_modules/@anthropic-ai/sdk/index.mjs");
const { IAClaude } = await import(B + "/src/iaClaude.ts");

let proxima: Record<string, string> = {};
(Anthropic as any).Messages.prototype.parse = async function () {
  const r = proxima; proxima = {};
  return { model: "stub", usage: { input_tokens: 0, output_tokens: 0 }, parsed_output: { resposta: "", status: "IA", quantidade_aplicavel: true,
    resumo: { nome: "Não informado", produto: "Não informado", quantidade: "Não informado", observacoes: "Não informado", ...r } } };
};
const logReal = console.log; console.log = () => {};
const P: Record<string, string> = { nome: "qual é o seu nome", produto: "Qual produto", quantidade: "Qual quantidade", observacoes: "alguma observação", humano: "encaminhar seu atendimento" };
const etapa = (r: string) => Object.entries(P).find(([, t]) => r.includes(t))?.[0] ?? "??";
let falhas = 0;
const ok = (cond: boolean, txt: string) => { if (!cond) falhas++; logReal(`${cond ? "OK  " : "FAIL"} ${txt}`); };

// Leva a conversa até a etapa pedida e devolve a IA + cliente.
async function ate(alvo: "nome" | "produto" | "quantidade") {
  const ia = new IAClaude("ATD-T"); const c = { telefone: "5591", status: "IA" as const, resumo: {} as any };
  proxima = alvo === "quantidade" ? { nome: "Ana", produto: "cimento" } : alvo === "produto" ? { nome: "Ana" } : {};
  const r = await ia.responder("oi", c);
  if (etapa(r.resposta) !== alvo) throw new Error(`setup: esperava ${alvo}, veio ${etapa(r.resposta)}`);
  return { ia, c };
}

logReal("== Recusas na pergunta de quantidade: devem pular na hora ==");
for (const frase of ["não sei", "nao sei", "não sei quantidade", "nao sei quantidade", "nao sei a quantidade", "não faço ideia", "não sei ainda", "não quero informar", "prefiro não informar", "não tenho essa informação", "Não sei a quantidade ainda."]) {
  const { ia, c } = await ate("quantidade");
  const r = await ia.responder(frase, c);
  ok(etapa(r.resposta) === "observacoes" && r.resumo.quantidade === "Não informado", `"${frase}" → ${etapa(r.resposta)} | quantidade=${r.resumo.quantidade}`);
}

logReal("\n== Recusa em outras etapas ==");
{ const { ia, c } = await ate("nome"); const r = await ia.responder("prefiro não informar", c); ok(etapa(r.resposta) === "produto" && r.resumo.nome === "Não informado", `nome: "prefiro não informar" → ${etapa(r.resposta)} | nome=${r.resumo.nome}`); }
{ const { ia, c } = await ate("produto"); const r = await ia.responder("não sei ainda", c); ok(etapa(r.resposta) === "quantidade", `produto: "não sei ainda" → ${etapa(r.resposta)}`); }

logReal("\n== Dado válido junto da recusa: NÃO pode virar recusa ==");
{ const { ia, c } = await ate("quantidade"); proxima = { quantidade: "10 caixas" };
  const r = await ia.responder("Não sei a quantidade, mas quero 10 caixas", c);
  ok(r.resumo.quantidade === "10 caixas" && etapa(r.resposta) === "observacoes", `com Claude extraindo → quantidade=${r.resumo.quantidade} | próxima=${etapa(r.resposta)}`); }
{ const { ia, c } = await ate("quantidade");
  const r = await ia.responder("Não sei a quantidade, mas quero 10 caixas", c);
  ok(r.resumo.quantidade.includes("10 caixas") && etapa(r.resposta) === "observacoes", `sem Claude (fallback) → quantidade="${r.resumo.quantidade}" | próxima=${etapa(r.resposta)}`); }
{ const { ia, c } = await ate("produto");
  const r = await ia.responder("não sei qual cimento comprar", c);
  ok(r.resumo.produto === "não sei qual cimento comprar", `produto: "não sei qual cimento comprar" → produto="${r.resumo.produto}" (é interesse, não recusa)`); }

logReal("\n== Caso real: quantidade → 'não sei quantidade' ==");
{ const { ia, c } = await ate("quantidade");
  const r = await ia.responder("não sei quantidade", c);
  ok(etapa(r.resposta) === "observacoes", `pergunta de quantidade → "não sei quantidade" → ${etapa(r.resposta)} (sem 2ª pergunta de quantidade)`); }

logReal(falhas ? `\n${falhas} FALHA(S)` : "\nTODOS OS TESTES PASSARAM");
process.exit(falhas ? 1 : 0);
