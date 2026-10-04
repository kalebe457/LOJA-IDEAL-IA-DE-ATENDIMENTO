import "dotenv/config";

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";

import { IAClaude } from "./iaClaude.js";

import type { IA } from "./ia.js";

import {
  ehChatMeta,
  normalizarMensagensMeta,
  processarPayloadMeta,
  verificarAssinaturaMeta,
  verificarDesafioMeta,
  type MetaWebhookPayload,
} from "./metaWebhook.js";

import type { Cliente, ResultadoIA } from "./tipos.js";

/*
 * Limite máximo do corpo recebido pelo webhook.
 */
const MAX_BODY_BYTES = 1_000_000;

/*
 * Porta do backend.
 */
const PORT = Number(process.env.PORT ?? 3000);

/*
 * Depois de 20 minutos sem mensagens,
 * o atendimento é encerrado.
 */
const INATIVIDADE_MS = 20 * 60 * 1000;

/*
 * Intervalo usado para verificar
 * atendimentos inativos.
 */
const VERIFICACAO_INATIVIDADE_MS = 30_000;

/*
 * Segredos e configurações do OpenWA.
 */
const OPENWA_WEBHOOK_SECRET = process.env.OPENWA_WEBHOOK_SECRET ?? "";

const OPENWA_API_URL = process.env.OPENWA_API_URL ?? "http://localhost:2785";

const OPENWA_SESSION_ID = process.env.OPENWA_SESSION_ID ?? "";

const OPENWA_API_KEY = process.env.OPENWA_API_KEY ?? "";

const OPENWA_GROUP_CHAT_ID = process.env.OPENWA_GROUP_CHAT_ID ?? "";

/*
 * Momento em que ESTE processo do webhook
 * foi iniciado.
 *
 * Mensagens que aconteceram antes desse momento
 * não serão processadas.
 */
let webhookIniciadoEm = 0;

/*
 * Evita processar o mesmo idempotencyKey
 * duas vezes enquanto o backend está ligado.
 */
const processedMessages = new Set<string>();

/*
 * Garante que mensagens recebidas do mesmo
 * cliente sejam processadas em ordem.
 */
const conversationQueues = new Map<string, Promise<void>>();

/*
 * Guarda os IDs das mensagens enviadas
 * automaticamente pelo nosso sistema.
 *
 * Quando chegar message.sent dessas mensagens,
 * não devemos interpretar como vendedor assumindo.
 */
const mensagensAutomaticasIds = new Set<string>();

/*
 * Fallback para quando o OpenWA não entregar
 * um ID de mensagem utilizável na resposta da API.
 */
type MarcadorEnvioAutomatico = {
  chatId: string;
  texto: string;
  criadoEm: number;
};

const mensagensAutomaticasPendentes: MarcadorEnvioAutomatico[] = [];

/*
 * Cada atendimento ativo possui seu próprio estado.
 */
type Conversa = {
  cliente: Cliente;

  ia: IA;

  /*
   * ID interno.
   *
   * Não aparece para o vendedor.
   */
  atendimentoId: string;

  /*
   * Resumo já enviado ao grupo?
   */
  resumoEnviado: boolean;

  /*
   * Resumo precisa de nova tentativa?
   */
  resumoPendente: boolean;

  /*
   * Algum vendedor já enviou mensagem manual
   * para esse cliente?
   */
  vendedorAssumiu: boolean;

  /*
   * Última atividade do atendimento.
   */
  ultimaMensagemEm: number;
};

/*
 * Conversas atualmente ativas.
 *
 * A chave é o chatId do WhatsApp.
 */
const conversas = new Map<string, Conversa>();

/*
 * Resumos que falharam no envio e
 * precisam ser reenviados.
 */
const resumosPendentes = new Map<string, Conversa>();

export type OpenWAEvent = {
  event?: string;

  timestamp?: string;

  sessionId?: string;

  idempotencyKey?: string;

  deliveryId?: string;

  data?: {
    id?: string;

    chatId?: string;

    from?: string;

    to?: string;

    body?: string;

    type?: string;

    /*
     * Timestamp real da mensagem.
     *
     * Normalmente vem como Unix time em segundos.
     */
    timestamp?: number | string;

    isGroup?: boolean;

    fromMe?: boolean;

    author?: string;

    senderId?: string;

    senderPhone?: string;

    sender?: {
      id?: string;
      name?: string;
      pushname?: string;
    };

    [key: string]: unknown;
  };
};

/**
 * Gera um ID curto para controle interno.
 */
function gerarAtendimentoId(): string {
  return "ATD-" + randomBytes(3).toString("hex").toUpperCase();
}

/**
 * Verifica a assinatura HMAC enviada pelo OpenWA.
 */
function verificarAssinatura(
  rawBody: Buffer,
  signatureHeader: string | undefined,
): boolean {
  if (!OPENWA_WEBHOOK_SECRET) {
    return false;
  }

  if (!signatureHeader) {
    return false;
  }

  const expected =
    "sha256=" +
    createHmac("sha256", OPENWA_WEBHOOK_SECRET).update(rawBody).digest("hex");

  const expectedBuffer = Buffer.from(expected, "utf8");

  const receivedBuffer = Buffer.from(signatureHeader, "utf8");

  if (expectedBuffer.length !== receivedBuffer.length) {
    return false;
  }

  return timingSafeEqual(expectedBuffer, receivedBuffer);
}

/**
 * Responde JSON.
 */
function responderJson(
  response: ServerResponse,
  statusCode: number,
  body: unknown,
): void {
  response.statusCode = statusCode;

  response.setHeader("Content-Type", "application/json; charset=utf-8");

  response.end(JSON.stringify(body));
}

/**
 * Lê o corpo da requisição.
 */
function lerCorpo(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];

    let totalBytes = 0;

    request.on("data", (chunk: Buffer) => {
      totalBytes += chunk.length;

      if (totalBytes > MAX_BODY_BYTES) {
        reject(new Error("Corpo da requisição excedeu o limite."));

        request.destroy();

        return;
      }

      chunks.push(chunk);
    });

    request.on("end", () => {
      resolve(Buffer.concat(chunks));
    });

    request.on("error", reject);
  });
}

/**
 * Normaliza telefone.
 *
 * Exemplo:
 * +55 (91) 98274-8787
 *
 * vira:
 * 559198274787
 */
function normalizarTelefone(telefone?: string): string {
  if (typeof telefone !== "string" || telefone.trim() === "") {
    return "";
  }

  return telefone.replace(/\D/g, "");
}

/**
 * Obtém o telefone real do evento.
 *
 * Primeiro tentamos senderPhone.
 * Depois usamos from @c.us.
 */
function obterTelefone(data: OpenWAEvent["data"]): string {
  if (!data) {
    return "Não informado";
  }

  const senderPhone = normalizarTelefone(data.senderPhone);

  if (senderPhone) {
    return senderPhone;
  }

  if (typeof data.from === "string" && data.from.endsWith("@c.us")) {
    const telefone = normalizarTelefone(data.from.replace("@c.us", ""));

    if (telefone) {
      return telefone;
    }
  }

  return "Não informado";
}

/**
 * Converte um timestamp para milissegundos.
 */
function timestampParaMs(valor: unknown): number | null {
  if (typeof valor === "number") {
    if (!Number.isFinite(valor)) {
      return null;
    }

    /*
     * Já está em milissegundos.
     */
    if (valor > 1_000_000_000_000) {
      return valor;
    }

    /*
     * Está em Unix time
     * em segundos.
     */
    return valor * 1000;
  }

  if (typeof valor === "string") {
    const numero = Number(valor);

    if (Number.isFinite(numero)) {
      return timestampParaMs(numero);
    }

    const data = Date.parse(valor);

    if (!Number.isNaN(data)) {
      return data;
    }
  }

  return null;
}

/**
 * Obtém o momento REAL em que a mensagem
 * aconteceu.
 *
 * Primeiro usa data.timestamp.
 *
 * O timestamp do envelope fica como fallback.
 */
function obterMomentoMensagem(payload: OpenWAEvent): number | null {
  const timestampMensagem = timestampParaMs(payload.data?.timestamp);

  if (timestampMensagem !== null) {
    return timestampMensagem;
  }

  const timestampEnvelope = timestampParaMs(payload.timestamp);

  if (timestampEnvelope !== null) {
    return timestampEnvelope;
  }

  return null;
}

/**
 * Verifica se o evento aconteceu antes
 * deste processo do webhook começar.
 *
 * Isso evita que mensagens antigas
 * que estavam pendentes no OpenWA
 * sejam tratadas como novas.
 */
function eventoAntesDoInicio(): boolean {
  return false;
}

/**
 * Verifica se o evento aconteceu antes
 * do início deste webhook.
 */
function mensagemAnteriorAoWebhook(payload: OpenWAEvent): boolean {
  const momento = obterMomentoMensagem(payload);

  /*
   * Sem timestamp confiável,
   * não processamos por segurança.
   */
  if (momento === null) {
    return true;
  }

  return momento < webhookIniciadoEm;
}

/**
 * Verifica se a mensagem possui
 * mais de 20 minutos.
 */
function mensagemComMaisDe20Minutos(payload: OpenWAEvent): boolean {
  const momento = obterMomentoMensagem(payload);

  if (momento === null) {
    return true;
  }

  const idade = Date.now() - momento;

  return idade >= INATIVIDADE_MS;
}

/**
 * Formata a idade de uma mensagem.
 */
function formatarIdadeMensagem(payload: OpenWAEvent): string {
  const momento = obterMomentoMensagem(payload);

  if (momento === null) {
    return "desconhecida";
  }

  const idade = Math.max(0, Date.now() - momento);

  const minutos = Math.floor(idade / 60_000);

  const segundos = Math.floor((idade % 60_000) / 1000);

  return `${minutos}min ${segundos}s`;
}

/**
 * Verifica se uma conversa está inativa.
 */
function conversaEstaInativa(conversa: Conversa, agora = Date.now()): boolean {
  return agora - conversa.ultimaMensagemEm >= INATIVIDADE_MS;
}

/**
 * Extrai ID de mensagem da resposta
 * da API de envio do OpenWA.
 */
function extrairIdMensagemResposta(valor: unknown): string | null {
  if (!valor || typeof valor !== "object") {
    return null;
  }

  const objeto = valor as Record<string, unknown>;

  if (typeof objeto.id === "string") {
    return objeto.id;
  }

  if (typeof objeto.messageId === "string") {
    return objeto.messageId;
  }

  if (objeto.data && typeof objeto.data === "object") {
    const data = objeto.data as Record<string, unknown>;

    if (typeof data.id === "string") {
      return data.id;
    }

    if (typeof data.messageId === "string") {
      return data.messageId;
    }
  }

  return null;
}

/**
 * Registra uma mensagem automática
 * que será enviada.
 */
function registrarEnvioAutomatico(
  chatId: string,
  texto: string,
): MarcadorEnvioAutomatico {
  const marcador = {
    chatId,
    texto,
    criadoEm: Date.now(),
  };

  mensagensAutomaticasPendentes.push(marcador);

  return marcador;
}

/**
 * Limpa marcadores antigos.
 */
function limparMarcadoresAutomaticos(): void {
  const agora = Date.now();

  for (let i = mensagensAutomaticasPendentes.length - 1; i >= 0; i--) {
    const marcador = mensagensAutomaticasPendentes[i];

    if (!marcador) {
      mensagensAutomaticasPendentes.splice(i, 1);

      continue;
    }

    if (agora - marcador.criadoEm > 60_000) {
      mensagensAutomaticasPendentes.splice(i, 1);
    }
  }

  /*
   * Evita crescimento infinito.
   */
  if (mensagensAutomaticasIds.size > 500) {
    const primeiro = mensagensAutomaticasIds.values().next().value;

    if (typeof primeiro === "string") {
      mensagensAutomaticasIds.delete(primeiro);
    }
  }
}

/**
 * Identifica se message.sent corresponde
 * a uma mensagem que o próprio sistema enviou.
 */
function ehMensagemAutomatica(data: OpenWAEvent["data"]): boolean {
  if (!data) {
    return false;
  }

  limparMarcadoresAutomaticos();

  /*
   * Primeiro tentamos pelo ID.
   */
  if (typeof data.id === "string" && mensagensAutomaticasIds.has(data.id)) {
    mensagensAutomaticasIds.delete(data.id);

    return true;
  }

  const chatId = typeof data.chatId === "string" ? data.chatId : "";

  const texto = typeof data.body === "string" ? data.body.trim() : "";

  if (!chatId || !texto) {
    return false;
  }

  const agora = Date.now();

  const indice = mensagensAutomaticasPendentes.findIndex(
    (marcador) =>
      marcador.chatId === chatId &&
      marcador.texto === texto &&
      agora - marcador.criadoEm < 60_000,
  );

  if (indice === -1) {
    return false;
  }

  mensagensAutomaticasPendentes.splice(indice, 1);

  return true;
}

/**
 * Envia uma mensagem através da API do OpenWA.
 */
async function enviarMensagemOpenWA(
  chatId: string,
  texto: string,
): Promise<void> {
  if (!OPENWA_SESSION_ID) {
    throw new Error("OPENWA_SESSION_ID não configurado.");
  }

  if (!OPENWA_API_KEY) {
    throw new Error("OPENWA_API_KEY não configurado.");
  }

  const url =
    `${OPENWA_API_URL}/api/sessions/` +
    `${OPENWA_SESSION_ID}` +
    `/messages/send-text`;

  /*
   * Registramos antes do envio
   * para evitar corrida com message.sent.
   */
  const marcador = registrarEnvioAutomatico(chatId, texto);

  try {
    const resposta = await fetch(url, {
      method: "POST",

      headers: {
        "Content-Type": "application/json",

        "X-API-Key": OPENWA_API_KEY,
      },

      body: JSON.stringify({
        chatId,
        text: texto,
      }),
    });

    if (!resposta.ok) {
      const indice = mensagensAutomaticasPendentes.indexOf(marcador);

      if (indice !== -1) {
        mensagensAutomaticasPendentes.splice(indice, 1);
      }

      const erro = await resposta.text();

      throw new Error(`OpenWA respondeu ${resposta.status}: ${erro}`);
    }

    /*
     * O endpoint normalmente retorna JSON.
     *
     * Se vier um messageId,
     * guardamos para identificar
     * o message.sent correspondente.
     */
    try {
      const corpo = (await resposta.json()) as unknown;

      const messageId = extrairIdMensagemResposta(corpo);

      if (messageId) {
        mensagensAutomaticasIds.add(messageId);
      }
    } catch {
      /*
       * O fallback por chat + texto continua válido.
       */
    }

    console.log(`Mensagem enviada para ${chatId}`);
  } catch (erro) {
    const indice = mensagensAutomaticasPendentes.indexOf(marcador);

    if (indice !== -1) {
      mensagensAutomaticasPendentes.splice(indice, 1);
    }

    throw erro;
  }
}

/**
 * Faz até 3 tentativas de envio.
 */
async function enviarComRetentativas(
  chatId: string,
  texto: string,
  tentativas = 3,
): Promise<boolean> {
  /*
   * Conversas da Meta nunca são enviadas pelo OpenWA.
   *
   * O envio pela Cloud API ainda não foi implementado.
   */
  if (ehChatMeta(chatId)) {
    console.log(
      `[Meta] resposta não enviada (envio pela Cloud API ainda não implementado): ${chatId} | ${texto}`,
    );

    return false;
  }

  for (let i = 1; i <= tentativas; i++) {
    try {
      await enviarMensagemOpenWA(chatId, texto);

      return true;
    } catch (erro: unknown) {
      console.error(
        `Falha no envio (tentativa ${i}/${tentativas}):`,
        erro instanceof Error ? erro.message : "erro desconhecido",
      );

      if (i < tentativas) {
        await new Promise((resolve) =>
          setTimeout(resolve, 1000 * 2 ** (i - 1)),
        );
      }
    }
  }

  return false;
}

/**
 * Formata o resumo para o grupo.
 *
 * O ID interno NÃO é mostrado.
 */
function formatarResumo(conversa: Conversa): string {
  const resumo = conversa.cliente.resumo;

  return [
    "📋 NOVO ATENDIMENTO",

    "",

    `Nome: ${resumo.nome}`,

    `Telefone: ${resumo.telefone}`,

    `Necessidade: ${resumo.necessidade}`,

    `Ambiente: ${resumo.ambiente}`,

    `Medidas: ${resumo.medidas}`,

    `Produto: ${resumo.produto}`,

    `Quantidade: ${resumo.quantidade}`,

    `Prazo: ${resumo.prazo}`,

    `Observações: ${resumo.observacoes}`,
  ].join("\n");
}

/**
 * Envia o resumo ao grupo.
 */
async function enviarResumoComRetentativas(conversa: Conversa): Promise<void> {
  if (conversa.resumoEnviado) {
    return;
  }

  if (!OPENWA_GROUP_CHAT_ID) {
    conversa.resumoPendente = true;

    resumosPendentes.set(conversa.atendimentoId, conversa);

    console.error("OPENWA_GROUP_CHAT_ID não configurado.");

    return;
  }

  const ok = await enviarComRetentativas(
    OPENWA_GROUP_CHAT_ID,
    formatarResumo(conversa),
  );

  if (ok) {
    conversa.resumoEnviado = true;

    conversa.resumoPendente = false;

    resumosPendentes.delete(conversa.atendimentoId);

    console.log("Resumo enviado para o grupo dos vendedores.");
  } else {
    conversa.resumoPendente = true;

    resumosPendentes.set(conversa.atendimentoId, conversa);

    console.error(
      "ERRO: resumo não enviado. Ficará pendente para nova tentativa.",
    );
  }
}

/**
 * Cria um cliente novo.
 */
function criarCliente(from?: string, senderPhone?: string): Cliente {
  let telefone = normalizarTelefone(senderPhone);

  if (!telefone) {
    if (from && from.endsWith("@c.us")) {
      telefone = normalizarTelefone(from.replace("@c.us", ""));
    }
  }

  if (!telefone) {
    telefone = "Não informado";
  }

  return {
    telefone,

    status: "IA",

    resumo: {
      nome: "Não informado",

      telefone,

      necessidade: "Não informado",

      ambiente: "Não informado",

      medidas: "Não informado",

      produto: "Não informado",

      quantidade: "Não informado",

      prazo: "Não informado",

      observacoes: "Não informado",
    },
  };
}

/**
 * Atualiza o telefone quando o OpenWA
 * consegue resolver o @lid.
 */
function atualizarTelefone(
  conversa: Conversa,
  data: OpenWAEvent["data"],
): void {
  const telefone = obterTelefone(data);

  if (telefone === "Não informado") {
    return;
  }

  conversa.cliente.telefone = telefone;

  conversa.cliente.resumo.telefone = telefone;
}

/**
 * Cria uma nova conversa.
 */
function criarNovaConversa(from?: string, senderPhone?: string): Conversa {
  const usarClaude =
    (process.env.USAR_IA ?? "").trim().toLowerCase() === "claude";

  const ia: IA = new IAClaude();

  const agora = Date.now();

  const conversa: Conversa = {
    cliente: criarCliente(from, senderPhone),

    ia,

    atendimentoId: gerarAtendimentoId(),

    resumoEnviado: false,

    resumoPendente: false,

    vendedorAssumiu: false,

    ultimaMensagemEm: agora,
  };

  console.log("Nova conversa criada");

  console.log(`Atendimento interno: ${conversa.atendimentoId}`);

  console.log("IA utilizada: Claude");

  return conversa;
}

/**
 * Finaliza uma conversa por inatividade.
 *
 * O resumo pendente, se existir, continua
 * separado para retry.
 */
function finalizarConversa(chatId: string, conversa: Conversa): void {
  conversas.delete(chatId);

  if (conversa.resumoPendente) {
    resumosPendentes.set(conversa.atendimentoId, conversa);
  }

  console.log(
    `Atendimento ${conversa.atendimentoId} encerrado por inatividade.`,
  );
}

/**
 * Obtém a conversa ativa.
 *
 * Se a anterior passou de 20 minutos,
 * ela é encerrada e uma nova é criada.
 */
function obterConversa(
  chatId: string,
  from?: string,
  senderPhone?: string,
): Conversa {
  const existente = conversas.get(chatId);

  if (existente) {
    /*
     * Atualiza o telefone caso ele esteja disponível.
     */
    if (senderPhone) {
      const telefone = normalizarTelefone(senderPhone);

      if (telefone) {
        existente.cliente.telefone = telefone;
        existente.cliente.resumo.telefone = telefone;
      }
    } else if (from && from.endsWith("@c.us")) {
      const telefone = normalizarTelefone(from.replace("@c.us", ""));

      if (telefone) {
        existente.cliente.telefone = telefone;
        existente.cliente.resumo.telefone = telefone;
      }
    }

    /*
     * Se ainda estiver dentro dos 20 minutos,
     * continuamos no mesmo atendimento.
     */
    if (!conversaEstaInativa(existente)) {
      return existente;
    }

    /*
     * Mais de 20 minutos sem atividade:
     * encerra o atendimento antigo.
     */
    finalizarConversa(chatId, existente);
  }

  /*
   * Não existe atendimento ativo.
   * Portanto criamos um novo.
   */
  const nova = criarNovaConversa(from, senderPhone);

  conversas.set(chatId, nova);

  return nova;
}

/**
 * Processa uma mensagem enviada manualmente
 * pelo vendedor.
 *
 * O vendedor não precisa se identificar.
 *
 * O próprio envio pelo número da loja
 * assume o atendimento.
 */
async function processarMensagemManual(payload: OpenWAEvent): Promise<void> {
  const data = payload.data;

  if (!data) {
    return;
  }

  /*
   * Só interessa mensagem enviada pelo
   * próprio número conectado ao OpenWA.
   */
  if (data.fromMe !== true) {
    return;
  }

  const chatId = typeof data.chatId === "string" ? data.chatId : "";

  if (!chatId) {
    return;
  }

  /*
   * Nunca usamos mensagens de grupo
   * para assumir atendimento.
   */
  if (data.isGroup === true || chatId.endsWith("@g.us")) {
    return;
  }

  /*
   * Se foi o nosso próprio bot que enviou,
   * não é vendedor.
   */
  if (ehMensagemAutomatica(data)) {
    console.log(`Mensagem automática ignorada no message.sent: ${chatId}`);

    const conversa = conversas.get(chatId);

    if (conversa) {
      conversa.ultimaMensagemEm = Date.now();
    }

    return;
  }

  /*
   * Só existe assunção se houver
   * um atendimento ativo.
   */
  const conversa = conversas.get(chatId);

  if (!conversa) {
    console.log(
      `Mensagem manual ignorada: não existe atendimento ativo para ${chatId}`,
    );

    return;
  }

  /*
   * Se já ficou inativo por 20 minutos,
   * não reabrimos o atendimento antigo.
   */
  if (conversaEstaInativa(conversa)) {
    finalizarConversa(chatId, conversa);

    console.log(
      `Mensagem manual ignorada porque o atendimento já estava encerrado: ${chatId}`,
    );

    return;
  }

  /*
   * Marca a atividade usando o horário
   * da mensagem enviada.
   */
  const momento = obterMomentoMensagem(payload);

  conversa.ultimaMensagemEm = momento ?? Date.now();

  /*
   * Primeiro vendedor a enviar
   * uma mensagem assume o atendimento.
   */
  if (!conversa.vendedorAssumiu) {
    conversa.vendedorAssumiu = true;

    conversa.cliente.status = "HUMANO";

    console.log(
      `Atendimento ${conversa.atendimentoId} assumido por mensagem manual da loja.`,
    );
  } else {
    console.log(
      `Mensagem manual recebida para atendimento já assumido: ${chatId}`,
    );
  }
}

/**
 * Processa mensagem recebida do cliente.
 */
async function processarMensagemRecebida(payload: OpenWAEvent): Promise<void> {
  const data = payload.data;

  if (!data) {
    return;
  }

  const chatId = typeof data.chatId === "string" ? data.chatId : "";

  const texto = typeof data.body === "string" ? data.body.trim() : "";

  if (!chatId || !texto) {
    return;
  }

  /*
   * Não processamos grupos.
   */
  if (data.isGroup === true || chatId.endsWith("@g.us")) {
    console.log(`Mensagem de grupo ignorada: ${chatId}`);

    return;
  }

  /*
   * Só texto.
   */
  if (typeof data.type === "string" && data.type !== "text") {
    return;
  }

  adicionarNaFila(chatId, async () => {
    const conversa = obterConversa(chatId, data.from, data.senderPhone);

    /*
     * Atualiza o telefone real.
     */
    atualizarTelefone(conversa, data);

    /*
     * Usa o horário da mensagem,
     * não o momento em que a IA terminou.
     */
    const momentoMensagem = obterMomentoMensagem(payload);

    conversa.ultimaMensagemEm = momentoMensagem ?? Date.now();

    console.log("Mensagem recebida pelo OpenWA");

    console.log(`chatId: ${chatId}`);

    console.log(`content: ${texto}`);

    console.log(`senderPhone: ${data.senderPhone ?? "Não informado"}`);

    /*
     * Se vendedor já assumiu,
     * a IA permanece desligada.
     */
    if (conversa.cliente.status === "HUMANO") {
      console.log(`IA desativada para ${chatId}: atendimento humano.`);

      return;
    }

    let resultado: ResultadoIA;

    try {
      resultado = await conversa.ia.responder(texto, conversa.cliente);
    } catch (erro: unknown) {
      console.error(
        "Falha na IA:",
        erro instanceof Error ? erro.message : "erro desconhecido",
      );

      const observacoes = conversa.cliente.resumo.observacoes;

      const nota = "Falha técnica na triagem automática.";

      resultado = {
        resposta:
          "Tive uma instabilidade aqui. Vou encaminhar seu atendimento para um vendedor da Loja Ideal, que dará continuidade.",

        status: "HUMANO",

        resumo: {
          ...conversa.cliente.resumo,

          telefone: conversa.cliente.telefone,

          observacoes:
            observacoes === "Não informado" ? nota : `${observacoes} | ${nota}`,
        },
      };
    }

    /*
     * IMPORTANTE:
     *
     * Um vendedor pode ter enviado uma mensagem
     * manual enquanto a Claude estava processando.
     *
     * Nesse caso, HUMANO tem prioridade.
     */
    if (conversa.vendedorAssumiu) {
      conversa.cliente.status = "HUMANO";

      console.log(
        `Atendimento ${conversa.atendimentoId} foi assumido pelo vendedor durante o processamento da IA.`,
      );

      /*
       * Atualizamos apenas o resumo.
       *
       * Não enviamos a resposta automática
       * da Claude.
       */
      conversa.cliente.resumo = resultado.resumo;

      atualizarTelefone(conversa, data);

      return;
    }

    /*
     * Resultado normal da IA.
     */
    conversa.cliente.status = resultado.status;

    conversa.cliente.resumo = resultado.resumo;

    /*
     * Garante novamente o telefone.
     */
    atualizarTelefone(conversa, data);

    console.log(`Status: ${resultado.status}`);

    console.log("Resumo:", JSON.stringify(conversa.cliente.resumo, null, 2));

    /*
     * Envia a resposta ao cliente.
     */
    const clienteAvisado = await enviarComRetentativas(
      chatId,
      resultado.resposta,
    );

    if (clienteAvisado) {
      /*
       * A resposta automática também
       * representa atividade.
       */
      conversa.ultimaMensagemEm = Date.now();
    } else {
      console.error(`Cliente ${chatId} não recebeu a resposta.`);
    }

    /*
     * Quando a IA conclui o atendimento,
     * o resumo vai para o grupo.
     */
    if (resultado.status === "HUMANO") {
      /*
       * Resumo da Meta fica só no log.
       *
       * Nunca vai para o grupo do OpenWA
       * e nunca fica pendente para retry.
       */
      if (ehChatMeta(chatId)) {
        console.log(
          `[Meta] resumo do atendimento ${conversa.atendimentoId} mantido só no log; não vai para o grupo do OpenWA.`,
        );
      } else {
        await enviarResumoComRetentativas(conversa);
      }

      console.log(`Atendimento transferido para humano: ${chatId}`);
    }
  });
}

/**
 * Mantém mensagens de um mesmo cliente
 * em ordem.
 */
function adicionarNaFila(chatId: string, tarefa: () => Promise<void>): void {
  const anterior = conversationQueues.get(chatId) ?? Promise.resolve();

  const atual = anterior
    .catch(() => undefined)
    .then(tarefa)
    .catch((erro: unknown) => {
      console.error(
        "Erro ao processar mensagem do OpenWA:",
        erro instanceof Error ? erro.message : "erro desconhecido",
      );
    });

  conversationQueues.set(chatId, atual);

  void atual.finally(() => {
    if (conversationQueues.get(chatId) === atual) {
      conversationQueues.delete(chatId);
    }
  });
}

/**
 * Finaliza automaticamente atendimentos
 * que ficaram 20 minutos sem atividade.
 */
function verificarInatividade(): void {
  const agora = Date.now();

  for (const [chatId, conversa] of conversas) {
    if (!conversaEstaInativa(conversa, agora)) {
      continue;
    }

    finalizarConversa(chatId, conversa);
  }
}

/**
 * Reenvia resumos pendentes.
 */
function reenviarResumosPendentes(): void {
  for (const conversa of resumosPendentes.values()) {
    if (!conversa.resumoPendente) {
      resumosPendentes.delete(conversa.atendimentoId);

      continue;
    }

    console.log(
      `Reenviando resumo pendente do atendimento ${conversa.atendimentoId}`,
    );

    void enviarResumoComRetentativas(conversa);
  }
}

/**
 * Processa um evento do OpenWA.
 */
async function processarEvento(payload: OpenWAEvent): Promise<void> {
  /*
   * Aceitamos somente eventos
   * de mensagem recebida ou enviada.
   */
  if (
    payload.event !== "message.received" &&
    payload.event !== "message.sent"
  ) {
    return;
  }

  const data = payload.data;

  if (!data) {
    return;
  }

  /*
   * O idempotencyKey é a chave principal.
   *
   * O header é usado como fallback
   * dentro do servidor.
   */
  const chave = payload.idempotencyKey ?? data.id ?? "";

  /*
   * Se esse evento já passou pelo backend,
   * ignoramos.
   */
  if (chave && processedMessages.has(chave)) {
    console.log(`Evento duplicado ignorado: ${chave}`);

    return;
  }

  /*
   * REGRA 1:
   *
   * Se a mensagem aconteceu ANTES
   * deste webhook ser iniciado,
   * ela nunca entra no sistema.
   */
  if (mensagemAnteriorAoWebhook(payload)) {
    console.log(
      [
        "Evento anterior ao início do webhook ignorado.",
        `Evento: ${payload.event}`,
        `Mensagem: ${typeof data.body === "string" ? data.body : ""}`,
        `Horário do webhook: ${new Date(webhookIniciadoEm).toLocaleString(
          "pt-BR",
        )}`,
      ].join(" | "),
    );

    if (chave) {
      processedMessages.add(chave);
    }

    return;
  }

  /*
   * REGRA 2:
   *
   * Mesmo sendo posterior ao início
   * do webhook, uma mensagem com mais
   * de 20 minutos não pode iniciar
   * um novo atendimento.
   */
  if (mensagemComMaisDe20Minutos(payload)) {
    console.log(
      [
        "Evento antigo ignorado.",
        `Evento: ${payload.event}`,
        `Idade: ${formatarIdadeMensagem(payload)}`,
        `Mensagem: ${typeof data.body === "string" ? data.body : ""}`,
      ].join(" | "),
    );

    if (chave) {
      processedMessages.add(chave);
    }

    return;
  }

  /*
   * A partir daqui o evento é considerado
   * realmente novo.
   */
  if (chave) {
    processedMessages.add(chave);
  }

  /*
   * EVENTO ENVIADO:
   *
   * verifica se foi uma mensagem manual
   * do vendedor.
   */
  if (payload.event === "message.sent") {
    await processarMensagemManual(payload);

    return;
  }

  /*
   * EVENTO RECEBIDO:
   *
   * trata mensagem do cliente.
   */
  await processarMensagemRecebida(payload);
}

/**
 * Inicia o servidor do webhook.
 */
export function iniciarWebhook(): void {
  /*
   * Marca o momento EXATO em que
   * esse processo começou.
   */
  webhookIniciadoEm = Date.now();

  console.log(
    [
      "Webhook aceitará somente mensagens recebidas a partir de:",
      new Date(webhookIniciadoEm).toLocaleString("pt-BR"),
    ].join(" "),
  );

  const server = createServer(async (request, response) => {
    try {
      /*
       * Health check.
       */
      if (request.method === "GET" && request.url === "/health") {
        responderJson(response, 200, {
          ok: true,
        });

        return;
      }

      /*
       * Webhook da WhatsApp Cloud API (Meta).
       */
      const urlMeta = new URL(request.url ?? "/", "http://localhost");

      if (urlMeta.pathname === "/meta/webhook") {
        if (request.method === "GET") {
          const verificacao = verificarDesafioMeta(urlMeta.searchParams);

          response.statusCode = verificacao.statusCode;

          response.setHeader("Content-Type", "text/plain; charset=utf-8");

          response.end(verificacao.body);

          return;
        }

        if (request.method === "POST") {
          const rawBodyMeta = await lerCorpo(request);

          const signatureMeta = request.headers["x-hub-signature-256"];

          if (
            typeof signatureMeta !== "string" ||
            !verificarAssinaturaMeta(rawBodyMeta, signatureMeta)
          ) {
            responderJson(response, 401, {
              received: false,
            });

            return;
          }

          let payloadMeta: MetaWebhookPayload;

          try {
            payloadMeta = JSON.parse(
              rawBodyMeta.toString("utf8"),
            ) as MetaWebhookPayload;
          } catch {
            responderJson(response, 400, {
              received: false,
            });

            return;
          }

          /*
           * Responde rapidamente à Meta.
           */
          responderJson(response, 200, {
            received: true,
          });

          processarPayloadMeta(payloadMeta);

          /*
           * messages[] entram no mesmo núcleo
           * de atendimento do OpenWA.
           */
          for (const evento of normalizarMensagensMeta(payloadMeta)) {
            processarEvento(evento).catch((erro: unknown) => {
              console.error(
                "Erro ao processar mensagem da Meta:",
                erro instanceof Error ? erro.message : "erro desconhecido",
              );
            });
          }

          return;
        }
      }

      /*
       * Endpoint do webhook.
       */
      if (request.method !== "POST" || request.url !== "/openwa/webhook") {
        responderJson(response, 404, {
          error: "Not found",
        });

        return;
      }

      /*
       * Lê o corpo bruto.
       */
      const rawBody = await lerCorpo(request);

      /*
       * Valida assinatura HMAC.
       */
      const signature = request.headers["x-openwa-signature"];

      const assinaturaValida =
        typeof signature === "string" &&
        verificarAssinatura(rawBody, signature);

      if (!assinaturaValida) {
        responderJson(response, 401, {
          received: false,
        });

        return;
      }

      let payload: OpenWAEvent;

      try {
        payload = JSON.parse(rawBody.toString("utf8")) as OpenWAEvent;
      } catch {
        responderJson(response, 400, {
          received: false,
        });

        return;
      }

      /*
       * Se o corpo não trouxer
       * idempotencyKey, usa o header.
       */
      const idempotencyHeader = request.headers["x-openwa-idempotency-key"];

      if (!payload.idempotencyKey && typeof idempotencyHeader === "string") {
        payload.idempotencyKey = idempotencyHeader;
      }

      /*
       * Responde rapidamente ao OpenWA.
       */
      responderJson(response, 200, {
        received: true,
      });

      /*
       * Processamento assíncrono.
       */
      void processarEvento(payload);
    } catch (erro: unknown) {
      if (!response.headersSent) {
        responderJson(response, 500, {
          received: false,
        });
      }

      console.error(
        "Erro interno no webhook:",
        erro instanceof Error ? erro.message : "erro desconhecido",
      );
    }
  });

  server.listen(PORT, () => {
    console.log(`Webhook OpenWA ouvindo na porta ${PORT}`);

    console.log("Endpoint: POST /openwa/webhook");

    console.log(
      `Mensagens anteriores a ${new Date(webhookIniciadoEm).toLocaleTimeString(
        "pt-BR",
      )} serão ignoradas.`,
    );
  });

  /*
   * Verifica inatividade a cada 30 segundos.
   */
  setInterval(verificarInatividade, VERIFICACAO_INATIVIDADE_MS);

  /*
   * Reenvia resumos pendentes
   * a cada 60 segundos.
   */
  setInterval(reenviarResumosPendentes, 60_000);

  /*
   * Limpa marcadores de mensagens
   * automáticas.
   */
  setInterval(limparMarcadoresAutomaticos, 30_000);
}
