import "dotenv/config";

/*
 * Configuração da integração dos vendedores pelo Telegram.
 *
 * Lida do .env no PRIMEIRO uso e guardada: alterar
 * TELEGRAM_RESUMO_TTL_HORAS exige REINICIAR o backend.
 *
 * Importar este módulo não lê nem valida nada.
 *
 * Quem pode atuar como vendedor NÃO é configurado aqui:
 * a fonte de verdade é a participação no grupo do Telegram
 * (getChatMember, em telegramBot.ts).
 */

const TTL_MAXIMO_HORAS = 720;

let ttlHoras: number | null = null;

/**
 * TELEGRAM_RESUMO_TTL_HORAS: validade do resumo do Telegram,
 * usada para assumir o atendimento e para o retry do resumo.
 *
 * Inteiro positivo, no máximo 720. Sem valor padrão: ausente
 * ou inválido gera erro.
 */
export function lerTelegramResumoTtlHoras(): number {
  if (ttlHoras !== null) {
    return ttlHoras;
  }

  const bruto = (process.env.TELEGRAM_RESUMO_TTL_HORAS ?? "").trim();

  if (bruto === "") {
    throw new Error("[Config] TELEGRAM_RESUMO_TTL_HORAS não configurado.");
  }

  /*
   * Só dígitos: recusa decimal, negativo, sinal e texto.
   */
  if (!/^\d+$/.test(bruto)) {
    throw new Error(
      "[Config] TELEGRAM_RESUMO_TTL_HORAS inválido: use um inteiro positivo de horas.",
    );
  }

  const horas = Number(bruto);

  if (horas < 1 || horas > TTL_MAXIMO_HORAS) {
    throw new Error(
      `[Config] TELEGRAM_RESUMO_TTL_HORAS fora do limite: deve estar entre 1 e ${TTL_MAXIMO_HORAS}.`,
    );
  }

  ttlHoras = horas;

  return horas;
}

/**
 * Somente para testes: descarta o valor guardado.
 */
export function redefinirConfigTelegramParaTestes(): void {
  ttlHoras = null;
}
