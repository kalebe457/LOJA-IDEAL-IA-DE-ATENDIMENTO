import "dotenv/config";

import { iniciarWebhook } from "./webhook.js";

/*
 * Recupera os atendimentos do banco e só então aceita webhooks.
 * Falha aqui é da porta/servidor (o banco nunca impede a partida).
 */
iniciarWebhook().catch((erro: unknown) => {
  console.error(
    "Falha ao iniciar o backend:",
    erro instanceof Error ? erro.message : "erro desconhecido",
  );

  process.exit(1);
});
