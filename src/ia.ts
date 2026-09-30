import type {
  Cliente,
  ResultadoIA
} from "./tipos.js";

export interface IA {
  responder(
    mensagem: string,
    cliente: Cliente
  ): Promise<ResultadoIA>;
}