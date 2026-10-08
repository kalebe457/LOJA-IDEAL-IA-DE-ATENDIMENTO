// Executa a bateria de regressão em sequência e resume o resultado.
//
// Uso: npm test   (ou: node tests/run-all.mjs)
//
// - Cada suíte roda em um processo próprio (node --import tsx), em ordem.
// - A execução continua até o fim mesmo se uma suíte falhar, para o resumo
//   mostrar todas as falhas.
// - Código de saída: 0 se todas passarem; 1 se qualquer uma falhar.
//
// Requisitos: dependências instaladas (npm install) e o PostgreSQL local com o
// banco loja_ideal (variáveis DB_* no .env). Nenhuma suíte acessa a internet:
// Meta, Telegram e Anthropic são simulados dentro de cada teste.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const raiz = fileURLToPath(new URL("..", import.meta.url));

const SUITES = [
  "passo4-somente-log.test.mts",
  "passo4-meta-envio.test.mts",
  "telegram-e2e.test.mts",
  "passo3-dedup.test.mts",
  "passo3-banco-indisponivel.test.mts",
  "passo3-ordem-lote.test.mts",
  "passo5a-espelho.test.mts",
  "passo5b-triagem.test.mts",
  "telegram.test.mts",
  "rota-telegram.test.mts",
  "passo2-grupo.test.mts",
  "tentativas.test.mts",
  "recusa.test.mts",
  "horario.test.ts",
  "testeAtribuicao-adaptado.mts",
];

// Tempo máximo por suíte; estourar conta como falha.
const TIMEOUT_MS = 5 * 60 * 1000;

const resultados = [];

for (const [indice, suite] of SUITES.entries()) {
  console.log(`\n========== [${indice + 1}/${SUITES.length}] ${suite} ==========`);

  const inicio = Date.now();

  const execucao = spawnSync(
    process.execPath,
    ["--import", "tsx", path.join("tests", suite)],
    { cwd: raiz, stdio: "inherit", timeout: TIMEOUT_MS },
  );

  const segundos = ((Date.now() - inicio) / 1000).toFixed(1);

  let codigo = execucao.status;

  let detalhe = "";

  if (execucao.error) {
    codigo = codigo ?? 1;
    detalhe = execucao.error.code === "ETIMEDOUT" ? " (tempo esgotado)" : ` (${execucao.error.message})`;
  } else if (execucao.signal) {
    codigo = codigo ?? 1;
    detalhe = ` (encerrada por sinal ${execucao.signal})`;
  }

  const passou = codigo === 0;

  resultados.push({ suite, passou, codigo, segundos, detalhe });

  console.log(`---------- ${passou ? "PASSOU" : "FALHOU"}: ${suite} | exit ${codigo}${detalhe} | ${segundos} s`);
}

const falhas = resultados.filter((r) => !r.passou);

console.log("\n================ RESUMO ================");

for (const r of resultados) {
  console.log(`${r.passou ? "PASSOU" : "FALHOU"}  ${r.suite.padEnd(36)} exit ${r.codigo}${r.detalhe}  (${r.segundos} s)`);
}

console.log(
  falhas.length === 0
    ? `\nTodas as ${resultados.length} suítes passaram.`
    : `\n${falhas.length} de ${resultados.length} suíte(s) falharam: ${falhas.map((r) => r.suite).join(", ")}`,
);

process.exit(falhas.length === 0 ? 0 : 1);
