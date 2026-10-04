import { lerChatIdMeta } from "./metaWebhook.js";

/*
 * Envio de mensagens de texto pela WhatsApp Cloud API.
 *
 * Totalmente separado do OpenWA.
 *
 * IMPORTANTE:
 *
 * HTTP 2xx + wamid significa somente que a Graph API
 * ACEITOU a requisição. Não é confirmação de entrega.
 * O resultado real chega depois em statuses[]
 * (sent, delivered, read, failed).
 */

const GRAPH_BASE_URL_PADRAO = "https://graph.facebook.com";

/*
 * Limite de text.body da Cloud API.
 */
const LIMITE_TEXTO = 4096;

/*
 * Timeout de cada tentativa.
 */
const TIMEOUT_MS = 10_000;

/*
 * Máximo de tentativas por envio.
 */
const MAX_TENTATIVAS = 3;

/*
 * Espera antes da 2ª e da 3ª tentativa.
 */
const ESPERAS_MS = [1_000, 3_000];

/*
 * Retry-After acima disso: desistimos
 * em vez de travar a fila do cliente.
 */
const MAX_RETRY_AFTER_MS = 30_000;

/*
 * Erros que nunca são repetidos,
 * mesmo vindo com HTTP 429/5xx.
 */
const CODIGOS_SEM_RETRY = new Set([1, 190, 130497, 131047, 131048]);

/*
 * Rate limit: a Meta recusou sem processar.
 */
const CODIGOS_RATE_LIMIT = new Set([4, 80007, 130429, 131056]);

/*
 * 503 explícito: serviço indisponível.
 */
const CODIGOS_503_EXPLICITO = new Set([131016, 133004, 131057]);

/*
 * Erros de rede em que a requisição
 * claramente não chegou à Meta.
 */
const ERROS_REDE_SEM_ENVIO = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN"]);

/*
 * Mapa wamid -> chatId.
 *
 * SOMENTE EM MEMÓRIA nesta etapa: perde-se ao reiniciar.
 * Em produção deve ser persistido.
 */
const TTL_MAPA_MS = 24 * 60 * 60 * 1000;

const MAX_ITENS_MAPA = 5_000;

export type ResultadoEnvioMeta =
  | {
      /*
       * Aceito pela Graph API. NÃO é entrega.
       */
      aceito: true;
      wamid: string;
    }
  | {
      aceito: false;
      motivo: "configuracao" | "tamanho" | "permanente" | "anomalia" | "esgotado";
    };

/*
 * Classe de cada tentativa.
 *
 * seguro:   não chegou à Meta ou foi recusado sem processar;
 *           pode repetir sem risco de duplicar.
 * incerto:  a Meta pode ter aceitado (timeout, ECONNRESET, 500...);
 *           repetir pode duplicar a mensagem.
 */
type ClasseTentativa = "aceito" | "anomalia" | "permanente" | "seguro" | "incerto";

type ResultadoTentativa = {
  classe: ClasseTentativa;

  wamid?: string;

  /*
   * Espera pedida pela Meta (Retry-After).
   */
  esperaMs?: number;

  /*
   * A Meta indicou que não adianta repetir agora.
   */
  desistir?: boolean;
};

/**
 * Mapa wamid -> chatId com TTL e teto.
 *
 * O relógio é injetável para testes.
 */
export class MapaWamidChatId {
  private readonly itens = new Map<
    string,
    { chatId: string; registradoEm: number }
  >();

  private readonly ttlMs: number;

  private readonly maxItens: number;

  private readonly agora: () => number;

  constructor(
    ttlMs: number,
    maxItens: number,
    agora: () => number = () => Date.now(),
  ) {
    this.ttlMs = ttlMs;

    this.maxItens = maxItens;

    this.agora = agora;
  }

  registrar(wamid: string, chatId: string): void {
    this.limparExpirados();

    this.itens.delete(wamid);

    this.itens.set(wamid, { chatId, registradoEm: this.agora() });

    /*
     * Teto: descarta os mais antigos.
     */
    while (this.itens.size > this.maxItens) {
      const maisAntigo = this.itens.keys().next().value;

      if (maisAntigo === undefined) {
        break;
      }

      this.itens.delete(maisAntigo);
    }
  }

  obter(wamid: string): string | null {
    const item = this.itens.get(wamid);

    if (!item) {
      return null;
    }

    if (this.agora() - item.registradoEm >= this.ttlMs) {
      this.itens.delete(wamid);

      return null;
    }

    return item.chatId;
  }

  tamanho(): number {
    this.limparExpirados();

    return this.itens.size;
  }

  /*
   * Os itens estão em ordem de registro,
   * então paramos no primeiro ainda válido.
   */
  private limparExpirados(): void {
    const agora = this.agora();

    for (const [wamid, item] of this.itens) {
      if (agora - item.registradoEm < this.ttlMs) {
        break;
      }

      this.itens.delete(wamid);
    }
  }
}

const chatIdPorWamid = new MapaWamidChatId(TTL_MAPA_MS, MAX_ITENS_MAPA);

/**
 * Lido a cada chamada.
 *
 * Padrão: false.
 */
export function metaEnvioAtivo(): boolean {
  return (process.env.META_ENVIO_ATIVO ?? "").trim() === "true";
}

/**
 * Procura o chatId que originou um wamid.
 */
export function obterChatIdPorWamid(wamid: string): string | null {
  return chatIdPorWamid.obter(wamid);
}

/**
 * Mascara um telefone para logs.
 *
 * 5591900000001 -> 5591*****0001
 */
export function mascararTelefone(telefone: string): string {
  if (telefone.length <= 8) {
    return "*".repeat(Math.max(0, telefone.length - 2)) + telefone.slice(-2);
  }

  return (
    telefone.slice(0, 4) +
    "*".repeat(telefone.length - 8) +
    telefone.slice(-4)
  );
}

/**
 * Descreve o destino de um chatId Meta
 * sem expor o telefone completo.
 */
export function descreverDestinoMeta(chatId: string): string {
  const destino = lerChatIdMeta(chatId);

  if (!destino) {
    return "destino inválido";
  }

  return mascararTelefone(destino.from);
}

let avisoBaseUrlEmitido = false;

/**
 * URL base da Graph API.
 *
 * Override só para localhost/127.0.0.1 (testes).
 * Qualquer outro valor é ignorado.
 */
function obterGraphBaseUrl(): string {
  const valor = (process.env.META_GRAPH_BASE_URL ?? "").trim();

  if (!valor) {
    return GRAPH_BASE_URL_PADRAO;
  }

  try {
    const url = new URL(valor);

    const protocoloValido =
      url.protocol === "http:" || url.protocol === "https:";

    const hostLocal =
      url.hostname === "localhost" || url.hostname === "127.0.0.1";

    if (protocoloValido && hostLocal) {
      return url.origin;
    }
  } catch {
    /*
     * Valor inválido: cai no aviso abaixo.
     */
  }

  if (!avisoBaseUrlEmitido) {
    avisoBaseUrlEmitido = true;

    console.warn(
      "META_GRAPH_BASE_URL ignorado: só localhost/127.0.0.1 é aceito. Usando a Graph API oficial.",
    );
  }

  return GRAPH_BASE_URL_PADRAO;
}

function esperar(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Lê Retry-After (segundos ou data HTTP).
 */
function lerRetryAfterMs(valor: string | null): number | null {
  if (!valor) {
    return null;
  }

  const segundos = Number(valor);

  if (Number.isFinite(segundos) && segundos >= 0) {
    return segundos * 1000;
  }

  const data = Date.parse(valor);

  if (!Number.isNaN(data)) {
    return Math.max(0, data - Date.now());
  }

  return null;
}

/**
 * X-Business-Use-Case-Usage com
 * estimated_time_to_regain_access > 0
 * (em minutos) indica que não adianta
 * repetir agora.
 */
function bucIndicaBloqueio(valor: string | null): boolean {
  if (!valor) {
    return false;
  }

  try {
    const uso = JSON.parse(valor) as Record<
      string,
      { estimated_time_to_regain_access?: number }[]
    >;

    return Object.values(uso).some((itens) =>
      itens.some((item) => (item.estimated_time_to_regain_access ?? 0) > 0),
    );
  } catch {
    return false;
  }
}

type ErroGraph = {
  code?: number;

  error_subcode?: number;

  type?: string;

  fbtrace_id?: string;
};

/**
 * Explicação curta para códigos conhecidos.
 */
function descreverCodigo(code: number | undefined): string {
  switch (code) {
    case 190:
      return "token provavelmente expirado ou inválido";

    case 131047:
      return "fora da janela de 24h";

    case 130497:
      return "restrição de país do destinatário";

    case 131048:
      return "restrição de envio do número (qualidade)";

    default:
      return "";
  }
}

/**
 * Classifica uma resposta HTTP de erro.
 */
function classificarErroHttp(status: number, code: number | undefined): ClasseTentativa {
  if (code !== undefined && CODIGOS_SEM_RETRY.has(code)) {
    return "permanente";
  }

  if (status === 429 || (code !== undefined && CODIGOS_RATE_LIMIT.has(code))) {
    return "seguro";
  }

  if (status === 503 && code !== undefined && CODIGOS_503_EXPLICITO.has(code)) {
    return "seguro";
  }

  /*
   * 500 genérico (131000), 503 sem código explícito,
   * 502, 504...: a Meta pode ter processado.
   */
  if (status >= 500) {
    return "incerto";
  }

  return "permanente";
}

/**
 * Classifica uma exceção do fetch.
 */
function classificarErroRede(erro: unknown): { classe: ClasseTentativa; codigo: string } {
  const causa =
    erro instanceof Error && erro.cause && typeof erro.cause === "object"
      ? (erro.cause as { code?: unknown })
      : null;

  const codigo = typeof causa?.code === "string" ? causa.code : "desconhecido";

  /*
   * Erro desconhecido ou ECONNRESET:
   * a requisição pode ter chegado.
   */
  return {
    classe: ERROS_REDE_SEM_ENVIO.has(codigo) ? "seguro" : "incerto",
    codigo,
  };
}

/**
 * Executa UMA tentativa de envio.
 */
async function tentarEnvio(
  url: string,
  token: string,
  corpo: string,
  rotulo: string,
): Promise<ResultadoTentativa> {
  const controller = new AbortController();

  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  let resposta: Response;

  try {
    resposta = await fetch(url, {
      method: "POST",

      headers: {
        "Content-Type": "application/json",

        Authorization: `Bearer ${token}`,
      },

      body: corpo,

      signal: controller.signal,
    });
  } catch (erro: unknown) {
    clearTimeout(timer);

    if (controller.signal.aborted) {
      console.error(`${rotulo} | timeout após ${TIMEOUT_MS}ms | classe: incerto`);

      return { classe: "incerto" };
    }

    const { classe, codigo } = classificarErroRede(erro);

    console.error(`${rotulo} | erro de rede: ${codigo} | classe: ${classe}`);

    return { classe };
  }

  let json: unknown = null;

  try {
    json = await resposta.json();
  } catch {
    /*
     * Corpo não-JSON (ex.: página de erro).
     */
  } finally {
    clearTimeout(timer);
  }

  if (resposta.ok) {
    const mensagens = (json as { messages?: { id?: unknown }[] } | null)
      ?.messages;

    const wamid = mensagens?.[0]?.id;

    if (typeof wamid === "string" && wamid) {
      return { classe: "aceito", wamid };
    }

    console.error(
      `${rotulo} | HTTP ${resposta.status} sem wamid | classe: anomalia (sucesso NÃO confirmado)`,
    );

    return { classe: "anomalia" };
  }

  const erroGraph =
    (json as { error?: ErroGraph } | null)?.error ?? ({} as ErroGraph);

  const classe = classificarErroHttp(resposta.status, erroGraph.code);

  const descricao = descreverCodigo(erroGraph.code);

  console.error(
    [
      rotulo,
      `HTTP ${resposta.status}`,
      `code: ${erroGraph.code ?? "-"}`,
      `subcode: ${erroGraph.error_subcode ?? "-"}`,
      `type: ${erroGraph.type ?? "-"}`,
      `fbtrace_id: ${erroGraph.fbtrace_id ?? "-"}`,
      ...(descricao ? [descricao] : []),
      `classe: ${classe}`,
    ].join(" | "),
  );

  const resultado: ResultadoTentativa = { classe };

  const retryAfterMs = lerRetryAfterMs(resposta.headers.get("retry-after"));

  if (retryAfterMs !== null) {
    resultado.esperaMs = retryAfterMs;
  }

  if (
    (retryAfterMs !== null && retryAfterMs > MAX_RETRY_AFTER_MS) ||
    bucIndicaBloqueio(resposta.headers.get("x-business-use-case-usage"))
  ) {
    resultado.desistir = true;
  }

  return resultado;
}

/**
 * Envia um texto pela Cloud API.
 *
 * Política de tentativas:
 *
 * - no máximo 3 tentativas no total;
 * - "seguro" (ECONNREFUSED, DNS, 429, 503 explícito)
 *   pode ser repetido até esse limite;
 * - depois de uma falha "incerta" (timeout, ECONNRESET,
 *   500 genérico) sobra no máximo MAIS UMA tentativa,
 *   pelo risco de a Meta já ter aceitado a mensagem;
 * - "permanente" e "anomalia" nunca são repetidos.
 *
 * Risco conhecido: o endpoint /messages não oferece
 * idempotência oficial. Um retry após timeout pode
 * duplicar a mensagem. O wamid NÃO é usado como
 * chave de idempotência.
 */
export async function enviarTextoMeta(
  chatId: string,
  texto: string,
): Promise<ResultadoEnvioMeta> {
  const token = process.env.META_ACCESS_TOKEN ?? "";

  const phoneNumberId = process.env.META_PHONE_NUMBER_ID ?? "";

  const versao = (process.env.META_GRAPH_VERSION ?? "").trim();

  const faltando = [
    ...(token ? [] : ["META_ACCESS_TOKEN"]),
    ...(phoneNumberId ? [] : ["META_PHONE_NUMBER_ID"]),
    ...(versao ? [] : ["META_GRAPH_VERSION"]),
  ];

  if (faltando.length > 0) {
    console.error(
      `[Meta envio] bloqueado: ${faltando.join(", ")} não configurado.`,
    );

    return { aceito: false, motivo: "configuracao" };
  }

  const destino = lerChatIdMeta(chatId);

  if (!destino) {
    console.error("[Meta envio] bloqueado: chatId Meta inválido.");

    return { aceito: false, motivo: "configuracao" };
  }

  if (destino.phoneNumberId !== phoneNumberId) {
    console.error(
      "[Meta envio] bloqueado: phone_number_id da conversa diferente de META_PHONE_NUMBER_ID (erro de configuração).",
    );

    return { aceito: false, motivo: "configuracao" };
  }

  const tamanho = Array.from(texto).length;

  if (tamanho > LIMITE_TEXTO) {
    console.error(
      `[Meta envio] bloqueado: texto com ${tamanho} caracteres excede o limite de ${LIMITE_TEXTO}.`,
    );

    return { aceito: false, motivo: "tamanho" };
  }

  const url = `${obterGraphBaseUrl()}/${versao}/${phoneNumberId}/messages`;

  const corpo = JSON.stringify({
    messaging_product: "whatsapp",
    to: destino.from,
    type: "text",
    text: {
      body: texto,
    },
  });

  const destinoMascarado = mascararTelefone(destino.from);

  let limite = MAX_TENTATIVAS;

  for (let tentativa = 1; ; tentativa++) {
    const rotulo = `[Meta envio] tentativa ${tentativa}/${limite} | destino: ${destinoMascarado}`;

    const resultado = await tentarEnvio(url, token, corpo, rotulo);

    if (resultado.classe === "aceito" && resultado.wamid) {
      /*
       * Grava assim que o 2xx é lido.
       */
      chatIdPorWamid.registrar(resultado.wamid, chatId);

      console.log(
        `${rotulo} | aceita pela Graph API (não é confirmação de entrega) | wamid: ${resultado.wamid} | tamanho: ${tamanho}`,
      );

      return { aceito: true, wamid: resultado.wamid };
    }

    if (resultado.classe === "anomalia") {
      return { aceito: false, motivo: "anomalia" };
    }

    if (resultado.classe === "permanente") {
      return { aceito: false, motivo: "permanente" };
    }

    if (resultado.classe === "incerto") {
      limite = Math.min(limite, tentativa + 1);
    }

    if (resultado.desistir || tentativa >= limite) {
      console.error(
        `[Meta envio] desistindo após ${tentativa} tentativa(s) | destino: ${destinoMascarado}`,
      );

      return { aceito: false, motivo: "esgotado" };
    }

    await esperar(
      resultado.esperaMs ?? ESPERAS_MS[tentativa - 1] ?? ESPERAS_MS.at(-1) ?? 0,
    );
  }
}
