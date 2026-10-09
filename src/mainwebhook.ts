import "dotenv/config";

import { descreverErro } from "./logSeguro.js";

import { iniciarWebhook } from "./webhook.js";

/*
 * Recupera os atendimentos do banco e só então aceita webhooks.
 * Falha aqui é da porta/servidor (o banco nunca impede a partida).
 */
iniciarWebhook().catch((erro: unknown) => {
  console.error(
    "Falha ao iniciar o backend:",
    descreverErro(erro),
  );

  process.exit(1);
});
