# Evidências — implementação técnica G3.1–G3.4

> Estado vigente — reauditoria focal independente Sol em 2026-11-13: **PASS**, A1–A4 confirmados corrigidos. G3 apta para checkpoint e tecnicamente apta para G4 mediante autorização própria. Produção não homologada. Histórico e limites em [relatório independente](../../g3-independent-audit.md).

Data: 2026-11-13. Escopo: contratos kq-operation/1, validação raw no WSS, journal operacional SQLite Main-only, dispatcher/outbox, replay/ACK/cursor e compactação conservadora. Sem execução de playback, fila operacional alternativa, reconexão automática ou aprovação de produção.

## Implementado

- src/operational-protocol-contracts.ts: versões independentes do transporte, limites, erros, discriminadores, alvos, comandos, tipos de eventos e mensagem discriminada.
- src/operational-protocol-validation.ts: validação fechada de envelopes/corpos, IDs opacos sem UUID obrigatório, alvos, códigos de cinco dígitos, campos extras, null/tipos, números seguros, bounds de arrays/UTF-8, profundidade e chaves perigosas. Parser raw lexical rejeita chaves duplicadas antes de qualquer JSON.parse convencional no caminho WSS.
- tests/fixtures/operational-v1/: envelopes válidos de todas as famílias, 13 eventos discriminados, fixtures negativas, JSON raw duplicado e arquivo UTF-8 acima do limite.
- tests/operational-protocol.test.ts: valida fixtures e rejeições incluindo duplicatas com chave JSON escapada equivalente.

IDs sintéticos incluem LOG-1762900000000-AB12, formato utilizado pelo Management, IDs UUID compatíveis e identificadores opacos do Player. Códigos 01001/00042 preservam zeros. Nenhum dado de usuário/segredo real está nas fixtures.

## Validação executada

- npm run compile: PASS.
- npm run test:unit:operational-protocol: PASS, 8 testes.
- node build/tests/pairing-wire.test.js: PASS, 3 testes.
- node build/tests/remote-infrastructure.test.js, com loopback permitido: PASS, 20/20. Inclui handshake TLS/WSS, autenticação, identidade, transporte e rejeição/dispatch dos casos operacionais inválidos.
- node scripts/run-windows-native-tests.cjs --remote-infrastructure --approve-untracked: NOT RUN; interop Windows PASS, mas o runner não encontrou clone Windows isolado em volume NTFS.
- git diff --check: PASS.

## Ingresso WSS comprovado

No handler WSS em src/remote-transport.ts, cada frame de texto passa por limite de bytes e pela varredura lexical assertNoDuplicateJsonKeys antes de JSON.parse. Após o hello de transporte G1, qualquer mensagem com messagePort configurado deve passar parseOperationalMessageObject e ter deviceId/controllerId iguais à identidade Player e ao peer autorizado antes da revalidação isCurrent e do dispatch. Mensagens inválidas fecham 1007 (identidade divergente 1008); excedente fecha 1009. Sem messagePort o canal fecha 1008 e não há despacho. O handshake G1 continua no caminho existente antes de operacional; pareamento G2 usa seus endpoints HTTP sem alteração.

A integração WSS real valida positivo e negativo: envelope válido chega ao port; duplicata no envelope, em body e no objeto de track dentro de array, JSON malformado, formato operacional inválido e identidade divergente não chegam ao port; payload UTF-8 acima do máximo fecha 1009. O teste confirma número de dispatches inalterado após rejeições. G3.1 não contém writer/journal, portanto não existe persistência operacional que possa ser alterada por essas entradas.

## Causa da falha anterior e Windows

Na rodada inicial G3.1, a reprodução sandboxada obteve listen EPERM ao bindar 127.0.0.1. Os marcadores de falha foram nos cenários transport denies control, transport rejects incompatible hello, WSS admission/revocation, HTTPS routes, pinned client, close racing listen e shutdown racing authorization. A execução ultrapassou 30 s antes do sumário final; o reproducer direto confirmou que a causa era listen EPERM. Fora do sandbox, os mesmos cenários e os dois casos MainRemoteRuntime encerraram normalmente. Fora do bloqueio de loopback, a suíte completa encerrou em cerca de 4 s com 20/20 PASS. Naquela rodada, o runner Windows não encontrou checkout NTFS; a validação nativa posterior da G3.2 está registrada abaixo.
## Evidências G3.2 — journal operacional

`src/player-operational-store.ts` implementa `node:sqlite` em Main, sem dependência nativa adicional. Schema `user_version=1` e `application_id=KQOP`: `journal_meta`; `operations`; `operation_tombstones` imutáveis; `events` com sequência global/causação; `consumer_cursors`; `checkpoints`. Índices cobrem status/sequence e causação. WAL, `synchronous=FULL`, `busy_timeout`, `wal_autocheckpoint=1000`, exclusive locking e `BEGIN IMMEDIATE` mantêm writer único e transações curtas.

Aceite grava tombstone, operação, evento de aceite e reservas numa transação; receipt só retorna após commit. Fingerprint canônico ignora `messageId`; mesmo ID/conteúdo retorna receipt, conteúdo diferente conflita. Finalização persiste evento(s), status/tombstone e libera reserva atomicamente. Evento append é deduplicado por conteúdo/caução; páginas validam continuidade e envelope bounded. Nenhuma API executa playback, altera fila ou chama engine.

Store inexistente só é criado com bootstrap explícito e marcador de identidade; store anteriormente pronto que some, schema incompatível, corrupção ou recovery marker falham fechados sem recriar/sobrescrever. Restart marca operações accepted como unknown com eventos de incerteza duráveis; não repete efeitos. Falha de escrita exige readback por chave/fingerprint; falha de readback grava recovery-required quando possível e bloqueia operações. Revogação grava metadado histórico, sem remover eventos/operações/tombstones. Restore usa diretório novo, valida manifesto SHA-256, integridade/schema/application-id e sempre mantém recovery-required; cursor externo adiantado ou de outra linhagem é registrado e não libera a store.

### Medição das quotas

Carga sintética derivada de fixtures operacionais reais G3.1, com uma intenção concluída por operação: tombstone + operation + evento de aceite + resultado terminal. WAL/FULL, commit em lotes de 100, autocheckpoint 1.000 páginas. Bytes lógicos contam os valores UTF-8 persistidos, sem overhead SQLite/índices/WAL.

| Operações | Registros | Lógico (bytes) | DB (bytes) | WAL (bytes) | DB+WAL (bytes) |
|---:|---:|---:|---:|---:|---:|
| 1.000 | 4.000 | 1.225.967 | 4.096 | 2.908.752 | 2.912.848 |
| 10.000 | 40.000 | 12.468.986 | 18.178.048 | 4.408.432 | 22.586.480 |
| 100.000 | 400.000 | 126.789.005 | 188.538.880 | 4.433.152 | 192.972.032 |

Envelopes de command G3.1: média 449 bytes/máximo 582; bodies: 297/426. Envelopes event: 380/482; bodies: 229/331. Índices via `dbstat` aos 100k: aproximadamente 34.209.792 bytes, 18,1% do DB principal. `wal_checkpoint(TRUNCATE)` reduziu WAL a zero e `integrity_check` ficou `ok`.

**Quotas adotadas:** 256 MiB lógicos e 1.000.000 registros totais, sendo linhas de operação, tombstone, evento e checkpoint. Registros reservados entram no teste de admissão. Na distribuição medida, 256 MiB são alcançados perto de 211.600 operações/846.400 linhas antes da quota de registros. Um milhão de operações não é suportado por esses limites; projeção linear seria ~1,27 GB lógico e ~1,89 GB de DB principal. No teto lógico, estima-se ~400 MB DB principal, ~5 MB WAL e ~400 MB de backup. Planejar ~0,8 GB livre durante backup no limite; restore simultâneo pode aproximar 1,2 GB com store e cópias. Projeções são estimativas, não garantias físicas.

Reserva por `activate-turn`: 8 eventos até 8 KiB cada + 512 bytes de margem; demais commands: 2 eventos. Quota não pode impedir terminal lógico já reservado; reserva não pré-aloca disco. `max_page_count` simula indisponibilidade de espaço SQLite; volume físico não foi saturado. Em falha física, status não é confirmado sem readback, podendo exigir recovery.

### Testes e Windows

- `npm run compile`: PASS Linux e runner oficial Windows.
- `node build/tests/player-operational-store.test.js`: 14/14 PASS Linux e Windows nativo (Node 24.11 x64), com SQLite real, restart, dedupe/fingerprint, disputas, morte abrupta antes/durante/depois do COMMIT, reservas, falta de espaço simulada, readback inconclusivo, backup/WAL, corrupção/schema, restore com cursor adiantado, revogação e cursores.
- `node build/tests/operational-protocol.test.js`: 8/8 PASS Linux e Windows.
- `node build/tests/remote-infrastructure.test.js`: 20/20 Linux fora do sandbox e Windows, incluindo HTTPS/WSS real. `node build/tests/pairing-wire.test.js`: 3/3 PASS Linux.
- `node scripts/windows-native-runner.test.cjs`: 40/40 PASS.
- Runner Windows: checkout NTFS isolado `C:\Users\Chris\source\karaoke-queue-g3-2`, criado de bundle Git local; branch `feature/remote-player-lan-integration-3`, HEAD `c36fb1d2dbd7cf17eea26ebd9c86936f0916739a`, fingerprint da execução `c423ad369076823d37b92ecd4707335265acf1fc2cc7a3c9b1d702d2ce27f7b0`; snapshot/build/tests/cleanup PASS. Ambiente validado: PowerShell 5.1, Node 24.11 x64, npm 11.6.1. O scanner remoto de WSS revelou que o evento `WS_ERR_UNSUPPORTED_MESSAGE_LENGTH` acionava `terminate()` após o `ws` já iniciar close 1009; o cliente via 1006. A correção preserva o close frame. Teste WSS 20/20 PASS no Windows após ajuste.

A barreira “durante COMMIT” pausa pelo authorizer SQLite enquanto o comando SQL está sendo processado/preparado e mata o processo antes da decisão nativa final. Não simula power-loss dentro de um syscall de flush. O teste de falha de espaço usa `max_page_count`, não saturação física do filesystem. Esses limites não são apresentados como garantias além do comportamento transacional do SQLite/WAL/FULL.

## G3.3 — dispatcher e outbox

`src/operational-protocol-service.ts` conecta o contrato operacional ao `RemoteTransportMessagePort` do WSS e à `RemoteAuthorizationPort` G2. O port valida hello/ready, IDs, schema e vínculo vigente; revalida autorização após awaits e imediatamente antes da escrita. Admissões são serializadas por instância com fila/executores limitados. Fencing compara playerEpoch/controlEpoch e consulta um `isTargetCurrent` síncrono; sem leitura do estado autoritativo os comandos novos são rejeitados. O executor existe como port tipado sintético; não foi conectado a playback, sequência, fila ou prioridades. Aceite persistido precede execução; `unknown` nunca é retomado como efeito.

`src/management-remote-outbox.ts` grava a intenção antes de transmitir, mantém `not-sent/rejected/accepted/completed/unknown`, verifica identidade/fingerprint e disponibiliza intenção recuperável e consulta de status. Antes do primeiro envio grava `unknown`; retries mantêm operationId e conteúdo, com novo messageId. A resposta positiva de `socket.send` seria apenas enfileiramento local e não altera o status. Persistência fica no banco de Gestão existente, schema v7, migration aditiva testada; não foi criado outro SQLite.

A integração `scripts/pairing-process-integration.test.cjs --operational` usa dois processos na mesma máquina, pairing OPAQUE G2, certificado TLS pinado, bearer ativo e WSS real. Perde as respostas no consumidor Gestão, repete o ID e consulta resultado completed; a contagem no Player comprova uma execução sintética. Serviço/outbox 8/8; protocolo 9/9; banco/migração 11/11; store 14/14; remote-infrastructure 20/20; pairing-wire 3/3; runner unitário 40/40; compile PASS Linux. O teste de processo passou com rede local habilitada. Não é validação de duas máquinas nem auditoria criptográfica.

Durante G3.3 foi corrigida uma inconsistência de schema: status not-found agora exige fingerprint/result/eventSequence nulos, pois não há fingerprint de comando ausente. Variantes existentes continuam exigindo fingerprint real.

## Não implementado

Execução de playback, regras da fila, reconciliação/reconexão G4, UI/pairing presentation G5, homologação G6 e operações H. G3 usa a infraestrutura WSS/G2 sem habilitar pairing de produção.

## Fechamento G3.4 e validação final — 2026-11-13

O fechamento técnico está descrito na [proposta T2/G3](../../g3-1-operational-protocol-proposal.md) e no ticket G3. A implementação reutiliza um único journal Player: ACK autenticado e monotônico, replay contíguo paginado, snapshot/checkpoint validado e compactação limitada por consumidores, checkpoint, high-watermark e operações pending/unknown. Tombstones permanecem para dedupe. A Gestão persiste inbox/cursor recebido em transação, mas esse cursor não prova aplicação na fila/histórico; H3 deverá persistir aplicação de domínio e cursor atomicamente antes de emitir ACK.

Validação Linux: `npm run compile`; store 18/18; serviço/ACK/checkpoint 9/9; inbox Gestão 3/3; protocolo 9/9; migrações 11/11; seletor do runner Windows 40/40; integração real entre dois processos com pairing OPAQUE, TLS pinado e WSS PASS. A integração usou ACK sintético para verificar a persistência dos cursores; não executa adapter de playback nem simula duas máquinas.

Validação Windows nativa pelo runner oficial em checkout NTFS: `WINDOWS REPORT PASS`, compile nativo, store 18/18, protocolo 9/9, serviço 9/9, inbox 3/3, migrações 11/11, integração independente WSS, `remote-infrastructure` 20/20 e regressões Electron selecionadas PASS; cleanup PASS. PowerShell 5.1.26100.9711, Node v24.11.0 win32 x64, npm 11.6.1. Branch e HEAD foram conferidos no relatório do runner; o fingerprint exato desta execução está no relatório final desta sessão.

G3.1–G3.4: implementação técnica completa e pronta para auditoria independente; não auditada nesta rodada e sem aprovação de produção. G4 não iniciada. Limites mantidos em 256 MiB lógicos e 1.000.000 de registros totais; projeções físicas seguem estimativas, e a quota não promete capacidade de 1 milhão de operações.

## Correções A1–A4 após auditoria independente — 2026-11-13

O reproducer `independent-audit-repro.cjs` agora valida os resultados corrigidos: A1 mantém slot/tarefa ocupados e drenos `blocked` até o handler efetivamente terminar; A2 rejeita tracks inválidas dentro do snapshot; A3 separa watermark anunciado do cursor contíguo recebido e migra cursores v8 não comprovados para estado `recovery_required`; A4 torna respostas accepted/completed semanticamente idênticas idempotentes, sem aceitar conflitos terminais. As correções foram feitas pelo Luna e aguardam confirmação independente.

Validação Linux após correções: compile PASS; reproducer A1–A4 PASS; store 18/18; protocolo 10/10; serviço/outbox 12/12; inbox Gestão 5/5; migrações 12/12; `pairing-wire` 3/3; `remote-infrastructure` HTTPS/WSS 20/20; integração G3 entre processos independentes com pairing OPAQUE, TLS pinado e WSS PASS. A execução sandboxada da suíte de rede bloqueou binds loopback; o mesmo teste foi repetido fora do sandbox com 20/20 PASS.

Windows nativo PASS pelo runner oficial `--operational-store` em checkout NTFS: fingerprint `e7db51bc7c000ebd42b0c0f151e4eaf494f03e0efe83740999f96aa505cd1776`, branch/HEAD verificados. Node 24.11 x64; compile nativo; store 18/18, protocolo 10/10, serviço/outbox 12/12, inbox 5/5, migrações 12/12, integração operacional entre processos independentes com WSS real e `remote-infrastructure` 20/20 PASS. Regressões Windows selecionadas e cleanup sem processo residual PASS. Reauditoria independente pendente; checkpoint ainda não liberado; G4 não iniciada.

## Reauditoria focal Sol — 2026-11-13

A1–A4 PASS independentemente. Compile, reproducer, serviço/outbox 12/12, inbox 5/5, migrações 12/12, protocolo 10/10 e store 18/18 reexecutados PASS. `focal-reaudit-migration.cjs` comprova layout v8 real, rollback de falha transacional, preservação de eventos, retomada e restart idempotente. Windows não repetido: relatório oficial e hashes de 309 arquivos conferidos contra fingerprint e7db51bc7c000ebd42b0c0f151e4eaf494f03e0efe83740999f96aa505cd1776, sem divergência. Observação P3: branch snapshot duplicada/inalcançável no parser; sem impacto funcional. Ver parecer independente para riscos e pré-requisitos H3. Checkpoint tecnicamente liberado, sem executá-lo. G4 não iniciada; produção não homologada. git diff --check PASS.

## Verificação final pré-checkpoint — 2026-11-13

Na consolidação do checkpoint, `npm run compile`, os reproducers A1–A4, a migração v8→v9 com rollback/restart, operational-protocol 10/10, serviço/outbox 12/12, store 18/18, inbox Gestão 5/5, migrações 12/12, pairing-wire 3/3, `remote-infrastructure` 20/20 e integração operacional entre processos independentes com TLS pinado/WSS real passaram em Linux. A rede restrita do primeiro sandbox impediu binds loopback; a suíte WSS e o teste de processos foram repetidos com permissão local de loopback e passaram, sem relaxar assertions. A validação Windows não foi repetida nesta consolidação; permanece a evidência nativa já verificada no fingerprint `e7db51bc7c000ebd42b0c0f151e4eaf494f03e0efe83740999f96aa505cd1776`.
