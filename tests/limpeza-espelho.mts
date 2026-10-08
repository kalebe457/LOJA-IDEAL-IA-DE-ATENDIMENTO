// Auxiliar dos testes (NÃO é uma suíte): limpa o espelho de atendimentos criado pelos testes.
//
// Todas as mensagens de teste usam o phone_number_id FICTÍCIO "999", então os chat_id de
// teste começam com "meta:999:". Apaga só as mensagens e os atendimentos desses chats e, depois,
// só os clientes e vendedores que ficaram sem nenhum atendimento. Vendedores criados pelos testes
// do 5c usam telegram_user_id na faixa FICTÍCIA reservada abaixo. Sem TRUNCATE.
// Ordem por causa das FKs (RESTRICT): mensagens → atendimentos → clientes/vendedores.

type Consultar = (texto: string, parametros?: unknown[]) => Promise<{ rows: any[]; rowCount: number | null }>;

export const PREFIXO_CHAT_TESTE = "meta:999:";

// Faixa de telegram_user_id dos vendedores de teste (fictícia).
export const VENDEDOR_TESTE_MIN = 990_000_000_000;
export const VENDEDOR_TESTE_MAX = 990_000_999_999;

export async function limparEspelhoDeTeste(
  consultar: Consultar,
): Promise<{ atendimentos: number; clientes: number; vendedores: number; restantes: number }> {
  const ids = (
    await consultar("SELECT DISTINCT cliente_id FROM atendimentos WHERE chat_id LIKE $1", [PREFIXO_CHAT_TESTE + "%"])
  ).rows.map((r) => r.cliente_id);

  const idsVendedores = (
    await consultar("SELECT DISTINCT vendedor_id FROM atendimentos WHERE chat_id LIKE $1 AND vendedor_id IS NOT NULL", [
      PREFIXO_CHAT_TESTE + "%",
    ])
  ).rows.map((r) => r.vendedor_id);

  // mensagens primeiro: FK RESTRICT para atendimentos.
  await consultar(
    "DELETE FROM mensagens WHERE atendimento_id IN (SELECT id FROM atendimentos WHERE chat_id LIKE $1)",
    [PREFIXO_CHAT_TESTE + "%"],
  );

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

  const vendedores =
    (
      await consultar(
        `DELETE FROM vendedores
          WHERE (id = ANY($1::bigint[]) OR telegram_user_id BETWEEN $2 AND $3)
            AND NOT EXISTS (SELECT 1 FROM atendimentos a WHERE a.vendedor_id = vendedores.id)`,
        [idsVendedores, VENDEDOR_TESTE_MIN, VENDEDOR_TESTE_MAX],
      )
    ).rowCount ?? 0;

  const restantes = Number(
    (await consultar("SELECT count(*) n FROM atendimentos WHERE chat_id LIKE $1", [PREFIXO_CHAT_TESTE + "%"])).rows[0]?.n ?? 0,
  );

  return { atendimentos, clientes, vendedores, restantes };
}
