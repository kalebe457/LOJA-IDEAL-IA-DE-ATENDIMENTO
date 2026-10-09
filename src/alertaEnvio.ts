import { descreverErro } from "./logSeguro.js";

import type { ResultadoEnvioMeta } from "./metaEnvio.js";

import { avisarAdministradores } from "./telegramBot.js";

/*
 * Alerta GERAL de envio pelo WhatsApp (só para os administradores do
 * grupo de vendedores, no privado; nunca no grupo).
 *
 * Dispara com 3 falhas de envio seguidas em até 10 min (de clientes
 * diferentes ou não), ou na hora com erro de token. No máximo 1
 * alerta a cada 30 min. No primeiro envio aceito depois de um
 * alerta, avisa que voltou ao normal. Sem nenhum dado de cliente.
 *
 * As mensagens aos administradores saem numa fila própria: a fila
 * da conversa do cliente não espera o Telegram.
 */

const FALHAS_SEGUIDAS = 3;

const JANELA_FALHAS_MS = 10 * 60 * 1000;

const INTERVALO_ALERTA_MS = 30 * 60 * 1000;

export type MotivoFalhaEnvio = "token" | "api" | "instabilidade";

const TEXTO_MOTIVO: Record<MotivoFalhaEnvio, string> = {
  token: "token da Meta expirado ou inválido",
  api: "erro na API da Meta",
  instabilidade: "instabilidade",
};

const MENSAGEM_NORMALIZADO = "✅ Os envios pelo WhatsApp voltaram ao normal.";

/*
 * Falhas desde o último envio aceito (só as mais recentes importam).
 */
let falhasSeguidas: { em: number; motivo: MotivoFalhaEnvio }[] = [];

let ultimoAlertaEm: number | null = null;

/*
 * Houve alerta e ainda não houve envio aceito depois dele.
 */
let alertaAtivo = false;

let fila: Promise<void> = Promise.resolve();

function enfileirar(tarefa: () => Promise<void>): Promise<void> {
  fila = fila
    .then(tarefa)
    .catch((erro: unknown) => {
      console.error(`[Alerta] falha ao avisar os administradores (${descreverErro(erro)}).`);
    });

  return fila;
}

/**
 * Motivo provável de uma falha de envio (para o texto do alerta).
 *
 * token: erro 190 ou token ausente; esgotado: rede/timeout/5xx
 * (instabilidade); o resto: erro na API da Meta.
 */
export function motivoDaFalhaEnvio(
  motivo: Extract<ResultadoEnvioMeta, { aceito: false }>["motivo"],
): MotivoFalhaEnvio {
  if (motivo === "token") {
    return "token";
  }

  return motivo === "esgotado" ? "instabilidade" : "api";
}

/**
 * Uma mensagem ao cliente foi dada como não entregue (depois do
 * retry). Devolve a promessa da fila (os testes podem esperar).
 */
export function registrarFalhaEnvio(motivo: MotivoFalhaEnvio): Promise<void> {
  const agora = Date.now();

  falhasSeguidas.push({ em: agora, motivo });

  falhasSeguidas = falhasSeguidas.slice(-FALHAS_SEGUIDAS);

  const primeiraDasUltimas = falhasSeguidas[0];

  const disparar =
    motivo === "token" ||
    (falhasSeguidas.length >= FALHAS_SEGUIDAS &&
      primeiraDasUltimas !== undefined &&
      agora - primeiraDasUltimas.em <= JANELA_FALHAS_MS);

  console.error(
    `[Alerta] falha de envio registrada (motivo: ${motivo}; ${falhasSeguidas.length} seguida(s)).`,
  );

  if (!disparar) {
    return fila;
  }

  if (ultimoAlertaEm !== null && agora - ultimoAlertaEm < INTERVALO_ALERTA_MS) {
    console.error("[Alerta] envios continuam falhando; alerta geral já enviado há menos de 30 min.");

    return fila;
  }

  ultimoAlertaEm = agora;

  alertaAtivo = true;

  /*
   * Token pesa mais que os outros motivos; depois, o mais recente.
   */
  const motivoAlerta = falhasSeguidas.some((f) => f.motivo === "token") ? "token" : motivo;

  const texto = [
    "⚠️ A IA não está conseguindo enviar mensagens no WhatsApp.",
    `Motivo provável: ${TEXTO_MOTIVO[motivoAlerta]}.`,
    "Os atendimentos afetados foram para o grupo.",
  ].join(" ");

  console.error(`[Alerta] ATENÇÃO: alerta geral de envio (motivo: ${motivoAlerta}).`);

  return enfileirar(async () => {
    await avisarAdministradores(texto);
  });
}

/**
 * Uma mensagem ao cliente foi aceita pela Meta.
 */
export function registrarEnvioAceito(): Promise<void> {
  falhasSeguidas = [];

  if (!alertaAtivo) {
    return fila;
  }

  alertaAtivo = false;

  console.log("[Alerta] envios voltaram ao normal; avisando os administradores.");

  return enfileirar(async () => {
    await avisarAdministradores(MENSAGEM_NORMALIZADO);
  });
}

/**
 * Somente para testes: zera o estado do alerta.
 */
export function redefinirAlertaEnvioParaTestes(): void {
  falhasSeguidas = [];

  ultimoAlertaEm = null;

  alertaAtivo = false;

  fila = Promise.resolve();
}

/**
 * Somente para testes: espera os avisos já enfileirados.
 */
export function aguardarAlertasParaTestes(): Promise<void> {
  return fila;
}
