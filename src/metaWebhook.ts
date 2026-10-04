import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import type { OpenWAEvent } from "./webhook.js";

/*
 * Segredos da integração com a WhatsApp Cloud API (Meta).
 *
 * Nunca devem ser impressos em logs.
 */
const META_APP_SECRET = process.env.META_APP_SECRET ?? "";

const META_VERIFY_TOKEN = process.env.META_VERIFY_TOKEN ?? "";

/*
 * Estrutura do payload enviado pela Cloud API.
 *
 * Apenas os campos usados nesta etapa.
 */
type MetaMensagem = {
  id?: string;

  from?: string;

  timestamp?: string;

  type?: string;

  text?: {
    body?: string;
  };

  [key: string]: unknown;
};

type MetaErro = {
  code?: number;

  title?: string;

  message?: string;

  error_data?: {
    details?: string;
  };
};

type MetaStatus = {
  /*
   * wamid da mensagem enviada.
   */
  id?: string;

  /*
   * sent, delivered, read, failed...
   */
  status?: string;

  timestamp?: string;

  recipient_id?: string;

  errors?: MetaErro[];
};

type MetaValue = {
  messaging_product?: string;

  metadata?: {
    display_phone_number?: string;

    phone_number_id?: string;
  };

  messages?: MetaMensagem[];

  statuses?: MetaStatus[];

  [key: string]: unknown;
};

export type MetaWebhookPayload = {
  object?: string;

  entry?: {
    id?: string;

    changes?: {
      field?: string;

      value?: MetaValue;
    }[];
  }[];
};

export type RespostaVerificacaoMeta = {
  statusCode: number;

  body: string;
};

/*
 * Prefixo do chatId das conversas da Meta.
 *
 * Mantém essas conversas separadas das do OpenWA
 * e impede que sejam enviadas pelo OpenWA.
 */
const PREFIXO_CHAT_META = "meta:";

/**
 * Indica se o chatId pertence a uma conversa da Meta.
 */
export function ehChatMeta(chatId: string): boolean {
  return chatId.startsWith(PREFIXO_CHAT_META);
}

/**
 * Compara dois textos em tempo constante.
 *
 * Os hashes têm sempre o mesmo tamanho,
 * então o tamanho do segredo não vaza.
 */
function textosIguais(a: string, b: string): boolean {
  const hashA = createHash("sha256").update(a, "utf8").digest();

  const hashB = createHash("sha256").update(b, "utf8").digest();

  return timingSafeEqual(hashA, hashB);
}

/**
 * Trata o GET de verificação do webhook.
 *
 * A Meta envia hub.mode, hub.verify_token
 * e hub.challenge. Se o token conferir,
 * devolvemos o challenge.
 */
export function verificarDesafioMeta(
  parametros: URLSearchParams,
): RespostaVerificacaoMeta {
  if (!META_VERIFY_TOKEN) {
    console.error("META_VERIFY_TOKEN não configurado.");

    return { statusCode: 403, body: "Forbidden" };
  }

  const modo = parametros.get("hub.mode");

  const token = parametros.get("hub.verify_token") ?? "";

  const challenge = parametros.get("hub.challenge") ?? "";

  if (modo !== "subscribe" || !textosIguais(token, META_VERIFY_TOKEN)) {
    console.log("Verificação do webhook Meta recusada.");

    return { statusCode: 403, body: "Forbidden" };
  }

  console.log("Webhook Meta verificado.");

  return { statusCode: 200, body: challenge };
}

/**
 * Verifica o header X-Hub-Signature-256.
 *
 * É o HMAC-SHA256 do corpo bruto,
 * usando o App Secret.
 */
export function verificarAssinaturaMeta(
  rawBody: Buffer,
  signatureHeader: string | undefined,
): boolean {
  if (!META_APP_SECRET) {
    console.error("META_APP_SECRET não configurado.");

    return false;
  }

  if (!signatureHeader) {
    return false;
  }

  const expected =
    "sha256=" +
    createHmac("sha256", META_APP_SECRET).update(rawBody).digest("hex");

  const expectedBuffer = Buffer.from(expected, "utf8");

  const receivedBuffer = Buffer.from(signatureHeader, "utf8");

  if (expectedBuffer.length !== receivedBuffer.length) {
    return false;
  }

  return timingSafeEqual(expectedBuffer, receivedBuffer);
}

/**
 * Registra um status de mensagem.
 *
 * IMPORTANTE:
 *
 * "accepted" na resposta da Graph API
 * NÃO é entrega. O resultado real chega
 * aqui depois (sent, delivered, read, failed).
 *
 * Os códigos de erro são registrados
 * exatamente como vieram (ex.: 130497),
 * sem interpretação automática.
 */
function registrarStatus(status: MetaStatus, phoneNumberId: string): void {
  const partes = [
    "Status Meta recebido.",
    `status: ${status.status ?? "desconhecido"}`,
    `wamid: ${status.id ?? "não informado"}`,
    `phone_number_id: ${phoneNumberId}`,
  ];

  for (const erro of status.errors ?? []) {
    partes.push(`erro code: ${erro.code ?? "não informado"}`);

    partes.push(`erro title: ${erro.title ?? "não informado"}`);

    if (erro.error_data?.details) {
      partes.push(`erro details: ${erro.error_data.details}`);
    }
  }

  if (status.status === "failed") {
    console.error(partes.join(" | "));
  } else {
    console.log(partes.join(" | "));
  }
}

/**
 * Parser mínimo do payload da Cloud API.
 *
 * Nesta etapa apenas registra o que chegou.
 * As mensagens ainda NÃO são enviadas
 * ao núcleo de atendimento.
 */
export function processarPayloadMeta(payload: MetaWebhookPayload): void {
  if (payload.object !== "whatsapp_business_account") {
    console.log(
      `Payload Meta ignorado: object = ${payload.object ?? "não informado"}`,
    );

    return;
  }

  for (const entrada of payload.entry ?? []) {
    for (const mudanca of entrada.changes ?? []) {
      const value = mudanca.value;

      if (mudanca.field !== "messages" || !value) {
        console.log(
          `Mudança Meta ignorada: field = ${mudanca.field ?? "não informado"}`,
        );

        continue;
      }

      const phoneNumberId = value.metadata?.phone_number_id ?? "não informado";

      for (const mensagem of value.messages ?? []) {
        console.log(
          [
            "Mensagem Meta recebida.",
            `type: ${mensagem.type ?? "desconhecido"}`,
            `wamid: ${mensagem.id ?? "não informado"}`,
            `phone_number_id: ${phoneNumberId}`,
          ].join(" | "),
        );
      }

      for (const status of value.statuses ?? []) {
        registrarStatus(status, phoneNumberId);
      }
    }
  }
}

/**
 * Converte messages[] da Cloud API para o mesmo
 * formato de evento que o OpenWA entrega ao
 * núcleo de atendimento.
 *
 * Assim a triagem, a fila, IA/HUMANO e os filtros
 * de eventos antigos são reaproveitados sem duplicação.
 *
 * statuses[] não viram eventos.
 */
export function normalizarMensagensMeta(
  payload: MetaWebhookPayload,
): OpenWAEvent[] {
  const eventos: OpenWAEvent[] = [];

  if (payload.object !== "whatsapp_business_account") {
    return eventos;
  }

  for (const entrada of payload.entry ?? []) {
    for (const mudanca of entrada.changes ?? []) {
      const value = mudanca.value;

      if (mudanca.field !== "messages" || !value) {
        continue;
      }

      const phoneNumberId = value.metadata?.phone_number_id;

      if (!phoneNumberId) {
        continue;
      }

      for (const mensagem of value.messages ?? []) {
        if (!mensagem.id || !mensagem.from) {
          continue;
        }

        eventos.push({
          event: "message.received",

          /*
           * O wamid evita processar duas vezes
           * quando a Meta reenvia o webhook.
           */
          idempotencyKey: mensagem.id,

          data: {
            id: mensagem.id,

            chatId: `${PREFIXO_CHAT_META}${phoneNumberId}:${mensagem.from}`,

            from: mensagem.from,

            /*
             * wa_id do cliente.
             */
            senderPhone: mensagem.from,

            body: mensagem.type === "text" ? (mensagem.text?.body ?? "") : "",

            type: mensagem.type ?? "desconhecido",

            /*
             * Unix time em segundos.
             */
            ...(mensagem.timestamp !== undefined
              ? { timestamp: mensagem.timestamp }
              : {}),

            isGroup: false,

            fromMe: false,
          },
        });
      }
    }
  }

  return eventos;
}
