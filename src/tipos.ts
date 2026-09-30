export type StatusAtendimento = "IA" | "HUMANO";

export type ResumoCliente = {
  nome: string;
  telefone: string;
  necessidade: string;
  ambiente: string;
  medidas: string;
  produto: string;
  quantidade: string;
  prazo: string;
  observacoes: string;
};

export type ResultadoIA = {
  resposta: string;
  status: StatusAtendimento;
  resumo: ResumoCliente;
};

export type Cliente = {
  telefone: string;
  status: StatusAtendimento;
  resumo: ResumoCliente;
};