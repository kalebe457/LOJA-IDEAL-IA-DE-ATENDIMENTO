import { consultar } from "./banco.js";

/*
 * Deduplicação persistente das MENSAGENS RECEBIDAS dos webhooks
 * (tabela eventos_processados, migration 002).
 *
 * "Já processei este evento?" — independe de atendimento: um
 * evento registrado e depois descartado por outra regra continua
 * registrado, e uma nova chegada do mesmo ID é duplicata.
 *
 * NÃO vale para statuses[] da Meta (trazem o mesmo wamid da
 * mensagem original).
 *
 * O canal OPENWA continua aceito (tipo e CHECK do banco), mas o
 * backend não produz mais eventos desse canal.
 *
 * O registro acontece ANTES do processamento: se o backend cair
 * entre o INSERT e o processamento, o evento não é reprocessado
 * quando chegar de novo. Aceito no MVP.
 */

export type CanalEvento = "META" | "OPENWA";

export type ResultadoRegistroEvento = "novo" | "duplicado";

/*
 * Tamanho da coluna mensagem_externa_id.
 */
const TAMANHO_MAXIMO_ID = 150;

/**
 * O ID cabe na tabela? IDs vazios ou maiores que a coluna
 * não são registrados (o evento segue como "sem ID externo").
 */
export function idRegistravel(mensagemExternaId: string): boolean {
  return mensagemExternaId !== "" && mensagemExternaId.length <= TAMANHO_MAXIMO_ID;
}

/**
 * Registra o evento de forma atômica pela restrição única
 * (canal, mensagem_externa_id).
 *
 * - "novo": este processo inseriu agora e deve processar;
 * - "duplicado": já existia (inclusive inserido por outra
 *   requisição concorrente); não processar.
 *
 * Qualquer erro de banco é LANÇADO: não é duplicata, e quem
 * chama não deve processar a mensagem.
 */
export async function registrarEventoRecebido(
  canal: CanalEvento,
  mensagemExternaId: string,
): Promise<ResultadoRegistroEvento> {
  const resultado = await consultar(
    `INSERT INTO eventos_processados (canal, mensagem_externa_id)
     VALUES ($1, $2)
     ON CONFLICT (canal, mensagem_externa_id) DO NOTHING
     RETURNING id`,
    [canal, mensagemExternaId],
  );

  return resultado.rowCount === 1 ? "novo" : "duplicado";
}
