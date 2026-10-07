export type StatusAtendimento = "IA" | "HUMANO";

export type ResumoCliente = {
  nome: string;
  telefone: string;
  produto: string;
  quantidade: string;
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