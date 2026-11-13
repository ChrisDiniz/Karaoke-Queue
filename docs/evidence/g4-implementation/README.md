# Evidências de implementação G4

## Estado relatado na entrega Luna (histórico; auditoria vigente no addendum)

- Checkpoint de entrada: `ca6af2e3bed30fa26a98b0921f46f51a59f54a8b` na branch `feature/remote-player-lan-integration-3`; HEAD permaneceu nesse commit. O plano G4 e alterações parciais já estavam na working tree antes desta retomada e foram preservados.
- Autorização: o proprietário aprovou os contratos do plano integral e autorizou G4.1–G4.4 em sequência.
- Resultado: **G4.1, G4.2, G4.3 e G4.4 PASS técnico**. Pronta para auditoria independente; auditoria e checkpoint posterior ainda pendentes.
- Pairing de produção **desabilitado** até apresentação local real/aprovada em G5. G5, G6 e H não iniciadas. Sem playback remoto, takeover ou aplicação de evento de negócio.

## G4.1 — PASS técnico

O coordenador Main-owned em `src/remote-reconnection-service.ts` está conectado a `src/main-remote-reconnection.ts` e ao runtime real `src/main-remote-runtime.ts`. O adapter reutiliza discovery G1, certificado pinado, vínculo/autorização G2 e transporte WSS já existente; executa `hello/ready` operacional G3 e só informa sincronização depois de reconciliação. mDNS é apenas localização. O último endpoint e os candidatos são revalidados por pin, geração e autorização. Canais antigos são cercados por token/fence.

O scheduler conserva uma única reconexão/reconciliação global ativa, em conformidade com os bounds do plano. Backoff, coalescing, timeout, cancelamento e shutdown têm testes determinísticos. Startup do Player respeita modo offline persistido; revogação e erro de identidade não são tratados como retry autorizado.

Gate: `tests/remote-reconnection.test.ts` (9 casos no gate Windows), `tests/remote-infrastructure.test.ts` e E2E de processos G4. O E2E usa OPAQUE G2 real, TLS pinado/WSS, handshake e reconexão depois de perda/restart; prova que conexão anterior não retoma autoridade.

## G4.2 — PASS técnico

`src/remote-reconciliation-service.ts` consulta status pela outbox G3 existente, mantendo `operationId` e fingerprint. Respostas são correlacionadas e validadas. Timeout, `accepted` sem terminal, `unknown` e `not-found` inconclusivo não disparam novo efeito físico. Handler ativo mantém contenção. Nenhum dispatcher, journal ou outbox paralelo foi criado.

Gate: `tests/remote-reconciliation.test.ts`, regressões `tests/operational-protocol-service.test.ts` e `tests/player-operational-store.test.ts`, e integração real entre processos. A integração perde resposta após tentativa, reconecta/reinicia, consulta a mesma operação e comprova que o handler sintético não é invocado novamente.

## G4.3 — PASS técnico

`src/remote-control-intent.ts` persiste a intenção em `remote-control-intent.sqlite`, banco SQLite Main-owned com tabela e versão próprias, `synchronous=FULL`, transação e revisão CAS. Estado ausente falha fechado como disabled; arquivo inválido não é recriado. Se existir o JSON criado pelo protótipo parcial, seu valor é importado uma vez e o arquivo original permanece. A transição grava antes de publicar; no startup, o runtime lê essa intenção. Modo offline fecha listener e cerca o cliente autorizado. Ativação precisa ser explícita e não cria pairing. Callbacks atrasados revalidam epoch/revision/fence; falha de persistência não libera o modo.

Gate: `tests/remote-control-intent.test.ts`, testes SQLite/migração e E2E de processos: offline → restart real do Player → tentativa de reconnect recusada → enable explícito → reconnect autorizada, sem pairing novo. Revogação concorrente e canal antigo são testados no coordenador/runtime.

## G4.4 — PASS técnico

Reconexão chama reconciliação G3 existente e verifica identidade de journal, epochs/revisions, snapshot, `highWatermark`, `compactedThrough`, replay paginado/contíguo, inbox persistente e consultas operation-status. `src/management-remote-journal.ts` valida epochs e watermark sem transformar snapshot em EOF. Cursor de recebimento permanece separado da aplicação de negócio H3; G4 não emite ACK de consumo. Estado de Management passou a associar snapshot à epoch do Player; checkpoints do Player também são cercados pela epoch com migração aditiva, preservando registros anteriores. Gaps, rollback e recovery marker continuam explícitos e fail-closed.

Gate: testes de journal/inbox/protocolo/migração, reinícios separados e simultâneos e E2E G4 com dois processos e SQLite real. Nenhum caso incerto repete efeito físico ou diminui cursor.

## Testes executados nesta retomada

### Linux/WSL2

- `npm run test:unit:g4` — PASS, **55/55**; inclui compilação TypeScript, inspeção de `PRAGMA integrity_check` e importação sem descarte do registro JSON anterior.
- `node --test build/tests/remote-infrastructure.test.js` — PASS, **23/23**; inclui TLS/WSS e contenção de reset do socket TLS aceito.
- `npm run test:e2e:g4` — PASS. Processo de Gestão e Player isolados; pairing OPAQUE G2, WSS real com TLS pinado, SQLite, handshake G3, reconnect/restart G4, status incerto por ID original, replay e modo offline persistente.
- Suites históricas G2/G3 não afetadas não foram repetidas indiscriminadamente.

### Windows nativo

Runner oficial `npm run test:e2e:g4:windows -- --approve-untracked`, usando checkout NTFS `C:\Users\Chris\source\karaoke-queue-g4-validation`, Windows Node v24.11.0, npm 11.6.1 e PowerShell 5.1.26100.9711. Fingerprint do snapshot validado: `5321faf82d70ecc989b8086f870864d32d9adeeba1c03f323c8f2f8a4bad890f`; branch/HEAD verificados. O diário é atualizado depois desse snapshot apenas em documentos; não houve alteração de código após o gate.

- Instalação/compilação nativas — PASS.
- `remote-control-intent` 3/3; reconnect 9/9; reconciliation 6/6; Player operational store 19/19; protocolo 10/10; operational service/outbox 13/13; Management inbox 5/5; migrações 13/13 — PASS (**78 testes** selecionados).
- `remote-infrastructure` — PASS, 23/23.
- E2E de pairing G2 real e integração G4 entre processos independentes — PASS.
- SafeStorage/DPAPI e persistência entre processos Electron; integração Electron de identidade segura Windows — PASS.
- Fingerprint/branch/HEAD e cleanup do runner; sem processos residuais — PASS.

Runner `npm ci` reportou seis advisories moderados e pacotes deprecated. Não houve atualização automática de dependências; investigar em manutenção separada. Não representa falha do gate funcional G4.

## Falhas encontradas e correções comprovadas

1. O primeiro protótipo de intenção em arquivo recebeu `EPERM` ao tentar `fsync` do diretório no Windows e, na revisão do contrato, não atendia ao gate de SQLite real. Foi substituído por SQLite transacional (`synchronous=FULL`); o registro anterior é importado sem apagar a fonte. A suíte SQLite/WSS e o runner Windows final passaram.
2. Durante o primeiro E2E Windows, um probe TLS válido fechou o TLSSocket após handshake e causou `ECONNRESET` não tratado no Player. Foram adicionados handlers de erro na conexão TLS estabelecida com logging sanitizado. Regressão WSS real e processo G4 passaram no gate final.
3. Iterações iniciais do harness G4 revelaram incompatibilidades de identidade/correlação e associação resposta-outbox. A fixture agora usa o formato real do `RemoteIdentityStore` protegido por safeStorage Electron e associa mensagens ao `operationId` original. A execução final real G2/G4 passou sem relaxar validação.

As primeiras execuções Windows falharam nas causas 1 e 2 acima; os resultados foram corrigidos e repetidos. Não são contados como PASS até a execução final indicada.

## Decisões autônomas registradas

| Problema | Decisão | Evidência |
|---|---|---|
| Disputa entre peers e bounded resources | Um slot global de reconnect/reconciliação; demais recebem estado `RECONNECT_SLOT_BUSY` e são reavaliados | Teste determinístico de scheduler e runner Windows |
| Persistir offline sem criar autoridade concorrente | Adicionar intenção ao store SQLite proprietário do Player; runtime real lê a intenção no startup | `remote-control-intent`, migração e E2E de restart |
| Proteger identidade de fixture em Windows | Usar RemoteIdentityStore real e safeStorage Electron; nenhuma chave privada auxiliar em claro | Pairing real e testes Electron/DPAPI nativos |
| Persistência offline com integridade entre processos | SQLite dedicado Main-owned, `synchronous=FULL`, transação CAS e importação preservadora do formato parcial | 55/55 Linux; 3/3 Windows para intenção; restart real WSS/Player PASS |
| Reset TLS pós-handshake | Tratar erro no socket aceito sem derrubar Player; mensagem sanitizada | Reproducer WSS/TLS real e `remote-infrastructure` 23/23 |
| Chamadas Main concorrentes durante startup | Coalescer para uma única Promise; revalidar intenção/revisão/fence depois de awaits | E2E G2/G4 afirma identidade da tarefa, e observa um único canal sincronizado |

Nenhuma decisão alterou autoridade Gestão/Player, G2/T2, durabilidade lógica, scopes, semântica operacional ou retry de efeito incerto; não há decisão material aguardando aprovação.

## Histórico preservado da primeira execução parcial

A execução anterior havia criado scheduler por peer e reconciliador sobre stores G3, mas faltavam adapter WSS/G2/G3 Main, integração runtime, modo offline persistente, fencing e E2E G4; o status era PARTIAL. Os testes unitários e regressões G3 da primeira entrega não eram prova de integração G4. Essa condição foi resolvida nesta retomada e as evidências históricas permanecem registradas nos commits/diffs anteriores da sessão.

## Riscos e dependências remanescentes

- Auditoria independente do Sol ainda deve revisar composição e contratos; este diário não a declara PASS.
- Pairing para produção depende da apresentação local real e aprovada em G5. G4 não fornece UI nem autoriza pairing.
- H3 deve persistir aplicação de evento e cursor de negócio na mesma transação antes do ACK. G4 só reconcilia recebimento técnico; não executa H.
- Rollback bilateral que apague toda evidência externa pode ser indetectável; sem autoridade externa G4 não promete detectar perda absoluta de dados ou exactly-once físico.
- Homologação física de rede/venue permanece G6/H5.
- Seis advisories moderados do npm reportados pelo runner permanecem sem triagem individual nesta fase.

## Estado final

- G4.1: PASS técnico.
- G4.2: PASS técnico.
- G4.3: PASS técnico.
- G4.4: PASS técnico.
- G4 pronta para auditoria independente: SIM.
- Aprovação de produção: NÃO.
- Working tree: contém alterações G4 autorizadas e documentação/evidências; nenhuma foi commitada ou publicada.
- `git diff --check`: verificado após a consolidação documental final.
- Commit/push/PR: não realizados.

## Relatório final consolidado desta execução

### Implementação e integrações

G4.1–G4.4 foram completadas no runtime Main. Os módulos principais são `src/main-remote-reconnection.ts`, `src/remote-operational-client.ts`, `src/remote-reconnection-service.ts`, `src/remote-reconciliation-service.ts`, `src/remote-control-intent.ts`, `src/main-remote-runtime.ts`, `src/management-remote-journal.ts`, `src/player-operational-store.ts` e `database.ts`. O Player offline é durável no SQLite `remote-control-intent.sqlite`; Management retoma apenas quando a intenção persistida está enabled. A integração reutiliza G1/G2/G3 existentes, sem dispatcher, fila ou engine paralela.

O E2E `scripts/pairing-process-integration.test.cjs --operational` executa processos independentes com OPAQUE G2, WSS/TLS pinado, handshake/replay G3, coordinator/reconciler G4, operações sintéticas, SQLite, perda/reconexão e restart. O mesmo `operationId` recupera resultado incerto sem segunda chamada ao handler. A decisão offline sobrevive restart e impede listener/reconnect até enable explícito. Não há UI/IPC de operador para mudar esse estado nesta fase; a apresentação aprovada e sua ligação visual permanecem em G5.

### Matriz de resultados

| Gate | Resultado verificável |
|---|---|
| G4.1 | PASS — coordinator Main-owned, WSS pinado + autorização G2 + hello/ready/replay G3, reconnect e fencing em processos independentes |
| G4.2 | PASS — consulta status pelo ID/fingerprint original; resposta/ACK perdido não repete efeito incerto |
| G4.3 | PASS — SQLite real, CAS/transação, import preservador, offline mantém fence/listener fechado através de restart e enable explícito reabre |
| G4.4 | PASS — snapshot/epoch/watermark/replay/inbox/outbox reconciliados; divergência fica recovery_required; sem ACK H3 ou cursor de negócio |
| Linux/WSL2 | PASS — G4 55/55; `remote-infrastructure` 23/23; `npm run test:e2e:g4` PASS |
| Windows nativo | PASS — runner oficial; fingerprint `5321faf82d70ecc989b8086f870864d32d9adeeba1c03f323c8f2f8a4bad890f`; compile; 78 regressões focadas; transporte 23/23; E2E G2/G4; DPAPI/safeStorage; cleanup sem processos residuais |
| `git diff --check` | PASS — executado após documentação final |

### Correções feitas nesta execução

- Prototipagem inicial offline gravava JSON. Revisão do gate G4.3 identificou que precisava SQLite real. Foi trocada por SQLite transacional; o teste verifica integridade e schema. JSON anterior é importado sem remoção. Não se usou a falha de `fsync` do diretório Windows como motivo para flexibilizar durabilidade.
- Um probe TLS que fechava após handshake deixava `ECONNRESET` sem tratamento no socket aceito; containment e regressão WSS real adicionados.
- O harness inicial precisou de ajustes de identidade protegida e correlação, sem afrouxar o contrato de pin/autorização ou dedupe.

### Decisões e pendências

- Decisões autônomas estão tabuladas acima, com justificativa e testes. Decisões materiais pendentes: **nenhuma**.
- Riscos remanescentes: a auditoria independente ainda precisa inspecionar a composição e stores; G4 não detecta rollback bilateral que elimina toda evidência externa; seis advisories moderados de dependências reportados por `npm ci` não foram investigados individualmente.
- G5 não começou e deve fornecer UI/presentation port aprovados antes do pairing de produção. H3 ainda deve transacionar aplicação de negócio + cursor antes de ACK. G6/H5 ainda homologam venue/hardware e não foram simuladas por duas máquinas.
- Recomendações de auditoria para Sol: revisar eleição/cancelamento Main-owned e validação após await; store offline e teste restart; atomicidade de migrações por epoch; limites de `snapshot`/`highWatermark`/cursor/replay; recuperação de backup; ausência de retransmissão de unknown; regressão TLS reset. Verificar o runner Windows contra fingerprint registrado.

### Estado Git e encerramento

Branch `feature/remote-player-lan-integration-3`; HEAD continua `ca6af2e3bed30fa26a98b0921f46f51a59f54a8b`, o checkpoint G3. A branch local estava `ahead 1` de `origin/feature/remote-player-lan-integration-3` na inspeção inicial; essa diferença preexistente não foi alterada. A working tree contém somente a implementação/evidências G4 autorizadas e alterações documentais desta execução; sem commit, push ou PR. O runner Windows confirmou cleanup e nenhum processo de teste residual.

G4.1: PASS<br>
G4.2: PASS<br>
G4.3: PASS<br>
G4.4: PASS<br>

G4 TECHNICAL IMPLEMENTATION: COMPLETE<br>
G4 READY FOR INDEPENDENT AUDIT: YES<br>
G4 WINDOWS NATIVE: PASS<br>
OWNER DECISIONS REQUIRED: NONE<br>
G4 PRODUCTION APPROVAL: NO<br>
COMMIT: NOT PERFORMED<br>
PUSH: NOT PERFORMED<br>
G5: NOT STARTED

O host Windows informou suporte a Standby S3 em `powercfg /a`; PowerState.Suspend e assinatura .NET foram verificadas sem executar a suspensão. A tentativa direta de suspensão continuará sendo a última ação operacional depois que este relatório estiver visível na conversa. O resultado dessa chamada não é presumido neste registro.


## Auditoria independente G4 — 2026-11-13

Sol confirmou A1 P2 (autorização tardia promove synchronized após disable), A2 P1 (perda/truncamento do SQLite apaga offline explícito) e A3 P2 (snapshot cancelado ainda persiste). Parecer **FAIL**; G4.1 FAIL, G4.2 PASS no escopo inspecionado, G4.3 FAIL, G4.4 FAIL. Checkpoint e G5 bloqueados até correção e reauditoria. Relatório: `docs/g4-independent-audit.md`; reproducer determinístico: `node scripts/g4-audit-repro.cjs`. Windows histórico PASS validado por relatório e 485 hashes de código/documentos iguais; cinco divergências somente documentais. Seis entradas moderadas npm decorrem de um advisory de minimatch nas ferramentas de build, sem caminho explorável identificado em G4; não bloqueiam esta fase. Implementação preservada, sem correção funcional nesta auditoria, commit/push ou início de G5.


## Correções Luna A1–A3 — validação, 2026-11-13

Esta rodada corrige os achados reproduzidos no parecer independente. O diário preserva separadamente os resultados PASS técnicos anteriores, o FAIL independente original e esta nova implementação; a reauditoria de Sol continua pendente.

### A2 — intenção offline fail-closed

O store considera identidade Player/Gestão e autorização G2 existentes como evidência de inicialização remota anterior. Se o SQLite estiver ausente diante dessa evidência, a leitura retorna `recovery_required` sem criar DB e sem importar JSON legado. Em instalação nova, a intenção é inicializada/migrada antes de criar identidade. DB de tamanho zero, inválido, esquema desconhecido ou integridade quebrada é preservado e causa erro fechado. Uma decisão local explícita pode criar uma nova intenção depois de perda do arquivo; JSON legado é ignorado quando já há evidência G2. Rollback que remova todas as evidências independentes não pode ser distinguido de bootstrap e não recebe garantia automática.

Arquivos: `src/remote-control-intent.ts`, `src/main-remote-runtime.ts`, `tests/remote-control-intent.test.ts`, `scripts/pairing-process-player.cjs` e `scripts/pairing-process-integration.test.cjs`.

### A1 — autorização tardia e lifecycle

O coordenador revalida geração, abort, estado enabled/closed e canal após os awaits de connect, autorização e reconciliação. Disable/close cercam tentativas pendentes; fechamento do mesmo canal é coalescido. O runtime Player também refaz fence de intenção após awaits de configuração/start e fecha listener se a decisão local mudou.

Arquivos: `src/remote-reconnection-service.ts`, `src/main-remote-runtime.ts`, `tests/remote-reconnection.test.ts`.

### A3 — admissão de persistência e cancelamento

O reconciliador valida abort/deadline após cada query assíncrona e imediatamente antes da escrita SQLite síncrona de página, snapshot e status. Cancelamento anterior à admissão não grava; cancelamento após commit síncrono mantém a evidência já durável, mas não retorna `synchronized` nem aceita status tardio.

Arquivos: `src/remote-reconciliation-service.ts`, `tests/remote-reconciliation.test.ts`.

### Testes desta rodada

- `npm run test:unit:g4` — PASS **70/70** após as correções.
- `node scripts/g4-audit-repro.cjs` — PASS: A1 não promove estado obsoleto; A2 bloqueia DB ausente/corrompido e JSON stale; A3 rejeita cancelamento sem snapshot persistido.
- `npm run test:e2e:g4` — PASS: Gestão/Player independentes, OPAQUE G2, WSS/TLS pinado, coordenador/reconciliador G4, SQLite, restart, replay/status e tentativa de recuperação de offline com SQLite ausente + JSON enabled; nenhuma sincronização até reabilitação local explícita.
- Windows nativo: NOT RUN nesta nota até a conclusão do runner oficial desta revisão; resultado histórico fingerprint `5321...` não cobre estes arquivos alterados.

Falhas do primeiro teste local de loopback foram `EPERM` de sandbox; os testes que dependem de bind local passaram pelo comando autorizado fora dessa restrição. O relatório Windows final e fingerprint desta revisão serão acrescentados após o runner. Nenhum commit/push/PR; auditoria independente permanece FAIL até reauditoria de Sol.


## Fechamento de validação das correções A1–A3 — 2026-11-13

Esta entrada atualiza os resultados parciais acima sem apagar o histórico. O parecer independente original continua **FAIL**; a execução das correções não é reauditoria independente.

### Resultados finais reproduzíveis

- `npm run test:unit:g4`: **PASS 71/71**, incluindo inicialização/CAS entre dois processos, restart Player, listener Main cercado após offline/perda/corrupção da intenção, primeira execução, recuperação local explícita, callbacks tardios e cancelamento antes/depois da admissão SQLite.
- `node scripts/g4-audit-repro.cjs`: **PASS** nos cinco checks A1–A3; autorização tardia não promove canal antigo, estado SQLite perdido/truncado não habilita conexão nem importa JSON legado stale, e snapshot cancelado não retorna sincronizado.
- `npm run test:e2e:g4`: **PASS** com Gestão e Player independentes, OPAQUE G2, WSS/TLS pinado, handshake/replay G3, coordenador/reconciliador G4, SQLite persistente, perda/restart e estado offline perdido com JSON legado `enabled`; sem canal sincronizado até escolha local explícita.
- Regressões Linux/WSL2 G1/G2/G3 diretamente afetadas: **52/52 PASS** (`remote-infrastructure`, pairing wire/audit regressions e protocolo/serviço operacional). A suíte G4 completa falhou inicialmente no sandbox por `listen EPERM` ao abrir listeners Main; a mesma suíte foi executada no contexto autorizado de bind e passou 71/71. Assertions e timeouts não foram alterados para obter PASS.
- Windows nativo: **PASS** no runner oficial em checkout NTFS isolado. Fingerprint do snapshot testado: `2559a710644766c6fc499e97daef79a5a5291b3f4247172118ecc6403eb21bab`; branch `feature/remote-player-lan-integration-3`, HEAD G3 `ca6af2e3bed30fa26a98b0921f46f51a59f54a8b`. Compile nativo passou; 94 testes focados nas suites de intenção (13), reconnect (12), reconciliação (9), store operacional (19), protocolo (10), serviço/outbox (13), inbox Gestão (5) e migrações (13) passaram; integração G2/G4 entre processos passou; `remote-infrastructure` 23/23, DPAPI/safeStorage entre dois processos Electron e cleanup sem processos residuais passaram. O runner reportou `REPORT PASS` com o mesmo fingerprint.
- O `npm ci` Windows voltou a reportar seis entradas moderadas decorrentes do advisory transitivo de minimatch já triado no relatório independente. Nenhuma dependência foi alterada nesta rodada.
- `git diff --check`: **PASS** após atualização desta entrada e demais documentos.

### Causa e resolução por achado

- **A1 RESOLVED para reauditoria:** lifecycle generation invalida disable/close e respostas tardias; o fence é verificado após awaits e antes da eleição/publicação. Testes com barreiras cobrem autorização inicial e posterior à reconciliação, start novo e revogação.
- **A2 RESOLVED para reauditoria:** leitura da intenção agora diferencia bootstrap de perda usando evidências G2 já existentes. Perda do SQLite com evidência anterior fica `recovery_required`; DB zero-byte, schema não suportado e corrupção são preservados e falham fechado. SQLite ausente só sai do estado incerto com decisão local explícita; JSON legado stale não substitui a prova perdida. A configuração de `busy_timeout` e `synchronous=FULL` ocorre em cada conexão, corrigindo também a corrida CAS real entre dois processos.
- **A3 RESOLVED para reauditoria:** cancelamento/deadline é revalidado após respostas e no ponto de admissão síncrona de cada escrita. Se commit já foi admitido, a evidência durável é conservada, mas a sessão cancelada não retorna `synchronized`.

Risco residual documentado: remoção/rollback simultâneo da store e de toda evidência G2 independente não pode ser distinguido com prova local; não há garantia contra rollback bilateral. DB corrompido é mantido bloqueado até restore/recuperação local explícita. Não há efeito de playback executado ou repetido.

**Status desta rodada:** A1, A2 e A3 RESOLVED segundo os reproducers e regressões acima; G4 pronta para reauditoria independente, não para checkpoint ou G5 até PASS independente. Produção não aprovada. Nenhuma autoridade, contrato criptográfico G2/T2, durabilidade G3, comportamento de fila ou playback foi alterado. Sem commit, push, PR ou início de G5.


## Reauditoria focal independente G4 — 2026-11-13

Sol confirmou A1–A3 corrigidos (PASS focal), mas reproduziu **A4 P1**: enable antigo suspenso em stopPlayer persiste enabled depois de offline posterior já confirmado. SQLite reaberta perde a decisão mais recente; restart volta a considerar o remoto elegível. Reproducer determinístico `node scripts/g4-reaudit-intent-race.cjs` CONFIRMED; devolver correção ao Luna. Parecer independente **FAIL**; G4.1 PASS, G4.2 PASS, G4.3 FAIL, G4.4 PASS no escopo focal. Checkpoint/G5 NÃO liberados.

Compile, reproducer original corrigido, 86 testes focados/regressivos e E2E G4 real entre processos reexecutados PASS. Windows fingerprint `2559a710644766c6fc499e97daef79a5a5291b3f4247172118ecc6403eb21bab` verificado: 488/494 hashes iguais, seis divergências exclusivamente documentais; nenhum código diferente. Campanha nativa não repetida e novo reproducer A4 ainda não executado no Windows. Causa, impacto, correção mínima e regressão necessária estão em `docs/g4-independent-audit.md`. Limites de rollback completo e advisories minimatch preservados. Sem alteração funcional, commit/push/PR ou G5. `git diff --check` PASS.


## Correção A4 — execução e validação final, 2026-11-13

A reauditoria focal encontrou enable antigo capaz de persistir depois de offline confirmado. A causa era a espera por `stopPlayer()` sem conferir a geração nova antes de gravar. Main agora atribui uma geração a cada escolha no momento do pedido, revalida depois do await e entrega ao SQLite uma condição de admissão que é checada imediatamente antes da transação síncrona. Escolha obsoleta rejeita sem persistir nem reportar sucesso; `close()` cerca tentativas pendentes. A linha SQLite reaberta por outro processo prova que offline prevalece.

A execução também detectou e corrigiu a observação transitória de SQLite vazio durante bootstrap concorrente. A leitura aguarda evento limitado de inicialização e só considera concluído quando o arquivo contém o banco; zero-byte sem conclusão continua sendo erro e nunca se recria silenciosamente.

Resultados finais desta rodada: A4 reproducer original CONFIRMED antes da mudança e PASS depois; teste cross-process A4 confirma offline via segundo Main; `npm run test:unit:g4` 75/75; A1–A3 reproducer/regressões mantidos; regressões G1/G2/G3 afetadas 52/52; `npm run test:e2e:g4` PASS. Runner oficial Windows PASS com compile, 98 testes focados, E2E G2/G4, remote-infrastructure 23/23, DPAPI/safeStorage e cleanup. Fingerprint `2a4e19d84f7dea3b32ae374efb149ec9a7023a42c80a529c9962ab7518ea6350`, branch e HEAD G3 conferidos. `git diff --check` PASS.

A4 RESOLVED tecnicamente, A1–A3 preservados. Reauditoria independente focal ainda pendente; este diário não altera o FAIL independente nem libera checkpoint/G5. Rollback completo sem provas G2 e recuperação de DB corrompido mantêm os limites anteriores. Advisories minimatch permanecem sem alteração; G5 não iniciada, sem commit/push/PR.


## Validação final de A4 — 2026-11-13

Este registro atualiza os números anteriores de 75/75 e fingerprint `2a4e19…`; preserva os resultados históricos e não declara auditoria independente PASS.

- Causa: uma chamada Player `enabled` recebia geração e aguardava `stopPlayer()`, mas não era invalidada de forma suficiente na fronteira de admissão durável quando outra intenção chegava durante o await. Main agora incrementa a geração no início de cada transição Player. Enable valida depois do shutdown e após o store; offline cerca imediatamente o runtime e fornece o predicado de admissão ao store. O store revalida depois da preparação assíncrona e imediatamente antes da transação SQLite síncrona. `close()` invalida tentativas pendentes. Operações obsoletas rejeitam e não publicam sucesso.
- Reproducer original A4: confirmado antes da correção (offline era sobrescrito por enable antigo); após a correção passa e um segundo Main reabre a store como `offline`, recusando iniciar o controle remoto.
- `npm run test:unit:g4`: **77/77 PASS**. Cobertura A4 inclui enable suspenso seguido por offline; offline antigo suspenso seguido por enable explícito mais novo; dois pedidos concorrentes iguais; fence na admissão SQLite; close concorrente; persistência e leitura cross-process. `node scripts/g4-audit-repro.cjs` confirma regressões A1–A3; `node scripts/g4-reaudit-intent-race.cjs` confirma A4.
- G1/G2/G3 diretamente afetadas: **52/52 PASS**. `npm run test:e2e:g4`: PASS com a integração G4 entre Management/Player independentes; WSS/TLS pinado, OPAQUE G2, hello/ready G3, coordenador e reconciliador G4, SQLite e restart. Nenhuma engine/fila/playback foi adicionada.
- Windows nativo oficial, checkout NTFS: **PASS**, runId `4e10e589-41fb-4cd7-b9e5-10f2deab8a0f`, fingerprint `4b11a16784faf49df02295605c5256ea02c7b5a415bfda13153a977fc7f61199`; compile, 100 testes focados (incluindo os 19 testes de intenção), E2E de processos independentes, `remote-infrastructure` 23/23, DPAPI/safeStorage e cleanup passaram. O relatório oficial confirmou branch/HEAD esperados e nenhum processo residual.
- Depois do runner, apenas os documentos de evidência/status foram atualizados para registrar esses resultados; nenhuma fonte ou teste executável mudou. O fingerprint identifica o snapshot de código/testes efetivamente validado, não a revisão documental posterior.
- `git diff --check`: PASS. Seis advisories moderados observados por `npm ci` permanecem sem alteração e não foram reclassificados.

A4 está RESOLVED pela implementação e evidência do Luna; A1–A3 continuam preservados. **Reauditoria independente focal pendente**. Checkpoint/G5 continuam bloqueados até PASS independente; produção não aprovada; sem commit/push/PR; G5 não iniciada.


## Reauditoria final independente A4 — 2026-11-13

Sol confirmou o reparo no mesmo Main e as regressões A1–A3, mas reproduziu A4 P1 entre dois processos Main com a mesma SQLite: enable antigo aguarda shutdown, offline posterior confirma no outro processo e enable antigo retoma e grava enabled/revisão 2. O fence é memória local e Main não fornece expectedRevision ao store. Reproducer determinístico: node scripts/g4-reaudit-cross-process-intent.cjs (CONFIRMED, não PASS do contrato). Correção devolvida ao Luna; parecer independente FAIL; G4.3 FAIL, demais lotes PASS no escopo focal. Checkpoint/G5 bloqueados.

Compile, reproducers A1–A3/A4 original e 40 testes focados PASS. Windows histórico runId 4e10e589-41fb-4cd7-b9e5-10f2deab8a0f/fingerprint 4b11a16784faf49df02295605c5256ea02c7b5a415bfda13153a977fc7f61199 conferido: 490/495 hashes iguais, cinco diferenças documentais; código/testes/scripts existentes coincidem. Novo reproducer cross-process executado somente no Linux. Detalhes, pré-condição de dois proprietários e limites dos locks de bootstrap estão no relatório independente. Nenhum código de produção alterado; histórico preservado. git diff --check PASS. Sem commit/push/PR, produção não aprovada e G5 não iniciada.


## Correção Luna A4 entre processos Main — 2026-11-13

A2 principal recebeu a correção autorizada por CAS durável. Toda gravação do store exige expectedRevision explícita; undefined é rejeitado. Main captura a revisão persistida antes de iniciar a espera de shutdown/preparação e a propaga sem atualizar estado como confirmado. SQLite compara a revisão dentro de BEGIN IMMEDIATE, antes do UPDATE. Revisão divergente retorna REMOTE_CONTROL_INTENT_REVISION_CONFLICT; não há retry nem conversão do conflito em sucesso. A mutação e COMMIT são síncronos. O estado em memória/listener só prossegue depois do retorno confirmado. Para instalação/recovery com DB ausente, expectedRevision null representa a ausência observada; apenas o processo que efetivamente inicializou a store pode prosseguir, se a revisão inicial permaneceu intacta. Dois inicializadores não podem reivindicar a mesma ausência.

O reproducer antes desta correção confirmou enabled/revisão 2 após offline confirmado por outro processo. O mesmo roteiro agora rejeita o Main antigo por conflito CAS, reabre SQLite em offline/revisão 1 e o novo Main recusa startup. Reproducer A4 original no mesmo Main, A1–A3 e suíte G4 77/77 PASS. Regressões G1/G2/G3 52/52 PASS; E2E G4 real WSS/G2/G3/G4 entre Management/Player independentes PASS.

Ownership do runtime de produto: `main.ts` só importa `main-runtime` depois de `app.requestSingleInstanceLock()`; no contexto empacotado, o gate global da instalação também é adquirido antes da composição. Uma segunda instância normal não importa o runtime, e a invocação administrativa encerra antes dessa composição. O teste estrutural `node --test scripts/installation-binding-build.test.cjs` passou nesta revisão e verifica a ordem do lock local, gate empacotado e abertura do runtime. A reauditoria e os testes multiprocessos exercitam owners independentes sobre SQLite compartilhada; o CAS protege a revisão durável mesmo fora desse bootstrap. Não foi introduzido um segundo lock distribuído.

Windows nativo pelo runner oficial: PASS em 2026-11-13, runId `5dffb033-02c0-4189-8056-f376d8d9a89c`, fingerprint `42f2ee6231c1444b4637672933358c67af478cf813f23c41c11b51e59d1c0e34`, branch e HEAD G3 esperados. O manifesto continha 496 arquivos e seus hashes coincidiram com a working tree no momento da execução. A execução incluiu compilação Windows, regressões focadas de intenção/reconexão/reconciliação/store/protocolo/migração, reproducer cross-process A4, E2E G2/G4 com WSS e processos independentes, infraestrutura remota, DPAPI/safeStorage e cleanup. Após o runner, somente documentação foi atualizada; código, testes e scripts testados permanecem iguais ao snapshot. A1–A3 continuam aprovados independentemente; esta seção registra a implementação Luna e não altera o parecer independente FAIL da reauditoria cross-process. Nova reauditoria focal pendente antes de checkpoint/G5. Sem commit/push/PR.


## Reauditoria independente final A4 cross-process — Sol — 2026-11-13

**Parecer vigente: PASS. A1–A4 PASS; G4.1–G4.4 PASS. G4 apta para checkpoint e tecnicamente apta para G5.** A autorização/execução do checkpoint e o início de G5 não foram realizados. Produção permanece não aprovada. Os FAILs anteriores são históricos e permanecem neste registro.

Inspeção focal confirmou: os quatro escritores Main capturam revisão durável antes da preparação assíncrona e a passam explicitamente; `undefined` é rejeitado. `BEGIN IMMEDIATE` engloba leitura, comparação e UPDATE condicionado à revisão. Conflito ocorre antes de no-op ou mutação e faz rollback; não há retry com revisão renovada. Commit/readback precedem confirmação; falha após commit permanece erro incerto. Gerações locais continuam cercando publicação e callbacks após awaits. Nenhum código funcional foi alterado nesta reauditoria.

O reproducer multiprocessos rejeitou enabled antigo com `REMOTE_CONTROL_INTENT_REVISION_CONFLICT`; a reabertura confirmou offline/revisão 1 e novo Main recusou startup. A ordenação inversa foi executada com dois processos Main independentes e SQLite real: enabled confirmou/revisão 1, offline posterior confirmou e reabriu em offline/revisão 2. Uma chamada sem revisão também foi rejeitada. Verificação auxiliar determinística em `/tmp/g4-final-order-b.cjs`, com barreiras IPC, sem sleeps.

**Limite de autoridade:** CAS ordena as escritas duráveis; não é um lease de sockets entre runtimes arbitrários. No produto, `main.ts` impede composição sem o lock Electron e, quando empacotado, sem o gate global de instalação. O caminho administrativo encerra antes de importar o runtime. Busca dos consumidores confirmou apenas uma construção de produção em `main-runtime.ts`; construtores diretos adicionais são testes/harnesses. Shutdown aguarda close remoto antes de liberar o gate global. Testes de bootstrap/gate e verificação estrutural de ordem passaram. Não se alegou uma nova execução de duas instâncias do produto empacotado nesta rodada; a inspeção dos caminhos obrigatórios não demonstrou entrada alternativa nem lacuna concreta que justifique repetir homologação de instalação. Runtimes diretos dos testes não recebem a garantia de exclusividade do bootstrap.

Validação independente: compile PASS; intenção/listener **19/19**, reconexão **12/12**, reconciliação **9/9**; reproducers `g4-reaudit-cross-process-intent.cjs`, `g4-reaudit-intent-race.cjs` e `g4-audit-repro.cjs` PASS. Testes de installation-bootstrap, installation-runtime-gate e installation-binding-build PASS. A primeira execução de quatro casos de listener foi impedida por EPERM no sandbox; reexecução autorizada com localhost permitido passou 19/19. A1–A3 preservados. Sem novo achado bloqueante.

Windows revisado, sem repetir campanha: relatório oficial PASS, runId `5dffb033-02c0-4189-8056-f376d8d9a89c`, fingerprint `42f2ee6231c1444b4637672933358c67af478cf813f23c41c11b51e59d1c0e34`, Node v24.11.0, branch esperada e HEAD G3 `ca6af2e3bed30fa26a98b0921f46f51a59f54a8b`. Das 496 entradas do manifesto, código/testes/scripts coincidem integralmente; cinco diferenças são exclusivamente os documentos atualizados após o runner. E2E/Windows anteriores permanecem evidência revisada, não nova execução nesta reauditoria.

Riscos residuais previamente aceitos permanecem: rollback completo sem evidência externa, recuperação explícita de corrupção, manutenção minimatch e limites G5/G6/H. Nenhum novo risco bloqueante demonstrado. Working tree G4 preservada, sem commit/push/PR. `git diff --check` PASS.
