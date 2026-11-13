# 0007/0003 — G3: Comandos, eventos e sincronização

## Identificação e estado

- Ticket: 0007/0003
- Etapa canônica: G3; pai 0007 — Comunicação remota segura.
- Status atual: reauditoria focal independente Sol PASS em 2026-11-13; A1–A4 confirmados corrigidos; G3.1–G3.4 PASS, apta para checkpoint e tecnicamente apta para G4 mediante autorização própria. Produção não homologada; G4 não iniciada. Histórico preservado abaixo.
- [Roadmap](../../standalone-player-roadmap.md), [contrato funcional](../../paired-mode-contract.md), [sequência e matriz de testes](../../paired-mode-execution-plan.md), [interfaces/IDs](../../paired-mode-ui-plan.md).

## Objetivo e limite

Fornecer schemas, confirmação de operações e registro durável/replay independentes da Gestão.

## Pré-requisitos e dependências

G1/G2 para tráfego autenticado; G3.1 é contrato sem rede, usado pela proposta G2; T2 antes de G3.2.

## Módulos envolvidos

src/{management,standalone-player,player-playback}-contracts.ts; src/player-playback-recovery*; futuros protocol/journal ports Main. São pontos existentes ou responsabilidades futuras, não alegação de arquivos novos já implementados. Conferir consumidores antes de editar.

## Lotes incrementais

### G3.1

Definir schemas e fixtures versionadas de pacote de vez, comandos, ACK, snapshot, consulta de mídia, journal e cursores; mapear IDs existentes conforme contrato §3.

### G3.2

Projetar e revisar T2; implementar store isolado Main-only, intenção/aceite/resultado, unicidade e replay paginado. Não usar inventário descartável nem persistir fila V1.

### G3.3

Implementar estados not-sent/rejected/accepted/completed/unknown e consulta por operationId; outbox recuperável por port na Gestão; mesmo ID/payload retorna resultado, conflito rejeita.

### G3.4

Implementar ACK durável/cursor contíguo, tombstones/checkpoints e limpeza segura; validar crash, disco cheio e ausência de reexecução após compactação.

## Critérios de aceite

Um comando duplicado não repete efeito. Aceite e resultado só confirmados após persistência. Resultado resiste a restart. Replay após ACK perdido é seguro e limpeza não invalida dedupe. G3 não aplica Round Robin nem conclui apresentações.

Cada lote entrega diff revisado, testes por impacto e documentação/evidências. Persistência exige preparar → gravar → publicar; sem enfraquecer invariantes ou assertions. Registrar NOT RUN e motivo; PASS técnico não presume aprovação do proprietário.

## Testes obrigatórios

ID com payload diferente, mensagens reordenadas, lacuna de sequência, crash antes/depois de commit e efeito físico, falha de escrita/rollback, ACK perdido, resultado persistido não recebido, backup antigo e compactação. SQLite/FS real conforme store escolhido, fixtures isoladas.

Usar relógios/barreiras determinísticos, rede sintética controlada, perfis/bancos isolados e runner Windows oficial quando aplicável. Nenhum sleep arbitrário como sincronização. CI existente recebe somente cenários determinísticos; campanhas físicas/duas máquinas ficam explícitas.

## Interfaces relacionadas

Frames de envio não confirmado e operação incerta são integrados em G5; decisões operacionais H3.

## Riscos e decisões pendentes

Não existe atomicidade entre efeito físico e disco: janela sem prova é incerta. TTL arbitrário perde idempotência. D1/D3/D4/D5 resolvidas; D2 parcialmente resolvida (somente descarte definitivo versus retorno da fila suspensa pendente). T1/T2 preservados no contrato; não recriar decisões já aprovadas de autoridade/EOF/pacote.

## Autonomia e conclusão

Implementação apenas com autorização específica do proprietário. Uma autorização de fase não autoriza a próxima. Dentro do lote autorizado, tarefas mecânicas e testes podem ser delegados consecutivamente com ownership exclusivo; parar no gate de decisão técnica/funcional/visual indicado, sem inventar política. Nenhuma etapa foi iniciada por este planejamento.

## Histórico preservado

O ticket anterior era exclusivamente planejado, sem implementação ou validação. A revisão atual detalha esse escopo mantendo ID e posição canônica. A antiga decisão aberta de autoridade em G4 foi resolvida funcionalmente pelo proprietário no contrato pareado; D1–D5 foram posteriormente revisadas pelo proprietário: D1/D3/D4/D5 resolvidas e D2 parcialmente resolvida, conforme o contrato vigente. Não há resultados de testes novos nesta atualização documental.

## G3.1 — retomada e análise documental, 2026-11-12 (histórico supersedido)

[Proposta implementável de contratos e T2](../../g3-1-operational-protocol-proposal.md): envelope versionado, variantes/IDs/bounds, consulta/snapshot/eventos/ACK, dedupe e outbox, journal SQLite isolado proposto, retenção/quotas/recovery e plano por lote com ownership e testes. Checkpoint `c36fb1d2dbd7cf17eea26ebd9c86936f0916739a` verificado, branch `feature/remote-player-lan-integration-3`, árvore inicialmente limpa. G2 PASS preservada; sem defeito concreto para reabertura.

A solicitação atual limita a rodada a análise/documentação. O entregável canônico G3.1 inclui schemas executáveis e fixtures; sua implementação/testes continuam pendentes, explicitamente separados da análise completa. Sem alteração funcional ou autorização de G3.2. A proposta está pronta para revisão e posterior execução pelo Luna após aprovação; não equivale a contrato aprovado.

Arquivos desta rodada: proposta acima, este ticket, roadmap e plano executivo. Inspeção estática/Git realizada; compile, testes de aplicação, Electron e Windows NOT RUN por escopo exclusivamente documental. Compatibilidade executável com IDs reais ainda não validada. Gate: aprovar contrato e autorizar restante G3.1; aprovar direção T2 e revisar quotas/store antes de G3.2. D2 final continua futura, sem bloquear estes contratos. Produção continua desabilitada até G5, homologação física G6/H5 pendente. Sem commit/push/PR/Doop/F.


## G3.1 — contratos executáveis antes da integração WSS, 2026-11-12 (histórico supersedido)

Implementados src/operational-protocol-contracts.ts, src/operational-protocol-validation.ts, testes e fixtures versionadas; detalhe e evidências em evidence/g3-implementation/README.md e g3-1-operational-protocol-proposal.md. npm run compile, testes G3.1 8/8 e pairing-wire 3/3 PASS. Regressão remote-infrastructure NOT PASS/timeout nesta execução; sem alteração final em G1. A detecção raw de duplicatas é testada, mas o parser ainda não está integrado ao ingresso WSS, portanto não se afirma proteção no fio. Quotas/store permanecem provisórios e não implementados. Nenhuma alteração de playback, fila, H ou pareamento de produção; G3.2–G3.4 não iniciadas.


## G3.1 — integração WSS e regressões fechadas, 2026-11-12 (registro histórico do lote)

Em src/remote-transport.ts, frames WSS são limitados em bytes e passam pelo scanner raw de chaves duplicadas antes de JSON.parse. Após handshake G1, todo conteúdo enviado ao messagePort exige schema G3.1 e identidade do envelope igual à identidade Player e ao peer autorizado. G1 HELLO segue intacto; G2 HTTP pairing-wire não foi alterado. Testes reais cobrem operação válida, duplicata no envelope/objeto aninhado/objeto dentro de array, inválido/malformado, oversized UTF-8, identidade falsa e zero dispatch em rejeições.

Validação: compile PASS; operational-protocol 8/8 PASS; pairing-wire 3/3 PASS; remote-infrastructure 20/20 PASS com loopback fora do sandbox. A falha anterior reproduzida no sandbox era `listen EPERM` em 127.0.0.1; não era regressão funcional. A regressão Windows 1006→1009 e seus resultados atuais estão na seção G3.2 abaixo.

## G3.2 — journal operacional durável, 2026-11-12 (registro histórico do lote)

Implementado `src/player-operational-store.ts` com `node:sqlite`, schema versionado (`journal_meta`, `operations`, `operation_tombstones`, `events`, `consumer_cursors`, `checkpoints`), WAL/FULL, locking exclusivo, transações curtas, fingerprint/dedupe, sequência, leitura paginada, checkpoint e backup/recovery. Aceite somente após commit; reservas lógicas protegem capacidade terminal; resultado incerto exige readback; restart transforma aceite sem prova terminal em unknown sem replay do efeito. Corrupção/schema incompatível/store ausente falham fechados; revogação preserva o histórico. Não há dispatcher, outbox, playback, fila, reconexão ou compactação.

Quotas revisadas com fixtures G3.1 e carga sintética de operações concluídas: 256 MiB lógicos e 1.000.000 linhas totais (operações + tombstones + eventos + checkpoints), contando reservas na admissão. O limite lógico ocorre primeiro, perto de 211,6 mil operações na carga medida. Em 100 mil operações/400 mil linhas foram medidos 126.789.005 bytes lógicos, DB 188.538.880 bytes e WAL 4.433.152 bytes; estimativa no teto ~400 MB DB + ~5 MB WAL e backup semelhante. Detalhes/limitações na proposta T2 e evidências G3.

Validação: compile Linux e Windows PASS; store 14/14 Linux/Windows; operational-protocol 8/8 Linux/Windows; remote-infrastructure 20/20 Linux fora do sandbox/Windows; pairing-wire 3/3 Linux; runner unitário 40/40. A campanha Windows foi feita pelo runner oficial após criar clone NTFS novo por bundle local; PowerShell 5.1, Node 24.11 x64, fingerprint/HEAD verificados, cleanup PASS. O teste WSS encontrou e corrigiu fechamento prematuro 1006 (agora 1009) quando `ws.maxPayload` rejeita tamanho. `max_page_count` é simulação de disco cheio; não houve saturação física do volume. O teste durante COMMIT pausa no authorizer SQLite e mata o processo antes da decisão nativa final; não simula perda de energia durante fsync. G3.3/G3.4 permanecem não iniciadas.

## G3.3 — dispatcher e outbox, 2026-11-12 — PASS Linux

Implementados `src/operational-protocol-service.ts` e `src/management-remote-outbox.ts`; o outbox usa o `karaoke.sqlite` da Gestão e schema aditivo v7 com backup migratório. O serviço entra pelo port WSS G1, valida/revalida o vínculo G2 e usa o store G3.2 antes de qualquer executor sintético. Sem port de leitura do target autoritativo, o dispatcher rejeita comandos novos; não há ligação com engine/fila.

Outbox grava `unknown` antes de transmitir e só aceita status com identidade/fingerprint correspondentes. Retries preservam operationId/corpo. Integração por processos independentes: OPAQUE G2, TLS pinado, WSS real, resposta perdida no consumidor, retry do mesmo ID, consulta completed e uma chamada ao handler sintético. Testes: dispatcher/outbox 8/8, protocolo 9/9, store 14/14, migração 11/11, `remote-infrastructure` 20/20, `pairing-wire` 3/3, runner Windows unitário 40/40, compile PASS. A integração de processo passou com rede local habilitada; não representa duas máquinas nem adapter de playback.

Corrigida incompatibilidade concreta no schema de status: `not-found` retorna fingerprint/result/eventSequence nulos; status conhecido requer fingerprint. A mudança evita inventar digest para operação ausente e foi coberta pelo parser e serviço. G2 permanece sem alteração semântica. No fechamento intermediário da G3.3, ACK/cursor, replay e compactação ainda aguardavam G3.4, concluída no registro seguinte sob a autorização combinada do proprietário.

## G3.4 — ACK, replay e compactação, 2026-11-13

Implementação técnica PASS. O store Player único valida e persiste ACK monotônico/idempotente com vínculo ativo, lê páginas contíguas limitadas, grava checkpoints antes do snapshot e compacta apenas até o mínimo seguro de cursores/checkpoint/high-watermark, sem cruzar operações accepted/unknown. Tombstones persistem. Gestão persiste páginas/snapshots e cursor de recebimento no SQLite existente, schema v8; esse cursor não é cursor de aplicação de negócio e não gera ACK automático. H3 deverá aplicar domínio e cursor atomicamente antes do ACK.

Testes Linux: compile; store 18/18; serviço 9/9; inbox 3/3; protocolo 9/9; migrações 11/11; runner unitário 40/40; integração de dois processos com OPAQUE/TLS pinado/WSS real PASS. Windows pelo runner oficial em NTFS: compile, store/protocolo/serviço/inbox/migrações, integração WSS, `remote-infrastructure` 20/20 e regressões selecionadas PASS; fingerprint verificado e cleanup PASS. Detalhes constam na proposta T2 e evidências G3. Sem reconexão automática G4, engine/fila, playback, duas máquinas, auditoria independente ou homologação de produção. O pareamento de produção permanece desabilitado.

## Auditoria independente — 2026-11-13

[Relatório](../../g3-independent-audit.md) e reproducer versionado em evidence/g3-implementation/independent-audit-repro.cjs. Compile e quatro arquivos focais G3 PASS; pairing-wire 3/3, migrações 11/11 e WSS real 20/20 PASS. Contraexemplos A1–A4 reproduzidos mesmo com as suítes passando. A1 P1: timeout libera slot e waitForIdle/close antes do término do handler. A2 P2: tracks inválidas no snapshot. A3 P2: snapshot avança cursor recebido sem eventos. A4 P2: accepted repetido é rejeitado. Nenhuma correção funcional aplicada; encaminhar ao Luna e reauditar. Windows anterior revisado, não repetido. Não houve nova autoridade de playback/fila, alteração G2 ou início G4.

## Correções A1–A4 — 2026-11-13, confirmação independente pendente

Luna corrigiu os quatro comportamentos sem alterar T2, playback, fila ou G2. O dispatcher conserva slot e tarefa após timeout até a Promise original assentar; `waitForIdle`/shutdown retornam `blocked` com limite explícito, e `unknown` não muda com resposta tardia. Snapshot aplica o mesmo schema fechado de tracks que activate-turn. A inbox separa `throughSequence` contíguo recebido de `highWatermark`/`snapshotHighWatermark`; migração `user_version=9` preserva o cursor v8 legado e coloca em recovery-required qualquer prefixo não demonstrável. Outbox repete accepted/completed idênticos, mantendo conflito para detalhes/resultados divergentes.

Linux após correções: compile PASS; reproducer independente A1–A4 PASS; store 18/18; protocolo 10/10; serviço/outbox 12/12; inbox 5/5; migrações 12/12; pairing-wire 3/3; `remote-infrastructure` 20/20 fora do sandbox; integração operacional entre processos independentes com OPAQUE/TLS pinado/WSS real PASS.

Windows nativo: runner oficial `--operational-store` PASS no checkout NTFS `C:\Users\Chris\source\karaoke-queue-g3-2`, fingerprint `e7db51bc7c000ebd42b0c0f151e4eaf494f03e0efe83740999f96aa505cd1776`; compile, store 18/18, protocolo 10/10, serviço/outbox 12/12, inbox 5/5, migrações 12/12, integração WSS independente, `remote-infrastructure` 20/20 e regressões Windows selecionadas PASS; cleanup sem processo residual PASS. O preflight sandboxado falhou antes da sincronização por `UtilBindVsockAnyPort: socket failed 1`; o runner oficial passou fora desse bloqueio.

Os achados estão resolvidos pela implementação, mas não reclassificados como PASS pela auditoria independente. `git diff --check` foi verificado após revisão final; reauditoria necessária antes do checkpoint; G4 continua não iniciada.

## Reauditoria focal independente — 2026-11-13 — PASS

[Relatório independente](../../g3-independent-audit.md): A1–A4 PASS; compile, reproducer e suites focais reexecutados, complemento de migração v8 real/rollback/restart PASS. Relatório Windows oficial e 309 hashes de código/testes conferidos contra fingerprint e7db51bc7c000ebd42b0c0f151e4eaf494f03e0efe83740999f96aa505cd1776. Sem nova regressão bloqueante; P3 de branch snapshot duplicada sem impacto. Riscos blocked/unknown e recovery explícito mantidos, aplicação/ACK de negócio reservados a H3. G3 apta para checkpoint e tecnicamente apta para G4, sem iniciá-la ou efetuar commit. git diff --check PASS.
