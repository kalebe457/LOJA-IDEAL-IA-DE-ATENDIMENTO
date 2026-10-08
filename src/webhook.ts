import "dotenv/config";

import { randomBytes } from "node:crypto";

import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";

import { IAClaude } from "./iaClaude.js";

import type { IA } from "./ia.js";

import {
  ehChatMeta,
  listarStatusesMeta,
  normalizarMensagensMeta,
  processarPayloadMeta,
  verificarAssinaturaMeta,
  verificarDesafioMeta,
  type MetaStatus,
  type MetaWebhookPayload,
} from "./metaWebhook.js";

import {
  descreverDestinoMeta,
  enviarTextoMeta,
  mascararTelefone,
  metaEnvioAtivo,
  obterChatIdPorWamid,
} from "./metaEnvio.js";

import {
  AVISO_ENCAMINHAMENTO_FORA_DO_HORARIO,
  MENSAGEM_LOJA_FECHADA,
  chavePeriodoFechado,
  lojaAberta,
} from "./horarioFuncionamento.js";

import {
  definirAoAssumirAtendimento,
  enviarResumoTelegram,
  processarUpdateTelegram,
  reenviarResumosTelegramPendentes,
  segredoWebhookTelegramValido,
  telegramConfigurado,
  type TelegramUpdate,
} from "./telegramBot.js";

import {
  idRegistravel,
  registrarEventoRecebido,
  type CanalEvento,
} from "./eventosProcessados.js";

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
 * Garante que mensagens recebidas do mesmo
 * cliente sejam processadas em ordem.
 */
const conversationQueues = new Map<string, Promise<void>>();

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
   * Um vendedor assumiu pelo Telegram?
   * (A IA não responde mais essa conversa.)
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
 * Aviso de loja fechada já enviado por chatId.
 *
 * O valor é a chave do período fechado
 * (data da próxima abertura), para avisar
 * uma única vez por período.
 */
const avisosLojaFechada = new Map<string, string>();

/*
 * Mensagem recebida, no formato interno do núcleo de
 * atendimento. A Meta é convertida para ele em
 * normalizarMensagensMeta (metaWebhook.ts).
 */
export type EventoMensagem = {
  event?: string;

  /*
   * ID externo da mensagem (wamid da Meta).
   */
  idempotencyKey?: string;

  data?: {
    id?: string;

    /*
     * meta:<phone_number_id>:<wa_id>
     */
    chatId?: string;

    from?: string;

    body?: string;

    type?: string;

    /*
     * Timestamp real da mensagem (Unix time em segundos).
     */
    timestamp?: number | string;

    /*
     * wa_id do cliente.
     */
    senderPhone?: string;
  };
};

/**
 * Gera um ID curto para controle interno.
 */
function gerarAtendimentoId(): string {
  return "ATD-" + randomBytes(3).toString("hex").toUpperCase();
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
 * Mascara telefones dentro de um chatId para logs.
 *
 * meta:<id>:559198274361 -> meta:<id>:5591****4361
 */
function mascararChatId(chatId: string): string {
  return chatId.replace(/\d{8,}/g, (digitos) => mascararTelefone(digitos));
}

/**
 * Descreve um erro da IA somente com dados técnicos.
 *
 * Erros da API da Anthropic: HTTP status, tipo e request_id.
 * Demais erros: nome e mensagem limitada.
 */
function descreverErroIA(erro: unknown): string {
  if (!(erro instanceof Error)) {
    return "erro desconhecido";
  }

  const api = erro as Error & {
    status?: unknown;
    requestID?: unknown;
    error?: { error?: { type?: unknown } };
  };

  if (typeof api.status === "number") {
    return [
      `HTTP ${api.status}`,
      `type: ${String(api.error?.error?.type ?? "-")}`,
      `request_id: ${String(api.requestID ?? "-")}`,
    ].join(" | ");
  }

  return `${erro.name}: ${erro.message.slice(0, 120)}`;
}

/**
 * Lista somente os NOMES dos campos preenchidos
 * do resumo, para logs sem dados pessoais.
 */
function camposPreenchidos(resumo: Cliente["resumo"]): string {
  const campos = Object.entries(resumo)
    .filter(
      ([campo, valor]) =>
        campo !== "telefone" &&
        typeof valor === "string" &&
        valor.trim() !== "" &&
        valor !== "Não informado",
    )
    .map(([campo]) => campo);

  return campos.length > 0 ? campos.join(", ") : "nenhum";
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
 * aconteceu (data.timestamp).
 */
function obterMomentoMensagem(payload: EventoMensagem): number | null {
  return timestampParaMs(payload.data?.timestamp);
}

/**
 * Verifica se a mensagem possui
 * mais de 20 minutos.
 */
function mensagemComMaisDe20Minutos(payload: EventoMensagem): boolean {
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
function formatarIdadeMensagem(payload: EventoMensagem): string {
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
 * Envia uma mensagem ao cliente pela WhatsApp Cloud API (Meta),
 * o ÚNICO canal do MVP. Não há fallback para outro provedor.
 *
 * META_ENVIO_ATIVO decide entre somente log e envio real.
 *
 * true no retorno = aceito pela Graph API,
 * NÃO é confirmação de entrega.
 */
async function enviarAoCliente(chatId: string, texto: string): Promise<boolean> {
  if (!ehChatMeta(chatId)) {
    console.error(
      `Envio recusado: ${mascararChatId(chatId)} não é uma conversa da Meta.`,
    );

    return false;
  }

  if (!metaEnvioAtivo()) {
    console.log(
      `[Meta] resposta não enviada (META_ENVIO_ATIVO=false) | destino: ${descreverDestinoMeta(chatId)} | tamanho: ${texto.length}`,
    );

    return false;
  }

  const resultado = await enviarTextoMeta(chatId, texto);

  return resultado.aceito;
}

/**
 * Cria um cliente novo a partir do wa_id da Meta.
 */
function criarCliente(senderPhone?: string): Cliente {
  const telefone = normalizarTelefone(senderPhone) || "Não informado";

  return {
    telefone,

    status: "IA",

    resumo: {
      nome: "Não informado",

      telefone,

      produto: "Não informado",

      quantidade: "Não informado",

      observacoes: "Não informado",
    },
  };
}

/**
 * Cria uma nova conversa.
 */
function criarNovaConversa(senderPhone?: string): Conversa {
  const usarClaude =
    (process.env.USAR_IA ?? "").trim().toLowerCase() === "claude";

  const atendimentoId = gerarAtendimentoId();

  const ia: IA = new IAClaude(atendimentoId);

  const agora = Date.now();

  const conversa: Conversa = {
    cliente: criarCliente(senderPhone),

    ia,

    atendimentoId,

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
 */
function finalizarConversa(chatId: string, conversa: Conversa): void {
  conversas.delete(chatId);

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
function obterConversa(chatId: string, senderPhone?: string): Conversa {
  const existente = conversas.get(chatId);

  if (existente) {
    /*
     * Atualiza o telefone caso ele esteja disponível.
     */
    const telefone = normalizarTelefone(senderPhone);

    if (telefone) {
      existente.cliente.telefone = telefone;
      existente.cliente.resumo.telefone = telefone;
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
  const nova = criarNovaConversa(senderPhone);

  conversas.set(chatId, nova);

  return nova;
}

/**
 * Responde a uma mensagem recebida com a loja fechada.
 *
 * Não cria atendimento, não chama a IA e não
 * gera resumo. O aviso vai uma única vez por
 * período fechado para cada chatId.
 */
async function avisarLojaFechada(chatId: string): Promise<void> {
  const periodo = chavePeriodoFechado();

  if (avisosLojaFechada.get(chatId) === periodo) {
    console.log(
      `Loja fechada: aviso já enviado neste período para ${mascararChatId(chatId)}; mensagem sem resposta.`,
    );

    return;
  }

  /*
   * Modo log-only da Meta conta como avisado,
   * igual ao restante do fluxo.
   */
  const modoSomenteLog = !metaEnvioAtivo();

  const enviado = await enviarAoCliente(chatId, MENSAGEM_LOJA_FECHADA);

  if (enviado || modoSomenteLog) {
    avisosLojaFechada.set(chatId, periodo);

    console.log(`Loja fechada: aviso enviado para ${mascararChatId(chatId)}.`);
  } else {
    console.error(
      `Loja fechada: aviso não entregue para ${mascararChatId(chatId)}; será tentado na próxima mensagem.`,
    );
  }
}

/**
 * Processa mensagem recebida do cliente.
 */
async function processarMensagemRecebida(payload: EventoMensagem): Promise<void> {
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
   * Só texto.
   */
  if (typeof data.type === "string" && data.type !== "text") {
    return;
  }

  adicionarNaFila(chatId, async () => {
    /*
     * Horário de funcionamento.
     *
     * Fora do horário, só um atendimento que
     * já estava ativo continua. Mensagem sem
     * atendimento ativo recebe o aviso de loja
     * fechada e não inicia triagem.
     */
    const ativa = conversas.get(chatId);

    const temAtendimentoAtivo = !!ativa && !conversaEstaInativa(ativa);

    if (!temAtendimentoAtivo && !lojaAberta()) {
      await avisarLojaFechada(chatId);

      return;
    }

    const conversa = obterConversa(chatId, data.senderPhone);

    /*
     * Usa o horário da mensagem,
     * não o momento em que a IA terminou.
     */
    const momentoMensagem = obterMomentoMensagem(payload);

    conversa.ultimaMensagemEm = momentoMensagem ?? Date.now();

    /*
     * Sem texto e sem telefone completo (LGPD).
     */
    console.log(
      [
        "Mensagem recebida (Meta)",
        `atendimento: ${conversa.atendimentoId}`,
        `chatId: ${mascararChatId(chatId)}`,
        `tamanho: ${texto.length}`,
        `senderPhone: ${data.senderPhone ? mascararTelefone(normalizarTelefone(data.senderPhone)) : "Não informado"}`,
      ].join(" | "),
    );

    /*
     * Se vendedor já assumiu,
     * a IA permanece desligada.
     */
    if (conversa.cliente.status === "HUMANO") {
      console.log(
        `IA desativada para ${mascararChatId(chatId)}: atendimento humano.`,
      );

      return;
    }

    let resultado: ResultadoIA;

    try {
      resultado = await conversa.ia.responder(texto, conversa.cliente);
    } catch (erro: unknown) {
      console.error(
        `Falha na IA (${conversa.atendimentoId}): ${descreverErroIA(erro)}`,
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
     * Um vendedor pode ter assumido pelo Telegram
     * enquanto a Claude estava processando.
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

      return;
    }

    /*
     * Resultado normal da IA.
     */
    conversa.cliente.status = resultado.status;

    conversa.cliente.resumo = resultado.resumo;

    /*
     * Triagem iniciada antes do fechamento e
     * concluída depois: o cliente fica sabendo
     * que o vendedor só retorna na reabertura.
     */
    if (resultado.status === "HUMANO" && !lojaAberta()) {
      resultado.resposta = `${resultado.resposta}\n\n${AVISO_ENCAMINHAMENTO_FORA_DO_HORARIO}`;
    }

    console.log(`Status: ${resultado.status}`);

    console.log(
      `Resumo (${conversa.atendimentoId}) campos preenchidos: ${camposPreenchidos(conversa.cliente.resumo)}`,
    );

    /*
     * Modo log-only da Meta (META_ENVIO_ATIVO=false):
     * a resposta NÃO é enviada de propósito.
     *
     * Isso não é falha de envio, então o estado
     * da triagem NÃO é desfeito e ela avança normalmente.
     *
     * A flag é lida uma única vez aqui para decidir.
     */
    const modoSomenteLog = !metaEnvioAtivo();

    let clienteAvisado = false;

    if (modoSomenteLog) {
      console.log(
        `[Meta] resposta não enviada (META_ENVIO_ATIVO=false) | destino: ${descreverDestinoMeta(chatId)} | tamanho: ${resultado.resposta.length}`,
      );
    } else {
      /*
       * Envia a resposta ao cliente (tentativa real).
       */
      clienteAvisado = await enviarAoCliente(chatId, resultado.resposta);
    }

    if (clienteAvisado) {
      /*
       * A resposta automática também
       * representa atividade.
       */
      conversa.ultimaMensagemEm = Date.now();
    } else if (!modoSomenteLog) {
      console.error(
        `Cliente ${mascararChatId(chatId)} não recebeu a resposta.`,
      );

      /*
       * Houve tentativa REAL de envio e ela falhou:
       * a pergunta não pode ficar registrada como feita.
       *
       * Só durante a triagem (IA). Em HUMANO nada é
       * desfeito: a triagem não reabre e o resumo
       * segue o fluxo normal, uma única vez.
       */
      if (resultado.status === "IA") {
        conversa.ia.desfazerRespostaNaoEntregue();

        console.log(
          `Atendimento ${conversa.atendimentoId}: resposta não entregue desfeita; a pergunta será feita novamente.`,
        );
      }
    }

    /*
     * Quando a IA conclui o atendimento, o resumo vai
     * SOMENTE para o grupo de vendedores no Telegram
     * (idempotente por atendimento).
     */
    if (resultado.status === "HUMANO") {
      if (telegramConfigurado()) {
        await enviarResumoTelegram(
          conversa.atendimentoId,
          chatId,
          conversa.cliente.resumo,
        );
      }

      console.log(
        `Atendimento transferido para humano: ${mascararChatId(chatId)}`,
      );
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
        "Erro ao processar mensagem:",
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

  /*
   * Com a loja aberta, nenhum aviso de
   * período fechado anterior vale mais.
   */
  if (avisosLojaFechada.size > 0 && lojaAberta(agora)) {
    avisosLojaFechada.clear();
  }
}

/**
 * Associa um status da Meta ao atendimento
 * que originou a mensagem.
 *
 * Apenas registra: não reenvia, não muda
 * o estado da IA, não cria atendimento e
 * não passa para HUMANO.
 */
function tratarStatusMeta(status: MetaStatus): void {
  const wamid = status.id ?? "";

  const situacao = status.status ?? "desconhecido";

  const chatId = wamid ? obterChatIdPorWamid(wamid) : null;

  if (!chatId) {
    console.log(
      `[Meta] status ${situacao} para wamid sem correspondência (envio anterior, expirado ou de outra origem): ${wamid || "não informado"}`,
    );

    return;
  }

  const conversa = conversas.get(chatId);

  const partes = [
    `[Meta] status ${situacao} associado`,
    `atendimento: ${conversa ? conversa.atendimentoId : "já encerrado"}`,
    `destino: ${descreverDestinoMeta(chatId)}`,
    `wamid: ${wamid}`,
  ];

  if (situacao !== "failed") {
    console.log(partes.join(" | "));

    return;
  }

  for (const erro of status.errors ?? []) {
    partes.push(`erro code: ${erro.code ?? "não informado"}`);

    partes.push(`erro title: ${erro.title ?? "não informado"}`);
  }

  partes.push("sem reenvio automático");

  console.error(partes.join(" | "));
}

/**
 * ID externo do evento: idempotencyKey (wamid da Meta) e,
 * na falta dele, data.id.
 */
function chaveEventoExterno(payload: EventoMensagem): string {
  return payload.idempotencyKey ?? payload.data?.id ?? "";
}

/**
 * Registra uma MENSAGEM RECEBIDA em eventos_processados.
 *
 * - "processar": evento novo, ou sem ID externo utilizável
 *   (não registrável: segue o fluxo normal, como antes);
 * - "duplicado": já registrado; não processar;
 * - "falha": erro de banco; não processar e NÃO é duplicata.
 */
async function registrarMensagemRecebida(
  canal: CanalEvento,
  chave: string,
): Promise<"processar" | "duplicado" | "falha"> {
  if (!idRegistravel(chave)) {
    if (chave !== "") {
      console.warn(
        `[Dedup] ${canal}: ID externo com ${chave.length} caracteres não cabe em eventos_processados; processado sem deduplicação.`,
      );
    }

    return "processar";
  }

  try {
    const resultado = await registrarEventoRecebido(canal, chave);

    if (resultado === "duplicado") {
      console.log(`[Dedup] ${canal}: mensagem duplicada ignorada: ${mascararChatId(chave)}`);

      return "duplicado";
    }

    return "processar";
  } catch (erro: unknown) {
    const codigo = (erro as { code?: unknown })?.code;

    console.error(
      `[Dedup] ${canal}: falha ao registrar em eventos_processados (${typeof codigo === "string" ? codigo : erro instanceof Error ? erro.name : "erro"}); mensagem NÃO processada.`,
    );

    return "falha";
  }
}

/**
 * Processa uma mensagem recebida da Meta.
 *
 * A deduplicação já aconteceu na rota (eventos_processados).
 *
 * Não há await antes de processarMensagemRecebida chegar em
 * adicionarNaFila: isso mantém a ordem de um lote messages[].
 */
async function processarEvento(payload: EventoMensagem): Promise<void> {
  if (payload.event !== "message.received") {
    return;
  }

  if (!payload.data) {
    return;
  }

  /*
   * Mensagem com mais de 20 minutos não pode
   * iniciar um novo atendimento.
   */
  if (mensagemComMaisDe20Minutos(payload)) {
    console.log(
      [
        "Evento antigo ignorado.",
        `Evento: ${payload.event}`,
        `Idade: ${formatarIdadeMensagem(payload)}`,
      ].join(" | "),
    );

    return;
  }

  await processarMensagemRecebida(payload);
}

/**
 * Inicia o servidor do webhook.
 */
export function iniciarWebhook(): void {
  /*
   * Vendedor venceu o lock no Telegram:
   * a IA para de responder essa conversa.
   */
  definirAoAssumirAtendimento((atendimentoId) => {
    for (const conversa of conversas.values()) {
      if (conversa.atendimentoId !== atendimentoId) {
        continue;
      }

      conversa.vendedorAssumiu = true;

      conversa.cliente.status = "HUMANO";

      console.log(`Atendimento ${atendimentoId} assumido por vendedor via Telegram.`);

      return;
    }

    console.log(
      `Atendimento ${atendimentoId} assumido via Telegram; conversa já encerrada na memória.`,
    );
  });

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

      /*
       * Webhook do bot do Telegram (vendedores).
       */
      if (urlMeta.pathname === "/telegram/webhook") {
        if (request.method !== "POST") {
          responderJson(response, 405, { error: "Method not allowed" });

          return;
        }

        if (
          !segredoWebhookTelegramValido(
            request.headers["x-telegram-bot-api-secret-token"],
          )
        ) {
          responderJson(response, 401, { received: false });

          return;
        }

        const rawBodyTelegram = await lerCorpo(request);

        let update: TelegramUpdate;

        try {
          update = JSON.parse(rawBodyTelegram.toString("utf8")) as TelegramUpdate;
        } catch {
          responderJson(response, 400, { received: false });

          return;
        }

        /*
         * Responde rápido; processa em seguida.
         */
        responderJson(response, 200, { received: true });

        processarUpdateTelegram(update).catch((erro: unknown) => {
          console.error(
            "Erro ao processar update do Telegram:",
            erro instanceof Error ? erro.message : "erro desconhecido",
          );
        });

        return;
      }

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
           * Deduplicação persistente das mensagens recebidas
           * (messages[]) ANTES de responder. statuses[] NÃO passa
           * por aqui: trazem o mesmo wamid da mensagem original.
           */
          const mensagensNovas: EventoMensagem[] = [];

          let falhaRegistro = false;

          for (const evento of normalizarMensagensMeta(payloadMeta)) {
            const registro = await registrarMensagemRecebida(
              "META",
              chaveEventoExterno(evento),
            );

            if (registro === "processar") {
              mensagensNovas.push(evento);
            } else if (registro === "falha") {
              falhaRegistro = true;
            }
          }

          /*
           * Falha ao registrar: 5xx para a Meta reenviar. As
           * mensagens registradas nesta mesma entrega seguem
           * normalmente (no reenvio serão duplicatas).
           */
          responderJson(response, falhaRegistro ? 503 : 200, {
            received: !falhaRegistro,
          });

          processarPayloadMeta(payloadMeta);

          /*
           * statuses[] são o resultado posterior
           * do envio (sent, delivered, read, failed).
           */
          for (const status of listarStatusesMeta(payloadMeta)) {
            try {
              tratarStatusMeta(status);
            } catch (erro: unknown) {
              console.error(
                "Erro ao tratar status da Meta:",
                erro instanceof Error ? erro.message : "erro desconhecido",
              );
            }
          }

          /*
           * messages[] entram no núcleo de atendimento.
           *
           * ORDEM DO LOTE: a ordem original do payload DEVE ser
           * preservada. Não pode existir await entre esta iteração
           * e adicionarNaFila (processarEvento →
           * processarMensagemRecebida), nem Promise.all aqui: as
           * mensagens entram na fila da conversa, de forma
           * síncrona, na ordem do laço. Qualquer mudança neste
           * fluxo precisa preservar essa regra
           * (teste: passo3-ordem-lote.test.mts).
           */
          for (const evento of mensagensNovas) {
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
       * Qualquer outra rota.
       */
      responderJson(response, 404, {
        error: "Not found",
      });
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
    console.log(`Backend ouvindo na porta ${PORT}`);

    console.log("Endpoint: GET/POST /meta/webhook");

    console.log("Endpoint: POST /telegram/webhook");
  });

  /*
   * Verifica inatividade a cada 30 segundos.
   */
  setInterval(verificarInatividade, VERIFICACAO_INATIVIDADE_MS);

  setInterval(() => {
    reenviarResumosTelegramPendentes().catch((erro: unknown) => {
      console.error(
        "Erro ao reenviar resumos do Telegram:",
        erro instanceof Error ? erro.message : "erro desconhecido",
      );
    });
  }, 60_000);
}
