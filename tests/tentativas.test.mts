// Nenhuma chamada de rede: qualquer fetch neste teste é um erro.
(globalThis as any).fetch = async (url: unknown) => { throw new Error("rede bloqueada no teste: " + String(url)); };
process.env.ANTHROPIC_API_KEY = "teste-sem-rede"; // sempre falsa, antes dos imports
const B = new URL("..", import.meta.url).href.replace(/\/$/, "");
const { default: Anthropic } = await import(B + "/node_modules/@anthropic-ai/sdk/index.mjs");
const { IAClaude } = await import(B + "/src/iaClaude.ts");

// Stub do Claude: devolve o que o teste mandar, sem chamar a API.
type Saida = { resumo?: Record<string, string>; quantidade_aplicavel?: boolean };
let proxima: Saida = {};
(Anthropic as any).Messages.prototype.parse = async function () {
  const s = proxima; proxima = {};
  return {
    model: "stub", usage: { input_tokens: 0, output_tokens: 0 },
    parsed_output: {
      resposta: "", status: "IA",
      resumo: { nome: "Não informado", produto: "Não informado", quantidade: "Não informado", observacoes: "Não informado", ...s.resumo },
      quantidade_aplicavel: s.quantidade_aplicavel ?? true,
    },
  };
};
const logOriginal = console.log; const logs: string[] = [];
console.log = (...a: unknown[]) => { logs.push(a.join(" ")); };

const P = { nome: "qual é o seu nome", produto: "Qual produto", quantidade: "Qual quantidade", observacoes: "alguma observação", humano: "encaminhar seu atendimento" };
const etapa = (r: string) => (Object.entries(P).find(([, t]) => r.includes(t))?.[0]) ?? `?? ${r}`;
const cliente = () => ({ telefone: "559100000000", status: "IA" as const, resumo: {} as any });

let falhas = 0;
async function cenario(nome: string, passos: [string, string, Saida?][], antes?: (ia: any, c: any) => Promise<void>) {
  const ia = new IAClaude("ATD-TESTE"); const c = cliente(); const vistos: string[] = [];
  if (antes) await antes(ia, c);
  for (const [msg, esperado, saida] of passos) {
    proxima = saida ?? {};
    const r = await ia.responder(msg, c);
    const e = etapa(r.resposta); vistos.push(`"${msg}"→${e}`);
    if (e !== esperado) { falhas++; logOriginal(`FAIL ${nome}: "${msg}" esperava ${esperado}, veio ${e}`); }
  }
  logOriginal(`${nome}\n   ${vistos.join("  |  ")}`);
}

await cenario("1. válida na 1ª tentativa", [["oi", "nome"], ["Ana", "produto"]]);
await cenario("2. válida na 2ª tentativa", [["oi", "nome"], ["ok", "nome"], ["Ana", "produto"], ["ok", "produto"], ["cimento", "quantidade"]]);
await cenario("3. duas inválidas → pula", [["oi", "nome"], ["ok", "nome"], ["ok", "produto"], ["ok", "produto"], ["ok", "quantidade"], ["ok", "quantidade"], ["ok", "observacoes"], ["ok", "observacoes"], ["ok", "humano"]]);
await cenario("4. 'não sei' → avança na hora", [["oi", "nome"], ["não sei", "produto"]]);
await cenario("5. quantidade não aplicável", [
  ["Vocês trabalham com a marca Tigre?", "nome", { resumo: { produto: "marca Tigre" }, quantidade_aplicavel: false }],
  ["Carlos", "observacoes"], ["não", "humano"]]);
await cenario("5b. já preenchida não conta tentativa", [
  ["Sou a Ana, quero 10 sacos de cimento", "observacoes", { resumo: { nome: "Ana", produto: "cimento", quantidade: "10 sacos" } }],
  ["ok", "observacoes"], ["ok", "humano"]]);

// 6. nova conversa (inatividade de 20 min) zera os contadores
const agoraReal = Date.now; let desloc = 0; Date.now = () => agoraReal() + desloc;
await cenario("6. novo atendimento zera contadores", [["ok", "nome"]], async (ia, c) => {
  await ia.responder("oi", c); await ia.responder("ok", c); // nome perguntado 2x
  desloc = 21 * 60 * 1000;                                  // 21 min depois
  const r = await ia.responder("oi de novo", c);             // novo atendimento: nome (1ª)
  if (etapa(r.resposta) !== "nome") { falhas++; logOriginal("FAIL 6: novo atendimento não começou no nome"); }
});
Date.now = agoraReal;

// Extra: pergunta não entregue não conta como tentativa
await cenario("extra. envio falhou não conta", [["ok", "nome"], ["ok", "produto"]], async (ia, c) => {
  await ia.responder("oi", c);          // nome (1ª)
  await ia.responder("ok", c);          // nome (2ª)...
  ia.desfazerRespostaNaoEntregue();     // ...mas não foi entregue
});

const pulos = logs.filter((l) => l.includes("pulada"));
logOriginal(`\nlogs de etapa pulada: ${pulos.length}`);
logOriginal(falhas ? `\n${falhas} FALHA(S)` : "\nTODOS OS CENÁRIOS PASSARAM");
process.exit(falhas ? 1 : 0);
