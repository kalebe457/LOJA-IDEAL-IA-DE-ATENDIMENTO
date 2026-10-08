import type { Cliente, EstadoTriagem, ResultadoIA } from "./tipos.js";

export interface IA {
  responder(mensagem: string, cliente: Cliente): Promise<ResultadoIA>;

  /**
   * Desfaz o que a última resposta registrou como
   * entregue quando houve tentativa REAL de envio
   * e ela falhou.
   */
  desfazerRespostaNaoEntregue(): void;

  /**
   * Cópia do estado atual da triagem (para o espelho no banco).
   */
  estadoTriagem(): EstadoTriagem;
}
