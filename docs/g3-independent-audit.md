# G3 — Auditoria independente — 2026-11-13

> Parecer vigente após reauditoria focal independente: **PASS**. A1–A4 confirmados corrigidos; G3 apta para checkpoint e tecnicamente apta para G4, que exige autorização própria. Produção não homologada.

## Parecer original — histórico

**FAIL; G3 não apta para checkpoint ou início G4.** G3.1 PARTIAL, G3.2 PASS no escopo inspecionado, G3.3 FAIL, G3.4 PARTIAL. Um P1 e três P2 reproduzidos. Os PASS anteriores permanecem como resultados históricos das suítes existentes; não cobriam estes contraexemplos. Nenhum defeito G2 demonstrado. Produção não homologada.

Branch `feature/remote-player-lan-integration-3`, HEAD `c36fb1d2dbd7cf17eea26ebd9c86936f0916739a`. Inspecionados arquivos rastreados e novos G3, contratos/parser, WSS, fingerprint/dispatcher, outbox/migração v8, store/backup/recovery, inbox, testes e seletores Windows. Nenhuma correção funcional aplicada: P1 deve ser delegado ao Luna. Não se iniciou G4/H nem engine/fila.

Reproducer: `npm run compile` e `node docs/evidence/g3-implementation/independent-audit-repro.cjs`, a partir da raiz. Usa SQLite real temporário, port sintético e relógio controlado `node:test`; limpa os arquivos e não abre rede. Exit 0 comprova os comportamentos defeituosos observados, não PASS dos invariantes de produto.

## A1 — P1 — Timeout libera capacidade e shutdown sem término do executor

Local: `src/operational-protocol-service.ts`, `executeAccepted`, `waitForIdle` e `close`.

Causa: `Promise.race` encerra a tarefa observada quando o timer vence. AbortSignal é cooperativo e não comprova contenção. O finally decrementa `activeExecutions` e remove a tarefa enquanto a promise original de `execute` continua pendente. `waitForIdle` e `close` deixam de observá-la.

Reprodução determinística: maxConcurrentExecutions=1; primeiro handler fica pendente em uma barreira e ignora abort; avançar relógio 10ms; waitForIdle retorna, primeira operação fica unknown, mas handler continua vivo; enviar segundo operationId. Dois handlers estão vivos simultaneamente. Não é repetição do mesmo ID nem alegação de duplicação física de playback: é violação demonstrada do limite de concorrência e do encerramento do serviço.

Impacto: BUSY deixa de conter trabalho ainda ativo, e close permite que o proprietário feche store/recursos enquanto um executor ainda os usa. Um adapter futuro não recebe garantia de exclusividade após timeout. Não é necessário implementar H para corrigir o ciclo de vida do port.

Correção mínima recomendada: separar resultado incerto do término/contensão do executor. Publicar unknown sem liberar o slot enquanto a execução original não terminar ou um port confirmar contenção; shutdown deve observar/fencear explicitamente a tarefa original. Não converter resultado tardio em completed automaticamente. Definir encerramento seguro diante de port que nunca conclui, sem alegar que abort confirmou término.

Regressão: relógio/barreira controlados; após timeout nova operação recebe BUSY e close não declara término enquanto handler permanece ativo; liberação confirmada permite novo trabalho; resultado tardio preserva unknown e dedupe.

## A2 — P2 — Snapshot não possui schema fechado de tracks

Local: `src/operational-protocol-validation.ts`, variante response snapshot.

Causa: acceptedTurn.tracks valida apenas array/count; não valida cada track, campos extras, índices, IDs, códigos ou unicidade. A união de contratos não é sustentada pelo parser.

Reprodução: substituir acceptedTurn por `{sessionId:'s',turnId:'t',packageRevision:1,tracks:[null]}` em snapshot válido. `parseOperationalMessageObject` aceita. O inbox também utiliza esse parser e pode persistir o snapshot inválido.

Impacto: consumidores recebem pacote que viola o contrato de 1–2 músicas com alvos explícitos. Não há efeito remoto não autorizado demonstrado, pois G3 não liga snapshot ao playback.

Correção mínima: reutilizar validação fechada de tracks do pacote, com occurrenceId único, trackIndex consecutivo e musicCode textual normalizado; validar coerência aplicável entre active e acceptedTurn. Testar null, campos extras, código numérico/inválido, índices/IDs duplicados e tracks válidas de uma e duas músicas.

## A3 — P2 — Snapshot avança cursor de recebimento sobre eventos ausentes

Local: `database.ts`, remoteJournal.persistSnapshot; contrato `ManagementRemoteJournalCursor.throughSequence`.

Causa: persistSnapshot atribui highWatermark ao throughSequence mesmo sem receber qualquer evento desse intervalo. Snapshot contém estado atual e resumo bounded de operações; não representa a história de eventos nem prova aplicação. O comentário do cursor mistura eventos presentes e prefixo coberto por snapshot.

Reprodução: inbox novo; persistir snapshot highWatermark=13, compactedThrough=0. Cursor retorna 13, readEvents(13,32) retorna [], mas readEvents(0,32) acusa GAP. A própria suíte existente espera o salto para 13 e não testa continuidade dos eventos necessários a H3.

Impacto demonstrado: cursor anunciado como recebido não é prefixo contíguo de eventos presentes. Usá-lo para retomar ingestão omite eventos ainda disponíveis no Player. Isso é ambiguidade concreta do contrato G3, não implementação exigida de H3.

Não foi demonstrada perda irreversível pelo fluxo atual: não existe ACK automático emitido pelo inbox. ACK de aplicação correto continuaria no cursor de negócio anterior, impedindo a compactação do Player além dele. Ausência de eventos é detectada quando a leitura começa no cursor anterior; snapshot isolado não pode recuperar EOF, cancelamentos e substituições antigos. H3 não pode usar o cursor atual como prova de aplicação ou completude.

Correção mínima: separar watermark/base de snapshot do cursor contíguo de eventos recebidos; persistir snapshot não deve afirmar recebimento de eventos ausentes. Exigir replay pelo cursor aplicado/recebido correto ou recovery explícito quando compactado. Testar snapshot recebido antes/durante replay, restart, inbox perdido/restaurado, Player já compactado e ausência de ACK/avanço de negócio com eventos faltantes.

## A4 — P2 — Outbox rejeita accepted repetido

Local: `database.ts`, remoteOutbox.recordRemoteStatus.

Causa: estados terminais idempotentes têm ramo específico, mas a tabela de transições de accepted só admite completed/rejected/unknown, excluindo accepted.

Reprodução: prepare → transmit → acceptStatus(accepted) → repetir a mesma resposta accepted. A segunda chamada lança `MANAGEMENT_OUTBOX_TRANSITION_INVALID`. SQLite permanece accepted; não houve corrupção demonstrada.

Impacto: repetição legítima de confirmação, prevista pelo transporte com retries, vira erro de consumidor. Correção mínima: reconhecer evidência repetida idêntica como idempotente e rejeitar conflitos reais. Testar accepted repetido, unknown repetido, respostas atrasadas e estados terminais conflitantes sem regredir prova já confirmada.

## Inbox, ACK e compactação

O Player autentica ACK pelo vínculo G2, exige consumerId do controller, journal local e sequência segura até highWatermark, persiste monotonicamente e rejeita consumidor revogado. ACK-of-ACK não foi inventado. A store não pode verificar remotamente que houve aplicação de negócio: isso depende do consumidor autorizado.

Não há gerador automático de ACK no inbox. O ACK usado na integração é sintético, explicitamente enviado pelo harness. Assim, recebimento isolado não libera compactação no produto atual. O pré-requisito de H3 continua aplicar evento + cursor de negócio na transação proprietária e emitir ACK só após commit. O SQLite da Gestão permite essa evolução sem transação distribuída, mas G3 ainda não fornece projeção/cursor aplicado H3 e não deve alegá-los.

Compactação Player usa mínimo dos consumidores/checkpoint/HWM, bloqueia antes de accepted/unknown e preserva tombstones. Backup antigo do Player restaura recovery-required; não libera efeitos automaticamente. Gaps e journal mismatch são detectáveis, mas perda/rollback integral da Gestão não é detectável apenas pelo banco local perdido: futuro G4/H3 precisa comparar cursor aplicado com journal/compactedThrough remoto, falhando fechado se replay estiver indisponível. Não restaurar história a partir de snapshot como se fosse prova dos eventos omitidos (A3).

## Segurança e persistência verificadas

WSS usa o endpoint G1 existente, parser lexical raw antes de JSON.parse, bounds UTF-8, schema e identidade do envelope contra peer autenticado. G1 HELLO e G2 HTTP permanecem separados. Não identificado endpoint alternativo, exposição de SQLite/segredos ao Renderer ou ligação com engine/fila nos arquivos G3. Revalidação G2 ocorre após awaits e imediatamente antes de admissão/ACK; o port de alvo síncrono continua obrigatório.

Dedupe é SQLite por identidade/operationId/fingerprint semântico; retry não troca intenção. Aceite precede executor, tombstones sobrevivem à compactação, restart trata accepted como unknown. WAL/FULL, writer exclusivo, reservas lógicas, readback e recuperação conservadora passaram nos testes focais. Isso não estabelece atomicidade entre SQLite e efeito físico. P1 A1 impede aprovar a contenção de concorrência/lifecycle do dispatcher.

## Validação e Windows

Nesta auditoria: compile PASS; quatro arquivos de testes protocolo/serviço/inbox/store PASS pelo runner Node (nenhuma falha); reproducer independente A1–A4 exit 0 com quatro contraexemplos confirmados. Regressões focais: pairing-wire 3/3, migrações 11/11 e remote-infrastructure HTTPS/WSS real 20/20 PASS. Windows e integração de dois processos não foram repetidos; suas evidências anteriores e os respectivos harnesses foram revisados. Suítes existentes passando não invalidam os reproducers.

Evidência Windows anterior revisada junto dos seletores/harnesses oficiais: checkout NTFS, Node 24.11 x64, compile, SQLite/restart/concorrência/replay, migração v8, integração OPAQUE/TLS pinado/WSS e remote-infrastructure 20/20; cleanup sem processo residual. Fingerprint informado na execução anterior `8d6b4c28fe91222ae4ba7c919e1b57223f840444365c3a1d76c65637047f8c8e`, HEAD G2 acima. É evidência histórica válida das suítes selecionadas antes desta auditoria documental; não cobre A1–A4. Windows não reexecutado nesta auditoria, pois nenhum código funcional foi modificado e os defeitos são reproduzíveis na lógica portátil. Após correções, rodar regressões focais e runner oficial direcionado; não repetir smokes G2 sem impacto.

## Encaminhamento

Delegar A1 ao Luna; corrigir A2/A3/A4 com regressões e reauditar os caminhos afetados. Não alterar G2, criptografia, quotas ou autoridade. Não iniciar G4. Arquivos desta auditoria: este relatório, reproducer e atualizações de status/evidências/roadmap/plano/proposta. Sem commit/push/PR.

## Adendo — correções de implementação A1–A4, 2026-11-13

Este adendo registra alterações feitas pelo Luna após o parecer acima. Ele não substitui a auditoria independente nem marca os achados como confirmados por um segundo revisor. O reproducer versionado agora verifica os quatro comportamentos corrigidos e terminou com exit 0.

- **A1 — resolvido pela implementação, reauditoria pendente.** `executeAccepted` mantém a execução original contada e rastreada até a Promise do handler assentar, mesmo depois de persistir `unknown` por timeout. `AbortSignal` continua sendo apenas pedido cooperativo. `waitForIdle` e `close` têm prazo explícito e retornam `blocked` com contagens quando o handler permanece ativo; só notificam encerramento depois do término observado. Testes cobrem segundo comando BUSY, retorno tardio sem substituir `unknown`, rejeição tardia, drain/shutdown bloqueados e revogação durante execução.
- **A2 — resolvido pela implementação, reauditoria pendente.** Snapshot `acceptedTurn.tracks` reutiliza o validator fechado do pacote: um ou dois itens, cada item objeto exato, occurrenceId/código canônicos, índices consecutivos únicos e occurrenceIds únicos. Fixtures/testes verificam null, parciais, campos extras, código inválido, índice/ocorrência duplicados e cardinalidade.
- **A3 — resolvido pela implementação, reauditoria pendente.** `throughSequence` significa prefixo contíguo efetivamente persistido; `highWatermark` e `snapshotHighWatermark` guardam os anúncios do Player separadamente. Snapshot não preenche o cursor. A migração Gestão `user_version=9` preserva o cursor v8 em `legacy_through_sequence`, recalcula o prefixo comprovado pelos eventos armazenados e marca `recovery_required` se o cursor antigo não puder ser sustentado. Inbox em recovery bloqueia leitura/replay; não fabrica eventos nem reduz o legado silenciosamente. H3 segue fora de escopo.
- **A4 — resolvido pela implementação, reauditoria pendente.** `recordRemoteStatus` retorna o registro para estado e detalhe semanticamente idênticos; resposta igual de `accepted` e `completed` é repetível inclusive após restart. O adapter normaliza identificadores de correlação variáveis. Resultado terminal divergente continua em conflito e não regride o estado.

Validação Linux após as correções: `npm run compile` PASS; reproducer A1–A4 PASS; store Player 18/18; protocolo 10/10; serviço/outbox 12/12; inbox Gestão 5/5; migrações 12/12; `pairing-wire` 3/3; HTTPS/WSS `remote-infrastructure` 20/20; integração operacional real entre dois processos independentes PASS. O teste de rede sandboxado foi incompleto por bloqueio de bind local e foi repetido fora do sandbox, com 20/20 PASS.

Windows nativo: runner oficial `--operational-store` PASS no checkout NTFS `C:\Users\Chris\source\karaoke-queue-g3-2`, PowerShell 5.1.26100.9711, Node 24.11 x64. Branch/HEAD verificados: `feature/remote-player-lan-integration-3` / `c36fb1d2dbd7cf17eea26ebd9c86936f0916739a`; fingerprint do snapshot final de código testado `e7db51bc7c000ebd42b0c0f151e4eaf494f03e0efe83740999f96aa505cd1776`. Compile nativo PASS; store 18/18, protocolo 10/10, serviço/outbox 12/12, inbox 5/5, migrações 12/12, integração operacional OPAQUE/TLS pinado/WSS real PASS, `remote-infrastructure` 20/20 e regressões Windows selecionadas PASS; cleanup e verificação de ausência de processo residual PASS. O primeiro intento sandboxado parou no preflight WSL com `UtilBindVsockAnyPort: socket failed 1`, antes de sincronizar; a execução oficial elevada passou sem contornar o runner.

Revisão final do diff e `git diff --check`: PASS; o único arquivo novo com espaços finais é a fixture sintética `oversized-utf8.json.txt`, cujo padding é intencional para ultrapassar o limite de bytes da entrada raw. A1–A4 estão prontos para reauditoria independente; checkpoint aguarda esse parecer; G4 não iniciada; produção não homologada.

## Reauditoria focal independente Sol — 2026-11-13 — PASS

Esta conclusão é distinta do registro de implementação do Luna. Branch e HEAD continuam `feature/remote-player-lan-integration-3` / `c36fb1d2dbd7cf17eea26ebd9c86936f0916739a`. Inspecionados código novo e rastreado, contratos, testes, transações e migração v9; nenhuma alteração funcional aplicada nesta reauditoria.

- **A1 PASS:** o timeout grava unknown e solicita abort cooperativo, mas o finally aguarda a Promise original antes de decrementar capacidade. Resolução/rejeição tardia não substitui unknown. Drenagem/close têm prazo e retornam blocked com trabalho ativo; o serviço recusa novas entradas e não fecha store nem descarta tarefas ao retornar blocked. Exceção de envio é tratada como entrega perdida. Reproduções determinísticas confirmam BUSY, shutdown bloqueado, término tardio, revogação e retry/restart sem nova execução. Um port que nunca assenta continua ocupando capacidade; o futuro proprietário H2 deve respeitar blocked antes de liberar recursos.
- **A2 PASS:** snapshot e activate-turn chamam o mesmo validator de tracks, com objetos fechados, cardinalidade 1–2, IDs/códigos canônicos, índices consecutivos e ocorrências únicas. Fixtures e negativos passam. Há uma segunda branch snapshot idêntica e inalcançável no parser (linhas 48–49): observação P3 de manutenção, sem divergência executável ou bloqueio; remoção mecânica pode ficar para manutenção posterior.
- **A3 PASS:** snapshot persiste anúncio sem avançar throughSequence; páginas só avançam após commit de eventos contíguos. Recovery bloqueia persistPage/listEvents, não é automaticamente limpo por snapshot e não gera ACK. Cursor/metadados e snapshot continuam legíveis como evidência, sem constituírem autorização. Inbox não oferece gerador de ACK; Player não consegue provar a aplicação remota. H3 deverá verificar recovery, aplicar evento e cursor de negócio atomicamente e somente então confirmar consumo. Recebimento e aplicação permanecem contratos distintos.
- **A4 PASS:** status e detalhe canônico idênticos retornam registro existente; correlação variável é removida da comparação. Conflitos continuam rejeitados, estado terminal não regride e retry conserva operationId. Restart e duplicatas accepted/completed revalidados sem mutação da fila.

**Migração v8→v9:** DDL, reconstrução do prefixo, preservação do cursor legado e user_version estão na mesma transação. Além das suítes existentes, `focal-reaudit-migration.cjs` preparou layout v8 sem as três colunas v9, injetou ABORT por trigger durante UPDATE e verificou rollback integral (schema/versão v8 e eventos preservados); removeu apenas a trigger de teste e reabriu, comprovando migração, prefixo consistente acessível e restart idempotente. É teste de falha transacional, não simulação de power-loss durante fsync. O caso inconsistente v8 é preservado e fenced por recovery_required nos testes existentes. Não há API que apague automaticamente essa marca ou invente eventos.

**Execução independente:** npm run compile PASS; reproducer versionado A1–A4 PASS; serviço/outbox 12/12, inbox 5/5, migrações 12/12, protocolo 10/10 e store 18/18 PASS, sem skips. Complemento de migração acima PASS. O reproducer atual contém assertions pós-correção; as condições pré-correção permanecem descritas no parecer original.

**Windows revisado:** relatório real `.git/karaoke-queue-last-windows-test.json` com owner oficial, status PASS, Node 24.11.0 e runId `987cdf82-82fc-4012-95a2-6d0d150a8663`; fingerprint `e7db51bc7c000ebd42b0c0f151e4eaf494f03e0efe83740999f96aa505cd1776`, branch/HEAD correspondentes. Conferidos SHA-256 de 309 arquivos atuais de src/tests/scripts/database/package contra manifesto testado, todos iguais. A evidência abrange os testes operacionais, migração v9, WSS/processos e cleanup registrados acima. Windows não repetido nesta reauditoria; novo script complementar é evidência Linux, fora daquele snapshot Windows. Atualizações posteriores de documentação não alteram o código nativo validado.

**Conclusão:** G3.1/G3.2/G3.3/G3.4 PASS; auditoria independente PASS, sem bloqueador técnico. G3 apta para checkpoint e tecnicamente apta para iniciar G4 mediante autorização específica. Riscos residuais conservadores: handler irrecuperável permanece blocked/unknown; inbox inconsistente exige recuperação explícita; perda/rollback integral da Gestão exige futura comparação remota G4/H3. Nenhum desses estados concede autoridade ou confirma efeito. G3 não está homologada para produção. Sem commit/push/PR; G4 não iniciada. git diff --check PASS.
