/*
 * Horário de funcionamento da Loja Ideal.
 *
 * Toda a configuração fica aqui.
 * Feriados e folgas: fechamento manual pelo Telegram (/fechar),
 * dia inteiro em America/Belem (DIAS FECHADOS abaixo).
 */

type Expediente = {
  /*
   * "HH:MM", horário local da loja.
   */
  abre: string;

  /*
   * "HH:MM". A loja fecha neste minuto
   * (19:00 já é fechado).
   */
  fecha: string;
};

/*
 * Índice = dia da semana (0 = domingo ... 6 = sábado).
 * null = fechado o dia inteiro.
 */
type ExpedienteSemanal = readonly [
  Expediente | null,
  Expediente | null,
  Expediente | null,
  Expediente | null,
  Expediente | null,
  Expediente | null,
  Expediente | null,
];

export const FUSO_HORARIO_LOJA = "America/Belem";

export const EXPEDIENTE_LOJA: ExpedienteSemanal = [
  /* domingo */ null,
  /* segunda */ { abre: "08:00", fecha: "19:00" },
  /* terça   */ { abre: "08:00", fecha: "19:00" },
  /* quarta  */ { abre: "08:00", fecha: "19:00" },
  /* quinta  */ { abre: "08:00", fecha: "19:00" },
  /* sexta   */ { abre: "08:00", fecha: "19:00" },
  /* sábado  */ { abre: "08:00", fecha: "15:00" },
];

/*
 * Enviada uma única vez por período fechado
 * quando o cliente escreve fora do horário.
 */
export const MENSAGEM_LOJA_FECHADA =
  "Olá! No momento a Loja Ideal está fechada. Nosso horário de atendimento é de segunda a sexta, das 8h às 19h, e aos sábados, das 8h às 15h. Retornaremos durante o próximo horário de atendimento.";

/*
 * Enviada (uma vez por período) num dia fechado manualmente
 * pelo /fechar, no lugar da mensagem de fora do horário.
 */
export const MENSAGEM_DIA_FECHADO =
  "Olá! Hoje a Loja Ideal não está funcionando. Retornaremos no próximo dia de atendimento.";

/*
 * Acrescentada ao encaminhamento para o vendedor
 * quando uma triagem iniciada antes do fechamento
 * termina com a loja já fechada.
 */
export const AVISO_ENCAMINHAMENTO_FORA_DO_HORARIO =
  "Como a loja já está fechada, o vendedor dará continuidade no próximo horário de atendimento.";

const DIAS_SEMANA: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

const formatador = new Intl.DateTimeFormat("en-US", {
  timeZone: FUSO_HORARIO_LOJA,
  weekday: "short",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

type MomentoLocal = {
  /*
   * "AAAA-MM-DD" no fuso da loja.
   */
  data: string;

  diaSemana: number;

  /*
   * Minutos desde 00:00 no fuso da loja.
   */
  minutos: number;
};

function momentoLocal(instante: number): MomentoLocal {
  const partes: Record<string, string> = {};

  for (const parte of formatador.formatToParts(new Date(instante))) {
    partes[parte.type] = parte.value;
  }

  return {
    data: `${partes.year}-${partes.month}-${partes.day}`,

    diaSemana: DIAS_SEMANA[partes.weekday ?? ""] ?? 0,

    minutos: Number(partes.hour) * 60 + Number(partes.minute),
  };
}

/*
 * Dias fechados manualmente ("AAAA-MM-DD", dia de Belém). A memória é
 * a fonte de verdade; o banco (tabela fechamentos) só a recarrega na
 * partida. Cada fechamento vale o dia inteiro e acaba sozinho à
 * meia-noite (a data muda).
 */
const diasFechados = new Set<string>();

export function definirDiasFechados(datas: Iterable<string>): void {
  diasFechados.clear();

  for (const data of datas) {
    diasFechados.add(data);
  }
}

export function adicionarDiaFechado(data: string): boolean {
  const novo = !diasFechados.has(data);

  diasFechados.add(data);

  return novo;
}

export function removerDiaFechado(data: string): boolean {
  return diasFechados.delete(data);
}

/**
 * Dias fechados de "desde" (AAAA-MM-DD) em diante, em ordem.
 */
export function listarDiasFechados(desde: string): string[] {
  return [...diasFechados].filter((data) => data >= desde).sort();
}

/**
 * Aviso para quem escreve com a loja fechada: dia fechado
 * manualmente (o dia inteiro) tem mensagem própria; fora do
 * horário normal, a mensagem com o horário de atendimento.
 */
export function mensagemLojaFechada(instante = Date.now()): string {
  return diasFechados.has(momentoLocal(instante).data) ? MENSAGEM_DIA_FECHADO : MENSAGEM_LOJA_FECHADA;
}

/**
 * Data ("AAAA-MM-DD") do instante no fuso da loja.
 */
export function dataLocal(instante = Date.now()): string {
  return momentoLocal(instante).data;
}

function paraMinutos(horario: string): number {
  const [hora, minuto] = horario.split(":");

  return Number(hora) * 60 + Number(minuto);
}

/**
 * Indica se a loja está aberta no instante informado.
 */
export function lojaAberta(instante = Date.now()): boolean {
  const local = momentoLocal(instante);

  const expediente = EXPEDIENTE_LOJA[local.diaSemana];

  if (!expediente || diasFechados.has(local.data)) {
    return false;
  }

  return (
    local.minutos >= paraMinutos(expediente.abre) &&
    local.minutos < paraMinutos(expediente.fecha)
  );
}

/**
 * Identifica o período fechado atual pela data
 * ("AAAA-MM-DD") da próxima abertura.
 *
 * Todas as mensagens entre um fechamento e a
 * abertura seguinte recebem a mesma chave.
 */
export function chavePeriodoFechado(instante = Date.now()): string {
  const hoje = momentoLocal(instante);

  const expedienteHoje = EXPEDIENTE_LOJA[hoje.diaSemana];

  if (expedienteHoje && !diasFechados.has(hoje.data) && hoje.minutos < paraMinutos(expedienteHoje.abre)) {
    return hoje.data;
  }

  /*
   * Próximo dia com expediente que não esteja fechado manualmente
   * (vários fechamentos seguidos são um período só).
   */
  for (let dias = 1; dias <= 400; dias++) {
    const dia = momentoLocal(instante + dias * 24 * 60 * 60 * 1000);

    if (EXPEDIENTE_LOJA[dia.diaSemana] && !diasFechados.has(dia.data)) {
      return dia.data;
    }
  }

  /*
   * Sem nenhum dia de expediente configurado.
   */
  return "sem-expediente";
}
