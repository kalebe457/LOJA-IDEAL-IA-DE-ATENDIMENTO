# Loja Ideal IA — backend

Atendimento de clientes da Loja Ideal: WhatsApp → triagem com Claude → resumo para os
vendedores no Telegram → vendedor assume e continua a venda pelo WhatsApp dele (wa.me).

## Stack e arquitetura

- Node.js + TypeScript (ESM), executado com `tsx`. Entrada: `npx tsx src/mainwebhook.ts`
  (nome em minúsculas). Rotas: `GET/POST /meta/webhook`, `POST /telegram/webhook`, `GET /health`.
- **WhatsApp: só Meta Cloud API.** OpenWA foi removido; não existe `WHATSAPP_PROVIDER` nem
  fallback. Envio em `metaEnvio.ts`; `META_ENVIO_ATIVO=false` = só log, o fluxo segue normal.
- **Telegram: canal dos vendedores.** Resumo no grupo + botão ASSUMIR. Quem pode ser vendedor
  é decidido por `getChatMember` no grupo (member/administrator/creator), no `/start` e a cada
  clique, antes do lock. Sem lista de vendedores no `.env`.
- **PostgreSQL `loja_ideal`:** deduplicação de `messages[]` em `eventos_processados` (falha → 503)
  e espelho de cliente/atendimento (`persistenciaAtendimento.ts`). A **memória é a fonte de
  verdade**; o banco segue pelo `codigo` (`ATD-` + 10 hex). Falha no espelho só gera log.
- Migrations em `sql/` (001, 002 já aplicadas). Nunca editar migration aplicada; mudança = nova.

## Segurança (inegociável)

- **Nunca tocar no banco `betgestor`** (mesmo servidor PostgreSQL). Confirmar `current_database()`.
- **Nunca copiar, fazer backup, imprimir ou mostrar o `.env`** nem valores de tokens, secrets,
  senhas ou connection strings. Para conferir, mostrar só nomes ou tamanhos.
- Nenhuma credencial, ID real (grupo, app, número, usuário) ou dado de cliente em código,
  testes, logs ou commits. Logs mascaram telefone (`5591****1234`).
- Não chamar APIs reais (Meta, Telegram, Anthropic) para testar; ações reais só com pedido.

## Regra crítica: ordem do lote da Meta

No laço de `messages[]` em `webhook.ts`, **nenhum `await` (nem `Promise.all`) entre a iteração e
`adicionarNaFila`**. Toda persistência acontece DENTRO da tarefa da fila da conversa.
Garantido por `tests/passo3-ordem-lote.test.mts`.

## Testes

- Ficam em `tests/`; `npm test` roda `tests/run-all.mjs` (sequencial, exit ≠ 0 se algo falhar).
  Suíte nova precisa ser adicionada ao `run-all.mjs`.
- Credenciais FALSAS definidas antes dos imports; `fetch` simulado/bloqueado (só `127.0.0.1`).
  Podem ler `DB_*` do `.env` em tempo de execução, nunca copiar valores.
- Mensagens de teste usam `phone_number_id` fictício `999` → `chat_id` `meta:999:<tel fictício>`.
  IDs externos com prefixo `teste-`. Limpeza só do que o teste criou, com `DELETE` filtrado
  (`tests/limpeza-espelho.mts`); **nunca `TRUNCATE`**. Falha de banco é simulada, nunca parando
  o PostgreSQL.
- O `tsconfig.json` não tem `include`: `tsc` também checa `tests/` — manter os testes tipados.

## Como trabalhar

1. Inspecionar o código real antes de editar; se algo divergir do pedido, explicar e escolher a
   menor alteração.
2. Um passo por vez; não antecipar passos seguintes nem refatorar fora do escopo.
3. Antes de commitar: `npm test`, `npx tsc --noEmit`, `git diff --check`, conferência (só leitura)
   de que não sobraram dados de teste.
4. Commit só dos arquivos do passo (`git diff --cached --name-only`); se algo falhar, não commitar.
5. Fim de linha LF (`.gitattributes`). Commits em português, push em `origin master`.

## Plano

- Feitos: dedup persistente (3), remoção do OpenWA (4), testes versionados (4.5), espelho de
  cliente/atendimento (5a), proteção contra colisão de codigo e banco travado (5a.1) e
  estado da triagem + mensagens ENTRADA/SAIDA espelhados após cada mensagem (5b).
- Próximos: **5c** assunção (lock) no PostgreSQL · **5d** recuperação após restart.
- Antes de produção: número exclusivo da IA, URL HTTPS fixa, credencial permanente da Meta,
  política de retenção/LGPD.
