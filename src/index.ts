import * as readline from "node:readline/promises";

import { IAMock } from "./iaMock.js";

import type {
  Cliente
} from "./tipos.js";

const ia = new IAMock();

const cliente: Cliente = {
  telefone: "5591999999999",

  status: "IA",

  resumo: {
    nome: "Não informado",
    telefone: "5591999999999",
    necessidade: "Não informado",
    ambiente: "Não informado",
    medidas: "Não informado",
    produto: "Não informado",
    quantidade: "Não informado",
    prazo: "Não informado",
    observacoes: "Não informado"
  }
};

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

console.log("=================================");
console.log("       LOJA IDEAL - TESTE");
console.log("=================================");
console.log("Digite 'sair' para encerrar.\n");

while (true) {

  const mensagem = await rl.question("Você: ");

  if (
    mensagem.trim().toLowerCase() === "sair"
  ) {
    break;
  }

  if (cliente.status === "HUMANO") {

    console.log("\n[ATENDIMENTO TRANSFERIDO]");

    console.log(
      "A IA não responde mais este cliente."
    );

    console.log("\nResumo:");

    console.log(
      JSON.stringify(
        cliente.resumo,
        null,
        2
      )
    );

    console.log("");

    continue;
  }

  const resultado = await ia.responder(
    mensagem,
    cliente
  );

  cliente.status = resultado.status;
  cliente.resumo = resultado.resumo;

  console.log(`\nIdeal: ${resultado.resposta}`);

  console.log(
    `Status: ${cliente.status}`
  );

  if (cliente.status === "HUMANO") {

    console.log("\n========== RESUMO ==========");

    console.log(
      JSON.stringify(
        cliente.resumo,
        null,
        2
      )
    );

    console.log("============================\n");
  } else {
    console.log("");
  }
}

rl.close();

console.log("\nPrograma encerrado.");