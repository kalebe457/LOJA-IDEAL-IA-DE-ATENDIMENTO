import "dotenv/config";

/*
 * Configuração da integração dos vendedores pelo Telegram.
 *
 * Lida do .env no PRIMEIRO uso e guardada: alterar
 * TELEGRAM_RESUMO_TTL_HORAS ou TELEGRAM_VENDEDORES_AUTORIZADOS
 * exige REINICIAR o backend.
 *
 * Importar este módulo não lê nem valida nada.
 */

const TTL_MAXIMO_HORAS = 720;

let ttlHoras: number | null = null;

let vendedoresAutorizados: ReadonlySet<string> | null = null;

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
 * TELEGRAM_VENDEDORES_AUTORIZADOS: user_ids do Telegram
 * separados por vírgula.
 *
 * Os IDs ficam como STRING (nunca Number): o PostgreSQL devolve
 * BIGINT como string e IDs do Telegram podem passar de 32 bits.
 *
 * Espaços externos são removidos e entradas vazias ignoradas.
 * Entrada que não seja só dígitos gera erro (citando a posição,
 * não o valor). Variável ausente ou vazia: ninguém autorizado.
 */
export function lerTelegramVendedoresAutorizados(): ReadonlySet<string> {
  if (vendedoresAutorizados !== null) {
    return vendedoresAutorizados;
  }

  const entradas = (process.env.TELEGRAM_VENDEDORES_AUTORIZADOS ?? "")
    .split(",")
    .map((entrada) => entrada.trim());

  const ids = new Set<string>();

  entradas.forEach((entrada, indice) => {
    if (entrada === "") {
      return;
    }

    if (!/^\d+$/.test(entrada)) {
      throw new Error(
        `[Config] TELEGRAM_VENDEDORES_AUTORIZADOS: entrada ${indice + 1} inválida (use apenas dígitos do user_id do Telegram).`,
      );
    }

    ids.add(entrada);
  });

  if (ids.size === 0) {
    console.warn(
      "[Config] TELEGRAM_VENDEDORES_AUTORIZADOS vazio: nenhum vendedor autorizado no Telegram.",
    );
  }

  vendedoresAutorizados = ids;

  return ids;
}

/**
 * Somente para testes: descarta os valores guardados.
 */
export function redefinirConfigTelegramParaTestes(): void {
  ttlHoras = null;

  vendedoresAutorizados = null;
}
