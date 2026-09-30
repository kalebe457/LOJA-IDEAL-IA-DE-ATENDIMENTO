import type { IA } from "./ia.js";

import type {
  Cliente,
  ResultadoIA,
  ResumoCliente
} from "./tipos.js";

export class IAMock implements IA {

  async responder(
    mensagem: string,
    cliente: Cliente
  ): Promise<ResultadoIA> {

    const texto = mensagem.toLowerCase();

    const resumo: ResumoCliente = {
      ...cliente.resumo
    };

    if (
      texto.includes("vendedor") ||
      texto.includes("atendente") ||
      texto.includes("humano")
    ) {
      return {
        resposta:
          "Claro! Vou encaminhar seu atendimento para um vendedor da Loja Ideal.",
        status: "HUMANO",
        resumo
      };
    }

    if (texto.includes("banheiro")) {
      resumo.necessidade = "Reforma";
      resumo.ambiente = "Banheiro";

      return {
        resposta:
          "Entendi. Qual é aproximadamente o tamanho do banheiro?",
        status: "IA",
        resumo
      };
    }

    if (
      texto.includes("x") &&
      /\d/.test(texto)
    ) {
      resumo.medidas = mensagem;

      return {
        resposta:
          "Entendi as medidas. A reforma será geral ou apenas de uma parte do ambiente?",
        status: "IA",
        resumo
      };
    }

    if (
      texto.includes("geral") ||
      texto.includes("reforma geral")
    ) {
      resumo.observacoes =
        "Cliente informou que deseja uma reforma geral.";

      return {
        resposta:
          "Perfeito. Você deseja falar com um vendedor para continuar o atendimento?",
        status: "IA",
        resumo
      };
    }

    if (
      texto.includes("obra") ||
      texto.includes("construção") ||
      texto.includes("construcao")
    ) {
      resumo.necessidade = "Obra/construção";

      return {
        resposta:
          "Entendi. Qual parte da obra você está fazendo?",
        status: "IA",
        resumo
      };
    }

    return {
      resposta:
        "Claro! Pode me explicar um pouco sobre o que você precisa?",
      status: "IA",
      resumo
    };
  }
}