// Auxiliar dos testes (NÃO é uma suíte): limpa o espelho de atendimentos criado pelos testes.
//
// Todas as mensagens de teste usam o phone_number_id FICTÍCIO "999", então os chat_id de
// teste começam com "meta:999:". Apaga só esses atendimentos e, depois, só os clientes que
// ficaram sem nenhum atendimento. Sem TRUNCATE.

type Consultar = (texto: string, parametros?: unknown[]) => Promise<{ rows: any[]; rowCount: number | null }>;

export const PREFIXO_CHAT_TESTE = "meta:999:";

export async function limparEspelhoDeTeste(
  consultar: Consultar,
): Promise<{ atendimentos: number; clientes: number; restantes: number }> {
  const ids = (
    await consultar("SELECT DISTINCT cliente_id FROM atendimentos WHERE chat_id LIKE $1", [PREFIXO_CHAT_TESTE + "%"])
  ).rows.map((r) => r.cliente_id);

  const atendimentos =
    (await consultar("DELETE FROM atendimentos WHERE chat_id LIKE $1", [PREFIXO_CHAT_TESTE + "%"])).rowCount ?? 0;

  const clientes =
    (
      await consultar(
        `DELETE FROM clientes
          WHERE id = ANY($1::bigint[])
            AND NOT EXISTS (SELECT 1 FROM atendimentos a WHERE a.cliente_id = clientes.id)`,
        [ids],
      )
    ).rowCount ?? 0;

  const restantes = Number(
    (await consultar("SELECT count(*) n FROM atendimentos WHERE chat_id LIKE $1", [PREFIXO_CHAT_TESTE + "%"])).rows[0]?.n ?? 0,
  );

  return { atendimentos, clientes, restantes };
}
