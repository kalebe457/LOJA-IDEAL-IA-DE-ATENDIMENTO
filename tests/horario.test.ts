// Nenhuma chamada de rede: qualquer fetch neste teste é um erro.
(globalThis as any).fetch = async (url: unknown) => { throw new Error("rede bloqueada no teste: " + String(url)); };
// Raiz do projeto, derivada deste arquivo (funciona em Windows e Linux).
const B = new URL("..", import.meta.url).href.replace(/\/$/, "");
const { lojaAberta, chavePeriodoFechado } = await import(B + "/src/horarioFuncionamento.ts");
// Belém = UTC-3. 2026-10-05 é segunda.
const t = (iso: string) => Date.parse(iso + "-03:00");
const casos: [string, boolean, string?][] = [
  ["2026-10-05T07:59", false, "2026-10-05"],
  ["2026-10-05T08:00", true],
  ["2026-10-05T18:59", true],
  ["2026-10-05T19:00", false, "2026-10-06"],
  ["2026-10-05T23:30", false, "2026-10-06"],
  ["2026-10-09T19:30", false, "2026-10-10"], // sexta à noite -> sábado
  ["2026-10-10T14:59", true],
  ["2026-10-10T15:00", false, "2026-10-12"], // sábado 15h -> segunda
  ["2026-10-11T10:00", false, "2026-10-12"], // domingo
  ["2026-10-12T07:00", false, "2026-10-12"],
];
let falhas = 0;
for (const [iso, aberta, chave] of casos) {
  const a = lojaAberta(t(iso));
  const c = a ? "-" : chavePeriodoFechado(t(iso));
  const ok = a === aberta && (chave === undefined || c === chave);
  if (!ok) falhas++;
  console.log(`${ok ? "OK  " : "FAIL"} ${iso} aberta=${a} periodo=${c}`);
}
process.exit(falhas ? 1 : 0);
