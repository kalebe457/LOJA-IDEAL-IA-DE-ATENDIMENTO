// Proteção do banco de testes: nada dos testes roda fora de loja_ideal_teste.
// As travas são exercitadas com conexões SIMULADAS (que só registram o que receberiam), e o script
// de preparo é chamado de verdade pedindo outro banco: precisa abortar sem conectar em nada.
// Nenhuma conexão real com loja_ideal, betgestor ou outro banco.
// Banco de TESTES (loja_ideal_teste) fixado antes de qualquer import de src/; loja_ideal é dado real.
const { exigirBancoDeTeste, bancoEhDeTeste, BANCO_TESTE } = await import(new URL("./banco-teste.mts", import.meta.url).href);
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const B = new URL("..", import.meta.url).href.replace(/\/$/, "");
const raiz = fileURLToPath(new URL("..", import.meta.url));

let falhas = 0, total = 0;
const ok = (c: boolean, t: string) => { total++; if (!c) falhas++; console.log(`${c ? "OK  " : "FAIL"} ${t}`); };

const banco = await import(B + "/src/banco.ts");
await exigirBancoDeTeste(banco.consultar);
ok(process.env.DB_NAME === BANCO_TESTE && (await banco.consultar("SELECT current_database() AS db")).rows[0].db === BANCO_TESTE,
  `esta suíte está em ${BANCO_TESTE}`);

const { prepararBancoDeTeste } = await import(B + "/tests/preparar-banco-teste.mts");

// Conexão simulada: registra o banco pedido e cada comando; current_database() devolve "banco".
function simulada(banco: string) {
  const registro = { conexoes: [] as string[], comandos: [] as string[], encerradas: 0 };
  const conectar = async (pedido: string) => {
    registro.conexoes.push(pedido);
    return {
      query: async (texto: string) => {
        registro.comandos.push(texto.trim().split(/\s+/).slice(0, 3).join(" "));
        return { rows: [{ db: banco }], rowCount: 0 };
      },
      end: async () => { registro.encerradas++; },
    };
  };
  return { registro, conectar };
}
const erroDe = async (p: Promise<unknown>) => { try { await p; return ""; } catch (e) { return e instanceof Error ? e.message : String(e); } };

console.log("== Trava 1: nome do banco diferente da constante ==");
for (const outro of ["loja_ideal", "betgestor", "postgres", "LOJA_IDEAL_TESTE", ""]) {
  const s = simulada(BANCO_TESTE);
  const erro = await erroDe(prepararBancoDeTeste(outro, s.conectar));
  ok(erro.startsWith("ABORTADO") && s.registro.conexoes.length === 0 && s.registro.comandos.length === 0,
    `preparo pedindo "${outro}": abortou sem conectar e sem executar nada`);
}

console.log("\n== Trava 2: conectado num banco que não é o de testes ==");
for (const real of ["loja_ideal", "betgestor"]) {
  const s = simulada(real);
  const erro = await erroDe(prepararBancoDeTeste(undefined, s.conectar));
  ok(erro.startsWith("ABORTADO") && JSON.stringify(s.registro.comandos) === JSON.stringify(["SELECT current_database() AS"]) && s.registro.encerradas === 1,
    `current_database() = "${real}": abortou antes de qualquer DROP/CREATE (comandos: ${s.registro.comandos.join(" | ")})`);
}
{
  const s = simulada(BANCO_TESTE);
  await prepararBancoDeTeste(undefined, s.conectar);
  ok(s.registro.conexoes.join() === BANCO_TESTE && s.registro.comandos[0] === "SELECT current_database() AS" && s.registro.comandos[1] === "DROP SCHEMA IF",
    "controle: em loja_ideal_teste a checagem vem ANTES do DROP SCHEMA");
}

console.log("\n== Script de preparo chamado de verdade pedindo outro banco ==");
for (const outro of ["loja_ideal", "betgestor"]) {
  const r = spawnSync(process.execPath, ["--import", "tsx", "tests/preparar-banco-teste.mts", outro], { cwd: raiz, encoding: "utf8", timeout: 60_000 });
  ok(r.status === 1 && r.stdout.includes(`ABORTADO: o preparo só roda em ${BANCO_TESTE} (pedido: "${outro}"); nada foi executado.`),
    `npm run test:db -- ${outro}: exit ${r.status}, abortou sem executar nada`);
}

console.log("\n== Auxiliar das suítes e limpeza ==");
const consultaSimulada = (db: string, comandos: string[]) => async (texto: string) => { comandos.push(texto); return { rows: [{ db }], rowCount: 0 }; };
ok((await bancoEhDeTeste(consultaSimulada("loja_ideal", []))) === false && (await bancoEhDeTeste(consultaSimulada(BANCO_TESTE, []))) === true &&
   (await bancoEhDeTeste(async () => { throw new Error("sem conexão"); })) === false,
  "bancoEhDeTeste: loja_ideal → false; loja_ideal_teste → true; erro de conexão → false");
const r = spawnSync(process.execPath, ["--import", "tsx", "-e",
  `const m = await import(${JSON.stringify(B + "/tests/banco-teste.mts")}); await m.exigirBancoDeTeste(async () => ({ rows: [{ db: "loja_ideal" }] })); console.log("NÃO ABORTOU");`],
  { cwd: raiz, encoding: "utf8", timeout: 60_000 });
ok(r.status === 1 && r.stdout.includes("ABORTADO") && !r.stdout.includes("NÃO ABORTOU"), `exigirBancoDeTeste com "loja_ideal": a suíte para (exit ${r.status})`);
const limpeza = await import(B + "/tests/limpeza-espelho.mts");
const comandosLimpeza: string[] = [];
const erroLimpeza = await erroDe(limpeza.limparEspelhoDeTeste(consultaSimulada("loja_ideal", comandosLimpeza)));
ok(erroLimpeza.startsWith("limpeza recusada") && comandosLimpeza.length === 1 && !comandosLimpeza.some((c) => /DELETE/i.test(c)),
  "limpeza no banco loja_ideal: recusada, nenhum DELETE executado");
const comandosVend: string[] = [];
const erroVend = await erroDe(limpeza.limparVendedoresDeTeste(consultaSimulada("loja_ideal", comandosVend), [10], new Date()));
ok(erroVend.startsWith("limpeza recusada") && !comandosVend.some((c) => /DELETE/i.test(c)), "limpeza de vendedores no banco loja_ideal: recusada");

await banco.encerrarBanco();
console.log(falhas ? `\n${total} verificações | ${falhas} FALHA(S)` : `\n${total} verificações | TODOS OS TESTES PASSARAM`);
await new Promise((res) => setTimeout(res, 300));
process.exit(falhas ? 1 : 0);
