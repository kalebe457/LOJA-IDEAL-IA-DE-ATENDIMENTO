# Loja Ideal IA — backend

Atendimento de clientes da Loja Ideal: WhatsApp → triagem com Claude → resumo para os
vendedores no Telegram → vendedor assume e continua a venda pelo WhatsApp dele (wa.me).

## Stack e arquitetura

- Node.js + TypeScript (ESM), executado com `tsx`. Entrada: `npx tsx src/mainwebhook.ts`
  (nome em minúsculas). Rotas: `GET/POST /meta/webhook`, `POST /telegram/webhook`, `GET /health`.
- **WhatsApp: só Meta Cloud API.** OpenWA foi removido; não existe `WHATSAPP_PROVIDER` nem
  fallback. Envio em `metaEnvio.ts`; `META_ENVIO_ATIVO=false` = só log, o fluxo segue normal.
- **Resposta que não chega** (falha depois do retry, inclusive incerta): o atendimento vai para
  HUMANO e o resumo sai no grupo com o aviso ⚠️ (um por atendimento). 3 falhas seguidas em 10 min
  ou erro 190 → alerta no privado dos admins do grupo com `/start` (`alertaEnvio.ts`, no máximo 1 a
  cada 30 min; "voltaram ao normal" no 1º envio aceito). No grupo o telefone sai só mascarado.
- **Telegram: canal dos vendedores.** Resumo no grupo + botão ASSUMIR. Quem pode ser vendedor
  é decidido por `getChatMember` no grupo (member/administrator/creator), no `/start` e a cada
  clique, antes do lock. Sem lista de vendedores no `.env`. Assunção: lock em memória →
  UPDATE condicional no banco (`persistenciaAssuncao.ts`, segundo portão: se o banco já tem
  OUTRO vendedor, ele vence; falha de banco não impede) → memória → DM → edição do grupo.
- **`/ranking`** (só no privado, só administrator/creator do grupo): assumidos por vendedor no
  mês (America/Belem) e no total. Não está no menu do bot (setMyCommands não registrado).
- **`/fechar [DD/MM]`, `/abrir [DD/MM]`, `/fechamentos`** (mesma regra do `/ranking`): fechamento
  manual do dia inteiro (Belém; sem data = hoje; data já passada no ano = próximo ano). Entra em
  `lojaAberta()`: o cliente recebe a mensagem própria de dia fechado (`MENSAGEM_DIA_FECHADO`, uma por período), sem atendimento; conversa em andamento
  continua, como no fim do horário. Memória + tabela `fechamentos` (sql/004), recarregada na partida.
- **PostgreSQL `loja_ideal`:** deduplicação de `messages[]` em `eventos_processados` (falha → 503)
  e espelho de cliente/atendimento (`persistenciaAtendimento.ts`). A **memória é a fonte de
  verdade**; o banco segue pelo `codigo` (`ATD-` + 10 hex). Falha no espelho só gera log.
- Migrations em `sql/` (001 a 004 aplicadas no loja_ideal; nova migration no banco real só com autorização). Nunca editar migration aplicada; mudança = nova.

## Partida (Passo 5d)

`iniciarWebhook()`: registra o gancho da assunção → **recupera do banco** (uma leitura, só chats
`meta:<META_PHONE_NUMBER_ID>:`, limite de 30 s) → `listen` → reenvia pendências (resumos não
publicados, DMs não ENVIADAS) sem bloquear → verificações periódicas. Recupera: conversas
abertas (e assumidas com atividade < 20 min, com a IA calada); fecha as abertas inativas;
resumos dentro do TTL (o mais restrito entre `TELEGRAM_RESUMO_TTL_HORAS` e o lock de 24 h) e
os vendedores da tabela. Banco fora ou lento: aviso em destaque e sobe com a memória vazia.
O `/start` aceito grava o vendedor em `vendedores` (5d.1), então ele volta sem novo `/start`.

**Limitação conhecida:** um evento registrado em `eventos_processados` que estava na fila quando
o processo morreu se perde (o texto não é guardado e a reentrega da Meta vira "duplicada").

## Retenção de dados (LGPD)

Prazos em `src/retencao.ts` (`PRAZOS_RETENCAO`, único lugar), só para atendimentos ENCERRADOS:
mensagens (texto da conversa) apagadas **60 dias** após o encerramento; atendimento
**anonimizado 365 dias** após o encerramento (sem nome/produto/quantidade/observações, `chat_id`
`meta:anon:<codigo>`, sem cliente; ficam codigo, datas e vendedor para o `/ranking`); cliente
apagado quando nenhum atendimento aponta para ele (criado há mais de 365 dias);
`eventos_processados` apagados com **7 dias**. Vendedores não são tocados. Roda na partida e a cada
24 h, em lotes de 500. Pedido do titular: `node --import tsx scripts/apagar-cliente.mts <telefone>`
(simula) e `... --confirmar` (apaga mensagens, anonimiza atendimentos e apaga o cliente; recusa se
houver atendimento aberto). Requer a migration 003 (`cliente_id` opcional).

## Segurança (inegociável)

- **Nunca tocar no banco `betgestor`** (mesmo servidor PostgreSQL). Confirmar `current_database()`.
- **Nunca copiar, fazer backup, imprimir ou mostrar o `.env`** nem valores de tokens, secrets,
  senhas ou connection strings. Para conferir, mostrar só nomes ou tamanhos.
- Nenhuma credencial, ID real (grupo, app, número, usuário) ou dado de cliente em código,
  testes, logs ou commits. Logs mascaram telefone (`5591****1234`).
- **Log diz o que o sistema fez, nunca o que o cliente disse** (`src/logSeguro.ts`): sem texto de
  mensagem, nomes, campos do resumo, corpo de requisição/resposta ou `erro.message` de biblioteca
  (use `descreverErro`); telefone, chat_id, user_id e phone_number_id só mascarados. Garantido por
  `tests/logs-sem-dados-pessoais.test.mts` (canários).
- Não chamar APIs reais (Meta, Telegram, Anthropic) para testar; ações reais só com pedido.

## Regra crítica: ordem do lote da Meta

No laço de `messages[]` em `webhook.ts`, **nenhum `await` (nem `Promise.all`) entre a iteração e
`adicionarNaFila`**. Toda persistência acontece DENTRO da tarefa da fila da conversa.
Garantido por `tests/passo3-ordem-lote.test.mts`.

## Testes

- **Testes só em `loja_ideal_teste`; `loja_ideal` é dado real.** Toda suíte carrega
  `tests/banco-teste.mts` como PRIMEIRA instrução (fixa `DB_NAME` e o número fictício `999`
  antes de importar `src/`) e chama `exigirBancoDeTeste(banco.consultar)`: outro banco → aborta.
  Host, porta, usuário e senha continuam vindo do `.env` (que não é editado nem copiado).
- `npm run test:db` recria do zero o schema de `loja_ideal_teste` (cria o banco se não existir) e
  aplica `sql/001` e `sql/002`. Trava dupla: nome por constante + `current_database()` antes de
  qualquer DROP/CREATE. O `npm test` faz isso antes das suítes. Nunca `DROP DATABASE`.
- Ficam em `tests/`; `npm test` roda `tests/run-all.mjs` (sequencial, exit ≠ 0 se algo falhar).
  Suíte nova precisa ser adicionada ao `run-all.mjs` e carregar `tests/banco-teste.mts` primeiro.
- Credenciais FALSAS definidas antes dos imports; `fetch` simulado/bloqueado (só `127.0.0.1`).
  Podem ler `DB_*` do `.env` em tempo de execução, nunca copiar valores.
- Mensagens de teste usam `phone_number_id` fictício `999` → `chat_id` `meta:999:<tel fictício>`.
  IDs externos com prefixo `teste-`; vendedores de teste com `telegram_user_id` 990000000001+.
  Limpeza só do que o teste criou, com `DELETE` filtrado (`tests/limpeza-espelho.mts`); **nunca
  `TRUNCATE`**. Falha de banco é simulada, nunca parando o PostgreSQL. O reinício real usa o
  backend num processo filho (`tests/processo-backend-teste.mts`). Não cortar a saída de uma
  suíte com `| head`: o processo morre antes da limpeza.
- O `tsconfig.json` não tem `include`: `tsc` também checa `tests/` — manter os testes tipados.

## Como trabalhar

1. Inspecionar o código real antes de editar; se algo divergir do pedido, explicar e escolher a
   menor alteração.
2. Um passo por vez; não antecipar passos seguintes nem refatorar fora do escopo.
3. Antes de commitar: `npm test`, `npx tsc --noEmit`, `git diff --check` e conferência (só
   leitura) de que as contagens de `loja_ideal` não mudaram.
4. Commit só dos arquivos do passo (`git diff --cached --name-only`); se algo falhar, não commitar.
5. Fim de linha LF (`.gitattributes`). Commits em português, push em `origin master`.

## Plano

- Feitos: dedup persistente (3), remoção do OpenWA (4), testes versionados (4.5), espelho de
  cliente/atendimento (5a), proteção contra colisão de codigo e banco travado (5a.1) e
  estado da triagem + mensagens ENTRADA/SAIDA espelhados após cada mensagem (5b), assunção,
  resumo publicado e DM gravados no banco + `/ranking` (5c) e recuperação na partida (5d).
- Antes de produção: número exclusivo da IA, URL HTTPS fixa, credencial permanente da Meta,
  política de retenção/LGPD.
