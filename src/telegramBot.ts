import { createHash, timingSafeEqual } from "node:crypto";

import {
  RegistroAtendimentosVendedor,
  ResultadoAssumir,
} from "./atendimentoVendedor.js";

import { mascararTelefone } from "./metaEnvio.js";

import type { ResumoCliente } from "./tipos.js";

/*
 * Integração dos vendedores pelo Telegram.
 *
 * - O resumo vai para o grupo com o botão ASSUMIR.
 * - O vendedor se registra mandando /start ao bot
 *   no privado (só o user_id, o nome do Telegram e
 *   o chat privado são guardados).
 * - Quem vence o lock recebe, SOMENTE no privado,
 *   os dados do cliente e o botão wa.me.
 *
 * SOMENTE EM MEMÓRIA nesta etapa, como o lock.
 */

const TELEGRAM_API = "https://api.telegram.org";

const CALLBACK_ASSUMIR = /^assumir:(ATD-[0-9A-F]{6})$/;

const MENSAGEM_ONBOARDING =
  "Antes de assumir um atendimento, abra @LojaIdealAtendimentoBot no privado e envie /start.";

const MENSAGEM_INDISPONIVEL = "Este atendimento não está mais disponível.";

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
 * O MESMO lock de atendimentoVendedor.ts:
 * autorizado = vendedor que fez /start.
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

/**
 * Chama a Bot API. Nunca registra o token.
 */
async function chamarTelegram<T>(
  metodo: string,
  corpo: Record<string, unknown>,
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

async function processarStartPrivado(mensagem: TelegramMensagem): Promise<void> {
  const usuario = mensagem.from;

  if (!usuario || usuario.is_bot) {
    return;
  }

  const userId = normalizarIdTelegram(usuario.id);

  if (!userId) {
    return;
  }

  const vendedor: Vendedor = {
    userId,
    nome: nomeDoUsuario(usuario),
    chatPrivadoId: mensagem.chat.id,
  };

  vendedores.set(userId, vendedor);

  console.log(`[Telegram] vendedor registrado pelo /start (user_id ${userId}).`);

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

  const vendedor = vendedores.get(userId);

  /*
   * Sem /start no privado: não tenta o lock.
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

      try {
        aoAssumir(atendimentoId);
      } catch (erro: unknown) {
        console.error(
          `[Telegram] falha ao marcar ${atendimentoId} como HUMANO:`,
          erro instanceof Error ? erro.message : "erro desconhecido",
        );
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
 * Processa um Update recebido em POST /telegram/webhook.
 *
 * Só /start em conversa privada e callback_query.
 * Todo o resto é ignorado.
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
  }
}
