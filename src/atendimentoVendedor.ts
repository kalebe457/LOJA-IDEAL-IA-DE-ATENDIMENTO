import { mascararTelefone } from "./metaEnvio.js";

/*
 * Atribuição de atendimento a vendedores (lock).
 *
 * O primeiro vendedor autorizado que assumir um
 * atendimento pendente fica responsável por ele;
 * os demais são rejeitados.
 *
 * SOMENTE EM MEMÓRIA nesta etapa: perde-se ao
 * reiniciar e só é correto com UM processo.
 * Em produção deve ir para o PostgreSQL:
 *
 *   UPDATE atendimentos
 *      SET estado = 'assumido', responsavel = $2, assumido_em = now()
 *    WHERE atendimento_id = $1 AND responsavel IS NULL AND <não expirado>
 *   RETURNING atendimento_id;
 *
 * 1 linha afetada = venceu; 0 linhas = um SELECT
 * decide entre inexistente, "por você" e "por outro".
 */

/*
 * TTLs padrão: REGRA DE NEGÓCIO, a confirmar com o dono.
 *
 * O vendedor fala com o cliente pelo WhatsApp dele (wa.me),
 * então a janela de 24h da Meta não limita esses valores.
 */
const TTL_PENDENTE_PADRAO_MS = 24 * 60 * 60 * 1000;

const TTL_ASSUMIDO_PADRAO_MS = 24 * 60 * 60 * 1000;

const MAX_ITENS_PADRAO = 5_000;

export const EstadoAtendimento = {
  PENDENTE: "pendente",
  ASSUMIDO: "assumido",
} as const;

export type EstadoAtendimento =
  (typeof EstadoAtendimento)[keyof typeof EstadoAtendimento];

export const ResultadoAssumir = {
  ASSUMIDO: "assumido",
  JA_ASSUMIDO_POR_OUTRO: "ja_assumido_por_outro",
  JA_ASSUMIDO_POR_VOCE: "ja_assumido_por_voce",
  INEXISTENTE_OU_EXPIRADO: "inexistente_ou_expirado",
  VENDEDOR_NAO_AUTORIZADO: "vendedor_nao_autorizado",
} as const;

export type ResultadoAssumir =
  (typeof ResultadoAssumir)[keyof typeof ResultadoAssumir];

export type RegistroAtendimento = {
  atendimentoId: string;

  /*
   * chatId do cliente.
   */
  chatId: string;

  estado: EstadoAtendimento;

  /*
   * Identidade canônica do vendedor
   * (user_id do Telegram). null enquanto pendente.
   */
  responsavel: string | null;

  criadoEm: number;

  /*
   * null enquanto pendente.
   */
  assumidoEm: number | null;
};

/*
 * Quem perde a disputa não recebe o chatId
 * do cliente nem a identidade do vencedor.
 */
export type TentativaAssumir =
  | {
      resultado: typeof ResultadoAssumir.ASSUMIDO;
      atendimentoId: string;
      chatId: string;
    }
  | {
      resultado: typeof ResultadoAssumir.JA_ASSUMIDO_POR_VOCE;
      atendimentoId: string;
      chatId: string;
    }
  | {
      resultado: typeof ResultadoAssumir.JA_ASSUMIDO_POR_OUTRO;
      atendimentoId: string;
    }
  | { resultado: typeof ResultadoAssumir.INEXISTENTE_OU_EXPIRADO }
  | { resultado: typeof ResultadoAssumir.VENDEDOR_NAO_AUTORIZADO };

export type OpcoesRegistro = {
  ttlPendenteMs?: number;

  ttlAssumidoMs?: number;

  maxItens?: number;

  /*
   * Relógio injetável para testes.
   */
  agora?: () => number;

  /*
   * Identidades canônicas que podem assumir.
   */
  vendedoresAutorizados: () => ReadonlySet<string>;

  /*
   * Forma canônica da identidade do vendedor
   * ("" quando inválida).
   */
  normalizarVendedor: (vendedor: unknown) => string;
};

/**
 * Registro de atendimentos e lock de atribuição.
 */
export class RegistroAtendimentosVendedor {
  private readonly itens = new Map<string, RegistroAtendimento>();

  /*
   * Índice secundário: chatId -> atendimentoIds.
   */
  private readonly porChat = new Map<string, Set<string>>();

  private readonly ttlPendenteMs: number;

  private readonly ttlAssumidoMs: number;

  private readonly maxItens: number;

  private readonly agora: () => number;

  private readonly vendedoresAutorizados: () => ReadonlySet<string>;

  private readonly normalizarVendedor: (vendedor: unknown) => string;

  constructor(opcoes: OpcoesRegistro) {
    this.ttlPendenteMs = opcoes.ttlPendenteMs ?? TTL_PENDENTE_PADRAO_MS;

    this.ttlAssumidoMs = opcoes.ttlAssumidoMs ?? TTL_ASSUMIDO_PADRAO_MS;

    this.maxItens = opcoes.maxItens ?? MAX_ITENS_PADRAO;

    this.agora = opcoes.agora ?? (() => Date.now());

    this.vendedoresAutorizados = opcoes.vendedoresAutorizados;

    this.normalizarVendedor = opcoes.normalizarVendedor;
  }

  /**
   * Registra um atendimento como pendente.
   *
   * Idempotente: se já existe, nada muda.
   * Devolve true somente quando criou a entrada.
   */
  registrarPendente(atendimentoId: string, chatId: string): boolean {
    if (
      typeof atendimentoId !== "string" ||
      atendimentoId.trim() === "" ||
      typeof chatId !== "string" ||
      chatId.trim() === ""
    ) {
      console.error(
        "[Atribuição] registro rejeitado: atendimentoId ou chatId vazio.",
      );

      return false;
    }

    this.limpar();

    if (this.itens.has(atendimentoId)) {
      console.log(
        `[Atribuição] ${atendimentoId} já registrado; nada alterado`,
      );

      return false;
    }

    this.itens.set(atendimentoId, {
      atendimentoId,
      chatId,
      estado: EstadoAtendimento.PENDENTE,
      responsavel: null,
      criadoEm: this.agora(),
      assumidoEm: null,
    });

    let ids = this.porChat.get(chatId);

    if (!ids) {
      ids = new Set();

      this.porChat.set(chatId, ids);
    }

    ids.add(atendimentoId);

    this.aplicarTeto();

    console.log(`[Atribuição] ${atendimentoId} registrado como pendente`);

    return true;
  }

  /**
   * Tenta assumir um atendimento.
   *
   * IMPORTANTE: função SÍNCRONA. Não pode haver
   * await entre a leitura do responsável e a
   * gravação do vencedor. Em um único processo
   * Node.js isso garante que o primeiro vence.
   *
   * A identidade do vendedor deve vir SOMENTE do
   * remetente real do update (callback_query.from,
   * com o secret do webhook validado). Nunca de
   * nome, texto ou payload do botão.
   */
  tentarAssumir(
    atendimentoId: string,
    vendedor: string | null | undefined,
  ): TentativaAssumir {
    const numero = this.normalizarVendedor(vendedor);

    /*
     * Autorização ANTES da busca: quem não é
     * vendedor não descobre se o ATD existe.
     */
    if (numero === "" || !this.vendedoresAutorizados().has(numero)) {
      this.registrarTentativa(
        atendimentoId,
        numero,
        ResultadoAssumir.VENDEDOR_NAO_AUTORIZADO,
      );

      return { resultado: ResultadoAssumir.VENDEDOR_NAO_AUTORIZADO };
    }

    this.limpar();

    const registro = this.itens.get(atendimentoId);

    if (!registro) {
      this.registrarTentativa(
        atendimentoId,
        numero,
        ResultadoAssumir.INEXISTENTE_OU_EXPIRADO,
      );

      return { resultado: ResultadoAssumir.INEXISTENTE_OU_EXPIRADO };
    }

    if (registro.responsavel !== null) {
      if (registro.responsavel === numero) {
        this.registrarTentativa(
          atendimentoId,
          numero,
          ResultadoAssumir.JA_ASSUMIDO_POR_VOCE,
        );

        return {
          resultado: ResultadoAssumir.JA_ASSUMIDO_POR_VOCE,
          atendimentoId,
          chatId: registro.chatId,
        };
      }

      this.registrarTentativa(
        atendimentoId,
        numero,
        ResultadoAssumir.JA_ASSUMIDO_POR_OUTRO,
      );

      return {
        resultado: ResultadoAssumir.JA_ASSUMIDO_POR_OUTRO,
        atendimentoId,
      };
    }

    /*
     * Gravação do vencedor, sem await desde a leitura.
     */
    registro.estado = EstadoAtendimento.ASSUMIDO;

    registro.responsavel = numero;

    registro.assumidoEm = this.agora();

    this.registrarTentativa(atendimentoId, numero, ResultadoAssumir.ASSUMIDO);

    return {
      resultado: ResultadoAssumir.ASSUMIDO,
      atendimentoId,
      chatId: registro.chatId,
    };
  }

  /**
   * Devolve uma CÓPIA do registro (alterá-la
   * não muda o estado interno).
   */
  obter(atendimentoId: string): RegistroAtendimento | null {
    this.limpar();

    const registro = this.itens.get(atendimentoId);

    return registro ? { ...registro } : null;
  }

  /**
   * Este chatId tem atendimento ativo
   * (pendente ou assumido, não expirado)?
   */
  chatTemAtendimentoAtivo(chatId: string): boolean {
    this.limpar();

    return (this.porChat.get(chatId)?.size ?? 0) > 0;
  }

  tamanho(): number {
    this.limpar();

    return this.itens.size;
  }

  private expirado(registro: RegistroAtendimento, agora: number): boolean {
    if (registro.estado === EstadoAtendimento.ASSUMIDO) {
      return (
        registro.assumidoEm !== null &&
        agora - registro.assumidoEm >= this.ttlAssumidoMs
      );
    }

    return agora - registro.criadoEm >= this.ttlPendenteMs;
  }

  private remover(atendimentoId: string): void {
    const registro = this.itens.get(atendimentoId);

    if (!registro) {
      return;
    }

    this.itens.delete(atendimentoId);

    const ids = this.porChat.get(registro.chatId);

    if (ids) {
      ids.delete(atendimentoId);

      if (ids.size === 0) {
        this.porChat.delete(registro.chatId);
      }
    }
  }

  /*
   * Limpeza preguiçosa. Percorre tudo porque os
   * dois TTLs contam de momentos diferentes.
   */
  private limpar(): void {
    const agora = this.agora();

    let removidos = 0;

    for (const [atendimentoId, registro] of this.itens) {
      if (this.expirado(registro, agora)) {
        this.remover(atendimentoId);

        removidos++;
      }
    }

    if (removidos > 0) {
      console.log(
        `[Atribuição] ${removidos} atendimento(s) removido(s) por expiração`,
      );
    }
  }

  /*
   * Teto: descarta os mais antigos.
   */
  private aplicarTeto(): void {
    let removidos = 0;

    while (this.itens.size > this.maxItens) {
      const maisAntigo = this.itens.keys().next().value;

      if (maisAntigo === undefined) {
        break;
      }

      this.remover(maisAntigo);

      removidos++;
    }

    if (removidos > 0) {
      console.log(
        `[Atribuição] ${removidos} atendimento(s) removido(s) pelo teto`,
      );
    }
  }

  private registrarTentativa(
    atendimentoId: string,
    numero: string,
    resultado: ResultadoAssumir,
  ): void {
    /*
     * O atendimentoId virá do payload do botão:
     * só é registrado se tiver o formato esperado.
     */
    const idSeguro =
      typeof atendimentoId === "string" && /^ATD-[0-9A-F]{6}$/.test(atendimentoId)
        ? atendimentoId
        : "formato inválido";

    console.log(
      [
        "[Atribuição] tentativa de assumir",
        `atendimento: ${idSeguro}`,
        `vendedor: ${numero ? mascararTelefone(numero) : "não informado"}`,
        `resultado: ${resultado}`,
      ].join(" | "),
    );
  }
}
