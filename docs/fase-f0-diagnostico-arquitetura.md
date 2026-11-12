# F0 — Diagnóstico e arquitetura proposta

> **Encerramento vigente — 2026-11-11:** Fase F, incluindo F0 e suas subdivisões, concluída e validada pelo proprietário. [Registro consolidado](fase-f-encerramento.md). Este documento preserva contratos, planejamento e evidências históricas; menções a homologação pendente ou F1–F4 não iniciadas estão superadas pelo aceite. Classificações técnicas e lacunas de evidência permanecem inalteradas. Prompts e gates históricos não autorizam novas execuções.

> **Correção estrutural vigente:** gate T2, revogação do protocolo e duas corridas de scan corrigidos e validados em fixtures Linux/Windows. Acervo real não acessado nesta correção; sua campanha anterior permanece histórica. F0 não homologada. Ver adendo final e evidências estruturais.

Registro da auditoria inicial: investigação documental concluída em 2026-11-10 sobre a branch `feature/remote-player-lan-integration-2`, HEAD `bc3d37de09462485caa9ff027341eeabdd4b88cb`; working tree inicialmente limpa. Após a aprovação P1/P2/P3 e autorização global, os sete lotes foram implementados nesta execução. O estado de validação e os limites atuais estão no [relatório de execução](fase-f0-relatorio.md) e na [matriz canônica](fase-f0-testes.md). Relatos do proprietário são observações reais; os arquivos AppData originais não foram acessados e o HD pessoal não foi montado nem medido. Fase E encerrada pelo proprietário; isso não transforma limites históricos em homologações adicionais.

## Fontes e reconhecimento

Foram consultados AGENTS.md, roadmap, V1, planos/revisão E, segurança SQLite, procedimentos Windows, backlogs C/D/E/F, biblioteca e catálogo, manifests e código abaixo. `src/` tem módulos planos por responsabilidade e `src/ui/` para Gestão; D1 aprovou manter essa organização. Não reorganizar diretórios. `tests/` combina unitários executáveis Node, integração SQLite, harnesses Electron e testes do Main de produção. `scripts/` contém compile/assets, runner Windows, launcher manual e empacotamento/proveniência. `build-resources/` contém NSIS, identidades e binding Win32; não é local para cache de usuário.

Stack observada em package.json: TypeScript 5.9, CommonJS ES2022, Node >=22.12, Electron ^45, Playwright ^1.64, electron-builder ^26, SQLite no Main por database.ts. `npm run compile` compila também testes e copia assets para build; executável usa `build/main.js`. NSIS x64 perMachine, ASAR e binding nativo são infraestrutura E preservada.

## Fluxo instalado e autoridades

`main.ts` adquire lock por perfil; no pacote Windows valida binding/local confiável e `InstallationControlStore`, adquire gate global em `acquirePackagedInstallationState()` e só então carrega `main-runtime.ts`. A função global é distinta do userData por conta. Welcome resolve primeira escolha e mídia opcional; execução normal respeita manifesto global. Não criar uma segunda autoridade por índice ou onboarding.

Em `main-runtime.ts`, callback `app.whenReady` aguarda `MainMediaRuntime.initializePlayerInfrastructure()` (aproximadamente linha 886), cria catálogo, sequência, opções, shutdown e finalmente `createStandalonePlayerWindow()` (aproximadamente 1068). Renderer → standalone-player-preload.ts → standalone-player-ipc.ts → Sequence/Main → serviços. Política de sender/documento em main-ipc-policy.ts permanece obrigatória. Main possui filesystem, protocolo, banco, sequência e tentativas. HTMLMediaElement no renderer é fonte de observações, não autoridade da fila. Gestão permanece em KaraokeApplication/StateRepository/MainManagementHost, com um writer e transações no database.ts.

## A — Inicialização e índice

**Comprovado no código:** `MainMediaRuntime.initializePlayerInfrastructure` cria nova VideoLibraryService e faz `await library.refresh()` antes da janela. `VideoLibraryService.rootIndexes` e knownCodes são apenas memória; configuração de raízes persiste em video-library.json, CSV no SQLite, mas não há índice de arquivos persistente. `scanOnce` percorre todas as raízes; `scanRoot` usa readdir recursivo ordenado, lstat por entrada; candidato válido abre handle, fstat, realpath, novo lstat, compara identidade e fecha. Não lê deliberadamente os 275 GB de conteúdo nem extrai metadados audiovisuais. Windows/driver/antivírus podem fazer leituras adicionais: não foram medidos.

Refresh completo também ocorre na configuração/refresh explícito. Chamadas concorrentes coalescem com um scan seguinte; não confundir isso com um scan redundante comprovado no startup. `close` interrompe entre operações, mas não cancela uma syscall já pendente. A identidade `rootIdentity` deriva do caminho absoluto normalizado/case-fold Windows, portanto depende da letra; dev/ino validam arquivos no processo, não identificam persistentemente um volume após reboot. Não há detector de mount ou regra especial HDD/SSD/USB/rede. A lógica é a mesma; custos são externos.

**Testes existentes:** video-library.test.ts e video-library-electron.ts cobrem parser, segurança, duplicidades, lookup e falhas. Não provam tempo com 9.000 MP4/USB frio. A documentação video-library.md confirma reconstrução a cada startup: não é divergência documental, mas limitação implementada incompatível com o novo objetivo de startup leve.

**Hipóteses a medir:** cache frio do filesystem após reconexão/reboot; spin-up, latência USB, antivírus, erros/retries do dispositivo. Reindexação completa é fato; atribuir todos os minutos a ela ainda é hipótese. Medir antes/depois por operação e por fase, sem registrar caminhos pessoais.

## B/C — Máquina de estados e recovery

Há três planos distintos: estado estável V1 da Sequence (`idle`, `playing`, `paused`), condições técnicas (`ready`, `transitioning`, `blocked`, `uncertain`), e engine (`idle`, `loading`, `ready`, `starting`, `playing`, `paused`, `stopping`, `stopped`, `completed`, `failed`, `uncertain`, `disposed`). Countdown e celebration são reservas/timers da Sequence, não estados duráveis equivalentes no JSON.

Fluxo normal: submit normaliza código → reserva/validação → countdown → engine load-intent/loading → loadedmetadata/ready → play-intent/starting → observação playing → confirmação playing na Sequence. Pause só confirma com observação correlacionada; EOF validado produz completed, celebração e avanço; Next/Restart têm reservas próprias. Stop All cancela transições conhecidas; a checagem de blocked/uncertain em `prepareCommand` ocorre **antes** de stop-all, portanto não é saída universal do bloqueio. `StandaloneOperationCoordinator` deduplica operationId/payload na vida do Main; árbitro síncrono ordena reservas/commits, não todo I/O. EventCoordinator correlaciona attemptId/código e engine, deduplica EOF. Host usa identidade/epoch e ACK; não substituir por timeout que declara sucesso.

`PlayerPlaybackService.waitForAttemptState` tem limite de 30 s para ready; falhas conhecidas usam failed/error e incertas exigem contenção. A promessa host.ready também é dependência: medir sua resolução e cobrir host que nunca fica pronto. Não há evidência de que SQLite causou o relato. Erro de abertura pode contribuir, mas não é necessário para reproduzir bloqueio de recovery.

`PlayerPlaybackRecoveryCoordinator.initialize` lê store; `pending/playing/paused/uncertain` antigos tornam startupRecoveryRequired verdadeiro. `StandalonePlayerSequence.create` chama setInitialRecoveryBlock. Runtime também chama assertPlaybackAllowed antes de preparar comandos. `isStandalonePlayerLibraryChangeAllowed` exige ready + idle + current null + pending vazio. Assim **um recovery paused antigo basta para bloquear comandos e refresh mesmo sem vídeo rodando**. Esse caminho é comprovado; a vinculação ao incidente exige executar cópia isolada do perfil/evidências. Renderer utiliza último estado confirmado em condições técnicas; aparência idle não comprova engine ativa. Mensagem de ocupação pode descrever esse bloqueio de forma imprecisa.

Store (`player-playback-recovery-store.ts`) limita 16 KiB, valida campos/versão, escreve temporário exclusivo, fsync, rename e sincronização de diretório. Usa `.player-playback-recovery-transaction.json`, cópia previous, fases prepared/committed; leitura recupera escrita interrompida. Preservação de inválidos usa manifesto resolution, hashes e quarentena. Não há garantia absoluta contra perda física de disco/BSOD; testes de falhas de processo não provam durabilidade elétrica.

| Campo da amostra | Semântica |
|---|---|
| version | Versão do contrato JSON, não schema SQLite/licença/SemVer |
| revision | Revisão incrementada de transição persistida; 50 não conta músicas |
| status paused | Última condição durável do coordenador; legítima durante pausa |
| playbackStatus paused | Estado técnico registrado na transição |
| attemptId | UUID da tentativa; não ID de comando nem apresentação Gestão |
| musicCode | Código canônico de cinco dígitos |
| lastTransition | Evento persistido playback-paused |
| updatedAt / startedAt | Timestamp da transição / início registrado da tentativa; não posição de seek |

Shutdown normal passa MainStandaloneShutdownCoordinator → barreira Sequence → contenção/stop → verificação durável → descarte; falha mantém saída normal bloqueada. Crash preserva último registro confirmado. Crash em countdown sem load-intent pode não deixar tentativa durável; loading/starting deixam pending; playing/paused ficam pendentes; celebration pode ter completed anterior (não restaura timer/fila). HD ausente ou música removida não autoriza retomar; registro não é descartado por isso. Corrompido/incompleto bloqueia preservando evidência. Reiniciar e reparar instalador preservam userData por contrato, portanto não são mecanismos de resolução de playback.

## D — Disponibilidade

Snapshot é atualizado por scan/ações explícitas, não monitoramento do dispositivo. OptionsService publica no começo/fim do refresh e mudanças de catálogo; não há polling nativo dinâmico da raiz. `scanOnce` retém índice anterior numa falha e publica degraded/unknown; em processo novo não há índice anterior para reter. `lookup` e `openForPlayback` validam segurança/identidade; falha de I/O não deve virar remoção definitiva. UI recebe snapshot, não consulta filesystem diretamente. Não atribuir Pasta indisponível à reparação sem comparar configuração e acessibilidade no mesmo perfil.

## E — Leitura e buffering

`PlayerMediaProtocol.handleRequest` usa capacidades opacas `kq-media://playback/token`, GET/HEAD, valida Origin, reabre por openForPlayback e suporta Range simples/suffix, 206/416, Accept-Ranges, Content-Length, Cache-Control no-store. FileHandle.createReadStream(autoClose) → Readable.toWeb → Response. O catch anterior à resposta fecha recursos; erro depois da entrega do stream exige teste real de cancelamento/fechamento. Revogar grant não é prova de interrupção de stream já aberto.

`player-playback-renderer.ts` é host técnico compartilhado, cria elemento com preload auto e envia loadedmetadata/timeupdate/playing/pause/ended/error/emptied/waiting/stalled. Não há política explícita de buffer adicional nem uso sistemático de buffered/readyState/networkState para diagnóstico. waiting/stalled não equivalem a EOF nem autorizam avançar. preload é uma indicação, não promessa de carregar todo MP4. Não há engasgo medido nesta sessão. Escolha preferida A: buffering nativo e eliminação de I/O concorrente; B só após medir; C/D adiadas. Não alocar 275 GB/uma faixa inteira em RAM nem manter pré-carga de próximo que prioridades podem mudar.

## Arquitetura aprovada — implementação executada sob autorização global F0

### Índice descartável separado de dados de negócio

P3 aprovada: usar snapshot JSON versionado e atômico Main-only `video-library-index.json` por userData, com store pequeno próprio, sem novas tabelas operacionais. Justificativa: 9–15 mil registros cabem num snapshot, gravação por geração completa e leitura única, reaproveita padrão de validação/rename; SQLite existente continua catálogo/Gestão. Alternativa SQLite é adequada se baseline demonstrar parse/memória/gravação excessivos; essa troca exige revisão do plano, não decisão silenciosa do executor. Não reutilizar recovery como índice.

Schema v1 implementado: version, generation, configurationFingerprint, scanCompletedAt, roots [{rootKey, configuredPath, canonicalRoot, entries:[{relativePath,musicCode,size,mtimeMs,device,inode}]}]. `device` e `inode` são strings decimais de até 64 bits sem sinal: `BigIntStats` conserva os identificadores NTFS exatos, enquanto JSON number os arredondava e fazia o Windows rejeitar gerações válidas. `size`/`mtimeMs` permanecem numéricos limitados/validados. Paths são privados do Main; rejeitar absolutos em relativePath, traversal, duplicidades inválidas, symlink/reparse e limites de tamanho/quantidade. rootKey é ID de configuração persistido no índice; nunca inferir identidade do USB por label/serial não validado. Fingerprint inclui lista ordenada de raízes e versão do parser/política. Conteúdo inválido/incompatível é cache miss preservado para diagnóstico; não bloqueia abrir UI nem altera configuração/CSV. Nenhum marcador de cache pode servir como prova de permissão.

Load de índice não verifica cada arquivo. Publicar inventário em memória como cache candidato e validar raiz/arquivo escolhido antes de grant. A engine atualmente exige scanStatus ready em prevalidate/local validation; adaptar esses consumidores explicitamente para distinguir índice carregado de raiz acessível sem chamar scan pesado. Revalidar caminho canonical/containment, dev/ino quando úteis, size/mtime e ambiguidades no open. Cache não garante ausência de duplicata nova ainda não descoberta: contrato P3 aprovado é resolução pelo último inventário completo, revalidação seletiva e reconciliação eventual. Arquivos novos e duplicidades novas podem ser descobertos depois; ambiguidades conhecidas bloqueiam playback. Não aguardar reconciliação completa para tocar um candidato conhecido validado com segurança.

Mesmo caminho reconectado: sonda leve de raiz, mesma configuração, índice preservado, revalidação seletiva e reconciliação em background. Letra alterada: **não fazer remap automático** nesta F0; operador seleciona pasta pelo diálogo existente, muda fingerprint e faz scan; não reproduzir arquivo em outra unidade apenas porque letra coincide. Reconhecimento automático por GUID de volume fica adiado, sem APIs Win32 novas nesta etapa.

Scan incremental significa reutilizar registros de arquivos sem mudança e reduzir opens; enumeração completa continua necessária para detectar alterações perdidas. Watcher opcional não é requisito inicial. Enumerar em background em startup/reconexão e refresh explícito; remoção só após scan completo bem-sucedido da raiz. Raiz parcial mantém geração anterior e unknown/degraded, sem apagar. Scan valida metadados, não conteúdo MP4. Conclusão com alterações concorrentes não é snapshot transacional do filesystem: revalidar itens alterados no open e agendar reconciliação, nunca prometer atomicidade de diretório externo.

### Coordenação, prioridades e disponibilidade

Um coordenador no VideoLibraryService, com generation + configurationEpoch + availabilityEpoch + AbortController por scan. Um scan ativo, concorrência inicial de I/O 1 (aumentar só com baseline). Refresh coalesce; mudança de raiz invalida geração; resultados antigos não publicam nem persistem. Playback/loading tem prioridade: pausar admissão de novas operações de scan até terminal/idle; fechar cada handle antes de pausar. Não cancelar leitura de mídia para acelerar scan. I/O já pendente pode terminar depois do cancelamento: descartar resultado e fechar handle. Timeout de UI não cancela syscall Windows; no máximo uma sonda pendente por raiz evita acumulação.

Sonda leve realpath/stat/access da raiz a cada 5 s quando janela ativa, 30 s em segundo plano, imediata ao foco/erro de leitura; esses intervalos são política inicial a medir, não sleeps de sincronização. Estado interno separado: availability unknown/probing/available/unavailable/permission-denied e index absent/cached/scanning/ready/degraded. Resultado deve carregar epochs. Reconexão não apaga cache, solicita reconciliação fora do bootstrap. Meta lógica: próxima sonda concluída publica estado atual; latência real depende do SO, registrar atraso/timeout sem declarar falsa disponibilidade. Renderer recebe revisão crescente e subscription; ignora snapshot atrasado. Reutilizar mensagens aprovadas onde semanticamente corretas; qualquer nova copy/layout/indicador requer Doop e aprovação.

### Recovery e convergência

P1 aprovada pelo proprietário nesta consolidação: startup Standalone sempre idle sem autoplay, sem restaurar pausa/countdown/celebração ou fila volátil. Antes de liberar comandos, preservar evidência antiga e confirmar que não existe host/tentativa da execução anterior; startup cria nova sessão de host sem mídia. Usar política específica Standalone no coordenador existente, default compartilhado inalterado. Não alterar recovery autoritativo Gestão/Combined.

Arquivo inválido ou falha de escrita não autoriza ignorar segurança: preservação idempotente com hashes/quarentena e confirmação; se não for possível preservar/confirmar, manter bloqueio explícito recuperável, sem apagar original. Reutilizar protocolo transacional do store; não criar segundo ledger. Registrar resolução de tentativa antiga sem inventar performance concluída. Novo processo não herda operationId volátil. Alternativa de bloquear todo restart aguardando decisão manual não foi escolhida. P1 não mascara falha de persistência ou contenção.

P2 aprovada: em runtime, recuperação só após invalidar epoch, cancelar reserva/timers, conter host (ACK stop ou destruição confirmada), revogar grant/fechar streams e confirmar transição persistida. Falha conhecida de carga retorna idle se não havia atual, preservando pendências; se fim da atual já confirmado e próxima falhou, manter head pendente e bloqueio recuperável, sem autoplay/repetição silenciosa. Incerteza permanece até contenção comprovada; resultado tardio não altera tentativa posterior. P2 aprova a política técnica, não novos elementos visuais. Localizar os frames existentes; se uma ação exigir nova UI/copy, registrar e obter aprovação específica desse elemento, continuando trabalho técnico independente. Não liberar refresh durante playback real, countdown, celebration, reservas ou incerteza.

## Decisões aprovadas e gates remanescentes

P1, P2 e P3 foram aprovadas explicitamente pelo proprietário na solicitação de consolidação, após a auditoria de 2026-11-10. Não solicitar novamente essas decisões. P1 inicia Standalone em idle seguro, sem autoplay/restaurar pausa/countdown/celebração/fila volátil, preservando configurações, dados duráveis e evidências, com resolução idempotente confirmada. P2 exige recuperação runtime com correlação, contenção e persistência confirmadas, sem EOF falso, perda de pendentes ou guardas enfraquecidos. P3 aprova JSON versionado/atômico/descartável Main-only separado do SQLite, UI sem scan pesado, consistência eventual e revalidação seletiva segura; sem remapeamento inseguro de unidade. Default compartilhado e Gestão permanecem preservados.

O proprietário autorizou F0-01–07 em execução autônoma sequencial com avanço pelos gates técnicos; não solicitar autorização por lote. Permanecem aprovação de elemento visual novo no Doop, acesso ao HD físico, uso/instalação operacional quando necessária e aprovação final F0. Inviabilidade técnica demonstrada exige evidência e proposta antes de trocar arquitetura. Matriz canônica em [testes](fase-f0-testes.md) define quando cada contrato se torna exigível; observação de defeito na F0-01 não é PASS funcional.

Roadmap contém parágrafos históricos de E ainda falando em homologação pendente; encerramento do proprietário no topo prevalece, sem apagar evidência. Trechos arquiteturais A1 descrevem main.ts monolítico/autoridade Renderer como histórico; código atual é main.ts → main-runtime.ts e Gestão hospedada no Main após D4. Não transplantar os paths legados removidos em D2. H6 mantém campanha extensa 15 mil/endurance; F0 mede apenas risco crítico e prepara fixture futura.

## Referências oficiais e limites da investigação

A implementação inspecionada basta para os achados acima; foram consultadas as referências oficiais [Electron protocol](https://www.electronjs.org/docs/latest/api/protocol) e [Node filesystem](https://nodejs.org/api/fs.html), sem ensaio físico. Electron confirma o registro antes de ready e stream:true para respostas de áudio/vídeo; Node documenta FileHandle e fs.watch, cujas limitações não autorizam usar watcher como inventário confiável. As páginas latest podem diferir do runtime empacotado; conferir a versão efetiva antes de implementar. Antes de mudar APIs de protocolo/streams, executor deve verificar documentação oficial da versão efetiva Electron protocol.handle/registerSchemesAsPrivileged, Node fs/FileHandle/streams e HTMLMediaElement. Não pressupor que watcher ou preload garantam consistência/buffer. As aprovações P1/P2/P3 registram as políticas; esta revisão inicial não era validação funcional/visual nem aceite final do produto.

## Resultado após implementação autorizada — 2026-11-10

P1/P2/P3 foram aplicadas nos contratos descritos acima, mantendo o recovery compartilhado da Gestão e V1. O caminho Standalone inicia em idle apenas após confirmação de host/recuperação; recovery antigo não reproduz nem reconstrói fila. Em runtime, erro e timeout só convergem após tentativa correlacionada e contenção confirmada. O inventário é armazenado em JSON versionado Main-only, atomizado por geração e separado de SQLite; startup restaura candidato e abre a janela antes de reconciliar; arquivo selecionado ainda é revalidado no open. Disponibilidade usa sondas coalescidas e revisões/epochs, preserva cache em erro temporário e só reconcilia automaticamente a mesma raiz/dispositivo. A identidade NTFS precisa de uint64 decimal para device/inode, descoberta na validação Windows e corrigida antes do gate final.

### Evidência e limites

No runner final, `npm run test:unit` passou 499/499; runner Windows completo, E2E de produção Windows, build candidato e `verify:windows-build` passaram com fingerprint `de3e33242ad4c63feb5fc0b4a574e89c19a43ffbbc50ed3bc5293f4e18b091cd`, HEAD `bc3d37de09462485caa9ff027341eeabdd4b88cb`. O E2E de produção usou Electron/IPC/SQLite reais e MP4 local de fixture. Detalhes de comandos, SHA, matriz e estados PARTIAL/NOT RUN estão no [relatório de execução](fase-f0-relatorio.md), [ledger](fase-f0-testes.md) e [ticket](backlog/0006-fase-f-regressao-estabilizacao-pos-instalacao/0000-f0-estabilizacao-critica-standalone.md).

Medições WSL2 com arquivos MP4 vazios mostram um scan completo de fixture 9k final em 6,38 s e uma restauração de índice + reconciliação de serviço em ~1,48 s, com enumeração total mas zero opens de arquivos inalterados. Não são medida do startup da janela, de Windows nativo ou do HD externo. A unidade D: não estava montada; nenhum dado original foi lido/modificado. Playback nativo foi preservado sem buffering adicional por não haver evidência de que buffer customizado seja necessário. O comportamento com HD lento, USB removido e pacote instalado ainda aguarda validação supervisionada; F0 permanece sem homologação do proprietário.

## Evidência posterior — ciclo de bootstrap com recovery antigo

Validação Windows nativa em 2026-11-10 confirmou D: disponível (NTFS/USB), sem modificar o acervo. Um perfil temporário com recovery `paused` impediu a janela Electron de ser criada no tempo-limite de 30 s. A falha foi localizada no caminho real e não atribui causalidade ao SQLite:

1. `main-runtime.ts` chama `createStandaloneSequence` antes de `createStandalonePlayerWindow`.
2. `createStandalonePlayerComposition` chama e aguarda `resolveStandaloneStartup` antes de retornar a Sequence.
3. `PlayerPlaybackRecoveryCoordinator.resolveStandaloneStartup` exige que `clearFreshStartupRecovery` confirme contenção da tentativa antiga antes de persistir a resolução.
4. `PlayerPlaybackService.clearFreshStartupRecovery` retorna `false` se `this.host` ainda não foi anexado.
5. `PlayerVideoWindow.attachControlWindow` anexa o host durante `createStandalonePlayerWindow`, que só é chamada depois da etapa 1.

Há, portanto, uma dependência circular de bootstrap: confirmar recovery exige host; criar o host exige janela; criar a janela aguarda a Sequence; a Sequence aguarda confirmar recovery. O coordenador então mantém o recovery protegido, e a janela não chega a ser criada. Esta evidência confirma o FAIL da variante Windows/Electron com recovery antigo para P1. Não reproduz exatamente o sintoma visual ocioso descrito originalmente, nem prova que esta foi sua causa exclusiva.

Não remover a guarda, descartar o JSON ou publicar idle sem contenção. A implementação corretiva deve ordenar a criação/identificação de um host novo e sem mídia antes da resolução do registro, mantendo persistência idempotente, evidências e comportamento compartilhado da Gestão. A campanha atual não fez essa alteração.

### Evidência posterior — biblioteca real e disponibilidade

A campanha em runner Windows oficial confirmou o volume USB D: em NTFS e iniciou a primeira varredura real. As assertions funcionais de T1 passaram, incluindo UI utilizável antes do fim da reconciliação e índice populado/coerente com o scan. O processo não exportou tempo, contagem exata e contadores antes de falhar posteriormente; o resultado continua PARTIAL e não há medição quantitativa para D:. Não foi feita uma segunda indexação pesada para compensar essa lacuna. Uma segunda inicialização limpa com a biblioteca real, reconexão física e playback do acervo não foram completados. O harness sintético sem recovery passou separadamente, sem provar performance do volume externo.

No E2E Windows com filesystem temporário, remoção lógica produziu snapshot/UI indisponível, preservou a configuração/índice e a recriação da raiz restaurou disponibilidade após retry isolado. A primeira execução integrada expirou durante a espera de reconexão; a causa dessa diferença não está estabelecida. Não houve remoção física do USB. Evidência detalhada e fingerprint do runner focado estão no [relatório](fase-f0-relatorio.md) e [ledger](fase-f0-testes.md).

Esta evidência posterior prevalece sobre a nota de auditoria anterior que dizia que D: não estava acessível. Sem números reais, a comparação com baseline fica limitada às fixtures Linux/WSL2 descritas historicamente. F0-02 está FAIL para recovery `paused`; F0-01/05/07 continuam parciais em relação ao HD real; T3/T4 são NOT RUN. Nenhuma implementação funcional ocorreu durante a validação e F0 não está homologada.

## Correção do ciclo validada — 2026-11-10

O ciclo acima foi removido pela preparação em duas etapas Main-only: `deferStartupRecovery` cria a Sequence inicialmente bloqueada; Main instala IPC, cria a janela e aguarda o host; `resolveStartupRecovery` confirma coordenador/persistência e então publica ready. Falha ou shutdown durante confirmação não libera admissão. O default da composição e Gestão permanecem preservados. Main real Linux/Windows, nova reprodução após paused e guardas de refresh passaram. O FAIL anterior é histórico; status vigente e fingerprints no [relatório](fase-f0-relatorio.md#correção-autorizada-do-bootstraprecovery--2026-11-10).

T6 tinha pré-condição de foco ausente: 20 s de espera versus sonda de 30 s inativa. O harness passou a exigir foco e passou integrado Windows sem alterar o monitor/timeout. O foco original não foi registrado, logo não se afirma causalidade exclusiva do timeout antigo. T1 real não foi repetido e suas métricas perdidas não foram comprovadas.

## Correção estrutural posterior à revisão T2/T4

Esta seção sucede o diagnóstico de ordenação anterior; as evidências da campanha USB permanecem históricas. P1/P2/P3 continuam aprovadas. A correção foi validada somente com fixtures internas, sem acessar D:.

**Causa T2:** `initializePlayerInfrastructure()` agendava `refresh()` com `setImmediate` antes da janela. `readdir` era assíncrono; seu retorno antecipado não provava bloqueio da event loop. A violação era a admissão de enumeração antes do gate operacional especificado, com possível competição por I/O e CPU no bootstrap.

**Ordem vigente:** Main restaura o JSON sem enumerar mídia; cria catálogo/Sequence bloqueada; cria a janela e instala IPC; anexa host Chromium; aguarda documento e host reais; resolve recovery com contenção e persistência confirmadas; registra `F0_STARTUP_USABLE_METRICS`; conclui a composição/`APP_READY`; chama `MainMediaRuntime.admitStandaloneReconciliation()`. Só então a Promise de background chama `library.refresh()`. O serviço rejeita admissão sem Sequence ready, após shutdown/dispose e não duplica o disparo. Sondas de foco/show/erro retornam sem acessar a raiz antes da admissão; o monitor periódico também começa depois dela. O scan nunca é aguardado para liberar a UI.

Marcos distintos: janela visível não significa comandos liberados; documento carregado não significa recovery resolvido. O gate operacional significa documento/IPC instalados, host confirmado e Sequence ready após recuperação durável. Não é uma medição de primeiro paint nem um ACK de pintura do Renderer. O E2E comprova IPC bloqueado enquanto a prontidão está retida e IPC/mídia reais operáveis quando o scan está artificialmente lento. O primeiro snapshot observado pelo polling pode ocorrer depois de um scan rápido: essa ordem do observador não é um contrato do produto.

**Causa confirmada no protocolo:** a capability era consultada antes de `await openForPlayback`, permitindo resposta válida de abertura concluída após revogação. `PlayerMediaProtocol` agora compara a mesma capability registrada, disposal e `request.signal.aborted` após obter o handle. Resposta obsoleta não cria stream e fecha o handle tardio. Cada capability acompanha seus streams: revoke/dispose os destroem; abort da requisição também encerra o stream; close retira referências/listeners. HEAD revalida a autorização também após fechar o handle. Origin/token/Range e validação física da biblioteca permanecem obrigatórios. Scan não revoga mídia nem destrói streams para ganhar I/O.

A confirmação Stop/idle continua pertencendo ao serviço/Sequence; o teste aguarda eventos reais de fechamento para comprovar liberação assíncrona antes de encerrar o aplicativo. Testes de filesystem mantêm resposta ativa para provar fechamento por revoke/abort/dispose. No E2E Chromium, ranges podem já ter terminado por buffering antes de Stop; isso não substitui aquele teste de stream ativo.

Instrumentação adicional de playback é exclusiva dos testes: observadores no serviço Main e nos comandos/eventos do Renderer registram identidade/hostEpoch e clocks monotônicos separados. Primeiro registro durável da identidade coincide com `loading`/`load-intent`; não é inventado um instante anterior. Submit e playing no Main são observados diretamente. O Renderer mede o instante anterior ao despacho de Enter, não seu keydown consumido pelo tratamento do produto; keydown é `NOT_MEASURED`. O primeiro avanço registrado é um `timeupdate` positivo observado, não o primeiro frame físico. Os antigos 6.059 ms da campanha real foram coletados depois do avanço temporal e não devem ser usados como confirmação inicial Main.

Arquivos funcionais alterados nesta correção: `main-runtime.ts`, `src/main-media-runtime.ts`, `src/player-media-protocol.ts`, `src/video-library-service.ts`. Wrappers/barreiras em `tests/f0-production-bootstrap-entry.ts` invocam o Main real do package depois de instrumentar a fronteira de host; não compõem outro aplicativo. Testes `build/tests/**` permanecem excluídos do pacote. Não houve alteração em Gestão/SQLite/V1, layout, buffering personalizado ou pré-carga. Interleavings e execução estão na [matriz](fase-f0-testes.md#correção-estrutural-t2t4--ledger-de-regressão) e nas [evidências sanitizadas](fase-f0-evidencias-estruturais.json).

A segunda revisão reproduziu duas corridas adicionais em `VideoLibraryService`: (1) o waiter acordava por idle e admitia I/O mesmo se outra tentativa já estivesse ativa; (2) um candidato privado concluído antes da mudança para playback podia publicar uma revisão nova durante mídia ativa. Dois testes falharam contra o código anterior (23/25 PASS, 2 FAIL). O permit agora reavalia playback em loop; também protege ordenação após readdir e publicação antes de trocar a geração. Após cada espera continuam obrigatórios os checks de closed/configurationEpoch/disponibilidade. A revisão publicada fica preservada durante playback; syscall e trabalho já admitidos não são preemptados. A reconciliação pode esperar até idle seguro em reprodução contínua.

### Interleavings revisados

| Estado inicial × evento concorrente | Invariante / resultado esperado | Prova | Risco residual |
|---|---|---|---|
| Índice restaurado/ausente × criação da janela | Nenhuma enumeração antes de documento/host/recovery operacional | Runtime 14 e Main ready/cached-ready | Parse/map do JSON ainda integra o bootstrap por contrato |
| Janela visível × host retido/falho | IPC permanece blocked; sem scan nem falsa prontidão | Wrapper Main host-failed/close-before-ready; host unit deadline/late-ready | Wrapper retém uma fronteira real; não representa todo defeito possível do driver |
| Recovery antigo × clear/commit pendente ou falho | Não liberar comandos/scan sem contenção e confirmação durável | Quatro estados no runtime; cinco variantes Main; persistence-failure preserva paused | Crash elétrico real não executado |
| Bootstrap pendente × shutdown/ready tardio | Disposed é terminal para admissão; liberar recursos sem ciclo | Runtime shutdown/callback tardio e Main close-before-ready | Syscall do SO já iniciada não é cancelável por uma Promise |
| Sonda/show/foco × bootstrap | Sonda retorna sem FS até admissão; monitor começa após gate | Runtime probe-before-gate e zero readdir nos Main cases | Estado cache não é prova de presença física; arquivo sempre revalidado |
| Scan com waiter × idle imediatamente seguido de active | Reavaliar active ao acordar, sem novo root I/O | Nova regressão realpathCalls=0 antes de segundo idle | Prioridade cooperativa nas fronteiras, sem preempção de operação admitida |
| Último candidato privado × loading/playback | Não publicar geração nem invalidar revisão do grant ativo | Nova barreira após scanRoot; revisão anterior mantida até idle | Disponibilidade pode mudar por motivo de segurança independentemente do scan |
| readdir pendente × playback × Stop | Syscall pode concluir; novas entradas e publicação esperam; Stop/clear permite retomada | Main real: currentTime >= 2, yield > 0, lstat de entradas=0; refresh conclui depois de Stop | Não é medição de contenção física USB |
| Refresh × reconfiguração/callback antigo | Epoch/fingerprint novo prevalece; parcial não apaga índice | Biblioteca/store 25+9 testes | FS externo não é snapshot transacional; validar no open continua obrigatório |
| Capability consultada × revoke/abort/dispose durante open | Nenhum corpo autorizado; fechar handle tardio | Quatro barreiras de protocolo com arquivo real | Não promete cancelar a syscall pendente |
| Stream/range ativo × cancelamento/Stop | Fechar stream/handle, revogar grant; não depender do shutdown | Protocolo real e Main Stop/nova tentativa | Ranges Chromium podem ter terminado antes de Stop; teste de corpo ativo é separado |
| Tentativa nova × ACK/playing/pause/EOF antigo | Não alterar a atual nem concluir por EOF falso | Main com filas drenadas; host/service/sequence unitários | Áudio e artefatos perceptíveis exigem pessoa |

Nenhum novo ciclo Main→Sequence→host foi criado. A revisão de caminhos completos confirmou o gate explícito após host/recovery e nenhuma sonda que o contorne. A mudança não libera uncertain, remove guardas ou interfere no writer SQLite da Gestão. Resultados e hashes finais no [ledger](fase-f0-testes.md#correção-estrutural-t2t4--ledger-de-regressão).


## Infraestrutura T3 — adendo verificado

A infraestrutura física/sintética está isolada da produção: [procedimento e segurança](fase-f0-t3-operacao.md), [evidências](fase-f0-t3-evidencias.json). `manual-usb-reconnect.cjs` orquestra autorização/snapshot e worker nativo; core modela checkpoints/resultados; native consulta somente metadados após autorização; adapter observa Main real. `usb-reconnect-main-entry.ts` importa package Main e instrumenta FS/scan/recursos, exigindo permissão de sessão/perfil. Quiescência A para remoção é opt-in do harness: impede novas operações e aguarda as existentes, sem interromper stream ativo. Descoberta normal retorna só depois da confirmação e verificação nativa. Não é nova política do produto.

A regressão sintética real exercita Main/IPC/SQLite/UI/cache e a rejeição de resposta de sonda antiga após nova geração. Identidade/proteção USB são mocks identificados; hardware/timestamps não foram consultados nesta tarefa. Preflight físico falha fechado para preservar metadados: LastAccess conhecido é insuficiente sem proteção contra escrita externamente validada e IsReadOnly nativo. P1/P2/P3, ausência de remapeamento automático e autoridade Gestão/SQLite permanecem preservadas. T3 físico NOT RUN; F0 não homologada.


## F0-08 — resiliência de armazenamento autorizada

Extensão direcionada, sem refazer a auditoria: [máquina de estados e política implementada](fase-f0-08-resiliencia.md). O blocked anterior preservava pending mas só permitia Stop All com limpeza total. Agora Sequence conserva target e filas para resolução manual, cancela timers/gerações e não transforma perda em EOF/Next. Erro conhecido usa contenção/recovery existentes; uncertain exige confirmação e resolução durável. Biblioteca ausente com buffer avançando não interrompe playback; watchdog Standalone opt-in detecta 15 s sem progresso, sem atribuir diagnóstico físico definitivo. Admissão e retomada validam identidade de handle, inclusive depois do countdown. Sem seek confirmado, alternativa explícita é reiniciar do início. Modal foi autorizado sem Doop nesta subfase e recebe apenas estado textual seguro pelo IPC/Preload restrito. Sem mudança no recovery default Gestão/SQLite. T3 físico permanece NOT RUN e sujeito ao seu preflight.

## Campanha T3 + F0-08 — complemento de infraestrutura

O novo modo unificado estende controller/adapter e worker T3, sem alterar máquinas de estado ou persistência de produção. O [procedimento vigente](fase-f0-t3-operacao.md#campanha-unificada-t3--f0-08--testekaraoke) separa mídia protegida de mídia descartável com risco aceito, somente para o testekaraoke verificado. Essa exceção de teste não protege nem autoriza o acervo D:. O provider novo consulta só letra autorizada; mudança de letra encerra a comparação atual e inicia perfil/baseline novo após reidentificação explícita. Não há remapeamento do produto. Perfis/estado volátil nunca são adotados de cenário interrompido; histórico e evidências permanecem. [Resultados sintéticos Linux/Windows](fase-f0-usb-campanha-evidencias.json); físico NOT RUN. A correção de foco identificada nesta entrega foi exclusivamente no harness F0-08, com confirmação do comando recebido no Main.
