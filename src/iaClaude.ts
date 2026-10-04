import "dotenv/config";

import Anthropic from "@anthropic-ai/sdk";

import { jsonSchemaOutputFormat } from "@anthropic-ai/sdk/helpers/json-schema";

import type { IA } from "./ia.js";

import type {
  Cliente,
  ResultadoIA,
  ResumoCliente,
  StatusAtendimento,
} from "./tipos.js";

const MODELO = "claude-sonnet-5-5";

const NAO_INFORMADO = "Não informado";

const INATIVIDADE_MS = 20 * 60 * 1000;

const client = new Anthropic();

/*
 * Ordem da triagem.
 */
const ORDEM_ETAPAS = [
  "nome",
  "necessidade",
  "ambiente",
  "produto",
  "medidas",
  "quantidade",
  "prazo",
  "observacoes",
] as const;

type EtapaTriagem = (typeof ORDEM_ETAPAS)[number];

/*
 * Schema utilizado pelo Claude.
 *
 * O telefone não é controlado pelo Claude.
 */
const SCHEMA = {
  type: "object",

  properties: {
    resposta: {
      type: "string",

      description:
        "Mensagem que seria adequada ao cliente. Escreva em português, de forma simpática, natural e objetiva. Faça no máximo UMA pergunta por mensagem. O sistema pode substituir essa resposta por uma pergunta fixa da etapa.",
    },

    status: {
      type: "string",

      enum: ["IA", "HUMANO"],

      description:
        "Campo auxiliar. O sistema controla o status final. Use IA durante a triagem e HUMANO quando o cliente pedir explicitamente atendimento humano ou houver situação de risco.",
    },

    resumo: {
      type: "object",

      properties: {
        nome: {
          type: "string",

          description:
            "Nome do cliente, somente se informado. Caso não informe ou não queira informar, use 'Não informado'.",
        },

        necessidade: {
          type: "string",

          description:
            "O que o cliente precisa comprar ou resolver. Use somente informações fornecidas pelo cliente.",
        },

        ambiente: {
          type: "string",

          description:
            "Ambiente ou local relacionado ao pedido, quando informado.",
        },

        medidas: {
          type: "string",

          description:
            "Medidas realmente informadas pelo cliente. Normalize expressões como '3 por 2 metros' para '3m x 2m'. Nunca calcule.",
        },

        produto: {
          type: "string",

          description:
            "Produto ou material explicitamente mencionado pelo cliente. Nunca recomende um produto.",
        },

        quantidade: {
          type: "string",

          description:
            "Quantidade realmente informada pelo cliente. Nunca estime.",
        },

        prazo: {
          type: "string",

          description:
            "Prazo, data ou urgência realmente informados pelo cliente. Nunca invente. Exemplos válidos: 'hoje', 'amanhã', 'sexta-feira', '6/10', 'semana que vem'.",
        },

        observacoes: {
          type: "string",

          description:
            "Informações adicionais relevantes para o vendedor. Se o cliente disser que não possui observações, use 'Nenhuma observação adicional.'.",
        },
      },

      required: [
        "nome",
        "necessidade",
        "ambiente",
        "medidas",
        "produto",
        "quantidade",
        "prazo",
        "observacoes",
      ],

      additionalProperties: false,
    },
  },

  required: ["resposta", "status", "resumo"],

  additionalProperties: false,
} as const;

const INSTRUCOES = `
Você é a assistente virtual da Loja Ideal, uma loja de material de construção.

Seu objetivo é fazer a triagem do cliente e preparar um resumo para um vendedor humano.

A TRIAGEM SEGUE ESTA SEQUÊNCIA:

1. nome
2. necessidade
3. ambiente
4. produto
5. medidas
6. quantidade
7. prazo
8. observações

REGRAS PRINCIPAIS:

- Faça no máximo UMA pergunta por mensagem.
- Não faça várias perguntas juntas.
- Não repita perguntas que já foram respondidas.
- Aproveite todas as informações que o cliente fornecer espontaneamente.
- Se uma mensagem trouxer várias informações, preencha todos os campos correspondentes.
- Não invente informações.
- Não recomende produtos.
- Não calcule quantidade de materiais.
- Não calcule área.
- Não avalie tecnicamente uma obra.
- Se o cliente não souber alguma informação, registre "Não informado".
- Se o cliente não quiser informar alguma informação, não insista e siga para a próxima etapa.
- O nome deve ser perguntado, mas o cliente não é obrigado a informar.
- As medidas devem ser tentadas, mas o cliente não é obrigado a informar.

NOME:
Tente descobrir o nome do cliente.

NECESSIDADE:
Descubra o que o cliente precisa comprar ou resolver.

AMBIENTE:
Descubra onde o material será utilizado.

PRODUTO:
Descubra qual produto ou material o cliente procura.

MEDIDAS:
Pergunte pelas medidas quando fizer sentido.

QUANTIDADE:
Pergunte qual quantidade o cliente precisa.
Se houver vários produtos, tente descobrir a quantidade de cada um.

PRAZO:
Pergunte para quando o cliente precisa dos materiais.
Aceite respostas como:
- hoje;
- amanhã;
- depois de amanhã;
- sexta-feira;
- semana que vem;
- 6/10;
- dia 15;
- urgente;
- sem pressa;
- quando puder.

OBSERVAÇÕES:
Pergunte se existe alguma observação adicional para o vendedor.

RECLAMAÇÕES:

Não transfira automaticamente para humano apenas porque o cliente reclamou.

PEDIDO DE HUMANO:

Se o cliente pedir explicitamente:
- vendedor;
- atendente;
- humano;
- alguém da loja;

o atendimento deve ser encaminhado para HUMANO.

ASSUNTOS DE RISCO:

Assuntos estruturais ou potencialmente perigosos devem ser encaminhados para humano.

Não forneça instruções técnicas perigosas.

QUANDO A TRIAGEM ESTIVER COMPLETA:

A sequência deve ser concluída.

O sistema decide quando o atendimento passa para HUMANO.

QUANDO HUMANO:

- não faça perguntas;
- não continue a triagem;
- não peça mais informações;
- informe que o atendimento será encaminhado para um vendedor da Loja Ideal.

O telefone do cliente nunca deve ser preenchido pelo Claude.
Esse campo é controlado pelo sistema.
`.trim();

type SaidaClaude = {
  resposta: string;

  status: string;

  resumo: Record<string, unknown>;
};

/**
 * Mantém o valor anterior quando o Claude devolve
 * campo vazio ou "Não informado".
 */
function normalizarCampo(novo: unknown, anterior: string): string {
  const anteriorLimpo =
    anterior.trim() === "" ? NAO_INFORMADO : anterior.trim();

  if (typeof novo !== "string") {
    return anteriorLimpo;
  }

  const novoLimpo = novo.trim();

  if (novoLimpo === "") {
    return anteriorLimpo;
  }

  const vazio =
    novoLimpo.toLowerCase() === "não informado" ||
    novoLimpo.toLowerCase() === "nao informado";

  if (vazio && anteriorLimpo !== NAO_INFORMADO) {
    return anteriorLimpo;
  }

  if (vazio) {
    return NAO_INFORMADO;
  }

  return novoLimpo;
}

/**
 * Normaliza textos para comparações.
 */
function normalizarTexto(texto: string): string {
  return texto
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s/.-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Detecta pedido explícito de humano.
 */
function pediuHumanoExplicitamente(mensagem: string): boolean {
  const texto = normalizarTexto(mensagem);

  const padroes = [
    /\bquero falar com (um )?(vendedor|atendente|humano)\b/,

    /\bquero falar com alguem\b/,

    /\bme passa (um )?vendedor\b/,

    /\bme passe (um )?vendedor\b/,

    /\bpode me passar (para )?(um )?vendedor\b/,

    /\bpode me passar (para )?(um )?atendente\b/,

    /\bquero falar com alguem da loja\b/,

    /\bpode chamar (um )?vendedor\b/,

    /\bquero atendimento humano\b/,

    /\bquero um vendedor\b/,

    /\bquero um atendente\b/,
  ];

  return padroes.some((padrao) => padrao.test(texto));
}

/**
 * Detecta assuntos potencialmente perigosos.
 */
function assuntoDeRisco(mensagem: string): boolean {
  const texto = normalizarTexto(mensagem);

  const padroes = [
    /\bderrubar parede\b/,
    /\bretirar parede\b/,
    /\bremover parede\b/,
    /\babrir parede\b/,
    /\bparede estrutural\b/,

    /\b(laje|viga|pilar)\b.*\b(derrubar|remover|quebrar|cortar|furar|alterar)\b/,
    /\b(derrubar|remover|quebrar|cortar|furar|alterar)\b.*\b(laje|viga|pilar)\b/,

    /\bpadrao de entrada\b/,
    /\btrifasico\b/,
    /\bquadro de distribuicao\b/,
    /\bfiacao de alta carga\b/,
    /\beletrica pesada\b/,
  ];

  return padroes.some((padrao) => padrao.test(texto));
}

/**
 * Detecta respostas negativas.
 */
function clienteNaoSabeOuNaoQuerInformar(mensagem: string): boolean {
  const texto = normalizarTexto(mensagem);

  const respostasNegativas = [
    "nao",
    "nao sei",
    "nao tenho",
    "nao tenho ideia",
    "nao quero informar",
    "prefiro nao informar",
    "nao quero dizer",
    "nenhum",
    "nenhuma",
    "nada",
    "sem observacoes",
    "sem observacao",
    "sem observacoes adicionais",
    "nao possui",
    "nao tenho observacoes",
    "nao tenho nenhuma",
  ];

  return respostasNegativas.some(
    (resposta) => texto === normalizarTexto(resposta),
  );
}

/**
 * Detecta respostas de encerramento das observações.
 */
function semObservacoes(mensagem: string): boolean {
  const texto = normalizarTexto(mensagem);

  const respostas = [
    "nao",
    "nao tenho",
    "nao tenho nenhuma",
    "nenhuma",
    "nenhum",
    "nada",
    "sem observacoes",
    "sem observacao",
    "sem observacoes adicionais",
    "so isso",
    "e so isso",
    "isso e tudo",
  ];

  return respostas.some((resposta) => texto === normalizarTexto(resposta));
}

/**
 * Detecta respostas que não trazem uma informação útil.
 *
 * Isso evita transformar "ok" ou "obrigada" em prazo,
 * quantidade etc.
 */
function mensagemSemInformacao(mensagem: string): boolean {
  const texto = normalizarTexto(mensagem);

  const mensagens = [
    "ok",
    "certo",
    "beleza",
    "blz",
    "ta",
    "entendi",
    "sim",
    "obrigado",
    "obrigada",
    "valeu",
  ];

  return mensagens.includes(texto);
}

/**
 * Verifica se um campo possui informação real.
 */
function campoPreenchido(valor: string): boolean {
  return valor.trim() !== "" && valor !== NAO_INFORMADO;
}

/**
 * Cria um resumo vazio para um novo atendimento.
 */
function criarResumoVazio(telefone: string): ResumoCliente {
  return {
    nome: NAO_INFORMADO,
    telefone,

    necessidade: NAO_INFORMADO,

    ambiente: NAO_INFORMADO,

    medidas: NAO_INFORMADO,

    produto: NAO_INFORMADO,

    quantidade: NAO_INFORMADO,

    prazo: NAO_INFORMADO,

    observacoes: NAO_INFORMADO,
  };
}

/**
 * Pergunta fixa de cada etapa.
 */
function perguntaDaEtapa(etapa: EtapaTriagem, resumo: ResumoCliente): string {
  switch (etapa) {
    case "nome":
      return "Para começarmos, qual é o seu nome?";

    case "necessidade":
      return "O que você precisa comprar ou resolver?";

    case "ambiente":
      return "Em qual ambiente ou local será usado esse material?";

    case "produto":
      return "Qual produto ou material você está procurando?";

    case "medidas":
      return "Você sabe as medidas do local? Se sim, poderia me informar?";

    case "quantidade":
      return campoPreenchido(resumo.produto)
        ? "Qual quantidade você precisa de cada material?"
        : "Qual quantidade você precisa?";

    case "prazo":
      return "Para quando você precisa desses materiais?";

    case "observacoes":
      return "Tem alguma observação que você gostaria de acrescentar para o vendedor?";
  }
}

/**
 * Marca etapas já preenchidas.
 */
function marcarEtapasPreenchidas(
  resumo: ResumoCliente,
  etapasConcluidas: Set<EtapaTriagem>,
): void {
  if (campoPreenchido(resumo.nome)) {
    etapasConcluidas.add("nome");
  }

  if (campoPreenchido(resumo.necessidade)) {
    etapasConcluidas.add("necessidade");
  }

  if (campoPreenchido(resumo.ambiente)) {
    etapasConcluidas.add("ambiente");
  }

  if (campoPreenchido(resumo.produto)) {
    etapasConcluidas.add("produto");
  }

  if (campoPreenchido(resumo.medidas)) {
    etapasConcluidas.add("medidas");
  }

  if (campoPreenchido(resumo.quantidade)) {
    etapasConcluidas.add("quantidade");
  }

  if (campoPreenchido(resumo.prazo)) {
    etapasConcluidas.add("prazo");
  }

  if (campoPreenchido(resumo.observacoes)) {
    etapasConcluidas.add("observacoes");
  }
}

/**
 * Encontra a próxima etapa.
 */
function encontrarProximaEtapa(
  etapasConcluidas: Set<EtapaTriagem>,
): EtapaTriagem | null {
  for (const etapa of ORDEM_ETAPAS) {
    if (!etapasConcluidas.has(etapa)) {
      return etapa;
    }
  }

  return null;
}

/**
 * Tenta aproveitar diretamente a resposta do cliente
 * para a etapa que estava sendo perguntada.
 *
 * Exemplo:
 *
 * etapa = prazo
 * mensagem = "6/10"
 *
 * resultado:
 * prazo = "6/10"
 *
 * Isso impede que a pergunta seja repetida
 * apenas porque o Claude não interpretou sozinho
 * uma resposta curta.
 */
function extrairRespostaDireta(
  etapa: EtapaTriagem,
  mensagem: string,
): string | null {
  const texto = mensagem.trim();

  if (texto === "") {
    return null;
  }

  if (clienteNaoSabeOuNaoQuerInformar(mensagem)) {
    return null;
  }

  if (mensagemSemInformacao(mensagem)) {
    return null;
  }

  switch (etapa) {
    case "nome":
      return texto;

    case "necessidade":
      return texto;

    case "ambiente":
      return texto;

    case "produto":
      return texto;

    case "medidas": {
      const pareceMedida =
        /\b\d+(?:[,.]\d+)?\s*(?:m|cm|mm)?\s*(?:x|por)\s*\d+(?:[,.]\d+)?\s*(?:m|cm|mm)?\b/i.test(
          texto,
        );

      return pareceMedida ? texto : null;
    }

    case "quantidade": {
      const pareceQuantidade =
        /\b\d+(?:[,.]\d+)?\s*(?:unidades?|unid|pecas?|peças?|gal(?:oes|ões)?|l|litros?|kg|g|sacos?|sacolas?|caixas?|metros?|m)\b/i.test(
          texto,
        );

      return pareceQuantidade ? texto : null;
    }

    case "prazo": {
      const parecePrazo =
        /\b\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?\b/i.test(texto) ||
        /\b\d{1,2}\s*de\s*(janeiro|fevereiro|marco|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro)\b/i.test(
          texto,
        ) ||
        /\b(hoje|amanha|depois de amanha|segunda|terca|quarta|quinta|sexta|sabado|domingo|semana que vem|mes que vem|esse mes|este mes|urgente|com urgencia|sem pressa|quando puder)\b/i.test(
          normalizarTexto(texto),
        );

      return parecePrazo ? texto : null;
    }

    case "observacoes":
      return texto;
  }
}

/**
 * Mensagem enviada quando o atendimento vai para humano.
 */
function gerarRespostaHumano(): string {
  return "Perfeito! Vou encaminhar seu atendimento para um vendedor da Loja Ideal, que dará continuidade.";
}

/**
 * Apresentação de início de atendimento.
 *
 * Não colocamos pergunta aqui para que o sistema
 * possa fazer exatamente UMA pergunta depois.
 */
const MENSAGEM_INICIAL =
  "Olá! Seja bem-vindo(a) à Loja Ideal-Materiais de Construção! Sou a assistente virtual e vou dar início ao seu atendimento.";

export class IAClaude implements IA {
  /**
   * Histórico completo.
   *
   * Ele nunca é apagado por causa da inatividade.
   */
  private readonly historico: Anthropic.MessageParam[] = [];

  /**
   * Posição dentro do histórico onde começou
   * o atendimento atual.
   *
   * Assim o histórico antigo continua armazenado,
   * mas não interfere na nova triagem.
   */
  private indiceInicioAtendimento = 0;

  /**
   * Estado da triagem atual.
   */
  private readonly etapasConcluidas = new Set<EtapaTriagem>();

  /**
   * Pergunta que o sistema está aguardando.
   */
  private etapaAtual: EtapaTriagem | null = null;

  /**
   * Indica se já existe um atendimento ativo.
   */
  private atendimentoIniciado = false;

  /**
   * Último momento em que houve mensagem.
   */
  private ultimaMensagemEm = 0;

  /**
   * Resumo pertencente ao atendimento atual.
   *
   * O resumo antigo não é reaproveitado
   * quando começa um novo atendimento.
   */
  private resumoAtual: ResumoCliente | null = null;

  /**
   * A apresentação ainda precisa chegar ao cliente?
   *
   * Volta a true se a resposta que a continha
   * não pôde ser enviada.
   */
  private apresentacaoPendente = false;

  /**
   * O que a última resposta registrou como entregue.
   *
   * Usado somente para desfazer quando o envio falha.
   */
  private ultimoTurno: {
    indiceResposta: number;
    incluiuApresentacao: boolean;
  } | null = null;

  /**
   * ID interno do atendimento (ATD-...),
   * usado somente na medição de tokens.
   */
  private readonly atendimentoId: string;

  constructor(atendimentoId: string) {
    this.atendimentoId = atendimentoId;
  }

  /**
   * Permite que o webhook saiba se esse atendimento
   * ficou inativo por 20 minutos.
   */
  public estaInativa(agora = Date.now()): boolean {
    if (!this.atendimentoIniciado) {
      return false;
    }

    if (this.ultimaMensagemEm === 0) {
      return false;
    }

    return agora - this.ultimaMensagemEm >= INATIVIDADE_MS;
  }

  /**
   * Inicia um novo atendimento.
   *
   * O histórico antigo continua guardado.
   */
  private iniciarNovoAtendimento(cliente: Cliente): void {
    this.atendimentoIniciado = true;

    this.indiceInicioAtendimento = this.historico.length;

    this.etapasConcluidas.clear();

    this.etapaAtual = null;

    this.resumoAtual = criarResumoVazio(cliente.telefone);

    this.apresentacaoPendente = true;
  }

  /**
   * Chamado quando houve tentativa REAL de envio
   * da última resposta e ela falhou.
   *
   * Desfaz somente o que supõe que o cliente
   * recebeu a resposta:
   *
   * - a resposta do assistente sai do histórico
   *   (a mensagem do cliente continua);
   * - nenhuma pergunta fica aguardando resposta;
   * - a apresentação volta a ficar pendente,
   *   se fazia parte da resposta.
   *
   * O resumo e as etapas concluídas são mantidos:
   * vieram do que o cliente realmente informou.
   */
  desfazerRespostaNaoEntregue(): void {
    const turno = this.ultimoTurno;

    if (!turno) {
      return;
    }

    this.ultimoTurno = null;

    const ultima = this.historico[turno.indiceResposta];

    if (
      turno.indiceResposta === this.historico.length - 1 &&
      ultima?.role === "assistant"
    ) {
      this.historico.pop();
    }

    this.etapaAtual = null;

    if (turno.incluiuApresentacao) {
      this.apresentacaoPendente = true;
    }
  }

  async responder(mensagem: string, cliente: Cliente): Promise<ResultadoIA> {
    const agora = Date.now();

    /*
     * Um novo turno começa: o anterior
     * não pode mais ser desfeito.
     */
    this.ultimoTurno = null;

    const novoAtendimento =
      !this.atendimentoIniciado || this.estaInativa(agora);

    /*
     * Começo de atendimento novo:
     *
     * - mantém histórico antigo;
     * - começa nova triagem;
     * - cria novo resumo;
     * - apresentação será enviada.
     */
    if (novoAtendimento) {
      this.iniciarNovoAtendimento(cliente);
    }

    /*
     * Garante que o telefone atual permaneça
     * controlado pelo sistema.
     */
    if (!this.resumoAtual) {
      this.resumoAtual = criarResumoVazio(cliente.telefone);
    }

    this.resumoAtual.telefone = cliente.telefone;

    const resumoBase = this.resumoAtual;

    /*
     * Guarda qual etapa estava aguardando
     * antes de processar a mensagem atual.
     */
    const etapaAnterior = this.etapaAtual;

    /*
     * Trata a resposta da pergunta anterior
     * antes de chamar o Claude.
     */
    if (!novoAtendimento && etapaAnterior) {
      if (clienteNaoSabeOuNaoQuerInformar(mensagem)) {
        this.etapasConcluidas.add(etapaAnterior);

        if (etapaAnterior === "observacoes" && semObservacoes(mensagem)) {
          this.resumoAtual.observacoes = "Nenhuma observação adicional.";
        }
      }
    }

    /*
     * Envia para o Claude somente o histórico
     * pertencente ao atendimento atual.
     *
     * O histórico antigo continua guardado,
     * mas não contamina a nova triagem.
     */
    const historicoDoAtendimento = this.historico.slice(
      this.indiceInicioAtendimento,
    );

    const contexto = [
      "Resumo atual do atendimento (JSON):",

      JSON.stringify(
        {
          nome: resumoBase.nome,

          telefone: resumoBase.telefone,

          necessidade: resumoBase.necessidade,

          ambiente: resumoBase.ambiente,

          medidas: resumoBase.medidas,

          produto: resumoBase.produto,

          quantidade: resumoBase.quantidade,

          prazo: resumoBase.prazo,

          observacoes: resumoBase.observacoes,
        },
        null,
        2,
      ),

      "",

      `Novo atendimento: ${novoAtendimento ? "SIM" : "NÃO"}`,

      "",

      `Última etapa aguardando resposta: ${etapaAnterior ?? "nenhuma"}`,

      "",

      "Mensagem atual do cliente:",

      mensagem,

      "",

      "Aproveite todas as informações fornecidas pelo cliente.",

      "Não invente informações.",

      "Não repita perguntas já respondidas.",

      "Faça no máximo uma pergunta.",
    ].join("\n");

    const resposta = await client.messages.parse({
      model: MODELO,

      max_tokens: 4096,

      system: INSTRUCOES,

      output_config: {
        effort: "medium",

        format: jsonSchemaOutputFormat(SCHEMA),
      },

      messages: [
        ...historicoDoAtendimento,

        {
          role: "user",

          content: contexto,
        },
      ],
    });

    /*
     * Medição de tokens por chamada.
     *
     * Somente dados técnicos: sem prompt,
     * resposta, histórico, telefone ou resumo.
     */
    const uso = resposta.usage;

    console.log(
      [
        "[Claude] uso",
        `atendimento: ${this.atendimentoId}`,
        `modelo: ${resposta.model}`,
        `input_tokens: ${uso.input_tokens}`,
        `output_tokens: ${uso.output_tokens}`,
        `cache_creation_input_tokens: ${uso.cache_creation_input_tokens ?? "-"}`,
        `cache_read_input_tokens: ${uso.cache_read_input_tokens ?? "-"}`,
        `service_tier: ${uso.service_tier ?? "-"}`,
      ].join(" | "),
    );

    const saida = resposta.parsed_output as SaidaClaude | null;

    if (!saida) {
      throw new Error(
        "O Claude não retornou um JSON válido no formato esperado.",
      );
    }

    const anterior = this.resumoAtual;

    /*
     * Primeiro usamos as informações identificadas
     * pelo Claude.
     */
    const resumo: ResumoCliente = {
      nome: normalizarCampo(saida.resumo.nome, anterior.nome),

      telefone: cliente.telefone,

      necessidade: normalizarCampo(
        saida.resumo.necessidade,
        anterior.necessidade,
      ),

      ambiente: normalizarCampo(saida.resumo.ambiente, anterior.ambiente),

      medidas: normalizarCampo(saida.resumo.medidas, anterior.medidas),

      produto: normalizarCampo(saida.resumo.produto, anterior.produto),

      quantidade: normalizarCampo(saida.resumo.quantidade, anterior.quantidade),

      prazo: normalizarCampo(saida.resumo.prazo, anterior.prazo),

      observacoes: normalizarCampo(
        saida.resumo.observacoes,
        anterior.observacoes,
      ),
    };

    /*
     * Agora aplicamos um fallback determinístico
     * para a etapa atual.
     *
     * Exemplo:
     *
     * Cliente responde "6/10"
     * etapa atual = prazo
     *
     * Mesmo que o Claude retorne prazo como
     * "Não informado", o sistema reconhece
     * "6/10" como prazo.
     */
    if (
      !novoAtendimento &&
      etapaAnterior &&
      !clienteNaoSabeOuNaoQuerInformar(mensagem)
    ) {
      const respostaDireta = extrairRespostaDireta(etapaAnterior, mensagem);

      if (respostaDireta !== null) {
        resumo[etapaAnterior] = respostaDireta;
      }
    }

    /*
     * Observações negativas recebem valor explícito.
     */
    if (
      !novoAtendimento &&
      etapaAnterior === "observacoes" &&
      semObservacoes(mensagem)
    ) {
      resumo.observacoes = "Nenhuma observação adicional.";

      this.etapasConcluidas.add("observacoes");
    }

    /*
     * Guarda o resumo atual dentro da instância.
     */
    this.resumoAtual = resumo;

    /*
     * Marca campos preenchidos automaticamente.
     */
    marcarEtapasPreenchidas(resumo, this.etapasConcluidas);

    /*
     * Situações especiais.
     */
    const pedidoHumano = pediuHumanoExplicitamente(mensagem);

    const risco = assuntoDeRisco(mensagem);

    /*
     * Descobre a próxima etapa.
     */
    const proximaEtapa = encontrarProximaEtapa(this.etapasConcluidas);

    const triagemConcluida = proximaEtapa === null;

    let status: StatusAtendimento = "IA";

    if (pedidoHumano) {
      status = "HUMANO";
    } else if (risco) {
      status = "HUMANO";
    } else if (triagemConcluida) {
      status = "HUMANO";
    }

    let respostaTexto = saida.resposta.trim();

    /*
     * A apresentação acompanha a primeira resposta
     * que de fato chegar ao cliente.
     */
    const incluirApresentacao = this.apresentacaoPendente;

    /*
     * Quando o atendimento é humano,
     * encerramos a etapa atual.
     */
    if (status === "HUMANO") {
      this.etapaAtual = null;

      respostaTexto = gerarRespostaHumano();

      if (incluirApresentacao) {
        respostaTexto = `${MENSAGEM_INICIAL}\n\n${gerarRespostaHumano()}`;
      }

      if (
        pedidoHumano &&
        !resumo.observacoes
          .toLowerCase()
          .includes("solicitou atendimento humano")
      ) {
        resumo.observacoes =
          resumo.observacoes === NAO_INFORMADO
            ? "Cliente solicitou atendimento humano."
            : `${resumo.observacoes} Cliente solicitou atendimento humano.`;
      }

      if (
        risco &&
        !resumo.observacoes.toLowerCase().includes("assunto de risco")
      ) {
        resumo.observacoes =
          resumo.observacoes === NAO_INFORMADO
            ? "Atendimento encaminhado para humano por envolver assunto de risco."
            : `${resumo.observacoes} Atendimento encaminhado para humano por envolver assunto de risco.`;
      }
    } else if (proximaEtapa) {
      /*
       * A pergunta é controlada pelo sistema.
       *
       * Isso impede o modelo de pular etapas
       * ou repetir uma pergunta que não corresponde
       * à etapa atual.
       */
      const pergunta = perguntaDaEtapa(proximaEtapa, resumo);

      this.etapaAtual = proximaEtapa;

      /*
       * Novo atendimento:
       * sempre apresenta a assistente antes
       * da primeira pergunta da triagem.
       */
      if (incluirApresentacao) {
        respostaTexto = `${MENSAGEM_INICIAL}\n\n${pergunta}`;
      } else {
        respostaTexto = pergunta;
      }
    }

    /*
     * Segurança para resposta vazia.
     */
    if (respostaTexto === "") {
      respostaTexto = "Pode me contar um pouco mais sobre o que você precisa?";
    }

    /*
     * IMPORTANTE:
     *
     * Guardamos exatamente o que o cliente recebeu.
     *
     * Antes estávamos guardando resposta.content,
     * que podia ser diferente da pergunta realmente enviada.
     */
    this.historico.push(
      {
        role: "user",

        content: mensagem,
      },

      {
        role: "assistant",

        content: respostaTexto,
      },
    );

    /*
     * Registra o turno para poder desfazê-lo
     * se o envio desta resposta falhar.
     */
    const apresentacaoNaResposta =
      incluirApresentacao && respostaTexto.startsWith(MENSAGEM_INICIAL);

    if (apresentacaoNaResposta) {
      this.apresentacaoPendente = false;
    }

    this.ultimoTurno = {
      indiceResposta: this.historico.length - 1,

      incluiuApresentacao: apresentacaoNaResposta,
    };

    /*
     * Atualiza o momento da última atividade
     * somente depois de finalizar o processamento.
     */
    this.ultimaMensagemEm = agora;

    return {
      resposta: respostaTexto,

      status,

      resumo,
    };
  }
}
