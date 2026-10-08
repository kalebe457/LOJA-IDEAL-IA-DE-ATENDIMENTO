import { createHash, timingSafeEqual } from "node:crypto";

import {
  RegistroAtendimentosVendedor,
  ResultadoAssumir,
} from "./atendimentoVendedor.js";

import { mascararTelefone } from "./metaEnvio.js";

import {
  consultarRanking,
  registrarAssuncao,
  registrarDmStatus,
  registrarResumoPublicado,
  registrarVendedor,
} from "./persistenciaAssuncao.js";

import type {
  ResumoRecuperado,
  VendedorRecuperado,
} from "./persistenciaRecuperacao.js";

import type { ResumoCliente } from "./tipos.js";

/*
 * Integração dos vendedores pelo Telegram.
 *
 * - O resumo vai para o grupo com o botão ASSUMIR.
 * - Quem pode ser vendedor: quem está no grupo dos
 *   vendedores (getChatMember), conferido no /start
 *   e de novo em cada clique em ASSUMIR.
 * - O vendedor se registra mandando /start ao bot
 *   no privado (só o user_id, o nome do Telegram e
 *   o chat privado são guardados).
 * - Quem vence o lock recebe, SOMENTE no privado,
 *   os dados do cliente e o botão wa.me.
 *
 * A memória (vendedores, atendimentos, lock) é a fonte de
 * verdade. O banco registra o resumo publicado, a assunção e a
 * DM, e é um segundo portão contra assunção dupla (Passo 5c).
 *
 * /ranking (só no privado, só administradores do grupo):
 * atendimentos assumidos por vendedor, no mês e no total.
 */

const TELEGRAM_API = "https://api.telegram.org";

const CALLBACK_ASSUMIR = /^assumir:(ATD-[0-9A-F]{10})$/;

const MENSAGEM_ONBOARDING =
  "Antes de assumir um atendimento, abra @LojaIdealAtendimentoBot no privado e envie /start.";

const MENSAGEM_INDISPONIVEL = "Este atendimento não está mais disponível.";

const MENSAGEM_FORA_DA_EQUIPE =
  "Você não faz parte da equipe de vendedores da Loja Ideal.";

const MENSAGEM_VERIFICACAO_FALHOU =
  "Não consegui verificar sua participação na equipe agora. Tente novamente em instantes.";

const MENSAGEM_RANKING_SO_ADMIN = "Esse comando é só para administradores do grupo.";

const MENSAGEM_RANKING_VAZIO = "Nenhum atendimento assumido ainda.";

const MENSAGEM_RANKING_ERRO = "Não consegui consultar agora. Tente de novo em instantes.";

/*
 * Tempo máximo da consulta ao grupo: uma API lenta não
 * pode deixar o /start ou o callback presos.
 */
const TIMEOUT_GET_CHAT_MEMBER_MS = 5_000;

/*
 * Quem está no grupo dos vendedores (TELEGRAM_CHAT_ID) com
 * um destes status pode atuar como vendedor. É a ÚNICA fonte
 * de autorização. "restricted", "left" e "kicked" não valem.
 */
const STATUS_AUTORIZADOS = new Set(["member", "administrator", "creator"]);

/*
 * Quem pode usar o /ranking.
 */
const STATUS_ADMINISTRADORES = new Set(["administrator", "creator"]);

/*
 * Atendimentos mais antigos que isso saem
 * da memória (o lock expira em 24h).
 */
const RETENCAO_ATENDIMENTO_MS = 48 * 60 * 60 * 1000;

const MAX_ATENDIMENTOS = 5_000;

const MAX_IDS_PROCESSADOS = 2_000;

function config(): { token: string; chatId: string; segredo: string } {
  return {
    token: (process.env.TELEGRAM_BOT_TOKEN ?? "").trim(),

    chatId: (process.env.TELEGRAM_CHAT_ID ?? "").trim(),

    segredo: (process.env.TELEGRAM_WEBHOOK_SECRET ?? "").trim(),
  };
}

/**
 * O envio para o grupo está configurado?
 */
export function telegramConfigurado(): boolean {
  const { token, chatId } = config();

  return token !== "" && chatId !== "";
}

/*
 * Tipos mínimos da Bot API usados aqui.
 */
type TelegramUsuario = {
  id: number;
  is_bot?: boolean;
  first_name?: string;
  last_name?: string;
  username?: string;
};

type TelegramChat = {
  id: number;
  type?: string;
};

type TelegramMensagem = {
  message_id: number;
  chat: TelegramChat;
  from?: TelegramUsuario;
  text?: string;
};

type TelegramCallbackQuery = {
  id: string;
  from: TelegramUsuario;
  message?: TelegramMensagem;
  data?: string;
};

export type TelegramUpdate = {
  update_id?: number;
  message?: TelegramMensagem;
  callback_query?: TelegramCallbackQuery;
};

type RespostaTelegram<T> = {
  ok: boolean;
  result?: T;
  error_code?: number;
  description?: string;
};

type Vendedor = {
  userId: string;

  /*
   * Nome como aparece no Telegram.
   */
  nome: string;

  chatPrivadoId: number;
};

type EstadoDM = "pendente" | "enviando" | "enviada" | "falhou";

type AtendimentoTelegram = {
  atendimentoId: string;

  chatIdCliente: string;

  resumo: ResumoCliente;

  envioResumo: "enviando" | "enviado" | "falhou";

  /*
   * message_id do resumo no grupo. Só cliques
   * nessa mensagem são aceitos.
   */
  mensagemGrupoId: number | null;

  vendedorId: string | null;

  vendedorNome: string | null;

  dm: EstadoDM;

  criadoEm: number;
};

/**
 * user_id do Telegram como identidade do vendedor.
 */
function normalizarIdTelegram(valor: unknown): string {
  if (typeof valor === "number" && Number.isSafeInteger(valor) && valor > 0) {
    return String(valor);
  }

  if (typeof valor === "string" && /^\d{1,20}$/.test(valor)) {
    return valor;
  }

  return "";
}

/*
 * Estado do módulo.
 */
let vendedores = new Map<string, Vendedor>();

let atendimentos = new Map<string, AtendimentoTelegram>();

let idsProcessados = new Set<string>();

/*
 * O MESMO lock de atendimentoVendedor.ts. Para ele,
 * "autorizado" = registrado pelo /start (precisa do chat
 * privado para a DM). A autorização de verdade (grupo)
 * é conferida ANTES de chamar o lock.
 */
let lock = criarLock();

function criarLock(): RegistroAtendimentosVendedor {
  return new RegistroAtendimentosVendedor({
    vendedoresAutorizados: () => new Set(vendedores.keys()),

    normalizarVendedor: normalizarIdTelegram,
  });
}

type AoAssumir = (atendimentoId: string) => void;

let aoAssumir: AoAssumir = () => undefined;

/**
 * Chamado quando um vendedor vence o lock.
 * O webhook usa para marcar a conversa como HUMANO.
 */
export function definirAoAssumirAtendimento(funcao: AoAssumir): void {
  aoAssumir = funcao;
}

/**
 * Somente para testes: zera o estado em memória.
 */
export function redefinirEstadoTelegramParaTestes(): void {
  vendedores = new Map();

  atendimentos = new Map();

  idsProcessados = new Set();

  lock = criarLock();

  aoAssumir = () => undefined;
}

function resumoRecuperado(r: ResumoRecuperado): ResumoCliente {
  return {
    nome: r.nome ?? "Não informado",
    telefone: r.telefone,
    produto: r.produto ?? "Não informado",
    quantidade: r.quantidade ?? "Não informado",
    observacoes: r.observacoes ?? "Não informado",
  };
}

/**
 * Recuperação na partida (Passo 5d): devolve à memória os
 * vendedores e os resumos publicados dentro do TTL, para o
 * botão ASSUMIR continuar valendo. Os TTLs do lock contam dos
 * horários reais. DM que não consta como ENVIADA (ENVIANDO ou
 * FALHOU) volta como "falhou" e é reenviada depois.
 */
export function restaurarEstadoTelegram(dados: {
  vendedores: VendedorRecuperado[];
  resumosPublicados: ResumoRecuperado[];
}): { vendedores: number; resumos: number; descartados: number } {
  let quantosVendedores = 0;

  for (const v of dados.vendedores) {
    const userId = normalizarIdTelegram(v.userId);

    if (!userId || !Number.isSafeInteger(v.chatPrivadoId)) {
      continue;
    }

    vendedores.set(userId, { userId, nome: v.nome, chatPrivadoId: v.chatPrivadoId });

    quantosVendedores++;
  }

  let resumos = 0;

  let descartados = 0;

  for (const r of dados.resumosPublicados) {
    /*
     * Só cliques no grupo configurado valem.
     */
    if (
      r.telegramChatId !== config().chatId ||
      r.telegramMessageId === null ||
      r.resumoEnviadoEm === null ||
      atendimentos.has(r.codigo)
    ) {
      descartados++;

      continue;
    }

    if (!lock.restaurar(r.codigo, r.chatId, r.vendedorUserId, r.resumoEnviadoEm, r.assumidoEm)) {
      descartados++;

      continue;
    }

    atendimentos.set(r.codigo, {
      atendimentoId: r.codigo,
      chatIdCliente: r.chatId,
      resumo: resumoRecuperado(r),
      envioResumo: "enviado",
      mensagemGrupoId: r.telegramMessageId,
      vendedorId: r.vendedorUserId,
      vendedorNome: r.vendedorNome,
      dm: r.dmStatus === "ENVIADA" ? "enviada" : r.dmStatus === null ? "pendente" : "falhou",
      criadoEm: r.resumoEnviadoEm,
    });

    resumos++;
  }

  return { vendedores: quantosVendedores, resumos, descartados };
}

/**
 * Depois da recuperação (sem bloquear a partida): publica os
 * resumos que ficaram sem publicar e reenvia as DMs que não
 * constam como enviadas.
 */
export async function reenviarPendenciasRecuperadas(
  naoPublicados: ResumoRecuperado[],
): Promise<{ resumos: number; dms: number }> {
  let resumos = 0;

  let dms = 0;

  if (!telegramConfigurado()) {
    return { resumos, dms };
  }

  for (const r of naoPublicados) {
    if (await enviarResumoTelegram(r.codigo, r.chatId, resumoRecuperado(r))) {
      resumos++;
    }
  }

  for (const atd of [...atendimentos.values()]) {
    if (atd.vendedorId === null || atd.dm !== "falhou") {
      continue;
    }

    const vendedor = vendedores.get(atd.vendedorId);

    if (!vendedor) {
      console.error(
        `[Recuperação] DM de ${atd.atendimentoId} não reenviada: vendedor sem chat privado registrado.`,
      );

      continue;
    }

    if (await enviarDMVencedor(atd, vendedor)) {
      dms++;

      await atualizarMensagemGrupo(atd);
    }
  }

  return { resumos, dms };
}

/**
 * Chama a Bot API. Nunca registra o token.
 */
async function chamarTelegram<T>(
  metodo: string,
  corpo: Record<string, unknown>,
  timeoutMs?: number,
): Promise<RespostaTelegram<T>> {
  const { token } = config();

  if (!token) {
    console.error(`[Telegram] ${metodo} não executado: TELEGRAM_BOT_TOKEN ausente.`);

    return { ok: false, description: "token ausente" };
  }

  try {
    const resposta = await fetch(`${TELEGRAM_API}/bot${token}/${metodo}`, {
      method: "POST",

      headers: { "Content-Type": "application/json" },

      body: JSON.stringify(corpo),

      ...(timeoutMs ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
    });

    const json = (await resposta.json()) as RespostaTelegram<T>;

    if (!json.ok) {
      console.error(
        `[Telegram] ${metodo} falhou | código: ${json.error_code ?? resposta.status} | ${json.description ?? "sem descrição"}`,
      );
    }

    return json;
  } catch (erro: unknown) {
    const mensagem =
      erro instanceof Error
        ? erro.message.split(token).join("<token>")
        : "erro desconhecido";

    console.error(`[Telegram] ${metodo} falhou | rede: ${mensagem}`);

    return { ok: false, description: mensagem };
  }
}

/**
 * Link wa.me: só dígitos, formato internacional.
 * null quando o telefone não é utilizável.
 */
export function gerarLinkWhatsApp(telefone: string): string | null {
  const digitos = (telefone ?? "").replace(/\D/g, "");

  if (digitos.length < 10 || digitos.length > 15) {
    return null;
  }

  return `https://wa.me/${digitos}`;
}

function formatarResumoGrupo(resumo: ResumoCliente): string {
  return [
    "📋 NOVO ATENDIMENTO",
    "",
    `Nome: ${resumo.nome}`,
    `Telefone: ${resumo.telefone}`,
    `Produto: ${resumo.produto}`,
    `Quantidade: ${resumo.quantidade}`,
    `Observações: ${resumo.observacoes}`,
  ].join("\n");
}

function formatarAssumidoGrupo(atd: AtendimentoTelegram): string {
  const linhas = ["🔒 ATENDIMENTO ASSUMIDO", "", `Vendedor: ${atd.vendedorNome ?? "-"}`];

  if (atd.dm === "falhou") {
    linhas.push(
      "",
      "⚠️ O atendimento foi assumido, mas houve erro ao enviar a mensagem privada ao vendedor. Para receber os dados, o vendedor deve enviar /start ao bot no privado.",
    );
  }

  return linhas.join("\n");
}

function formatarDM(resumo: ResumoCliente, link: string | null): string {
  const linhas = [
    "🔒 ATENDIMENTO ASSUMIDO",
    "",
    `Cliente: ${resumo.nome}`,
    `Telefone: ${resumo.telefone}`,
    `Produto: ${resumo.produto}`,
    `Quantidade: ${resumo.quantidade}`,
    `Observações: ${resumo.observacoes}`,
  ];

  if (!link) {
    linhas.push("", "Telefone indisponível para abrir o WhatsApp diretamente.");
  }

  return linhas.join("\n");
}

function nomeDoUsuario(usuario: TelegramUsuario): string {
  const nome = [usuario.first_name, usuario.last_name]
    .filter((parte) => typeof parte === "string" && parte.trim() !== "")
    .join(" ")
    .trim();

  if (nome) {
    return nome.slice(0, 64);
  }

  if (usuario.username) {
    return `@${usuario.username}`.slice(0, 64);
  }

  return "Vendedor";
}

/**
 * Evita processar o mesmo update/callback duas vezes.
 */
function jaProcessado(chave: string): boolean {
  if (idsProcessados.has(chave)) {
    return true;
  }

  idsProcessados.add(chave);

  if (idsProcessados.size > MAX_IDS_PROCESSADOS) {
    const primeiro = idsProcessados.values().next().value;

    if (primeiro !== undefined) {
      idsProcessados.delete(primeiro);
    }
  }

  return false;
}

function limparAtendimentosAntigos(agora = Date.now()): void {
  for (const [id, atd] of atendimentos) {
    if (agora - atd.criadoEm >= RETENCAO_ATENDIMENTO_MS) {
      atendimentos.delete(id);
    }
  }

  while (atendimentos.size > MAX_ATENDIMENTOS) {
    const maisAntigo = atendimentos.keys().next().value;

    if (maisAntigo === undefined) {
      break;
    }

    atendimentos.delete(maisAntigo);
  }
}

/**
 * Envia o resumo ao grupo com o botão ASSUMIR.
 *
 * Idempotente por atendimento: só reenvia
 * se o envio anterior falhou.
 */
export async function enviarResumoTelegram(
  atendimentoId: string,
  chatIdCliente: string,
  resumo: ResumoCliente,
): Promise<boolean> {
  if (!telegramConfigurado()) {
    console.error(
      `[Telegram] resumo de ${atendimentoId} não enviado: TELEGRAM_BOT_TOKEN ou TELEGRAM_CHAT_ID ausente.`,
    );

    return false;
  }

  const existente = atendimentos.get(atendimentoId);

  if (existente && existente.envioResumo !== "falhou") {
    console.log(
      `[Telegram] resumo de ${atendimentoId} já ${existente.envioResumo}; ignorado.`,
    );

    return existente.envioResumo === "enviado";
  }

  limparAtendimentosAntigos();

  const atd: AtendimentoTelegram = existente ?? {
    atendimentoId,
    chatIdCliente,
    resumo: { ...resumo },
    envioResumo: "enviando",
    mensagemGrupoId: null,
    vendedorId: null,
    vendedorNome: null,
    dm: "pendente",
    criadoEm: Date.now(),
  };

  atd.envioResumo = "enviando";

  atendimentos.set(atendimentoId, atd);

  /*
   * Registrado no lock ANTES do envio: um clique
   * logo após a mensagem chegar já encontra o ATD.
   */
  lock.registrarPendente(atendimentoId, chatIdCliente);

  const resposta = await chamarTelegram<TelegramMensagem>("sendMessage", {
    chat_id: config().chatId,

    text: formatarResumoGrupo(atd.resumo),

    reply_markup: {
      inline_keyboard: [
        [
          {
            text: "🔒 ASSUMIR ATENDIMENTO",
            callback_data: `assumir:${atendimentoId}`,
          },
        ],
      ],
    },
  });

  if (resposta.ok && resposta.result) {
    atd.envioResumo = "enviado";

    atd.mensagemGrupoId = resposta.result.message_id;

    console.log(`[Telegram] resumo de ${atendimentoId} enviado ao grupo.`);

    /*
     * Espelho: a mensagem que está valendo (falha só gera log).
     */
    await registrarResumoPublicado(
      atendimentoId,
      resposta.result.chat?.id ?? config().chatId,
      resposta.result.message_id,
    );

    return true;
  }

  atd.envioResumo = "falhou";

  console.error(
    `[Telegram] resumo de ${atendimentoId} não enviado; nova tentativa no próximo ciclo.`,
  );

  return false;
}

/**
 * Reenvia resumos cujo envio falhou.
 */
export async function reenviarResumosTelegramPendentes(): Promise<void> {
  limparAtendimentosAntigos();

  for (const atd of [...atendimentos.values()]) {
    if (atd.envioResumo === "falhou") {
      await enviarResumoTelegram(atd.atendimentoId, atd.chatIdCliente, atd.resumo);
    }
  }
}

/**
 * Valida o header X-Telegram-Bot-Api-Secret-Token.
 *
 * Sem TELEGRAM_WEBHOOK_SECRET configurado,
 * nada é aceito (falha fechada).
 */
export function segredoWebhookTelegramValido(header: unknown): boolean {
  const { segredo } = config();

  if (!segredo) {
    console.error("[Telegram] TELEGRAM_WEBHOOK_SECRET não configurado; update recusado.");

    return false;
  }

  if (typeof header !== "string" || header === "") {
    return false;
  }

  const a = createHash("sha256").update(header, "utf8").digest();

  const b = createHash("sha256").update(segredo, "utf8").digest();

  return timingSafeEqual(a, b);
}

async function responderCallback(
  callbackId: string,
  texto: string,
  alerta = false,
): Promise<void> {
  await chamarTelegram("answerCallbackQuery", {
    callback_query_id: callbackId,
    text: texto,
    show_alert: alerta,
  });
}

/**
 * Edita a mensagem do grupo para "assumido".
 * Sem reply_markup: o botão ASSUMIR some.
 */
async function atualizarMensagemGrupo(atd: AtendimentoTelegram): Promise<void> {
  if (atd.mensagemGrupoId === null) {
    return;
  }

  const resposta = await chamarTelegram("editMessageText", {
    chat_id: config().chatId,
    message_id: atd.mensagemGrupoId,
    text: formatarAssumidoGrupo(atd),
  });

  if (!resposta.ok) {
    console.error(
      `[Telegram] mensagem do grupo de ${atd.atendimentoId} não editada.`,
    );
  }
}

/**
 * Envia a DM com os dados do cliente ao vencedor.
 *
 * ÚNICO lugar que monta o botão wa.me.
 */
async function enviarDMVencedor(
  atd: AtendimentoTelegram,
  vendedor: Vendedor,
): Promise<boolean> {
  if (atd.vendedorId !== vendedor.userId) {
    console.error(
      `[Telegram] DM de ${atd.atendimentoId} bloqueada: destinatário não é o vencedor.`,
    );

    return false;
  }

  atd.dm = "enviando";

  const link = gerarLinkWhatsApp(atd.resumo.telefone);

  const corpo: Record<string, unknown> = {
    chat_id: vendedor.chatPrivadoId,
    text: formatarDM(atd.resumo, link),
  };

  if (link) {
    corpo.reply_markup = {
      inline_keyboard: [[{ text: "💬 ABRIR WHATSAPP", url: link }]],
    };
  }

  const resposta = await chamarTelegram("sendMessage", corpo);

  atd.dm = resposta.ok ? "enviada" : "falhou";

  /*
   * Espelho do resultado da DM (falha só gera log).
   */
  await registrarDmStatus(atd.atendimentoId, resposta.ok ? "ENVIADA" : "FALHOU");

  if (resposta.ok) {
    console.log(
      `[Telegram] DM de ${atd.atendimentoId} enviada ao vendedor (cliente ${mascararTelefone(atd.resumo.telefone.replace(/\D/g, ""))}).`,
    );
  } else {
    console.error(
      `[Telegram] DM de ${atd.atendimentoId} NÃO enviada. Lock mantido; o vendedor recebe de novo ao enviar /start no privado.`,
    );
  }

  return resposta.ok;
}

type ParticipacaoGrupo = "autorizado" | "fora_da_equipe" | "erro";

/**
 * Status do usuário no grupo dos vendedores (getChatMember,
 * sem cache, com timeout). null = falha técnica.
 */
async function statusNoGrupo(usuarioId: number): Promise<string | null> {
  const resposta = await chamarTelegram<{ status?: unknown }>(
    "getChatMember",
    { chat_id: config().chatId, user_id: usuarioId },
    TIMEOUT_GET_CHAT_MEMBER_MS,
  );

  const status = resposta.ok ? resposta.result?.status : undefined;

  return typeof status === "string" && status !== "" ? status : null;
}

/**
 * O usuário faz parte AGORA do grupo dos vendedores?
 *
 * Consulta getChatMember a cada chamada (sem cache): sair ou
 * ser removido do grupo retira a autorização na hora.
 * O bot precisa ser administrador do grupo.
 *
 * - "autorizado": member, administrator ou creator;
 * - "fora_da_equipe": qualquer outro status (left, kicked,
 *   restricted...);
 * - "erro": falha técnica (HTTP/API, rede, timeout, resposta
 *   inesperada). Também NEGA o acesso.
 */
async function participaDoGrupoVendedores(usuarioId: number): Promise<ParticipacaoGrupo> {
  const status = await statusNoGrupo(usuarioId);

  if (status === null) {
    console.log(
      `[Telegram] participação no grupo não verificada (user_id ${usuarioId}): falha técnica; acesso negado.`,
    );

    return "erro";
  }

  if (STATUS_AUTORIZADOS.has(status)) {
    console.log(
      `[Telegram] participação no grupo confirmada (user_id ${usuarioId}, status: ${status}).`,
    );

    return "autorizado";
  }

  console.log(
    `[Telegram] user_id ${usuarioId} fora da equipe de vendedores (status no grupo: ${status}); acesso negado.`,
  );

  return "fora_da_equipe";
}

async function processarStartPrivado(mensagem: TelegramMensagem): Promise<void> {
  const usuario = mensagem.from;

  if (!usuario || usuario.is_bot) {
    return;
  }

  const userId = normalizarIdTelegram(usuario.id);

  if (!userId) {
    return;
  }

  /*
   * Só quem está no grupo dos vendedores é registrado.
   */
  const participacao = await participaDoGrupoVendedores(usuario.id);

  if (participacao !== "autorizado") {
    /*
     * Fora do grupo: o registro anterior deixa de valer.
     * Falha técnica: nada muda (não dá para saber).
     */
    if (participacao === "fora_da_equipe") {
      vendedores.delete(userId);
    }

    await chamarTelegram("sendMessage", {
      chat_id: mensagem.chat.id,
      text:
        participacao === "erro"
          ? MENSAGEM_VERIFICACAO_FALHOU
          : MENSAGEM_FORA_DA_EQUIPE,
    });

    return;
  }

  const vendedor: Vendedor = {
    userId,
    nome: nomeDoUsuario(usuario),
    chatPrivadoId: mensagem.chat.id,
  };

  vendedores.set(userId, vendedor);

  console.log(`[Telegram] vendedor registrado pelo /start (user_id ${userId}).`);

  /*
   * Também no banco: depois de um reinício o vendedor volta sem
   * novo /start. Falha de banco só gera log (a memória vale).
   */
  await registrarVendedor({
    telegramUserId: userId,
    nome: vendedor.nome,
    chatPrivadoId: vendedor.chatPrivadoId,
  });

  await chamarTelegram("sendMessage", {
    chat_id: vendedor.chatPrivadoId,
    text: "✅ Você está registrado para assumir atendimentos da Loja Ideal.",
  });

  /*
   * Reenvio seguro: só as DMs que falharam
   * e cujo vencedor é ESTE vendedor.
   */
  for (const atd of atendimentos.values()) {
    if (atd.vendedorId === userId && atd.dm === "falhou") {
      const ok = await enviarDMVencedor(atd, vendedor);

      if (ok) {
        await atualizarMensagemGrupo(atd);
      }
    }
  }
}

async function processarCallback(callback: TelegramCallbackQuery): Promise<void> {
  if (jaProcessado(`cb:${callback.id}`)) {
    return;
  }

  const mensagem = callback.message;

  /*
   * Só cliques no grupo configurado.
   */
  if (!mensagem || String(mensagem.chat.id) !== config().chatId) {
    console.log("[Telegram] callback fora do grupo configurado; ignorado.");

    await responderCallback(callback.id, MENSAGEM_INDISPONIVEL);

    return;
  }

  const correspondencia = CALLBACK_ASSUMIR.exec(callback.data ?? "");

  const atendimentoId = correspondencia?.[1];

  const atd = atendimentoId ? atendimentos.get(atendimentoId) : undefined;

  /*
   * O clique precisa ser na MESMA mensagem que o
   * bot enviou para esse atendimento.
   */
  if (!atendimentoId || !atd || atd.mensagemGrupoId !== mensagem.message_id) {
    await responderCallback(callback.id, MENSAGEM_INDISPONIVEL);

    return;
  }

  const userId = normalizarIdTelegram(callback.from.id);

  /*
   * Autorização ANTES de qualquer lock, mesmo para quem
   * já fez /start: precisa estar no grupo agora.
   */
  if (!userId) {
    await responderCallback(callback.id, MENSAGEM_FORA_DA_EQUIPE, true);

    return;
  }

  const participacao = await participaDoGrupoVendedores(callback.from.id);

  if (participacao !== "autorizado") {
    await responderCallback(
      callback.id,
      participacao === "erro" ? MENSAGEM_VERIFICACAO_FALHOU : MENSAGEM_FORA_DA_EQUIPE,
      true,
    );

    return;
  }

  const vendedor = vendedores.get(userId);

  /*
   * No grupo, mas sem /start no privado (não há chat
   * para a DM): não tenta o lock.
   */
  if (!vendedor) {
    await responderCallback(callback.id, MENSAGEM_ONBOARDING, true);

    return;
  }

  /*
   * Lock síncrono: nenhum await entre a decisão
   * e a gravação do vencedor abaixo.
   */
  const tentativa = lock.tentarAssumir(atendimentoId, userId);

  switch (tentativa.resultado) {
    case ResultadoAssumir.ASSUMIDO: {
      atd.vendedorId = userId;

      atd.vendedorNome = vendedor.nome;

      atd.dm = "enviando";

      /*
       * Segundo portão: o banco (UPDATE só se ainda sem vendedor).
       * Linha inexistente ou falha de banco NÃO impedem a
       * assunção: segue pela memória, como antes.
       */
      const banco = await registrarAssuncao({
        codigo: atendimentoId,
        telegramUserId: userId,

        /*
         * Nome ATUAL no Telegram (do clique), não o do /start.
         */
        nome: nomeDoUsuario(callback.from),
        chatPrivadoId: vendedor.chatPrivadoId,
        telegramChatId: mensagem.chat.id,
        telegramMessageId: mensagem.message_id,
      });

      if (banco === "ja_por_outro") {
        /*
         * O banco vence (proteção para depois de um reinício):
         * a memória NÃO fica com este vendedor.
         */
        lock.desfazerAssuncao(atendimentoId, userId);

        atd.vendedorId = null;

        atd.vendedorNome = null;

        atd.dm = "pendente";

        console.error(
          `[Telegram] ${atendimentoId}: o banco já registra outro vendedor; assunção recusada.`,
        );

        await responderCallback(
          callback.id,
          "Este atendimento já foi assumido por outro vendedor.",
          true,
        );

        return;
      }

      if (banco === "sem_linha" || banco === "erro") {
        console.warn(
          `[Telegram] ${atendimentoId}: assunção não gravada no banco (${banco === "erro" ? "falha de banco" : "atendimento ausente"}); segue pela memória.`,
        );
      }

      try {
        aoAssumir(atendimentoId);
      } catch (erro: unknown) {
        console.error(
          `[Telegram] falha ao marcar ${atendimentoId} como HUMANO:`,
          erro instanceof Error ? erro.message : "erro desconhecido",
        );
      }

      /*
       * O banco já tinha ESTE vendedor (depois de um reinício):
       * mesma resposta de hoje para "já assumido por você".
       */
      if (banco === "ja_por_voce" || banco === "ja_por_voce_dm_pendente") {
        await responderCallback(callback.id, "Você já assumiu este atendimento.");

        /*
         * A DM não consta como ENVIADA no banco (ENVIANDO ou
         * FALHOU): reenvia. Duplicar é aceitável; perder não.
         */
        if (banco === "ja_por_voce_dm_pendente") {
          const ok = await enviarDMVencedor(atd, vendedor);

          if (ok) {
            await atualizarMensagemGrupo(atd);
          }
        } else {
          atd.dm = "enviada";
        }

        return;
      }

      await responderCallback(
        callback.id,
        "Atendimento assumido! Os dados do cliente foram enviados no seu privado.",
      );

      const dmOk = await enviarDMVencedor(atd, vendedor);

      /*
       * Remove o botão e informa quem assumiu
       * (e o erro da DM, se houve).
       */
      await atualizarMensagemGrupo(atd);

      if (!dmOk) {
        console.error(
          `[Telegram] ${atendimentoId} assumido, mas a DM falhou. Atendimento continua HUMANO.`,
        );
      }

      return;
    }

    case ResultadoAssumir.JA_ASSUMIDO_POR_VOCE: {
      await responderCallback(callback.id, "Você já assumiu este atendimento.");

      if (atd.dm === "falhou") {
        const ok = await enviarDMVencedor(atd, vendedor);

        if (ok) {
          await atualizarMensagemGrupo(atd);
        }
      }

      return;
    }

    case ResultadoAssumir.JA_ASSUMIDO_POR_OUTRO: {
      const quem = atd.vendedorNome ? ` (${atd.vendedorNome})` : "";

      await responderCallback(
        callback.id,
        `Este atendimento já foi assumido por outro vendedor${quem}.`,
        true,
      );

      return;
    }

    case ResultadoAssumir.VENDEDOR_NAO_AUTORIZADO: {
      await responderCallback(callback.id, MENSAGEM_ONBOARDING, true);

      return;
    }

    default: {
      await responderCallback(callback.id, MENSAGEM_INDISPONIVEL);
    }
  }
}

/**
 * /ranking no privado: só administradores do grupo.
 * Só nomes de vendedores e números (sem cliente, sem codigo).
 */
async function processarRankingPrivado(mensagem: TelegramMensagem): Promise<void> {
  const usuario = mensagem.from;

  if (!usuario || usuario.is_bot) {
    return;
  }

  const responder = (texto: string) =>
    chamarTelegram("sendMessage", { chat_id: mensagem.chat.id, text: texto });

  const status = await statusNoGrupo(usuario.id);

  if (status === null) {
    await responder(MENSAGEM_VERIFICACAO_FALHOU);

    return;
  }

  if (!STATUS_ADMINISTRADORES.has(status)) {
    console.log(`[Telegram] /ranking negado (user_id ${usuario.id}, status: ${status}).`);

    await responder(MENSAGEM_RANKING_SO_ADMIN);

    return;
  }

  const ranking = await consultarRanking();

  if (ranking === null) {
    await responder(MENSAGEM_RANKING_ERRO);

    return;
  }

  if (ranking.length === 0) {
    await responder(MENSAGEM_RANKING_VAZIO);

    console.log("[Telegram] /ranking respondido (vazio)");

    return;
  }

  const mes = new Intl.DateTimeFormat("pt-BR", {
    timeZone: "America/Belem",
    month: "long",
    year: "numeric",
  }).format(Date.now());

  await responder(
    [
      "🏆 ATENDIMENTOS ASSUMIDOS",
      `Mês: ${mes}`,
      "",
      ...ranking.map(
        (linha, indice) =>
          `${indice + 1}. ${linha.nome}: ${linha.mes} no mês | ${linha.total} no total`,
      ),
    ].join("\n"),
  );

  console.log(`[Telegram] /ranking respondido (${ranking.length} vendedores)`);
}

/**
 * Processa um Update recebido em POST /telegram/webhook.
 *
 * Só /start e /ranking em conversa privada e callback_query.
 * Todo o resto (inclusive comandos no grupo) é ignorado.
 */
export async function processarUpdateTelegram(update: TelegramUpdate): Promise<void> {
  if (typeof update?.update_id === "number" && jaProcessado(`up:${update.update_id}`)) {
    return;
  }

  if (update.callback_query) {
    await processarCallback(update.callback_query);

    return;
  }

  const mensagem = update.message;

  if (
    mensagem &&
    mensagem.chat?.type === "private" &&
    typeof mensagem.text === "string" &&
    /^\/start(?:@\w+)?(?:\s|$)/.test(mensagem.text.trim())
  ) {
    await processarStartPrivado(mensagem);

    return;
  }

  if (
    mensagem &&
    mensagem.chat?.type === "private" &&
    typeof mensagem.text === "string" &&
    /^\/ranking(?:@\w+)?(?:\s|$)/.test(mensagem.text.trim())
  ) {
    await processarRankingPrivado(mensagem);
  }
}
