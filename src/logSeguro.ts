/*
 * O que pode ir para o LOG (único lugar com essas regras).
 *
 * O log diz o que o SISTEMA fez, nunca o que o cliente disse. Os
 * dados completos ficam no banco, no resumo do grupo e na DM do
 * vendedor; aqui só entram códigos, contagens, tamanhos, classes de
 * erro, status HTTP e identificadores MASCARADOS.
 *
 * Nunca: texto de mensagem, telefone/chat_id/user_id completos,
 * nomes, campos do resumo, corpo de requisição ou resposta,
 * erro.message cru de biblioteca externa, tokens e segredos.
 */

/*
 * Códigos técnicos aceitos como estão: pg (57014, 3D000), Node
 * (ECONNREFUSED, ERR_...), etc.
 */
const CODIGO_SEGURO = /^[A-Z0-9_]{2,40}$/;

/*
 * Nome de classe de erro (TimeoutError, AbortError, TypeError...).
 */
const NOME_SEGURO = /^[A-Za-z]{1,40}$/;

/*
 * Identificador técnico vindo de fora (tipo de erro, request_id).
 */
const TOKEN_SEGURO = /^[\w.-]{1,80}$/;

/**
 * Valor técnico externo só se tiver o formato esperado; senão "-".
 */
export function valorSeguro(valor: unknown): string {
  return typeof valor === "string" && TOKEN_SEGURO.test(valor) ? valor : "-";
}

/**
 * wamid vindo de um corpo da Meta, só se tiver o formato de wamid.
 */
export function wamidSeguro(valor: unknown): string {
  return typeof valor === "string" && /^[A-Za-z0-9._=+/-]{1,200}$/.test(valor) ? valor : "formato inválido";
}

/**
 * Descrição de um erro só com dados técnicos, NUNCA a mensagem.
 *
 * - API da Anthropic (e outras com status HTTP): "HTTP 529 | type: ... | request_id: ...";
 * - erros com código (pg, Node): o código;
 * - fetch com causa de rede: o código da causa;
 * - demais: o nome da classe do erro.
 */
export function descreverErro(erro: unknown): string {
  if (erro === null || typeof erro !== "object") {
    return "erro desconhecido";
  }

  const e = erro as {
    status?: unknown;
    code?: unknown;
    requestID?: unknown;
    error?: { error?: { type?: unknown } };
    cause?: { code?: unknown } | null;
    name?: unknown;
  };

  if (typeof e.status === "number") {
    return [
      `HTTP ${e.status}`,
      `type: ${valorSeguro(e.error?.error?.type)}`,
      `request_id: ${valorSeguro(e.requestID)}`,
    ].join(" | ");
  }

  if (typeof e.code === "string" && CODIGO_SEGURO.test(e.code)) {
    return e.code;
  }

  const causa = typeof e.cause === "object" && e.cause !== null ? e.cause.code : undefined;

  if (typeof causa === "string" && CODIGO_SEGURO.test(causa)) {
    return causa;
  }

  if (typeof e.name === "string" && NOME_SEGURO.test(e.name)) {
    return e.name;
  }

  return "erro desconhecido";
}

/**
 * Mascara um telefone (ou outro identificador numérico) para logs.
 *
 * Sempre 4 asteriscos, para não revelar o tamanho:
 * 5591900000000 -> 5591****0000
 */
export function mascararTelefone(telefone: string): string {
  if (telefone.length <= 8) {
    return "****" + telefone.slice(-2);
  }

  return telefone.slice(0, 4) + "****" + telefone.slice(-4);
}

/**
 * Mascara números longos dentro de um chatId para logs.
 *
 * meta:<id>:5591900000000 -> meta:<id mascarado>:5591****0000
 */
export function mascararChatId(chatId: string): string {
  return chatId.replace(/\d{8,}/g, (digitos) => mascararTelefone(digitos));
}

/**
 * user_id do Telegram para logs (mesmo padrão do telefone).
 */
export function mascararIdTelegram(id: unknown): string {
  const texto = typeof id === "number" || typeof id === "string" ? String(id) : "";

  return /^\d+$/.test(texto) ? mascararTelefone(texto) : "inválido";
}

/**
 * phone_number_id do número da loja para logs (é ID real).
 */
export function mascararPhoneNumberId(id: unknown): string {
  return typeof id === "string" && /^\d+$/.test(id) ? mascararTelefone(id) : "não informado";
}
