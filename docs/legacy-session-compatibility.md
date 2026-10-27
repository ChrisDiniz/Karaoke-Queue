# Prioridade 5 — compatibilidade de pendências sem sessão

## Diagnóstico confirmado

O schema SQLite atual (versão 4) permite `entries.session_id` nulo. `database.ts` retorna como fila ativa toda pendência cujo vínculo coincide com `app_state.current_session_id` **ou é nulo**; pendências com outro vínculo são devolvidas no histórico para permanecerem arquivadas. `debutTurnIds()` em `queue-rules.ts` só classifica como estreia pendências cujo `sessionId` coincide exatamente com a sessão ativa. Assim, a leitura podia expor um registro sem sessão na fila enquanto a regra de estreia o ignorava.

O fluxo antigo de armazenamento em `localStorage` mantinha uma única fila e não tinha sessões; a migração cria a sessão inicial no carregamento. Perfis SQLite com sessões, porém, podem conter nulos sem guardar a origem ou a sessão anterior. O schema não registra versão do escritor por linha. `inserted_at` e `queue_order` não provam a sessão e não resolvem sessões que atravessam a meia-noite ou duram vários dias.

## Critérios do reparo

O reparo ocorre durante a preparação de `loadDraft()`, antes da publicação e da gravação confirmada pelo repositório:

1. Se não existe nenhum registro de sessão, trata-se do formato antigo de fila única: cria-se a sessão inicial e vinculam-se a ela as pendências ativas e o histórico que ainda não tinha sessão.
2. Se há sessões, só se carrega como operacional e vincula uma pendência nula quando seu ID está explicitamente referenciado pelo estado operacional persistido: Vez atual, próximo turno, prioridade legada, posição fixada ou prefixo congelado. A sessão precisa existir e estar aberta.
3. Pendências nulas sem essas referências permanecem com `sessionId = null` e são preservadas em histórico como pendências arquivadas. Não são ativadas na nova sessão nem recebem classificação de estreia ou estatísticas por inferência. O schema atual não permite resolver sua origem com segurança; o diagnóstico é registrado pelo canal de logs existente.

Data civil, proximidade temporal, ordem de sessão e `queue_order` isoladamente nunca determinam o vínculo. Sessões encerradas não são elegíveis. Nenhum histórico de conclusão é criado e `regularsSinceDebut` não é alterado pelo reparo.

## Ordem e idempotência

O reparo só atualiza `sessionId` no objeto das entradas comprovadas. IDs, músicas, mesa, cantor, timestamp, ordem da fila, estado de Vez atual, pins, congelamento e cadência são mantidos. Pendências incertas deixam a fila operacional e passam a histórico pendente, conservando os dados originais. Não há chamada de `getPlayOrder()` para gravar nem reconstrução do Round Robin. Uma entrada vinculada na primeira carga deixa de corresponder ao critério nulo nas seguintes, tornando a ação idempotente.

O candidato inteiro passa pela arquitetura existente **preparar → confirmar SQLite → publicar**. O salvamento usa a transação diferencial já existente; o `session_id` alterado é persistido junto ao snapshot. Falha no commit não publica o candidato, e a reconciliação/recovery do repositório existente continua valendo. Não há alteração de schema, IPC ou `queueOrderPolicyVersion`.

## Limitações

Instalações com sessões registradas e pendências nulas não referenciadas por controles persistidos permanecem ambíguas. Elas não são descartadas nem associadas automaticamente e não aparecem como trabalho operacional ativo. O estado atual não tem metadados suficientes para distinguir essas linhas de dados pertencentes a sessões anteriores. Resolver individualmente esses casos exigiria evidência externa ao schema atual.

## Validação

Os testes unitários cobrem a ausência total de sessões, referências ativas, nulos ambíguos, preservação de pins/congelamento/cadência e reinício. Um teste com SQLite real verifica os valores diretamente antes/depois, incluindo IDs e conteúdo, e reabre a aplicação para validar idempotência. Não foram alteradas as regras do Round Robin nem da cadência.
