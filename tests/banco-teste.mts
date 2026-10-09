// Auxiliar dos testes (NÃO é uma suíte): os testes usam SÓ o banco loja_ideal_teste.
//
// Carregar este módulo como a PRIMEIRA instrução da suíte, antes de qualquer import de src/:
//
//   const { exigirBancoDeTeste } = await import(new URL("./banco-teste.mts", import.meta.url).href);
//
// Ele fixa DB_NAME (o dotenv não sobrescreve variável já definida, então host, porta, usuário e
// senha continuam vindo do .env, sem cópia) e o phone_number_id fictício "999" (a recuperação na
// partida só lê os chats desse número). Depois de importar src/banco.ts, a suíte chama
// exigirBancoDeTeste(banco.consultar): se o banco conectado não for loja_ideal_teste, ABORTA.
// loja_ideal é dado REAL: nenhum teste conecta nele.

export const BANCO_TESTE = "loja_ideal_teste";

process.env.DB_NAME = BANCO_TESTE;
process.env.META_PHONE_NUMBER_ID = "999";

type Consultar = (texto: string, parametros?: unknown[]) => Promise<{ rows: any[] }>;

/**
 * O banco conectado é o de testes? (Erro de conexão: false.)
 */
export async function bancoEhDeTeste(consultar: Consultar): Promise<boolean> {
  try {
    return (await consultar("SELECT current_database() AS db")).rows[0]?.db === BANCO_TESTE;
  } catch {
    return false;
  }
}

/**
 * Aborta a suíte (exit 1) se o banco conectado não for loja_ideal_teste.
 */
export async function exigirBancoDeTeste(consultar: Consultar): Promise<void> {
  if (!(await bancoEhDeTeste(consultar))) {
    // stdout direto: várias suítes capturam o console.log.
    process.stdout.write(`ABORTADO: esta suíte só roda no banco ${BANCO_TESTE} (confira se ele existe: npm run test:db).\n`);

    process.exit(1);
  }
}
