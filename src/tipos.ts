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

export type EtapaTriagem = "nome" | "produto" | "quantidade" | "observacoes";

/*
 * Estado da triagem exposto para o espelho no banco (somente leitura).
 */
export type EstadoTriagem = {
  /*
   * Pergunta aguardando resposta (null = nenhuma).
   */
  etapaAtual: EtapaTriagem | null;

  /*
   * Perguntas já feitas da primeira etapa ainda não concluída
   * (0 quando todas estão concluídas).
   */
  perguntasEtapa: number;

  /*
   * Etapas concluídas sem valor ("não sei", limite de perguntas,
   * quantidade não aplicável).
   */
  etapasPuladas: EtapaTriagem[];

  apresentacaoPendente: boolean;

  quantidadeNaoAplicavel: boolean;
};

export type Cliente = {
  telefone: string;
  status: StatusAtendimento;
  resumo: ResumoCliente;
};