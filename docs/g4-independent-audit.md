# Auditoria independente integral G4 — Sol

Data: 2026-11-13. Parecer original: **FAIL** (histórico preservado). Parecer vigente após reauditoria final A4 cross-process: **PASS**; checkpoint G4 e prontidão técnica para G5 liberados. Ver registro final abaixo.

## Base e escopo

Branch conferida: `feature/remote-player-lan-integration-3`. HEAD: `ca6af2e3bed30fa26a98b0921f46f51a59f54a8b`, checkpoint G3 esperado. Working tree G4 modificada e com arquivos novos, preservada. Nenhum código funcional foi corrigido nesta auditoria; acrescentados reproducer e documentação. G2/G3 e seus pareceres anteriores não foram reclassificados.

Inspeção abrangeu coordenador, cliente WSS, adapter G2/G3, runtime Main, intenção SQLite, reconciliador/inbox/outbox, migrações Management v10 e Player v2, mudanças de transporte/discovery, testes/harness e seletor Windows. Referências: plano integral G4, evidências, ticket G4, contrato/plano pareados, roadmap e auditorias G2/G3. Os PASS históricos são evidência de execução, sem substituir os contratos e a inspeção das bordas assíncronas.

## Achados bloqueadores

### A1 — P2 — autorização tardia publica sincronização após disable

Local: `src/remote-reconnection-service.ts:233` e `:250–256`.

Causa: há verificação de token/abort antes de `isAuthorizationCurrent`, mas não depois que a Promise resolve. Uma decisão local pode invalidar o canal durante esse await. O retorno tardio `true` publica `synchronized` mesmo quando `disable()` já fechou o canal e publicou `disabled`.

Reproducer: `node scripts/g4-audit-repro.cjs`. Barreira segura a segunda consulta de autorização; `disable()` conclui; a barreira libera `true`. Resultado observado: `state=synchronized`, `connectionId=null`, canal fechado uma vez. Não é prova de comando físico executado, mas é confirmação falsa de sincronização e violação do fence de lifecycle; consumidores futuros podem confiar nesse estado incorreto.

Correção mínima recomendada: revalidar token, abort, enabled/closed e referência do canal depois de cada await de autorização, inclusive caminhos negativos, antes de alterar/publicar estado. Resultado obsoleto deve somente limpar seu próprio recurso. Não transformar disable em reconnect.

Regressão necessária: barreiras nas duas consultas de autorização; disable, close e substituição de canal entre chamada e retorno; assegurar ausência de publicação authorized/reconciling/synchronized obsoleta e recursos drenados. Delegar a correção coordenada ao Luna junto de A3.

### A2 — P1 — perda/truncamento do SQLite apaga o offline explícito

Local: `src/remote-control-intent.ts:43–54,76–98`; consumidor `src/main-remote-runtime.ts:100`.

Causa: falta prova persistida de inicialização distinguindo banco novo de banco perdido. ENOENT retorna `disabled` (ou reimporta JSON legado), e SQLite vazio com application_id/user_version zero é inicializado silenciosamente. O Player recusa somente `offline`; portanto `disabled` permite iniciar o listener. Após restart, o vínculo G2 continua válido e a decisão offline perdida pode deixar de impedir reconexão autorizada.

Reproducer SQLite real: gravar `offline`, remover somente o banco de intenção e abrir novo store; leitura retorna `disabled`. Repetir com banco truncado em zero bytes: a leitura recria schema/default `disabled`. Ambos confirmados em `scripts/g4-audit-repro.cjs`, sem tocar em dados do proprietário. O vínculo G2 não é descartado nem regenerado. O mesmo reproducer confirma que um JSON legado enabled, retido antes da decisão SQLite offline, é reimportado como enabled se esse banco for perdido.

Impacto: viola explicitamente o contrato de falhar fechado após perda/corrupção de store inicializado e de preservar offline após restart. Não depende de acesso de rede não autenticado; pode ser provocado por perda local de armazenamento/restauração parcial.

Correção recomendada ao Luna: acrescentar identidade/marker durável de inicialização com protocolo crash-safe; validar marker e banco antes de permitir startup. Banco perdido, vazio ou incompatível após inicialização deve preservar evidência e exigir recovery explícito. Migração deve ser reconhecida como consumida sem apagar o JSON; não reimportar configuração antiga como se fosse nova. Falha em provar elegibilidade deve impedir listener, inclusive no startup. Não basta tratar `disabled` como offline sem resolver a perda de prova.

Regressões: SQLite real, restart de processo, exclusão/truncamento/substituição depois do commit offline; JSON anterior enabled seguido de SQLite offline perdido; crash nas fronteiras da inicialização/migração; dois processos tentando inicializar ou escrever; falha de commit/readback; nenhuma abertura de listener quando a prova é incompleta. Por ser P1 e envolver durabilidade/recovery, nenhuma correção foi improvisada nesta auditoria.

### A3 — P2 — resposta de snapshot cancelada ainda é persistida

Local: `src/remote-reconciliation-service.ts:query` e sequência `freshSnapshot` → `persistSnapshot` → retorno final.

Causa: `query()` valida sinal antes do await, mas não depois dele; a sequência de snapshot também não revalida cancelamento antes de gravar/publicar. Uma Promise pode resolver, ter o sinal abortado e só depois executar sua continuação. O aborto não desfaz a resolução já ocorrida no cliente WSS.

Reproducer com inbox/outbox e SQLite reais: a segunda resposta snapshot é liberada com o sinal abortado na mesma fronteira. Resultado: snapshot persistido e retorno `state=synchronized`, embora `signal.aborted=true`. Confirmado em `scripts/g4-audit-repro.cjs`. O port controlado representa a fronteira de continuação da resposta; não substitui o transporte como prova de autenticação.

Impacto: evidência de uma conexão já cancelada pode modificar a inbox, contrariando o contrato de respostas antigas não persistirem. O coordenador normalmente impede promoção pelo token depois da reconciliação, mas essa verificação ocorre tarde demais para impedir a escrita. Este caso não prova repetição de efeito físico.

Correção mínima: revalidar sinal/deadline depois de todos os awaits de query e imediatamente antes de persistir páginas/snapshot/status e publicar resultado; transportar fence contextual quando a geração puder mudar sem abort. Conservar a evidência já confirmada, sem limpar cursor para desbloquear.

Regressões: abort entre resolução e continuação para snapshot, journal-page e operation-status; nenhuma escrita posterior ao fence; deadline expirado no último await não retorna synchronized. Reauditar composição real com A1.

## Conformidade e fronteiras

| Lote | Parecer atual | Motivo |
|---|---|---|
| G4.1 | FAIL | A1 permite promoção de estado obsoleto após disable |
| G4.2 | PASS no escopo inspecionado | Query-first usa ID/fingerprint originais, sem comando/retransmissão física automática; contenção G3 preservada |
| G4.3 | FAIL | A2 perde offline em perda/truncamento do store |
| G4.4 | FAIL | A3 persiste snapshot cancelado e anuncia sincronização |

TLS pinado/SAN, bearer G2 e verificação de vínculo continuam no caminho real do adapter. mDNS fornece endereço/porta candidatos e não troca pin nem geração. Não foi identificado caminho alternativo que conceda operação por identidade declarada em JSON ou por simples abertura de socket. Não foi reaberta a seleção OPAQUE.

O reconciliador não envia comandos nem ACK de consumo; a outbox aceita resultado por ID/fingerprint e não interpreta not-found como prova de não execução. Snapshot não preenche cursor recebido; gaps, compactação e linhagem divergente continuam conservadores. Migrações preservam evidência por epoch em transações. Estes pontos positivos não resolvem A1–A3.

Não há nova fila/engine nem integração com playback real no diff G4. Gestão/Player conservam autoridades. Pairing de produção permanece dependente da apresentação real aprovada em G5; aplicação de negócio/cursor/ACK é H3; homologação física é G6/H5. Nenhuma fase posterior iniciada.

## Harness, Windows e correspondência dos arquivos

O harness foi efetivamente ampliado para G4: processos Gestão/Player independentes, MainRemoteRuntime, novo coordenador/adapter/cliente operacional, OPAQUE G2, WSS com TLS pinado, G3, SQLite, troca de endpoint, restart separado/conjunto, recuperação por status original e offline persistente. O presentation port e o handler são sintéticos, conforme o escopo; não representam aprovação de UI/pairing de produção. Não é apenas o E2E G3 inalterado.

Relatório oficial lido em `C:\Users\Chris\source\karaoke-queue-g4-validation\.git\karaoke-queue-last-windows-test.json`: PASS, runId `f3088027-a63d-402f-aa0e-d99cfe5a9b3a`, Node `v24.11.0`, testedAt `2026-11-13T08:31:13.331Z`, branch/HEAD esperados, fingerprint `5321faf82d70ecc989b8086f870864d32d9adeeba1c03f323c8f2f8a4bad890f`.

Comparação SHA-256 das 490 entradas do manifesto contra a origem antes das alterações desta auditoria: **485 iguais** e cinco documentos finais diferentes (ticket, evidências, plano G4, roadmap e plano pareado); **nenhuma diferença de código/testes/scripts**. Fonte compilada usada pelos reproducers corresponde aos módulos executáveis desse snapshot. A1–A3 são lacunas de cobertura, não indício de Windows PASS fabricado. Campanha Windows não repetida: não houve correção de código e os achados são determinísticos nas regras/SQLite. Os reproducers novos ainda não foram executados em Windows nativo.

## Triagem objetiva npm

`npm audit --json` obtido nesta auditoria e salvo em `docs/evidence/g4-implementation/npm-audit-independent.json`. São seis entradas moderadas propagadas de **um advisory** de minimatch, não seis causas independentes. Todas as instalações sinalizadas têm `dev: true` no lockfile.

| Pacote instalado | Relação | Uso e exposição |
|---|---|---|
| electron-builder 26.18.0 | Direto, desenvolvimento | Empacotamento; não atende WSS G4 |
| app-builder-lib 26.18.0 | Transitivo | Ferramentas de build e padrões de arquivos |
| dmg-builder 26.18.0 | Transitivo | Build macOS; não é execução Windows/G4 |
| electron-builder-squirrel-windows 26.18.0 | Transitivo | Build Squirrel; produto usa NSIS |
| @electron/universal 2.0.3 | Transitivo | Build universal macOS |
| minimatch 10.2.6 e 9.0.9 | Transitivo | Raiz do advisory: amplificação de CPU/memória com glob controlado pelo atacante |

[GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249): faixa publicada >=7 <11.0.1; corrigido em 11.0.1. Exige padrão hostil chegando ao processamento vulnerável; não foi encontrado fluxo de mensagens LAN, CSV ou mídia G4 que forneça glob a essas ferramentas. A configuração de empacotamento vem do repositório. Risco residual de build com padrões não confiáveis; **não bloqueia G4** com a exposição atual. O audit sugere electron-builder 25.1.0 como remediação major, um downgrade em relação ao instalado: não aplicar automaticamente. Atualização de minimatch/ancestors requer compatibilidade e validação de build/release separadas. Nenhuma dependência alterada, nenhum audit fix executado.

## Execução desta auditoria e próximos gates

- `node scripts/g4-audit-repro.cjs`: três achados CONFIRMED; suas assertions confirmam o defeito, **não** são uma suíte de aceitação PASS. Inverter/transformar em regressões após correções.
- `node --test build/tests/remote-reconnection.test.js build/tests/remote-reconciliation.test.js`: dois arquivos PASS; cobertura existente não detectou os achados.
- Consulta npm audit e comparação de hashes Windows concluídas. Não repetidos compile, campanha integral G4/Windows ou E2E completo, pois não houve implementação funcional nesta auditoria.
- `git diff --check`: PASS na conclusão documental.

Luna deve corrigir A2 e as bordas A1/A3, adicionar regressões com barreiras/crash reais, repetir os testes afetados e gate Windows dos caminhos alterados; Sol deve reauditar antes de checkpoint/G5. Preservar evidência e alterações preexistentes. Nenhum commit, push, PR, upgrade, alteração de G2/G3, produção ou G5 nesta auditoria.

G4.1: FAIL<br>
G4.2: PASS<br>
G4.3: FAIL<br>
G4.4: FAIL<br>
INDEPENDENT AUDIT: FAIL<br>
G4 READY FOR CHECKPOINT: NO<br>
G4 READY FOR G5: NO<br>
G4 PRODUCTION APPROVAL: NO<br>
BLOCKING FINDINGS: A1 (P2), A2 (P1), A3 (P2)<br>
NON-BLOCKING FINDINGS: triagem de dependências de build descrita acima<br>
COMMIT: NOT PERFORMED<br>
PUSH: NOT PERFORMED<br>
G5: NOT STARTED


## Registro após execução das correções — 2026-11-13

O parecer independente desta auditoria permanece **FAIL** para o estado originalmente examinado; este registro não é reauditoria e não declara o parecer revertido. Luna aplicou as correções autorizadas para A1–A3. `node scripts/g4-audit-repro.cjs` agora passa seus checks de regressão, `npm run test:unit:g4` passa 71/71, as regressões G1/G2/G3 diretamente afetadas passam 52/52 e `npm run test:e2e:g4` passa com processos independentes e OPAQUE/WSS/TLS/SQLite reais. O runner Windows oficial passou na revisão atual: compile, 94 testes focados, integração G2/G4 entre processos, `remote-infrastructure` 23/23, DPAPI/safeStorage e cleanup; fingerprint `2559a710644766c6fc499e97daef79a5a5291b3f4247172118ecc6403eb21bab` para branch/HEAD G3 esperados. Detalhes estão no [diário de implementação](evidence/g4-implementation/README.md).

A1–A3 são considerados corrigidos pelos testes do implementador, mas aguardam inspeção independente do diff e confirmação dos contratos por Sol. Riscos mantidos: rollback que elimina também todas as evidências G2 não pode ser detectado; DB corrompido continua fechado até recuperação local explícita. Checkpoint e G5 permanecem bloqueados até reauditoria PASS. Aprovação de produção continua NÃO. Os seis advisories moderados de minimatch permanecem classificados como não bloqueantes; nenhuma dependência foi atualizada. Sem commit/push/PR e G5 não iniciada.


## Registro posterior — correções Luna de A1–A3, 2026-11-13

Este registro não altera o parecer independente acima. O FAIL original é o resultado da auditoria no estado examinado. O proprietário autorizou correções; a confirmação independente permanece pendente.

### Alterações técnicas feitas

- **A1:** `RemoteReconnectionService` agora invalida gerações no início de `disable()`/`close()`, refaz a validação de token, abort, lifecycle e canal após conexão, autorização e reconciliação assíncronas, e coalesce o fechamento por canal. `MainRemoteRuntime` também cerca start/renewal com geração de intenção para que um callback de Player anterior não sobreviva à decisão local offline.
- **A2:** `RemoteControlIntentStore` usa arquivos já existentes de identidade/autorização G2 como prova independente de que o subsistema remoto foi inicializado. Na falta do SQLite com essa prova, retorna `recovery_required`, sem recriar DB ou reimportar JSON antigo. Arquivo SQLite vazio, incompatível ou corrompido falha fechado e é preservado. Bootstrap novo lê/migra a intenção antes de criar identidade G2; escolha local explícita pode criar uma nova intenção após perda, ignorando JSON legado quando há histórico. Corrupção presente não é apagada/reparada pela escrita normal; requer restauração/recuperação local explícita.
- **A3:** o reconciliador revalida abort/deadline após cada resposta assíncrona e imediatamente antes de persistir página, snapshot ou status. Como as transações do inbox/outbox são síncronas, a verificação imediatamente anterior é o ponto de admissão; cancelamento posterior conserva a evidência já confirmada, mas impede retorno `synchronized`.

### Regressões e validação da implementação

O antigo `scripts/g4-audit-repro.cjs`, que afirmava os defeitos, foi convertido em reprodutor de regressão: agora exige que A1 permaneça disabled após a resposta tardia, A2 mantenha `recovery_required`/erro sem consumir intenção legado stale e A3 rejeite cancelamento sem persistir o snapshot cancelado.

`npm run test:unit:g4` passou **70/70** após as correções. Inclui SQLite real para restart, exclusão/truncamento/corrupção, precedência legado, migração inválida, erro pré-commit e confirmação perdida; runtime Player/Main com listener TLS real para bloqueio e reabilitação; barreiras determinísticas A1; e cancelamento antes/depois da admissão síncrona e de status A3. `node scripts/g4-audit-repro.cjs` confirmou A1–A3 corrigidos. `npm run test:e2e:g4` passou com Gestão e Player em processos independentes, OPAQUE, WSS/TLS pinado, G3 e recuperação após perda do SQLite offline com JSON legado enabled. A execução Windows atual ainda deve ser consultada no diário; os resultados históricos anteriores não são reaproveitados como prova das correções.

### Limites para reauditoria

A2 não promete recuperação de rollback completo que remova simultaneamente SQLite e todas as evidências G2; nesse caso não há prova para distinguir instalação inicial de restauração antiga. Um SQLite corrompido permanece preservado/bloqueado até recuperação explícita. Reauditoria independente de A1–A3 não foi realizada; o parecer aqui continua FAIL até que Sol confirme as correções. G4 não está liberada para checkpoint ou G5, e produção continua não aprovada.


## Reauditoria focal independente Sol — 2026-11-13

**Parecer: FAIL por novo A4 P1.** Os defeitos originais A1–A3 estão corrigidos no escopo reproduzido: A1 PASS, A2 PASS (perda/truncamento/corrupção/migração da store), A3 PASS. G4.1 PASS, G4.2 PASS, G4.3 FAIL pelo A4, G4.4 PASS no escopo focal. Checkpoint e G5 NÃO liberados. O histórico FAIL anterior permanece preservado.

### Evidência independente das correções

Inspecionados `RemoteReconnectionService`, `RemoteControlIntentStore`, `ManagementRemoteReconciliationService`, composição Main/adapter/cliente e testes alterados. Disable/close invalidam tentativas e o coordenador refaz o fence após autorização/reconciliação, sem await entre a última validação e publicação synchronized. As barreiras verificam também o histórico de publicações, não só estado final. A leitura SQLite perdida com evidência G2 retorna recovery_required; arquivo vazio/corrompido/incompatível não é consumido como bootstrap. Main recusa listener nessa condição. Primeira inicialização lê intenção antes de criar identidade G2. BEGIN IMMEDIATE/CAS e busy_timeout/synchronous=FULL em cada conexão preservam concorrência e durabilidade. Isso corrige a perda de store, mas não impede o novo problema de ordenação Main descrito abaixo.

No reconciliador, abort/deadline são checados após await e antes de cada chamada SQLite síncrona. Esse trecho define a admissão sem intercalação de callbacks JS; commit já concluído não é desfeito e não permite synchronized após abort. Cursor recebido não é avançado por snapshot; evidência unknown/recovery e ausência de ACK H3 permanecem conservadas.

Execução independente: `npm run compile` PASS; `node scripts/g4-audit-repro.cjs` PASS nos cinco checks corrigidos; 86/86 testes PASS (intenção 13, reconexão 12, reconciliação 9 e regressões G1/G2/G3 afetadas 52); `node scripts/pairing-process-integration.test.cjs --operational` PASS. A integração inspecionada e reexecutada usa Gestão/Player independentes, OPAQUE G2, WSS pinado, coordenador/reconciliador G4 reais, handshake G3, SQLite, restart e offline/perda de store. O shutdown no reproducer novo usa barreira controlada; ele não é prova de autenticação WSS.

### A4 — P1 — reabilitação antiga sobrescreve offline confirmado mais recente

Local: `src/main-remote-runtime.ts:234`–`238`, em composição com a transição offline em `:223`–`230`.

Causa-raiz: o ramo enabled incrementa playerIntentGeneration e aguarda stopPlayer, mas não valida a geração capturada antes de persistir enabled. O ramo offline posterior persiste imediatamente. A serialização do store só ordena chamadas que já chegaram a ele, não a intenção Main que ficou suspensa antes da admissão. Assim uma escolha antiga chega por último ao SQLite e substitui a decisão local mais recente.

Reproducer determinístico: `node scripts/g4-reaudit-intent-race.cjs`. A barreira segura apenas o primeiro stopPlayer (enable antigo), enquanto o segundo shutdown conclui. A chamada offline posterior retorna sucesso, e a leitura SQLite confirma offline. Ao liberar o enable antigo, ele retorna sucesso e a store reaberta lê `{version:1,intent:'enabled',revision:2}`. As assertions confirmam o defeito, não um contrato correto. Não usa sleeps ou dados do proprietário; SQLite e método Main são reais. A substituição privada de stopPlayer representa a fronteira assíncrona de encerramento; não substitui autenticação como objeto do teste.

Impacto concreto: perde-se a decisão offline já confirmada, mesmo sem corrupção ou exclusão de arquivos. No restart, startPlayer não rejeita enabled; com vínculo G2 preservado, o controle remoto pode voltar a ser elegível sem nova ação local. Viola a precedência da decisão local e o contrato de offline durável. A autorização criptográfica G2 não é contornada; é a política local persistente que foi sobrescrita.

Correção mínima recomendada ao Luna: ordenar as transições de intenção no proprietário Main e invalidar a admissão de uma reabilitação que ficou obsoleta durante shutdown. Capturar/revalidar geração e manter a relação atômica entre escolha vigente e entrada no writer (inclusive awaits internos), ou serializar as transições completas com semântica explícita para a última escolha. Offline deve cercar imediatamente o runtime. Não basta CAS sem definir a revisão esperada da intenção original, nem apenas validar depois do commit.

Regressão necessária: barrier no shutdown de enable antigo; offline posterior confirma; liberar enable e exigir que SQLite permaneça offline, chamada antiga não reporte reabilitação e restart real continue sem listener/canal autorizado. Cobrir também ordem inversa, duas reabilitações, falha de escrita e close concorrente. Correção funcional devolvida ao Luna; nenhuma refatoração ou correção de produção feita nesta reauditoria.

### Windows, riscos e gates

Relatório oficial verificado em `.git/karaoke-queue-last-windows-test.json` do checkout NTFS: PASS, runId `7cb79c30-865b-4ada-a314-d3c3cab17c21`, testedAt `2026-11-13T18:47:53.069Z`, Node v24.11.0, branch/HEAD esperados, fingerprint `2559a710644766c6fc499e97daef79a5a5291b3f4247172118ecc6403eb21bab`. Comparação das 494 entradas do manifesto contra a origem antes desta reauditoria: 488 hashes iguais, seis diferenças somente documentais (ticket, diário, plano G4, auditoria, plano pareado, roadmap); nenhuma divergência de código/testes/scripts. A campanha Windows não foi repetida; o PASS histórico testou exatamente o código com A4, cuja corrida não estava coberta. O novo reproducer A4 foi executado no Linux, não no Windows.

Riscos previamente documentados permanecem: rollback que elimine também todas as evidências G2 é indistinguível de bootstrap; SQLite corrompido exige recuperação local explícita; UI/consentimento real é G5, aplicação transacional/ACK é H3, homologação física é G6/H5. Advisory minimatch segue manutenção não bloqueante, sem nova exposição ou upgrade. `git diff --check` PASS após atualização documental. Sem commit/push/PR; G5 não iniciada.

G4.1: PASS<br>
G4.2: PASS<br>
G4.3: FAIL<br>
G4.4: PASS<br>
A1: PASS<br>
A2: PASS<br>
A3: PASS<br>
INDEPENDENT AUDIT: FAIL<br>
G4 READY FOR CHECKPOINT: NO<br>
G4 READY FOR G5: NO<br>
G4 PRODUCTION APPROVAL: NO<br>
BLOCKING FINDINGS: A4 (P1)<br>
COMMIT: NOT PERFORMED<br>
PUSH: NOT PERFORMED<br>
G5: NOT STARTED


## Correção Luna de A4 — validação técnica, 2026-11-13

Este registro preserva o achado A4 e seu parecer independente FAIL acima. Luna corrigiu a precedência Main; Sol ainda precisa executar a reauditoria focal e não declara a auditoria independente PASS nesta seção.

### Correção e ponto de linearização

Causa confirmada: `setRemoteControlIntent('enabled')` aguardava `stopPlayer()` e persistia sem revalidar `playerIntentGeneration`. Uma escolha offline posterior podia confirmar primeiro e depois ser sobrescrita pela continuação antiga.

Agora cada transição Player recebe sua geração na entrada do Main. Enable valida a geração depois do shutdown e novamente após o store; offline invalida imediatamente a geração, cerca autorização/listener e passa ao store um predicado de admissão. O store revalida esse predicado após preparação assíncrona e imediatamente antes de `BEGIN IMMEDIATE`/mutação SQLite. A validação final e a transação são síncronas, sem callback JavaScript intercalado. Uma requisição que perdeu a geração falha com `REMOTE_PLAYER_START_FENCED` ou `REMOTE_CONTROL_INTENT_TRANSITION_FENCED`, não reporta sucesso e não grava. `close()` também invalida a geração antes de iniciar cleanup. Escrita já commitada mantém sua evidência; falha ou ACK perdido segue retornando erro, sem publicar estado como confirmado.

A verificação local expôs uma corrida adicional no bootstrap cross-process: um segundo Main podia observar o arquivo SQLite em zero bytes entre `open` e o commit do inicializador e confundi-lo com corrupção. O leitor agora aguarda uma notificação limitada de mudança do arquivo e aceita apenas quando o SQLite deixa de estar vazio; sem evidência de inicialização concluída, continua falhando fechado. O arquivo corrompido não é recriado.

### Regressões e resultado

- `scripts/g4-reaudit-intent-race.cjs`: antes da correção confirmou `offline → continuação antiga → enabled` na SQLite. Após a correção passa e um novo Main recusa start por offline.
- Testes A4 com barreiras: enabled antigo aguardando stop → offline confirmado → continuação antiga rejeitada; espera antes da admissão SQLite → offline → tentativa obsoleta rejeitada; duas operações offline; duas operações enabled; close durante enable; estado final reaberto em processo separado continua offline. A escolha enabled posterior explícita permanece permitida.
- `npm run test:unit:g4`: **75/75 PASS** após a correção final.
- `node scripts/g4-audit-repro.cjs` e `node scripts/g4-reaudit-intent-race.cjs`: PASS. Regressões G1/G2/G3 afetadas: 52/52 PASS.
- `npm run test:e2e:g4`: PASS com os processos Management/Player e restart, OPAQUE G2, WSS/TLS pinado, cliente/reconciliador reais, SQLite e fencing offline.
- Windows nativo oficial/checkout NTFS: **PASS**, fingerprint `2a4e19d84f7dea3b32ae374efb149ec9a7023a42c80a529c9962ab7518ea6350`, branch/HEAD esperados. Compile, 98 testes focados, E2E G2/G4 entre processos, `remote-infrastructure` 23/23, DPAPI/safeStorage e cleanup passaram. O relatório oficial terminou REPORT PASS com esse fingerprint.
- `git diff --check`: PASS após atualizar esta documentação.

A4 é considerado RESOLVED pela implementação e pelos testes, pendente de confirmação independente. A1–A3 permanecem preservados e as regressões foram reexecutadas. Riscos já aceitos mantêm-se: rollback que remova SQLite e todas as evidências G2 não é distinguível de bootstrap; DB corrompido exige recuperação local explícita. Os seis advisories moderados transitivos minimatch seguem como manutenção, sem upgrade. A4 não altera autoridade Gestão/Player, G2, fila/playback, ACK H3 ou consentimento G5. G4 está pronta para reauditoria focal, sem liberação de checkpoint/G5 até PASS independente. Produção não aprovada; sem commit/push/PR; G5 não iniciada.


## Evidência final de execução Luna A4 — 2026-11-13

Este adendo registra validação do implementador após o reparo; **não é uma reauditoria independente** e não substitui o parecer FAIL histórico acima.

- `npm run test:unit:g4`: **77/77 PASS**, incluindo a regressão em que um pedido offline antigo termina seu shutdown depois de um enable explícito mais novo e não pode reportar sucesso obsoleto.
- `node scripts/g4-audit-repro.cjs` e `node scripts/g4-reaudit-intent-race.cjs`: **PASS** após a mudança; os reproducers confirmam A1–A3 e verificam A4 em SQLite reaberta por outro Main.
- Regressões G1/G2/G3 diretamente afetadas: **52/52 PASS**. `npm run test:e2e:g4`: PASS, com o resultado registrado no diário de implementação.
- Runner oficial Windows/checkout NTFS: **REPORT PASS**, runId `4e10e589-41fb-4cd7-b9e5-10f2deab8a0f`, Node `v24.11.0`, fingerprint `4b11a16784faf49df02295605c5256ea02c7b5a415bfda13153a977fc7f61199`, branch `feature/remote-player-lan-integration-3`, HEAD G3 `ca6af2e3bed30fa26a98b0921f46f51a59f54a8b`. Compile nativo e 100 testes focados passaram; o E2E entre processos usou pairing OPAQUE G2, WSS/TLS pinado, coordenador Main G4, restart/fencing, replay G3, SQLite independente e resultado incerto. `remote-infrastructure` 23/23, DPAPI/safeStorage e cleanup sem processos residuais passaram.
- Após esse runner, apenas a documentação de evidências/status foi atualizada; código e testes executáveis não mudaram. O fingerprint acima identifica o snapshot executável testado.
- O runner Windows repetiu o aviso de seis advisories moderados; nenhum pacote foi atualizado nesta correção.
- `git diff --check`: PASS após a atualização documental.

O ponto de admissão SQLite é protegido pelo fence da geração capturada no Main e verificada novamente após preparação assíncrona, imediatamente antes de `BEGIN IMMEDIATE`; a mutação/commit ocorre síncrona e sem interleaving JavaScript. Escolha obsoleta rejeita sem persistir ou retornar sucesso. A4 está RESOLVED **para reauditoria focal**; checkpoint e G5 continuam bloqueados até parecer independente PASS. Produção não aprovada; sem commit/push/PR; G5 não iniciada.


## Reauditoria final independente Sol — A4, 2026-11-13

**Parecer: FAIL. A4 P1 permanece bloqueador na concorrência entre processos.** A correção funciona no mesmo Main/event loop; A1–A3 permanecem PASS. G4.1 PASS, G4.2 PASS, G4.3 FAIL, G4.4 PASS no escopo focal. Checkpoint/G5 não liberados.

### A4 — fence local não protege escritores Main independentes

Locais: `src/main-remote-runtime.ts:224–244` e `src/remote-control-intent.ts:144–195`. Cada runtime mantém sua própria geração; Main chama set com expectedRevision undefined. O predicado canAdmit só conhece a geração daquele objeto. BEGIN IMMEDIATE ordena commits, mas não detecta que a intenção que aguardava shutdown ficou obsoleta em outro processo. O CAS disponível no store é opcional e não é usado nesse caminho Main.

Reproducer independente: `node scripts/g4-reaudit-cross-process-intent.cjs`. Dois processos Node executam MainRemoteRuntime sobre um diretório temporário/SQLite real. O filho inicia enabled e sinaliza uma barreira em stopPlayer; o pai confirma offline e verifica sua durabilidade; libera o filho; o filho confirma enabled; após encerrar o filho, o pai reabre o SQLite e encontra enabled, revisão 2. Resultado **CONFIRMED**. Sem sleeps, substituição de SQLite ou qualquer comando de playback. A substituição de stopPlayer representa apenas a fronteira de shutdown pendente. O exit 0 significa que o defeito foi reproduzido, não PASS do contrato.

Impacto: um escritor Main antigo ainda consegue remover offline confirmado por outro escritor e deixar o perfil elegível depois de restart. Não demonstra bypass TLS/G2 ou comando físico. A instância única Electron em main.ts e o gate de instalação empacotada reduzem a exposição do produto normal; não constituem exclusividade no port MainRemoteRuntime/RemoteControlIntentStore, que aceitam processos independentes sobre o mesmo arquivo. O teste existente cross-process cobre CAS explicitamente solicitado ao store, não a chamada Main sem revisão esperada. Esta reauditoria recebeu exigência expressa de verificar esse cenário; não presume que o lock do aplicativo implemente o fence persistente.

Correção mínima recomendada ao Luna: garantir ownership exclusivo entre processos no proprietário da intenção, ou reservar/validar uma geração/revisão durável vinculada à intenção original antes dos awaits e exigir sua validade dentro da transação. Uma intenção offline posterior, inclusive se o valor já for offline, precisa invalidar tentativas anteriores. Apenas ler a revisão depois do shutdown ou usar um mutex que executa enable antigo por último não resolve. Não alterar a autoridade Gestão/Player ou descartar evidência.

Regressão necessária: transformar o reproducer cross-process em teste que exige rejeição do enable antigo, SQLite offline após reabertura e startup remoto recusado no perfil reaberto; cobrir ordem inversa legítima e fechamento de um proprietário. A correção de produção foi devolvida ao Luna; nenhuma refatoração funcional foi feita na reauditoria.

### Verificações independentes

- Compile PASS; reproducer A4 original PASS no mesmo Main; reproducer A1–A3 PASS.
- Suites de intenção SQLite/startup, reconexão e reconciliação: **40/40 PASS**, com barreiras, persistência real, falha de commit/ACK perdido, close, callback antigo e startup concorrente. Esses testes não cobriam a disputa entre dois escritores Main sem CAS.
- Novo reproducer cross-process: **defeito CONFIRMED**, enabled/revisão 2 após offline confirmado.
- Windows histórico conferido no relatório oficial: runId `4e10e589-41fb-4cd7-b9e5-10f2deab8a0f`, fingerprint `4b11a16784faf49df02295605c5256ea02c7b5a415bfda13153a977fc7f61199`, PASS, Node v24.11.0, branch/HEAD G3 esperados. Das 495 entradas do manifesto, 490 hashes coincidem; cinco divergências são exclusivamente ticket/diário/plano G4/auditoria/roadmap. Nenhuma divergência de código/testes/scripts previamente executados. O novo reproducer desta reauditoria não pertence ao manifesto e foi executado somente no Linux. Campanha Windows não repetida.
- A1–A3 e seus PASS independentes preservados. Rollback completo sem provas G2, recuperação explícita de corrupção, minimatch em manutenção e limites G5/G6/H permanecem os documentados.
- git diff --check PASS após atualização documental. Sem commit/push/PR; G5 não iniciada.


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
