# Propagação de deleção — `financial_transactions` (auditoria + desenho)

**Data:** 2026-10-16 · **Status:** auditoria concluída, desenho proposto, **nada implementado** · **Escopo:** `saipos-worker` (este repo) + o que o Mise precisa fazer do lado dele.

Legenda: **[MEDIDO]** = número tirado de produção hoje, com a query/método ao lado · **[CÓDIGO]** = lido no código deste repo (arquivo:linha) · **[INFERIDO]** = conclusão razoável sem prova direta.

---

## 0. Veredito em uma tabela

| Afirmação (CLAUDE.md do Mise, 2026-07-14) | Veredito | Evidência |
|---|---|---|
| O worker nunca propaga deleção de `financial_transactions` | ✅ **VERDADEIRA** | [CÓDIGO] nenhum statement apaga/marca `financial_transactions`; [MEDIDO] varredura completa da API × espelho: **344 (ilili)** e **2.473 (sheesh)** linhas vivas no espelho que a API não devolve mais |
| Uma linha apagada na Saipos fica viva no espelho para sempre e o Mise a ingere como lançamento real | ✅ **VERDADEIRA** | [MEDIDO] das linhas sumidas da origem, **283 (ilili)** e **475 (sheesh)** são lançamentos **vivos** em `agent_finance.transactions` |
| "~202 lançamentos não pagos / R$ 262k foram atribuídos a isso" | ❌ **LEITURA ERRADA DO NÚMERO** | A spec de 07-14 chamou 202/R$262k de **superfície de exposição** ("o conjunto que um DELETE *deixaria* fantasma") — é o total de lançamentos `paid=false` na janela, **não** uma contagem de deleções. Os números reais estão no §2 |
| `financial_transactions_raw.received_at` é bumpado a cada poll → linha varrida cujo `received_at` não avançou foi deletada | ⚠️ **VERDADEIRA, MAS INSUFICIENTE** | [CÓDIGO] bump incondicional confirmado (`src/db.ts:296`). Mas o poll só varre `date ∈ [now−8d, now+6d]`: o sinal só existe para linhas **dentro** dessa janela. Deleção de linha fora da janela (passado já varrido, ou projeção futura) é **invisível** a ele — [MEDIDO] o heurístico pega 59/60 (ilili) e 233/263 (sheesh) no passado e **0** das futuras |
| A janela da API é ±15 dias; ~98 janelas cobrem 2026→2029; sweep diário cabe | ✅ **VERDADEIRA** | [MEDIDO] varredura real 2025-09-01→2030-04-01 = **112 janelas**, **82 s (ilili) / 185 s (sheesh)**, máx. **612 linhas/janela** (≤ 3 páginas) |
| Spec `docs/superpowers/specs/2026-07-14-ingestao-fatia-2-design.md` | ⚠️ **NÃO ESTÁ NO `main` DO MISE** | Existe só no commit `db81714`, branch `docs/spec-ingestao-fatia-2` — **nunca mergeada**. O CLAUDE.md cita um arquivo que quem clona o `main` não encontra |

---

## 1. O que o código faz hoje [CÓDIGO]

### 1.1 Financeiro

| Peça | Onde | Comportamento |
|---|---|---|
| Endpoint | `src/saipos/dataApi.ts:236` | `GET /v1/search_financial_transactions`, filtro `p_date_column_filter` + `[start,end]`, paginação offset/limit 300 |
| Limite 15 dias | `dataApi.ts:263` | lança erro se `end−start > 15d` (limite da Saipos) |
| Paginação | `dataApi.ts:269-283` | para quando a página vem vazia ou `< limit`; **para em silêncio** ao bater `maxPages` (sem erro — truncamento indistinguível de "acabou") |
| `extractRows` | `dataApi.ts:47` | resposta que não é array (nem `.data`/`.items`) vira **`[]` silencioso** |
| Retry | `dataApi.ts:19` | 4 tentativas só em 5xx; 4xx lança; esgotou → lança |
| Pass `date` | `financialWorker.ts:29` | `date ∈ [now−8d, now+6d]` a cada ciclo |
| Pass `updated_at` | `financialWorker.ts:13` | `updated_at ∈ [now−7d−26h, now]` a cada ciclo |
| Ciclo | env prod | `POLL_INTERVAL_MS=120000` (2 min) nos dois hosts |
| Upsert raw | `src/db.ts:281` (bump em :296) | `ON CONFLICT` → **`received_at` sempre sobrescrito** (heartbeat); `payload_hash = md5(payload)`; `normalized=false` **só se o hash mudou** |
| Normalizer | `financialNormalizer.ts`, `db.ts:411` | único escritor de `financial_transactions`; copia `received_at` do raw **no momento da normalização** → `financial_transactions.received_at` e `.updated_at` só andam quando o payload muda (**não** são heartbeat) |
| Filhos | `db.ts:520` | `DELETE` + `INSERT` de `financial_transaction_children` a cada normalização (ids novos; ninguém referencia) |
| Deleção do pai | — | **não existe**. Nenhum `DELETE`/`UPDATE … deleted` em `financial_transactions(_raw)`; migration 0013 não tem coluna de tombstone |
| Backfill | `backfillFinancialTransactionsRaw.ts` | só upsert; default começa em 2026-01-01 |

| Coluna | Significa | Serve de sinal de vida? |
|---|---|---|
| `financial_transactions_raw.received_at` | último poll em que a API devolveu a linha | ✅ sim — mas só para linhas que algum pass ainda cobre |
| `financial_transactions_raw.payload_hash` | md5 do payload; decide se renormaliza | não |
| `financial_transactions.received_at` | `received_at` do raw na última **mudança de payload** | ❌ não |
| `financial_transactions.updated_at` | `now()` na última normalização | ❌ não (foi o erro da evidência antiga de "43 linhas congeladas") |
| `financial_transactions.updated_at_source` | `updated_at` da Saipos | não |

### 1.2 Vendas (`orders` / `order_payments`)

| Peça | Onde | Comportamento |
|---|---|---|
| Janela | `worker.ts:11` | `shift_date ∈ [now−17h−INGEST_DAYS_BACK, now−17h]` (prod: 7 dias) |
| Upsert `orders_raw` | `db.ts:17` | mesmo padrão: `received_at` sempre, renormaliza só se `payload_hash` mudou |
| `orders` | `db.ts:734` | upsert por `(provider, store_id, order_id)` — **id estável** |
| `order_payments` | `db.ts:878` `replaceOrderPaymentsV2` | **`DELETE … WHERE order_row_id` + `INSERT` um a um** a cada renormalização → **ids `bigserial` novos toda vez**; as linhas antigas são **apagadas fisicamente** (não ficam órfãs) |
| `order_items` / `order_item_choices` / `order_deliveries` | `db.ts:845, 911` | mesmo padrão delete+insert |
| Deleção de pedido | — | não existe; mas venda na Saipos é **cancelada** (`canceled=Y`, a API continua devolvendo), não apagada |

**Por que os ids de `order_payments` mudam:** qualquer mudança de `payload_hash` do pedido → normalizer roda → `replaceOrderPaymentsV2` apaga e reinsere. Não é "reimport" que cria duplicata; é substituição do snapshot com ids novos.

[MEDIDO] escala do churn:

| Host | `order_payments` linhas | `order_payments_id_seq` | ids queimados por linha viva |
|---|---:|---:|---:|
| ilili | 199.381 | 3.671.181 | **~18×** |
| sheesh | 119.626 | 3.179.725 | **~27×** |

[MEDIDO] ilili, últimas 24h: **886** pedidos com `shift_date` > 2 dias atrás foram renormalizados, e em **886/886** o `updated_at` da Saipos é mais velho que 24h (a origem não registrou edição). Eles vêm em **rajada diária ~14:06 BRT** (880 pedidos na hora 14h de hoje, 269 ontem), varrendo todo o pedido da janela de 7 dias.
[MEDIDO] controle: duas leituras seguidas da mesma janela (`shift_date=2026-10-10`, 232 vendas) deram payload **idêntico** em 232/232 — não é ordenação não-determinística da API.
[INFERIDO] algum campo do payload de venda é recalculado uma vez por dia do lado da Saipos sem mexer em `updated_at`. Qual campo: **não identificado** (pergunta aberta).

[MEDIDO] deleção de pedidos: na janela ativa (ilili 1.512 pedidos, sheesh 911), **0** com `received_at` velho → **nenhuma evidência de pedido apagado na origem**.

---

## 2. Medição em produção (somente leitura)

Método: (a) SELECT no espelho via `docker exec n8n-postgres-1 psql`; (b) **varredura read-only da API** com o próprio cliente do worker (`dist/saipos/dataApi.js`, `docker exec … node -`), 112 janelas de 15 dias por `date`, 2025-09-01 → 2030-04-01, comparando o **conjunto de ids** devolvido com o espelho. Nenhuma escrita em banco, nenhum restart.

### 2.1 Linhas vivas no espelho que a API não devolve mais — **verdade de chão** [MEDIDO]

| Host | ids na API (varredura completa) | ids no espelho | **só no espelho (sumiram da origem)** | só na API |
|---|---:|---:|---:|---:|
| ilili | 14.636 | 10.661 | **344** | 4.319 (todas `date` 2025-09..12 — nunca backfilladas) |
| sheesh | 16.681 | 15.493 | **2.473** | 3.661 (3.660 em 2025-09..12 + 1 em 2030-01) |

| Host | Balde | `paid` (espelho) | Linhas | Σ `amount` | Recorrentes | `date` mín–máx |
|---|---|---|---:|---:|---:|---|
| ilili | passado | não | 60 | −R$ 60.975,37 | 35 | 2026-05-13 → 2026-10-13 |
| ilili | futuro | não | 284 | −R$ 342.537,99 | 284 | 2026-10-19 → 2029-12-30 |
| sheesh | passado | não | 239 | −R$ 567.350,15 | 207 | 2026-04-15 → 2026-10-16 |
| sheesh | passado | **sim** | 24 | −R$ 23.939,94 | 14 | 2026-01-31 → 2026-10-01 |
| sheesh | futuro | não | 2.210 | −R$ 5.675.520,31 | 2.171 | 2026-10-18 → 2029-12-28 |

Controles:
- contagem independente direto no raw (`JOIN` por `(store_id, financial_transaction_id)` sem passar por `financial_transactions`): **344** e **2.473** — bate.
- janela ativa do pass `date`: linhas com `received_at` < 10 min = **220 (ilili) / 255 (sheesh)** = exatamente o `rows=` do log do worker no mesmo minuto; as **5 / 22** restantes da janela são as que a API não devolveu.
- janela isolada 2026-07-01..15 lida da API duas vezes de forma independente: ilili 6 só-no-espelho (6/6 também no heurístico); sheesh 23 só-no-espelho (20 no heurístico — as 3 restantes foram vistas pela última vez exatamente em `date+8d`, isto é, **apagadas depois que saíram da janela**).

O padrão dominante é **série recorrente apagada** ("excluir esta e as próximas"): ex. ilili `EDILSON, PASSAGEM semana corrente` (22), `BOLETO LUZ` (6); sheesh `box boy semanal` (23), `Obra renovare` (18+11), `Passagem jefferson semanal` (16). Cada série morta deixa ~44 projeções futuras até 2029 no espelho.

### 2.2 O heurístico `received_at` sozinho [MEDIDO]

Predicado: linha cuja janela de cobertura do pass `date` (`[D−6d, D+8d]`, a partir de 2026-05-21) teve > 2 dias de polls **depois** do último `received_at`.

| Host | Heurístico | Verdade (varredura) passado | Falsos positivos | Perdidas |
|---|---:|---:|---:|---:|
| ilili | 59 | 60 | 0 | 1 + **todas as 284 futuras** |
| sheesh | 233 | 263 | 0 | 30 + **todas as 2.210 futuras** |

⇒ O heurístico é **preciso mas cego**: só enxerga deleção enquanto a linha está a ≤ 8 dias do `date`. Serve como alarme barato; **não** substitui a varredura.

### 2.3 Quanto disso o Mise ingeriu [MEDIDO]

`agent_finance.transactions` (banco `mise`), `source='saipos'`, `source_row_id = financial_transactions.id`, **com o predicado de domínio de saída** (`amount < 0 AND sale_order_row_id IS NULL`, `lib/financeiro-dominio-saida.ts`) — sem ele, `source_row_id` colide com ids de `order_payments` (ver `ingest-dominio-isolado.integration.test.ts`).

| Host | Competência | Vivo no Mise | `paid` no Mise | Linhas | Σ `amount` | `amount` bate com o espelho |
|---|---|---|---|---:|---:|---:|
| ilili | passado | **sim** | não | **38** | −R$ 15.746,71 | 38/38 |
| ilili | futuro | **sim** | não | **245** | −R$ 46.137,99 | 245/245 |
| ilili | passado | já soft-deletado | não | 22 | −R$ 45.228,66 | 22/22 |
| ilili | futuro | já soft-deletado | não | 39 | −R$ 296.400,00 | 39/39 |
| sheesh | passado | **sim** | não | **313** | −R$ 724.286,66 | 313/313 |
| sheesh | passado | **sim** | **sim** | **18** | −R$ 22.882,39 | 17/18 |
| sheesh | futuro (≤ 2026-12-31) | **sim** | não | **144** | −R$ 365.398,60 | 144/144 |

Controle: `count(DISTINCT source_row_id)` via `= ANY(array)` sem join → ilili **283 vivos / 344 total**, sheesh **475 / 475** — bate com a soma das linhas acima.

Os 61 já apagados no ilili foram limpos **à mão** pelo Marcos (`deleted_reason`: "BOLETO LUZ fantasma … 43 instâncias até 2029", "duplicidade …", etc.) — ou seja, o problema já custou trabalho manual e o modo de falha é exatamente este.

**Exposição viva hoje:** ilili **283 lançamentos / R$ 61,9k**; sheesh **475 lançamentos / R$ 1,11 mi** (dos quais 18 marcados pagos).

---

## 3. Desenho da correção no worker

### 3.1 Princípio

> Uma linha só pode ser tombstonada por **ausência em uma leitura COMPLETA** que cobre o `date` dela. Qualquer dúvida sobre a completude da leitura ⇒ **não tombstona nada**.

Isto não é teórico: na primeira tentativa de varredura do ilili hoje, a janela de 2026-03-15 tomou **504 (`PGRST003`)** e o script parou; comparar aquele resultado parcial com o espelho teria marcado **8.045 de 10.661 linhas (75%)** como apagadas. A segunda tentativa, com retry por janela, passou limpa.

### 3.2 Schema (migration `0014_financial_tombstones.sql`)

| Objeto | Coluna | Tipo | Uso |
|---|---|---|---|
| `financial_transactions_raw` | `last_swept_at` | `timestamptz` | última varredura completa em que a linha veio |
| `financial_transactions_raw` | `missing_since` | `timestamptz` | 1ª varredura completa em que **não** veio (strike 1) |
| `financial_transactions_raw` | `deleted_at_source` | `timestamptz` | tombstone confirmado (strike 2) |
| `financial_transactions` | `deleted_at_source` | `timestamptz` | espelho do tombstone (o que o Mise lê) |
| `financial_transactions` | índice parcial | `WHERE deleted_at_source IS NOT NULL` | |
| nova `financial_sweeps` | `id, started_at, finished_at, range_start, range_end, windows_total, windows_ok, rows_seen, status (running/complete/aborted), abort_reason, marked_missing, tombstoned, revived` | | auditoria; o Mise/controller pode ler "última varredura completa" |

Não usar `received_at` como critério de decisão (continua sendo bumpado pelos passes curtos); usar `last_swept_at`, que só a varredura escreve.

### 3.3 Algoritmo do sweep

| Passo | Regra |
|---|---|
| Agenda | 1×/dia (ex. 04:30 BRT), fora da rajada das 14h; loop próprio, não bloqueia os passes de 2 min |
| Faixa | `date ∈ [2025-09-01, max(date no espelho) + 31d]`, arredondado em janelas de 15d **contíguas** (`end = próximo start − 1s`, como o backfill). Hoje ≈ 112 janelas |
| Leitura | por janela, retry próprio (5 tentativas, backoff 15/30/45/60 s) além do retry interno de 5xx; `sleep 400ms` entre janelas |
| Completude da janela | falha se: exceção; resposta não-array (não aceitar o `[]` silencioso de `extractRows`); `pages == maxPages` (truncamento); qualquer linha sem `id_store`/`id_store_fin_transaction` |
| Completude do sweep | **todas** as janelas completas. Se uma falhar ⇒ `status=aborted`, **zero** tombstones nesta rodada (as linhas vistas ainda são upsertadas normalmente) |
| Upsert | toda linha vista: upsert normal no raw + `last_swept_at = sweep.started_at`, `missing_since = NULL`, `deleted_at_source = NULL` (revive) |
| Candidatas | linhas do raw com `date ∈ [range_start + 1d, range_end − 1d]` e `last_swept_at < sweep.started_at` (ou nulo) e `deleted_at_source IS NULL` |
| Strike 1 | `missing_since IS NULL` ⇒ `missing_since = sweep.started_at` (ainda **não** tombstona — protege contra paginação por offset que pula linha quando a origem muda entre páginas) |
| Strike 2 | `missing_since` setado por uma varredura **anterior** completa ⇒ `deleted_at_source = now()` no raw **e** em `financial_transactions`, na mesma transação |
| Disjuntor | se as candidatas de uma rodada passarem de `max(50, 5% das linhas vivas da faixa)` ⇒ abortar a marcação, logar alto, exigir rodada manual (`SWEEP_FORCE=1`). Hoje o sheesh teria 2.473 na **primeira** rodada — a carga inicial passa por um modo `--initial` revisado manualmente (dry-run → relatório → aplicar) |
| Dry-run | `FINANCIAL_SWEEP_MODE=off|dry_run|apply`; `dry_run` grava só em `financial_sweeps` + log com a lista |

### 3.4 Interação com os passes de 2 min

| Situação | Efeito |
|---|---|
| Pass curto vê uma linha tombstonada (reapareceu, ou `date` foi movido para dentro da janela) | upsert limpa `missing_since`/`deleted_at_source` no raw **e** força renormalização (`normalized=false`) para que `financial_transactions.deleted_at_source` volte a NULL |
| `date` editado para fora da faixa do sweep | linha some do sweep; o pass `updated_at` pega a edição (mesmo `id`, `date` novo) → payload novo → deixa de ser candidata. Faixa larga (até `max(date)+31d`) torna isso raro |
| Linha vista no pass curto entre strike 1 e strike 2 | o upsert do pass curto **não** mexe em `last_swept_at`; mas limpa `missing_since` (vista viva = não apagada). Regra simples: qualquer upsert limpa `missing_since` |

### 3.5 Custo e limites [MEDIDO]

| | ilili | sheesh |
|---|---:|---:|
| Janelas | 112 | 112 |
| Linhas lidas | 14.636 | 16.681 |
| Máx. por janela | 612 | 494 |
| Requests (≈ 1–3 páginas/janela) | ~150 | ~150 |
| Duração (sleep 400 ms) | 82 s | 185 s |
| 504 transitório observado | 1 (`PGRST003`, pool da Saipos) | 0 |

### 3.6 Testes obrigatórios (o repo não tem `test` hoje — `lint` é `console.log('ok')`)

| Caso | Esperado |
|---|---|
| janela N falha após retries | sweep `aborted`, 0 `missing_since`, 0 tombstone |
| resposta 200 não-array | janela falha |
| `pages == maxPages` | janela falha |
| linha ausente em 1 sweep completo | só `missing_since` |
| ausente em 2 sweeps completos | `deleted_at_source` no raw e no normalizado |
| reaparece (sweep ou pass curto) | ambos os campos voltam a NULL e renormaliza |
| candidatas > disjuntor | nada marcado, log de erro |
| linha com `date` fora da faixa | nunca candidata |

### 3.7 Opcional: reaproveitar o heurístico como alarme

Uma query barata (§2.2) a cada hora: linha na janela do pass `date` com `received_at` > 2h atrás ⇒ log/métrica "suspeita de deleção". Não tombstona; só antecipa o que o sweep confirmará.

---

## 4. O que o Mise precisa fazer

| # | Mudança | Onde | Regra |
|---|---|---|---|
| M1 | Ler `deleted_at_source` | `lib/financeiro-ingest.ts` (providers via `getSaiposDb` — coluna nova aparece sozinha) | — |
| M2 | Linha nova com tombstone | ingest | **não inserir** |
| M3 | Lançamento vivo cuja origem tem tombstone, mês **aberto**, `payment_date IS NULL` e sem match de conciliação bancária | ingest | **soft-delete** (`deleted_at = now()`, `deleted_reason = 'saipos: apagado na origem em <deleted_at_source> (sweep <id>)'`). **Nunca** hard delete |
| M4 | Mesmo caso, **mês fechado** | ingest | não tocar; contar como recusa nova `origem_apagada_mes_fechado` → pendência em `/financeiro/pendentes` ("reabra o mês para remover") |
| M5 | Mesmo caso, lançamento **pago** ou **conciliado** | ingest | não tocar automaticamente; pendência `origem_apagada_pago` para revisão humana (sheesh tem 18 assim) |
| M6 | Origem reaparece (tombstone limpo) e o lançamento do Mise foi apagado **pelo M3** (reconhecível pelo `deleted_reason` com prefixo da máquina) | ingest | pendência `origem_reapareceu` — **não** ressuscitar sozinho; respeita a regra atual "nunca ressuscita soft-delete" |
| M7 | Universo dos critérios (`ingestao_completa`, pendências) | `lib/financeiro-pendencias.ts` e afins | excluir `deleted_at_source IS NOT NULL` do universo da origem — senão a linha apagada vira "saída da origem sem lançamento" para sempre |
| M8 | `saipos_fdw` (controller openclaw) | `db/manual/agent_finance_fdw_setup.sql` | a foreign table tem lista de colunas congelada no `IMPORT`: re-importar `financial_transactions` depois da migration |
| M9 | Carga inicial | operação | rodar o sweep em `dry_run`, revisar a lista (ilili 283 / sheesh 475 lançamentos vivos), só então `apply`; avisar o Marcos que sheesh vai perder ~R$ 1,1 mi de contas a pagar previstas |

---

## 5. `order_payments` × deleção

| Pergunta | Resposta |
|---|---|
| O churn de ids de `order_payments` é o mesmo problema? | **Não.** Lá o worker **apaga e reinsere** (deleção dentro do pedido propaga; o id é que não é estável). No financeiro o id é estável e a deleção **não** propaga |
| O sweep financeiro muda algo em `order_payments`? | Não. Domínios separados |
| Ponto de contato | `agent_finance.transactions.source_row_id` serve aos dois espaços de id sob `source='saipos'`. Qualquer query do M3–M7 tem que usar o predicado de domínio de saída (`amount<0 AND sale_order_row_id IS NULL`) — a medição do §2.3 só bate por causa dele |
| O Mise já se defendeu do churn? | Sim: recebíveis são ancorados em `(sale_order_row_id, sale_payment_amount, sale_payment_ordinal)` (`ux_transactions_sale_anchor`), não no id de `order_payments` |
| Correção sugerida no worker (fora deste escopo) | upsert de `order_payments` por `(order_row_id, idx)` (índice único já existe) + `DELETE … WHERE idx >= n` — ids estáveis enquanto a posição não muda. E descobrir o campo que muda diariamente (§1.2) |

---

## 6. Riscos

| Risco | Mitigação |
|---|---|
| Leitura parcial da API vira tombstone em massa (aconteceu na medição de hoje) | completude por janela + sweep all-or-nothing + 2 strikes + disjuntor |
| Paginação por offset pula linha se a origem muda durante a leitura | 2 strikes em dias diferentes |
| `extractRows` aceita resposta inesperada como vazia | validar array explicitamente no caminho do sweep |
| Truncamento silencioso em `maxPages` | tratar `pages == maxPages` como falha |
| Linha com `date` movido para fora da faixa | faixa larga + pass `updated_at` revive |
| Tombstone em mês fechado mexendo no DRE | Mise não toca (M4), só sinaliza |
| Lançamento pago apagado na origem (pode ser limpeza legítima de duplicata **ou** erro na Saipos) | revisão humana (M5) |
| Primeira aplicação remove muito dinheiro previsto de uma vez (sheesh ~R$ 1,1 mi) | `dry_run` + aprovação explícita |
| Limite de pool da Saipos (`PGRST003`) | 1×/dia, `sleep` entre janelas, backoff |

---

## 7. Perguntas abertas para o dono

1. **Deleção ou outra coisa?** A API não diferencia "apagado" de "fora do filtro". Existe na Saipos algum status (ex. "cancelado", "estornado") que some do `search_financial_transactions` mas que o negócio considera vivo? (A amostra é dominada por séries recorrentes — compatível com "excluir esta e as próximas".)
2. **Os 18 lançamentos pagos do sheesh** que sumiram da origem: foram limpezas intencionais? Decide se M5 pode virar automático no futuro.
3. **2025-09 → 2025-12 nunca foi backfillado** (4.319 linhas no ilili, 3.660 no sheesh existem na API e não no espelho). Queremos? O sweep as traria de graça.
4. **O que muda diariamente às ~14:06 nos pedidos** e re-normaliza ~900 pedidos/dia sem a Saipos registrar `updated_at`? Vale capturar o diff de um payload antes/depois.
5. Sweep **1×/dia** basta, ou o caixa previsto precisa de latência menor (ex. 4×/dia, ~5 min de API por dia)?
6. Mise deve ressuscitar automaticamente quando a origem reaparece (M6) ou sempre pedir confirmação?
7. Mergear (ou apagar a referência) da spec `2026-07-14-ingestao-fatia-2-design.md`, que só existe na branch `docs/spec-ingestao-fatia-2` do Mise.
