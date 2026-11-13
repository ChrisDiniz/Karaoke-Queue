# 0007/0004 — G4: Reconexão e recuperação

## Identificação e estado

- Ticket: 0007/0004
- Etapa canônica: G4; pai 0007 — Comunicação remota segura.
- Status: reauditoria independente final A4 cross-process PASS; G4.1–G4.4 PASS; apta para checkpoint e tecnicamente apta para G5. Checkpoint não realizado; G5 não iniciada; produção não aprovada.
- [Roadmap](../../standalone-player-roadmap.md), [contrato funcional](../../paired-mode-contract.md), [sequência e matriz de testes](../../paired-mode-execution-plan.md), [interfaces/IDs](../../paired-mode-ui-plan.md).

## Objetivo e limite

Reconciliar identidade, estado e operações sem replay cego ou tomada automática de controle.

## Pré-requisitos e dependências

G3.1–G3.4 e G2; sem dependência da implementação H. Política funcional já definida no contrato; suspensão local D2 e restrição de offline D3 são integradas em H; só o destino final da fila suspensa permanece pendente.

## Módulos envolvidos

Ports G3, transporte G1; futuros recovery/reconciliation Main; src/player-playback-recovery*. São pontos existentes ou responsabilidades futuras, não alegação de arquivos novos já implementados. Conferir consumidores antes de editar.

## Lotes incrementais

### G4.1

Implementar handshake de reconexão: snapshot, cursor/eventos, comparação de epochs/revisões e consulta de operação original; não bloquear execução por rede.

### G4.2

Resolver timeout e uncertain; invalidar comandos por sessão/controlEpoch sem apagar resultados antigos; nenhuma nova intenção Avançar no retry.

### G4.3

Expor mecanismo de transição explícita de modo/autoridade e fences; H3 fornece intenção/política de domínio e takeover.

### G4.4

Recuperar após restart sem autoplay, mídia ativa presumida ou perda de resultados; disponibilizar divergência contextual e bloqueio apenas dependente.

## Critérios de aceite

Conexão não implica controle operacional; snapshot e replay convergem mesmo com EOF durante handshake. Comando velho não afeta próxima ocorrência. Não espera ACK segurando lock/transação.

Cada lote entrega diff revisado, testes por impacto e documentação/evidências. Persistência exige preparar → gravar → publicar; sem enfraquecer invariantes ou assertions. Registrar NOT RUN e motivo; PASS técnico não presume aprovação do proprietário.

## Testes obrigatórios

EOF durante reconnect, restart de ambos peers, resultado sem ACK, duplicatas/atrasos, epoch/sessão antiga, falha parcial e corrida entre reconciliação e nova revisão. Rede sintética determinística e integração Main.

Usar relógios/barreiras determinísticos, rede sintética controlada, perfis/bancos isolados e runner Windows oficial quando aplicável. Nenhum sleep arbitrário como sincronização. CI existente recebe somente cenários determinísticos; campanhas físicas/duas máquinas ficam explícitas.

## Interfaces relacionadas

G5 mostra estado; H3/H4 fazem retorno pareado, takeover e decisão de conflito. Não importar fila local.

## Riscos e decisões pendentes

Dependências circulares com H; transporte não deve conhecer política de fila nem interromper playback. D1/D3/D4/D5 resolvidas; D2 parcialmente resolvida (somente descarte definitivo versus retorno da fila suspensa pendente). T1/T2 preservados no contrato; não recriar decisões já aprovadas de autoridade/EOF/pacote.

## Autonomia e conclusão

Implementação apenas com autorização específica do proprietário. Uma autorização de fase não autoriza a próxima. Dentro do lote autorizado, tarefas mecânicas e testes podem ser delegados consecutivamente com ownership exclusivo; parar no gate de decisão técnica/funcional/visual indicado, sem inventar política. Nenhuma etapa foi iniciada por este planejamento.

## Histórico preservado

O ticket anterior era exclusivamente planejado, sem implementação ou validação. A revisão atual detalha esse escopo mantendo ID e posição canônica. A antiga decisão aberta de autoridade em G4 foi resolvida funcionalmente pelo proprietário no contrato pareado; D1–D5 foram posteriormente revisadas pelo proprietário: D1/D3/D4/D5 resolvidas e D2 parcialmente resolvida, conforme o contrato vigente. Não há resultados de testes novos nesta atualização documental.

## Revisão T1 — descoberta/pareamento integral LAN (planejado)

G4.1 acrescenta reconexão automática por vínculo salvo: descoberta/último endpoint como pistas, TLS pinado+bearer antes de confirmar endereço. Um scheduler por peer, backoff 1/2/4/8/16/30 s com jitter e relógio/RNG controlados; cancelar no shutdown e coalescer eventos de rede/Atualizar. Mudança de IP não requer pairing se identidade/certificado permanecem; pin diferente exige UI G2, nunca troca automática. G4.4 cobre resume/DHCP/busy, mensagem antiga e reconstrução de snapshot/eventos/operationId antes de liberar controle. Transporte pode reconectar com Player offline, mas modo/autoridade não mudam automaticamente. Testar queda durante vez, anúncios falsos e recuperação anual.

Referência técnica: [complemento T1 LAN](../../g1-1-t1-lan-pairing.md), ainda aguardando aprovação. Nenhuma implementação/teste de aplicação, alteração Doop ou início automático autorizado. T2/D2 e decisões funcionais aprovadas preservados.


## Análise integral Sol — 2026-11-13

Checkpoint G3 VERIFIED: `ca6af2e3bed30fa26a98b0921f46f51a59f54a8b`, branch `feature/remote-player-lan-integration-3`; árvore limpa na entrada. Reauditoria independente A1–A4 PASS incluída no commit. Produção não homologada; G5/G6/H5 preservadas.

[Plano canônico integral G4](../../g4-full-execution-plan.md): mapeia todos os quatro lotes acima, contratos herdados versus propostas novas, máquina de estados, limites, reconciliação/recovery, testes e gates sequenciais. É a referência detalhada de execução; não duplica especificação neste ticket. Após futura aprovação integral explícita, Luna poderá avançar G4.1 → G4.4 pelos gates técnicos sem autorizações intermediárias. A regra anterior de autorização por lote continua aplicável enquanto não houver essa autorização integral. Esta análise não a concede.

Decisões novas propostas G4-D1–D5 aguardam aprovação conjunta: coordenador/token/canal eleito; replay por barreira; query-first sem retransmissão automática incerta; intenção persistida default disabled e fences; recovery sem reset. H3 mantém aplicação+cursor de negócio transacionais antes do ACK. O mecanismo técnico de transição e persistência é G4; política/takeover/UI ficam nas etapas previstas, sem deslocar recuperação de infraestrutura.

Diário futuro: `docs/evidence/g4-implementation/README.md`, por lote com arquivos/testes/falhas/correções/decisões/riscos. Testes de aplicação/Windows NOT RUN nesta rodada documental. Sem implementação, commit, push ou PR. Plano pronto para revisão/autorização; G4 não iniciada.

A nota T1 acima é histórica: T1 foi aprovada e G2 adotou OPAQUE conforme perfil final, sem reabrir criptografia nesta rodada. Reconexão técnica com vínculo válido não solicita código; produção pairing aguarda G5. Gate Windows G4 obrigatório, campanha física somente G6/H5.


## Execução Luna — primeira entrega parcial, 2026-11-13

O proprietário aprovou os contratos e autorizou todos os lotes. A execução não encerrou: ver [diário de evidências](../../evidence/g4-implementation/README.md). Coordenador por peer e reconciliador sobre inbox/outbox G3 implementados; compile, testes direcionados e SQLite reais PASS. G4.1–G4.4 permanecem PARTIAL: adapter WSS/G2/G3, integração Main, persistência da decisão offline, fences/epochs duráveis, crashes de Gestão integrados, runner Windows e integração real de processos G4 ainda não comprovados. Pairing produção permanece desligado. Bloqueio de rede RFC1918 e falha preflight Windows documentados; nenhuma aprovação material nova foi presumida.

## Execução Luna — fechamento integral dos lotes, 2026-11-13

Esta entrada sucede a primeira entrega parcial acima e preserva seu histórico. G4.1–G4.4 passaram tecnicamente após integração vertical ao runtime Main, sem alterar os contratos funcionais ou as fronteiras de G5/G6/H. O plano [G4 integral](../../g4-full-execution-plan.md) registra implementação e decisões; o [diário de evidências](../../evidence/g4-implementation/README.md) registra arquivos, gates, falhas/correções e limitações.

- **G4.1 PASS:** adapter Main-owned conectado ao WSS G1, vínculo/autorização e pin G2, handshake `hello/ready` e reconciliação G3; reconexão/restart testados entre processos independentes. Socket conectado não libera operação antes da sincronização.
- **G4.2 PASS:** status de outbox consultado pelo mesmo `operationId`/fingerprint; timeout e resposta perdida não repetem operação física incerta. Handler ativo mantém contenção.
- **G4.3 PASS:** intenção offline persistida na SQLite do Player, respeitada no startup real e capaz de cercar listener/clientes antigos; reativação requer ação explícita.
- **G4.4 PASS:** recovery usa journal/inbox/outbox existentes, snapshot e replay contíguo, cursores, epochs/revisions e markers; inconsistências preservam evidência e permanecem bloqueadas. ACK de aplicação de negócio continua reservado a H3.

Validação Linux/WSL2: `npm run test:unit:g4` 55/55, `node --test build/tests/remote-infrastructure.test.js` 23/23 e `npm run test:e2e:g4` PASS com OPAQUE G2 real, TLS pinado/WSS, dois processos independentes, SQLite, reconnect/restart, status incerto e intenção offline. Windows nativo pelo runner oficial/checkout NTFS: compile e 78 testes selecionados PASS, `remote-infrastructure` 23/23, E2E G2/G4 entre processos (inclusive chamadas simultâneas de startup coalescidas), safeStorage/DPAPI, fingerprint `5321faf82d70ecc989b8086f870864d32d9adeeba1c03f323c8f2f8a4bad890f` e cleanup PASS. Falhas iniciais do protótipo (directory fsync `EPERM` e reset não tratado de TLSSocket) foram corrigidas; o primeiro store JSON foi substituído por SQLite transacional para cumprir o gate, preservando seu registro como fonte de migração. O `npm ci` reportou seis advisories moderados; nenhuma dependência foi atualizada.

G4 está pronta para auditoria independente do Sol; auditoria e checkpoint permanecem pendentes. Isto não concede aprovação de produção. Pairing continua aguardando apresentação local real/aprovada em G5; aplicação transacional/ACK de negócio requer H3; homologação física fica em G6/H5. Nenhuma fase posterior iniciada. Commit/push/PR não realizados.


## Auditoria independente G4 — 2026-11-13

Sol confirmou A1 P2 (autorização tardia promove synchronized após disable), A2 P1 (perda/truncamento do SQLite apaga offline explícito) e A3 P2 (snapshot cancelado ainda persiste). Parecer **FAIL**; G4.1 FAIL, G4.2 PASS no escopo inspecionado, G4.3 FAIL, G4.4 FAIL. Checkpoint e G5 bloqueados até correção e reauditoria. Relatório: `docs/g4-independent-audit.md`; reproducer determinístico: `node scripts/g4-audit-repro.cjs`. Windows histórico PASS validado por relatório e 485 hashes de código/documentos iguais; cinco divergências somente documentais. Seis entradas moderadas npm decorrem de um advisory de minimatch nas ferramentas de build, sem caminho explorável identificado em G4; não bloqueiam esta fase. Implementação preservada, sem correção funcional nesta auditoria, commit/push ou início de G5.

## Correções dos achados da auditoria — 2026-11-13

Em mandato explícito, Luna corrigiu A1–A3 sem alterar autoridade Gestão/Player, perfil G2 ou garantias G3. A1 usa fences pós-await e fechamento de canal coalescido; A2 bloqueia estado ausente quando arquivos de identidade/autorização G2 provam inicialização anterior, não reimporta JSON antigo sobre esse estado e preserva SQLite vazio/corrompido; A3 valida cancelamento/deadline após resposta e antes de cada admissão síncrona no inbox/outbox. A primeira inicialização lê a intenção antes de criar identidade G2. Detalhes e limites estão em `docs/g4-independent-audit.md` e no diário.

Regressões Linux/WSL2: `npm run test:unit:g4` 70/70; reproducer independente A1–A3 PASS; E2E G4 em processos independentes PASS, incluindo modo offline, DB removido, JSON legado enabled, ausência de canal sincronizado e reabilitação local explícita. Runner Windows nativo e fingerprint desta revisão ainda pendentes de execução/registro. Isto não é reauditoria independente: A1–A3 aguardam confirmação de Sol; checkpoint e G5 seguem bloqueados. G5 não iniciada; sem commit/push/PR.

### Validação final das correções A1–A3 — 2026-11-13

Atualização posterior à execução do runner oficial: `npm run test:unit:g4` **71/71 PASS**; reproducer A1–A3 **PASS**; `npm run test:e2e:g4` **PASS** com processos independentes, OPAQUE, WSS/TLS pinado, G3 e recuperação do estado offline perdido; regressões diretamente afetadas G1/G2/G3 **52/52 PASS**. A tentativa inicial da suite local no sandbox recebeu `listen EPERM`; a reexecução autorizada com bind local passou sem alterações de assertions.

Windows nativo pelo runner oficial/checkout NTFS: compile e 94 testes selecionados PASS, `remote-infrastructure` 23/23, integração G2/G4 entre processos, DPAPI/safeStorage e cleanup PASS. Fingerprint `2559a710644766c6fc499e97daef79a5a5291b3f4247172118ecc6403eb21bab`, branch e HEAD G3 verificados. Resultado registrado em `docs/evidence/g4-implementation/README.md`.

A1, A2 e A3 estão **RESOLVED para reauditoria**; a auditoria independente original permanece FAIL até Sol reexaminar o diff. Limitações: rollback que remova todas as evidências G2 não é detectável; store corrompida continua bloqueada até recuperação local explícita. G4 pronta para reauditoria, não para checkpoint/G5. Produção não aprovada; G5 não iniciada. Sem commit/push/PR.


## Reauditoria focal independente G4 — 2026-11-13

Sol confirmou A1–A3 corrigidos (PASS focal), mas reproduziu **A4 P1**: enable antigo suspenso em stopPlayer persiste enabled depois de offline posterior já confirmado. SQLite reaberta perde a decisão mais recente; restart volta a considerar o remoto elegível. Reproducer determinístico `node scripts/g4-reaudit-intent-race.cjs` CONFIRMED; devolver correção ao Luna. Parecer independente **FAIL**; G4.1 PASS, G4.2 PASS, G4.3 FAIL, G4.4 PASS no escopo focal. Checkpoint/G5 NÃO liberados.

Compile, reproducer original corrigido, 86 testes focados/regressivos e E2E G4 real entre processos reexecutados PASS. Windows fingerprint `2559a710644766c6fc499e97daef79a5a5291b3f4247172118ecc6403eb21bab` verificado: 488/494 hashes iguais, seis divergências exclusivamente documentais; nenhum código diferente. Campanha nativa não repetida e novo reproducer A4 ainda não executado no Windows. Causa, impacto, correção mínima e regressão necessária estão em `docs/g4-independent-audit.md`. Limites de rollback completo e advisories minimatch preservados. Sem alteração funcional, commit/push/PR ou G5. `git diff --check` PASS.

### Correção A4 — precedência de modo Main, 2026-11-13

O Luna reproduziu a sequência antes da mudança: enable antigo aguardou `stopPlayer()`, offline confirmou e a continuação antiga gravou enabled. A correção atribui geração no Main no momento do pedido e verifica autoridade após awaits e na admissão da mutação SQLite. O ponto de linearização é a transação síncrona admitida enquanto a geração ainda é vigente. A operação antiga agora rejeita; restart em processo independente permanece offline. `close()` também cerca enable pendente. A leitura de arquivo vazio aguarda bootstrap concurrente limitado e continua falhando fechado se nenhum DB válido aparecer.

Validação: G4 75/75; reproducers A1–A3 e A4 PASS (A4 confirmado antes); regressões G1/G2/G3 52/52; E2E G4 PASS; Windows nativo oficial PASS com 98 testes focados, E2E e remote-infrastructure 23/23. Fingerprint `2a4e19d84f7dea3b32ae374efb149ec9a7023a42c80a529c9962ab7518ea6350`; git diff --check PASS. A1–A3 permanecem preservados. A4 aguarda reauditoria focal independente. G4 não liberada para checkpoint/G5 até auditoria independente PASS; G5 não iniciada; sem commit/push/PR.

#### Atualização de validação após a última regressão de precedência

npm run test:unit:g4 passou 77/77; reproducers A1–A3 e A4 e regressões G1/G2/G3 52/52 passaram. E2E G4 entre processos independentes passou. O runner oficial Windows em checkout NTFS concluiu REPORT PASS com compile, 100 testes focados, E2E G2/G4, remote-infrastructure 23/23, DPAPI/safeStorage e cleanup. Fingerprint 4b11a16784faf49df02295605c5256ea02c7b5a415bfda13153a977fc7f61199, runId 4e10e589-41fb-4cd7-b9e5-10f2deab8a0f; branch e HEAD G3 esperados. A auditoria independente não foi atualizada para PASS; G4 está pronta somente para reauditoria focal de A4. Sem commit/push/PR e G5 não iniciada.


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
