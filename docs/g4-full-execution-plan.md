# G4 — Contratos e execução integral de reconexão e recuperação

## Estado e base verificada — 2026-11-13

**Contratos aprovados pelo proprietário para execução integral G4.1–G4.4 nesta sessão.** A aprovação autoriza avanço sequencial pelos gates, sem aprovações intermediárias. Não autoriza G5/H, commit, push ou PR. Contratos herdados seguem distinguidos das propostas G4-D1–D5 aprovadas para esta execução.

Branch `feature/remote-player-lan-integration-3`; HEAD/checkpoint G3 `ca6af2e3bed30fa26a98b0921f46f51a59f54a8b`, `feat(g3): implement durable operational protocol and journal`. Árvore limpa na entrada. Ancestrais: G2 `c36fb1d`, G1 `97f48c7`. O checkpoint inclui a reauditoria independente PASS A1–A4 e implementação G3.1–G3.4. Evidências Windows anteriores são históricas, não execução nesta rodada. G1 foi aceita com limitações; os testes Windows posteriores G2/G3 não homologam descoberta física nem produção.

Fontes herdadas: [contrato pareado](paired-mode-contract.md), [plano executivo](paired-mode-execution-plan.md), [T1](g1-1-t1-secure-transport-proposal.md), [LAN](g1-1-t1-lan-pairing.md), [perfil G2 vigente](g2-1-final-pairing-profile.md), [contrato G2](g2-1-secure-pairing-contract.md), [T2/G3](g3-1-operational-protocol-proposal.md), [auditoria G1](g1-independent-audit.md), [auditoria G2](g2-independent-audit.md), [reauditoria G3](g3-independent-audit.md), [evidências G3](evidence/g3-implementation/README.md), [Windows](windows-native-testing.md). Menções históricas a SRP e gates anteriores não substituem OPAQUE/kq-pair/2 vigente. Nenhuma decisão criptográfica é reaberta.

## Inventário real e fronteiras

| Componente existente | Uso e limite G4 |
|---|---|
| `remote-discovery.ts`, `remote-contracts.ts` | Candidatos não verificados, TTL e limites; descoberta nunca autoriza |
| `remote-clients.ts`, `remote-tls.ts`, `remote-transport.ts` | HTTPS/WSS pinado, hello G1, heartbeat, bounds, autorização e abort no fechamento; cliente ainda precisa de coordenação/cancelamento G4 |
| `pairing-store.ts`, `pairing-authorization.ts`, `pairing-renewal.ts` | Vínculo/cofre, geração, revogação, renovação stage-first; reutilizar, sem nova autoridade |
| `main-remote-runtime.ts` | Composition root lazy; não inicia rede no startup ordinário; apresentação de pairing de produção continua bloqueada sem port aprovado G5 |
| `operational-protocol-contracts.ts`, validation e service | kq-operation/1, hello/ready, query snapshot/status/page, targets e admission fence; `isTargetCurrent` síncrono obrigatório; sem executor H2 real |
| `player-operational-store.ts` | Único journal, tombstones/dedupe, checkpoint, ACK e compactação, recovery e backup; não criar outro store operacional |
| `management-remote-outbox.ts` | `prepare/get/recoverable/transmit/statusQuery/acceptStatus`; intenção persistida antes de rede; original ID/fingerprint |
| `management-remote-journal.ts`, `database.ts` | Inbox no SQLite Gestão existente; migração v9 separa recebimento/anúncio e cerca legado incompleto; sem cursor aplicado H3 |
| `player-playback-recovery*` | Contrato de recuperação local a preservar; não usar como prova de execução remota ou adaptar playback nesta fase |

Gestão é autoridade administrativa, Player de execução. Não sincronizar fila inteira, não criar engine, não alterar prioridade/Round Robin. G4 reconcilia evidências técnicas, disponibilidade e fences; H1 produz intenções/ocorrências, H2 liga execução/snapshot real, H3 aplica resultado e cursor de negócio atomicamente e integra offline/takeover, H4 integra operação visual. G5 apresenta estados reais e pairing local aprovado. G6/H5 homologam duas máquinas/A/V reais. Nenhum destes limites dispensa G4 de implementar restart, timeout, reconexão, diagnóstico contextual e bloqueio dependente com handlers sintéticos.

## Arquitetura proposta e recursos

Criar coordenador Main-only por peer salvo, com scheduler e reconciliador testáveis por clock/RNG/transporte injetáveis. Nomes previstos: `remote-reconnection-service.ts`, `remote-reconciliation-service.ts`, `remote-recovery-contracts.ts`; podem ser simplificados pelo executor. Integrar pelos ports existentes no runtime, sem Renderer privilegiado, SQL exposto ou endpoint paralelo. Não instalar handler operacional real.

Uma tentativa e um canal eleito por peer; uma consulta de reconciliação pendente por canal; eventos live são pistas para replay, evitando buffer não limitado. Coalescer anúncios, refresh, resume e mudanças de interface. Último endpoint é pista não confiável; tentar candidatos LAN válidos e recentes pelo cache limitado G1, com ordem determinística/round-robin para evitar starvation por endereço antigo. Não fazer scan de subrede. Sucesso de endpoint só depois de pin, identidade, vínculo e hello; não gravar endereço como autoridade.

Backoff herdado T1 1/2/4/8/16/30 s; proposta de jitter multiplicativo uniforme [0,8;1,2], teto absoluto 30 s, clock monotônico/RNG injetados. Reset somente após sincronização técnica bem-sucedida. Falha temporária permite tentativas indefinidas espaçadas enquanto habilitado; não há loop apertado. No máximo uma tentativa global de conexão ativa no coordenador Gestão; pares adicionais aguardam scheduler bounded pelos vínculos persistidos, sem criar vínculos de anúncios. Cache G1 máximo 64 candidatos, envelopes 64 KiB, páginas até 32 eventos, fila G1 até 64 e buffered bytes 256 KiB preservados. Processar outbox incrementalmente, sem carregar histórico ilimitado novo; adaptar listagem existente com paginação se necessário.

Usar prazos existentes: TLS/hello/autorização 5 s, HTTP 10 s, heartbeat 15 s + timeout 10 s, shutdown de transporte 3 s. Consulta G4 proposta 10 s; rodada de reconciliação 30 s, preservando commits parciais e retomando do cursor durável. Não esperar silêncio infinito do journal para reconhecer prefixo sincronizado: capturar barreira HWM e continuar incrementalmente após ela. Não esperar rede mantendo lock/transação. Timeout não cancela fato durável nem comprova término do handler.

Adicionar AbortSignal ao cliente quando necessário; invalidar tentativa, remover listeners/timers, destruir requests/agent e terminar socket após prazo de close. Shutdown cancela scheduler/discovery e novas admissões; drena serviço G3. `blocked` com handler vivo impede fechar seu store/recursos como se estivesse idle. Worker OPAQUE não é iniciado na reconexão normal; workers de pairing já existentes mantêm lifecycle G2. Falha de cleanup deve aparecer como blocked, sem fabricar encerramento completo.

## Identidade, restart e disputa

Reconexão automática usa vínculo active salvo, bearer protegido e certificado TLS exato pinado/SAN/identidade do peer. Não solicita código se tudo continua válido. mDNS e DHCP só mudam endereço candidato; nenhum TXT muda pin, geração ou identidade. Revalidar G2 após awaits e antes de admissão/ACK; revogação cerca imediatamente e fecha o canal, sem retry autorizado. Rejeição de autorização ou pin de candidato impede uso daquele candidato; anúncios falsos não revogam vínculo legítimo nem impedem tentar outro endpoint pinado válido. Se nenhum endpoint confiável resolve, expor identity/auth conflict, sem autoaceitar substituição.

Certificado expirado ou trocado requer fluxo guiado G2 existente com apresentação G5; G4 não renova por descoberta. Recuperar journals G2 stage/pending/commit pelo coordenador aprovado antes de listener/conexão; geração só muda com prova durável G2. Nunca adotar geração anunciada. Rollback de geração/linhagem comprovado bloqueia efeitos.

Persistir intenção local de remoto habilitado/desabilitado em configuração Main proprietária (aditiva, sem inferir de socket ou vínculo). Ausência do novo campo significa desabilitado, preservando startup lazy atual. Port explícito habilita para testes e futura UI; nenhuma ativação de produção nesta fase. Se remoto estava habilitado e vínculo íntegro, reiniciar infraestrutura e reconciliar automaticamente. Player explicitamente offline pode permitir canal técnico de diagnóstico, mas continua com fence de controle após restart; não muda para pareado automaticamente. Desabilitar infraestrutura cancela também canal diagnóstico. Falha de gravação da intenção mantém fence imediato e estado blocked, não confirma persistência ao chamador.

Eleição local serializada por peer: primeiro canal autorizado eleito permanece; adicional é diagnóstico/recusado BUSY, sem desalojar o vencedor. Fechamento observado permite próxima tentativa; cada tentativa possui token local monotônico e conexão/correlação. Toda continuação assíncrona confere token atual; resposta antiga não libera controle nem atualiza outbox/cursor. No Player a serialização/dedupe e target fence G3 permanecem obrigatórios mesmo com dois sockets. Não inventar lease distribuído ou mudar autoridade G2; concorrência entre instâncias usa writer exclusivo e falha fechada existentes.

## Máquina de estados proposta

Estados técnicos internos; não são copy/layout G5. Publicar visão imutável com motivo, peer, token, cursor recebido e barreira, pendências e bloqueios por contexto, sem segredos/caminhos.

| Estado | Entrada e saída permitidas |
|---|---|
| disabled/offline | Intenção persistida desabilitada ou controle offline; só ação explícita habilita infraestrutura/retorno de controle respectivamente |
| discovering/backoff | Vínculo salvo + política habilitada; candidato válido leva a connecting; shutdown cancela |
| connecting | Pin + G1 hello + G2 atual levam a authorized; timeout/queda a backoff; identidade/auth inválida a diagnóstico de conflito |
| authorized | Transporte e vínculo válidos, zero permissão operacional implícita; hello/ready G3 levam a reconciling |
| reconciling | Snapshot, replay e status confirmados até barreira; sucesso leva a synchronized; lacuna/rollback a recovery_required |
| synchronized | Prefixo técnico consistente; queda volta a backoff; nova geração/revisão cerca e reconcilia; não equivale a controle retomado |
| conflict/recovery_required | Evidência incompleta/divergente preservada; queries seguras/diagnóstico permitidos; não liberar efeitos dependentes; saída só com prova/ação explícita validada |
| stopping/blocked/closed | Cancelar entradas; closed só após recursos encerrados; blocked retém handler/recursos vivos e permite nova drenagem após término observado |

Permissão efetiva é conjunção de canal eleito/autorizado, sincronização atual, modo pareado explicitamente confirmado, fences atuais, store saudável, alvo atual e ausência de incerteza dependente. Em G4 sem adapter H, essa permissão de negócio permanece falsa. Conexão por si só nunca confirma retomada. Queda não pausa nem interrompe uma execução já aceita.

## Reconciliação e recuperação propostas

1. Capturar token local, identidade/vínculo/geração e cursores persistidos; negociar G1 e hello/ready G3. Conferir `journalId`, `playerEpoch`, `controlEpoch`. Epoch de execução muda com restart real; controlEpoch só pelo proprietário/fence explícito. Não gerar IDs para escapar de inconsistência.
2. Pedir snapshot correlacionado; persistir anúncio consistente (`highWatermark`, `compactedThrough`, revisões), sem avançar `throughSequence`. Snapshot não prova EOF nem completa operação física. Revisões/epochs incompatíveis invalidam alvos antigos sem apagar resultados consultáveis.
3. Ler páginas contíguas desde `throughSequence`, até barreira capturada, e persistir página+cursor recebido na mesma transação existente. Eventos live apenas disparam nova leitura; duplicata idêntica é idempotente, payload divergente conflita. Resposta fora da correlação/token não persiste. Página vazia abaixo de HWM, gap, regressão de HWM ou cursor acima do remoto => recovery, nunca EOF falso.
4. Se cursor < compactedThrough, journalId diverge ou há recovery legado, preservar ambos os lados e bloquear dependência. Não saltar para snapshot, diminuir cursor, apagar inbox/journal ou inventar eventos. Snapshot pode informar diagnóstico contextual. Inexistência local de inbox não é prova de instalação nova se o Player já compactou; começar de zero apenas quando replay integral desde zero é comprovável.
5. Consultar pendências da outbox pelo `operationId` original. Validar identidade, fingerprint e transição G3; terminal só por evidência durável autenticada. Não alterar corpo/alvo de intenção antiga. Consulta status é independente do replay quando inbox estiver bloqueado, desde que segura/autorizada; não limpa recovery.
6. Publicar synchronized para prefixo técnico validado; revalidar geração, token e revisões antes de anunciar. EOF durante handshake entra no próximo replay; não congelar mídia. Expor recebido/aplicado separadamente: G4 não implementa cursor de negócio nem emite ACK de consumo automático. Futuro H3 aplica evento+cursor em transação de domínio, verifica recovery e só então fornece ACK durável; harness pode fornecer ACK sintético explicitamente identificado.

| Falha/cenário obrigatório | Resolução conservadora |
|---|---|
| Antes do envio | `not-sent` durável permanece; só transmitir mesma intenção se alvo ainda válido e permissão explícita; reconnect não cria Avançar novo |
| Após enviar antes da resposta | outbox já unknown; consultar ID, não disparar efeito novamente |
| Após aceite durável / resultado com resposta perdida | status/replay recuperam accepted ou terminal; duplicata não executa handler novamente |
| Gestão reinicia | abrir SQLite/outbox/inbox, retomar cursor recebido comprovado e consultar pendências; nenhum ACK por snapshot |
| Player reinicia | accepted pendente torna-se unknown pelo store; novo playerEpoch cerca comandos; sem autoplay ou mídia ativa presumida |
| Ambos reiniciam | primeiro recuperar stores/G2, depois canal e reconciliação; nenhuma ordem de startup é prova de sucesso |
| Resposta de conexão antiga | token/correlação rejeitam; resultado durável segue consultável no canal atual |
| Duplicatas/fora de ordem | idempotência por conteúdo; pedir página desde cursor confirmado, sem buffer ilimitado ou aplicação fora da ordem |
| Gap / snapshot adiantado / compactação | snapshot não preenche eventos; replay ou recovery_required com evidências preservadas |
| journalId/geração divergente | fence contextual; não resetar IDs nem substituir vínculo automaticamente |
| Backup/rollback antigo | comparar cursores remotos, HWM, compactedThrough e markers; discrepância exige recovery explícito, não apagar para desbloquear |
| Execução física desconhecida | unknown permanece; não repetir efeito para descobrir resultado |

**Política de retry proposta:** consultas/leitura e transporte podem repetir com novas correlações. G4 não retransmite automaticamente comandos unknown/accepted. `not-found` não prova que efeito nunca ocorreu após perda/rollback; mantém incerteza se houve tentativa de envio. Reenvio idempotente G3 continua disponível sob contrato original, mas não serve de estratégia automática G4 para efeito incerto. `not-sent` pode aguardar produtor H e alvo fresco; nunca reescrever target antigo para nova ocorrência.

## Estados conservadores e provas de saída

`accepted` sem terminal: observar/consultar; não admiti-lo novamente no executor. Timeout marca unknown e pede abort cooperativo; handler continua contado até assentar. Término tardio não sobrescreve unknown (A1). `blocked` sai para idle somente com término observado/drenagem real, sem transformar resultado físico em completed. `unknown` não vira completed por timer, snapshot ou desconexão; terminal já comprovado pelo journal pode atualizar a outbox conforme transições existentes, mas G4 não reclassifica registro unknown terminal do Player. Evidência externa/decisão de domínio que demande novo contrato fica para aprovação, preservando diagnóstico.

`recovery_required` persistente não é limpo por novo socket, novo snapshot ou restart. Esta proposta entrega diagnóstico e port de solicitação explícita de recuperação, sem botão genérico “limpar”. Recuperação automática limita-se a retomar replay íntegro sem marker e consultar resultados originais. Recuperação de marker exige prova completa e procedimento específico já suportado pelo store; na ausência deles, permanece bloqueada para revisão. Não prometer repair arbitrário. Leituras/status de outros contextos e administração local independentes continuam; operação com alvo/linhagem incertos é bloqueada. Nenhum bloqueio técnico liga Stop All, troca fila ou altera reprodução por efeito colateral.

Rollback integral de ambos os bancos com perda de toda prova externa pode ser indetectável. Sem autoridade externa/ancoragem nova, G4 não promete detectar esse cenário nem exactly-once físico. Registrar esse limite e falhar fechado quando houver evidência de divergência; não inventar detecção absoluta.

## Todos os lotes canônicos e gates

Arquivos novos são previsão, não existência. Ownership de implementação é sequencial; não há escritores/builds/perfis/bancos concorrentes. Para todos: compile, testes novos e consumidores afetados, diff review, evidência e contrato validados antes do próximo. Falha corrigível exige correção e repetição focada. Bloqueio material impede somente dependentes; trabalhos independentes podem continuar, sem declarar o lote PASS.

### G4.1 — Handshake de reconexão

- Objetivo: scheduler por vínculo, descoberta/DHCP, cancelamento e handshake snapshot/cursor/epochs/status sem bloquear execução por rede.
- Arquivos: novos services/contracts acima; `remote-clients.ts`, runtime e ports discovery/protocolo/inbox; testes `remote-reconnection.test.ts`, `remote-reconciliation.test.ts` previstos. Sem alterar playback.
- Dependências: G1/G2/G3 auditados; ler estado real antes de editar. Implementar eleição/token, pin+G2, backoff, transporte cancelável, barreira e replay/inbox pelas regras anteriores; sinalizar gaps sem reparo inventado.
- Invariantes: conexão ≠ controle; um scheduler; cursor só após commit; sem ACK automático; sem segredo em logs.
- Unitários: clock/RNG, coalescing, jitter/cap, timeout/abort, anúncio falso, identidade/pin divergente, BUSY, stale token, reordenação/correlação.
- Integração: WSS/TLS real com OPAQUE/vínculo real, mudança de endpoint com mesmo pin, página SQLite, EOF sintético durante snapshot e evento posterior à barreira; revogação durante await.
- Crash/restart: queda durante handshake, commit do inbox antes da resposta, reabertura e retomada sem salto.
- Regressões: discovery-cache/private-network, remote-infrastructure, protocolo/inbox; pairing-wire se cliente/transporte mudar.
- PASS/avanço: canal e replay convergem até barreira ou erro conservador determinístico; zero efeito sintético no reconnect; cleanup completo demonstrado. Contrato/testes registrados permitem G4.2.

### G4.2 — Timeout e uncertain

- Objetivo: recuperar status de intenção original; invalidar sessão/controlEpoch antigos e preservar resultados.
- Arquivos: reconciliador, `management-remote-outbox.ts`, `operational-protocol-service.ts` apenas se necessário; testes de serviço/outbox/reconciliação; integração de processos existente.
- Dependências: G4.1; ports status/fingerprint/tombstone G3. Implementar enumeração bounded de pendências, correlação, classificação transitória/permanente, status terminal e bloqueio dependente. Sem retry físico automático.
- Invariantes: mesmo operationId/fingerprint; resultado terminal não regride; accepted/unknown não executam de novo; handler pós-timeout permanece contado.
- Unitários: matriz not-sent/unknown/accepted/completed/rejected/not-found, duplicata idêntica, conflito, resposta antiga, target stale, timeout com handler retido por barreira, resolução/rejeição tardias.
- Integração: perder conexão antes de envio/depois de envio/depois do commit/depois do resultado; consultar por WSS autenticado e verificar contador físico sintético ≤1 por operação admitida.
- Crash/restart: matar Gestão/Player nas quatro fronteiras, accepted recuperado unknown, restart simultâneo; resultado e tombstone sobrevivem.
- Regressões: serviço/outbox/store, reproducer A1–A4, protocolo e integração `--operational`; não repetir auditoria criptográfica.
- PASS/avanço: zero reexecução incerta, nenhuma falsa conclusão, handler ainda ativo impede close/segunda admissão; cenários e invariantes registrados liberam G4.3.

### G4.3 — Transição explícita de modo/autoridade e fences

- Objetivo: mecanismo técnico persistente de intenção/fence, com CAS/revalidação contra revisões; H3 fornece política/takeover e confirmação.
- Arquivos: contratos/coordenador/runtime, persistência proprietária mínima aditiva; tests de lifecycle/transição e migração se banco afetado. Reutilizar camada existente; não colocar política na renderização.
- Dependências: G4.1/2; geração G2 é distinta de playerEpoch/controlEpoch/revisão. Persistir fence antes de confirmar transição; porta de containment/eligibilidade sintética nega quando não conectada. Offline durante vez ativa é recusado pelo futuro proprietário H3; G4 exige prova atual pelo port e não produz Stop All.
- Invariantes: nenhuma retomada automática de controle, sem apagar decisões locais, reconexão não é takeover; invalidação cerca await antigo; falha de commit não publica modo confirmado.
- Unitários: enable/disable idempotente, CAS velho, transições concorrentes, confirmação obsoleta, local ativo, unknown dependente, save fail/readback indisponível, ausência de adapter nega.
- Integração: dois sockets e revogação/disable durante reconciliação; simular containment sem playback, manter consulta de resultado antigo; nenhum evento funcional H fabricado.
- Crash/restart: antes/depois de commit da intenção/fence; desabilitado permanece desabilitado; vínculo salvo não reabilita modo.
- Regressões: runtime/transporte/autorização, migração se afetada, serviço G3 e shutdown. Não alterar scopes nem PairingAuthorization para representar modo de playback.
- PASS/avanço: mecanismo testado independentemente de H, persistência confirmada e fence efetivo antes de liberar qualquer port; H apenas consumidor futuro claramente documentado. Gate permite G4.4.

### G4.4 — Recuperação após restart e divergência contextual

- Objetivo: fechar composição do ciclo, restore/rollback, resume/DHCP/busy e recuperação sem autoplay; expor bloqueios contextuais.
- Arquivos: runtime/coordenador, diagnósticos tipados, stores/inbox somente por necessidade comprovada; testes `remote-recovery.test.ts` e worker/process integration previstos; runners oficiais/evidências/documentação.
- Dependências: G4.1–3; implementar sequência stores/G2 → política persistida → transporte → reconciliação; recuperação segura retoma prefixo comprovado, inconsistência permanece preservada.
- Invariantes: snapshot não presume mídia ativa/EOF; journal não é recriado; resultados antigos legíveis; nenhum cursor reduzido ou repair destrutivo.
- Unitários: matriz de estados/saídas, journal divergente, compactedThrough além do cursor, HWM regressivo, inbox legado recovery, quota e armazenamento indisponível, cancel/shutdown blocked.
- Integração: dois processos e SQLite reais, perda/restauração controlada de endpoint, restart separado/simultâneo, replay paginado, snapshots adiantados, gaps e resultados sem ACK; ACK somente por consumidor sintético explicitamente marcado.
- Crash/restart: backup antigo Gestão e Player, perda total de inbox com journal compactado, commit incerto e readback falho; preservar evidências/markers. Provar limites do rollback bilateral, sem teste que finja detectabilidade absoluta.
- Regressões: G3 replay/store/inbox/service/migração e A1–A4, runtime/discovery/WSS, shutdown local e playback-recovery somente se composition root afetar seus consumidores.
- PASS final: todos cenários G4 determinísticos + integração independente + gates Windows diretamente relevantes PASS, sem processo/timer/socket residual, documentação e diff revistos. Se Windows indisponível: NOT RUN, validação G4 incompleta, não declarar PASS global. Não iniciar G5/H; preparar auditoria independente e checkpoint posterior pelo proprietário.

## Campanha e evidências de execução

Reutilizar `tests/remote-process-worker.cjs`, `scripts/pairing-process-integration.test.cjs --operational` e padrões de worker/store existentes. Integração exige OPAQUE real, bearer autorizado, TLS pinado, WSS e SQLite reais em processos/perfis independentes na mesma máquina; handlers sintéticos com contadores e barreiras de envio/admissão/commit/resultado. Rede perdida deve ser close/drop controlado, não sleeps. Clock injetado controla scheduler; barreiras controlam concorrência. Registrar contagem do handler e conteúdo/cursor após restart, não apenas Promise resolvida.

Base de comandos existentes: `npm run compile`, `test:unit:operational-protocol`, `test:unit:operational-service`, `test:unit:operational-store`, `test:unit:operational-replay`, `test:e2e:operational-process`. Rodar testes novos compilados com Node e adicioná-los ao seletor adequado. Não rodar toda `test:unit` sem impacto demonstrado; não mudar expectation sem requisito/autorização. Correções novas exigem regressão observável.

Windows é gate: estender seletor oficial `--operational-store` ou criar seletor G4 explícito com testes do próprio runner (`scripts/windows-native-runner.test.cjs`); incluir suites novas, integração de processos e runtime Electron quando composition/safeStorage/lifecycle depender dele. Executar de WSL em checkout NTFS pelo runner `scripts/run-windows-native-tests.cjs`, revisar untracked e hashes antes de aprovar transferência. Registrar HEAD, fingerprint, runId, runtime e cleanup. Não testar Windows diretamente no checkout WSL, remover locks ou modificar checkout durante runner. Prerequisito ausente => NOT RUN e motivo, sem bypass. Não repetir smokes OPAQUE/ASAR completos salvo impacto no worker/empacotamento. Não alterar CI/release ou publicar artefato por efeito colateral.

G4 não exige dois computadores, A/V perceptível nem Doop porque não altera visual. G5 compara UI aprovada, G6/H5 fazem homologação física. UI/reprodução de produção não podem ser alegadas pelo harness sintético.

## Autonomia, decisões e diário

Após autorização integral: para cada lote, conferir Git/local rules e consumidores → implementar → compile/testes → corrigir → repetir afetados → revisar diff/contrato → registrar evidências → avançar automaticamente pelo gate. Preservar staged/unstaged/untracked preexistentes; não reset/clean/overwrite. Não usar bancos/perfis reais. Sem commit/push/PR, mesmo ao terminar.

Luna pode decidir nomes/organização interna, interfaces auxiliares, pequenas refatorações necessárias, tratamento de erros compatível, fixtures, correções de concorrência comprovadas, bounds menores compatíveis, lifecycle/cleanup e documentação pontual. Registrar motivo, alternativas relevantes e teste que demonstra o resultado. Ajustes de testes não autorizam enfraquecer assertions ou remover cobertura; expectation existente exige requisito ou autorização conforme AGENTS.

Exigem aprovação material: mudar autoridade Gestão/Player, durabilidade/dedupe, autenticação/pinning/scopes, descartar evidência, repetir efeito físico incerto, contrato criptográfico G2, alteração substancial T2, operação H, produção pairing ou comportamento funcional aprovado. Parar apenas dependentes; registrar pergunta concreta, prova e alternativas conservadoras; continuar independente seguro. Não pedir aprovação para escolha mecânica já coberta.

Paradas objetivas: regressão não resolvida, prova durável insuficiente, incompatibilidade material de protocolo, perda de recurso sem cleanup seguro, risco de sobrescrever trabalho alheio ou gate Windows não executável. NOT RUN não significa FAIL de implementação, mas impede PASS de validação correspondente. Não criar falsa recuperação para cumprir prazo.

Diário em `docs/evidence/g4-implementation/README.md` (criar na implementação): por lote registrar snapshot inicial/diff, arquivos, implementado, comando/ambiente/data/exit/contagens, PASS/FAIL/NOT RUN e motivos, falhas e correções, decisões com justificativa/teste, evidência de crash/cleanup, riscos e dependências. Atualizar ticket G4; roadmap só para status/história de fase. Relatório final deve mapear todos requisitos aos testes e registrar pendências, sem exigir reconstruir a sessão. Auditoria independente vem antes do checkpoint posterior.

## Registro de decisões propostas nesta análise

| ID | Proposta e motivo | Gate |
|---|---|---|
| G4-D1 | Coordenador/token local + canal eleito, mantendo G2 e store únicos; impede resposta obsoleta e disputa local | Aprovação integral do plano |
| G4-D2 | Sincronização por barreira finita e replay contíguo, sem ACK de negócio; não esperar journal ficar idle | Aprovação integral do plano |
| G4-D3 | Query-first, sem retransmissão automática de unknown/accepted; ausência pode decorrer de rollback | Aprovação integral do plano |
| G4-D4 | Intenção remota persistida default disabled + fence e diagnóstico contextual; preserva startup e offline | Aprovação integral do plano |
| G4-D5 | Repair sem prova permanece recovery; não introduzir reset nem ancoragem externa para rollback bilateral | Aprovação integral do plano |

Única decisão necessária para iniciar: aprovar estes contratos propostos e autorizar G4.1–G4.4 integralmente. D2 funcional (destino final da fila suspensa) permanece pendente de H e não bloqueia infraestrutura G4. Não há necessidade de escolher nova criptografia, autoridade ou engine.

## Execução Luna — fechamento técnico integral, 2026-11-13

O proprietário autorizou G4.1–G4.4 em sequência. O estado inicial parcial e as evidências anteriores permanecem no [diário G4](evidence/g4-implementation/README.md); esta seção registra o trabalho desta retomada e substitui o status anterior de execução parcial. Os quatro lotes passaram os gates técnicos Linux/WSL2 e Windows nativo descritos no diário. A auditoria independente do Sol e o checkpoint posterior continuam pendentes; aprovação de produção não foi concedida.

### Resultado por lote

- **G4.1 — PASS técnico:** coordenador singleton Main-owned conectado ao WSS G1, certificado pinado, autorização e identidade G2 persistidas, handshake `hello/ready` G3 e sincronização/replay antes do estado sincronizado. Mudança de endereço usa descoberta somente como localização; identidade/pin e vínculo são revalidados. Troca de canal cerca conexão antiga. O scheduler global mantém uma única reconexão/reconciliação em andamento, coalesce eventos e aplica retry limitado/cancelável. Main reinicia peers elegíveis sem criar pairing; intenção offline impede reconexão.
- **G4.2 — PASS técnico:** reconciliador usa a outbox, dispatcher e journal G3 existentes. Consulta estado por `operationId` original, valida fingerprint/envelope/correlação e mantém `unknown`/`not-found` inconclusivos. Timeout não cancela handler nem inicia outra execução física. Teste de processo prova que resultado incerto é consultado após reconnect/restart sem segundo ingresso no handler.
- **G4.3 — PASS técnico:** intenção explícita de modo offline é gravada em SQLite antes da publicação da transição e lida no startup real do Player. Desabilitar fecha listener e cerca clientes; callbacks tardios revalidam fence/geração. Reativar explicitamente permite nova reconexão autorizada sem novo pairing. Falhas de persistência mantêm o modo conservador.
- **G4.4 — PASS técnico:** reconciliação integrada percorre snapshot, `journalId`, epochs/revisions, `highWatermark`, `compactedThrough`, replay contíguo/paginado, inbox durável e operação pendente. Migrações aditivas vinculam estado recebido à epoch do Player preservando registros anteriores. Gaps, regressões, backup antigo ou marcadores permanecem em recovery; cursor recebido não é cursor de aplicação de negócio. G4 não envia ACK H3 nem cria fila/engine de playback.

### Decisões autônomas aplicadas

1. **Serialização global de canal:** o scheduler permite uma conexão/reconciliação ativa por vez, conforme o limite de recurso do contrato; pares restantes ficam no estado tipado `RECONNECT_SLOT_BUSY` e são reavaliados sem concorrência. Teste determinístico cobre a barreira.
2. **Intenção local em SQLite dedicado e Main-owned:** tabela pequena com revisão CAS, transação `BEGIN IMMEDIATE`, `synchronous=FULL` e readback guarda a decisão; default ausente é disabled. Migra o registro JSON da execução parcial sem removê-lo. Listener real é encerrado e startup respeita o valor; não depende de UI G5 nem cria autoridade operacional. Testes SQLite/Electron e de processo cobrem restart.
3. **Identidade protegida no E2E:** fixture semeia o formato real de `RemoteIdentityStore` usando safeStorage Electron, evitando segredo de chave privada em arquivo auxiliar; OPAQUE/G2 e autorização são exercitados pelo fluxo real.
4. **Correção da persistência offline durante revisão:** o primeiro protótipo em arquivo recebeu `EPERM` ao tentar sincronizar o diretório no Windows e também não cumpria o gate aprovado de SQLite real. Foi substituído por SQLite transacional `synchronous=FULL`, sem contornar a falha nem deixar de aplicar o requisito; um importador preserva e mantém o registro JSON anterior. Testes reais SQLite, Windows e restart passaram.
5. **Containment de socket aceito:** erros de TLSSocket depois de `secureConnection` são tratados com código sanitizado. Um probe TLS válido que fecha durante descoberta causou reset não tratado no Windows; regressão real WSS/TLS valida que o processo permanece ativo.
6. **Startup Main concorrente cercado:** chamadas simultâneas compartilham a mesma Promise de startup; intenção/revisão e geração são revalidadas depois de awaits antes de manter o canal. Isso impede que um startup atrasado ressuscite reconnect após disable/close. O E2E real verifica que as duas chamadas obtêm a mesma tarefa e um único canal.

Essas decisões mantêm autoridade, durabilidade lógica, G2/T2 e as garantias de não repetição. Não surgiu decisão material que exigisse aprovação adicional.

### Gates, limites e sequência futura

Linux/WSL2: `npm run test:unit:g4` (55/55), regressão de transporte `node --test build/tests/remote-infrastructure.test.js` (23/23) e `npm run test:e2e:g4` passaram. O E2E executa Gestão e Player como processos independentes, OPAQUE G2, WSS real com TLS pinado, SQLite, reconnect/restart, replay G3, status incerto por ID original e intenção offline persistente.

Windows: runner oficial em checkout NTFS, fingerprint `5321faf82d70ecc989b8086f870864d32d9adeeba1c03f323c8f2f8a4bad890f`, branch/HEAD conferidos. Compilação nativa, 78 testes unitários/regressivos selecionados, `remote-infrastructure` 23/23, E2E de processos G2+G4, safeStorage/DPAPI entre processos Electron, cleanup e verificação do fingerprint passaram. O fingerprint identifica o snapshot de código testado; as alterações documentais finais foram gravadas depois e não alteraram código executável. O resumo completo está no diário.

Limites preservados: pairing de produção aguarda apresentação local real e aprovada em G5; não foi implementado playback remoto, takeover, regra operacional de fila ou aplicação/ACK de negócio H3. Homologação física G6/H5 não foi executada; não são necessárias duas máquinas para o gate G4. Auditoria independente ainda não ocorreu. O `npm ci` do runner reportou seis advisories moderados de dependências; nenhuma dependência foi atualizada nesta fase. G5, G6 e H não iniciadas. Commit/push/PR não realizados.

**Status atual:** G4.1–G4.4 PASS técnico e pronta para auditoria independente, sem aprovação de produção. A auditoria do Sol deve revisar especialmente integração Main-owned e eleição/cancelamento, transições offline/fence, limites de snapshot/cursor/epoch e ausência de repetição de resultado incerto, além das migrações aditivas e da diferença de flush POSIX/Windows.


## Correções da auditoria independente A1–A3 — validação final, 2026-11-13

O parecer independente FAIL original e o histórico técnico anterior permanecem registrados acima. Após autorização do proprietário, A1–A3 foram corrigidos e validados; esta seção não substitui a reauditoria independente.

- A1: disable/close incrementa o fence de lifecycle; geração, abort, autorização, intenção e canal são revalidados depois de awaits e antes de sincronizar ou eleger canal.
- A2: o store Main usa evidências G2 existentes para distinguir primeiro uso da perda posterior do SQLite. Ausência com evidência prévia, arquivo vazio, schema incompatível ou corrupção falham fechado e preservam provas. JSON legado não sobrepõe evidência mais recente; uma escolha local explícita é necessária para sair de `recovery_required`. Configuração SQLite de `busy_timeout`/`synchronous=FULL` é aplicada em cada conexão.
- A3: query/reconciliação verifica cancelamento/deadline após respostas e imediatamente antes de admitir escrita síncrona. Evidência já commitada é conservada, mas a sessão cercada não anuncia `synchronized`.

**Validação final:** Linux/WSL2 compile por `npm run test:unit:g4`, 71/71 G4 PASS; reproducer A1–A3 PASS; E2E G4 entre processos independentes PASS; suites G1/G2/G3 afetadas 52/52 PASS. A tentativa inicial sob sandbox recebeu `listen EPERM`; a repetição no contexto autorizado de bind local passou sem relaxar testes. Windows nativo pelo runner oficial/checkout NTFS: compile, 94 testes focados, E2E G2/G4, `remote-infrastructure` 23/23, DPAPI/safeStorage e cleanup PASS. Fingerprint `2559a710644766c6fc499e97daef79a5a5291b3f4247172118ecc6403eb21bab` corresponde ao snapshot com branch/HEAD G3 esperados.

Limites residuais: rollback que apague a store e toda evidência G2 não pode ser provado localmente; uma store corrompida fica bloqueada até restore/recuperação local explícita. Nenhum dispatcher/fila/playback foi adicionado; ACK de aplicação segue reservado a H3. Seis entradas moderadas de um advisory transitivo minimatch foram novamente reportadas por `npm ci`; sem atualização nesta rodada e sem caminho explorável G4 identificado. G4 está pronta para reauditoria, mas checkpoint e G5 seguem bloqueados até PASS independente. Produção não aprovada; G5/G6/H não iniciadas; commit/push/PR não realizados.


## Parecer independente G4 — 2026-11-13

O PASS técnico relatado acima foi sucedido pela auditoria independente **FAIL** em `docs/g4-independent-audit.md`: A1 P2, A2 P1 e A3 P2 reproduzidos. Checkpoint/G5 bloqueados até correção e reauditoria; histórico de execução preservado. Nenhuma fase posterior iniciada.


## Correções Luna dos achados A1–A3 — 2026-11-13

O parecer independente original permanece **FAIL** até reauditoria de Sol. Este adendo documenta a implementação posterior autorizada pelo proprietário; não altera contratos herdados de G1/G2/G3, autoridade Gestão/Player, semântica física ou limites G5/H.

### A2 — recuperação da intenção local

`RemoteControlIntentStore` usa evidência já mantida pelo G2 (`remote-player-identity.json`, `remote-controller-identity.json` e `remote-authorization.json`) para diferenciar bootstrap de primeira execução de perda do banco depois da inicialização remota. Banco ausente com essa evidência retorna `recovery_required` sem criar SQLite e sem reimportar JSON antigo. Primeiro uso lê/migra a intenção antes de criar uma nova identidade G2. Banco de zero bytes, schema/app-id incompatível ou arquivo corrompido é preservado e rejeitado; a escrita normal não o recria. Uma chamada local explícita para definir a intenção pode iniciar nova store somente após perda/ausência, começando fechada e ignorando legado quando há evidência G2. Ausência simultânea da store e de todas as evidências não permite provar rollback completo; não há garantia contra rollback bilateral.

O Main Player recusa listener e apresentação de pareamento em `offline` ou `recovery_required`. Configuração/start e mudança de intenção usam uma geração local para que `offline` durante awaits invalide a continuação. Regressões exercitam listener TLS real em restart e exigem reabilitação local antes da reconexão.

### A1 — autoridade de callbacks

`RemoteReconnectionService` incrementa o fence antes de `disable`/`close`; callbacks validam estado, token, abort e canal após conexão, autorização e reconciliação assíncronas, antes de publicar. Fechamentos do mesmo canal compartilham uma Promise para não fechar duas vezes. Um start explícito posterior não pode ser sobreposto pela continuação tardia de disable. Testes de barreira cobrem autorização inicial/post-replay e restart com nova conexão.

### A3 — ponto de admissão durável

`ManagementRemoteReconciliationService` verifica sinal e deadline depois da resposta do query port e novamente após o retorno ao chamador. Antes de `persistPage`, `persistSnapshot` e `acceptStatus`, repete a validação imediatamente antes da chamada SQLite síncrona. Esse trecho sem `await` constitui a admissão: se abort já está confirmado, nenhuma nova mutação inicia; se a transação síncrona já terminou, mantém-se a evidência confirmada e o método ainda valida novamente antes de resultado final, sem declarar synchronized nem aceitar status tardio.

### Validação da correção

- `npm run test:unit:g4`: **70/70 PASS** após as correções; inclui SQLite real, crash-residue vazio, exclusão/truncamento/corrupção, migração JSON, falha pré-commit/ACK perdido, teste Main listener e barreiras A1/A3.
- `node scripts/g4-audit-repro.cjs`: os reproducer A1–A3 agora exigem o resultado corrigido.
- `npm run test:e2e:g4`: PASS com dois processos independentes, OPAQUE G2, WSS/TLS pinado, runtime/coordenador/reconciliador G4, SQLite, replay/restart e perda do SQLite offline com JSON legado enabled; nenhuma conexão sincronizada antes de reabilitação local explícita.
- Regressões diretamente afetadas G1/G2/G3: 52/52 PASS (`remote-infrastructure`, pairing-wire/audit regressions, operacional protocol/service). Runner Windows nativo/fingerprint desta revisão: pendente até gate oficial final registrado no diário.

Limitação de primeira inicialização: o perfil é considerado novo se ainda não existe DB de intenção, JSON legado nem identidade/autorização G2. Nesse estado o bootstrap cria apenas `disabled`; não concede por si só pairing de produção. Corrupção presente não é descartada para recuperar disponibilidade: permanece bloqueada até restaurar/recuperar localmente o store. Não se reivindica proteção contra rollback completo que remova a base e todas as evidências. A reauditoria independente continua pendente; checkpoint/G5 seguem bloqueados.


## A4 — precedência das transições locais, 2026-11-13

A reauditoria encontrou que `enabled` podia ficar aguardando shutdown enquanto um pedido offline mais recente era confirmado; ao continuar, a gravação antiga substituía a intenção. Cada escolha recebe geração no Main. A operação revalida após o await de shutdown; o store também consulta o fence depois da preparação assíncrona e imediatamente antes da transação SQLite síncrona. O commit é o ponto de linearização durável; resposta obsoleta não é publicada como sucesso. `close()` invalida geração antes do cleanup.

Foi coberta também a corrida de observação do banco vazio enquanto outro processo o cria: a leitura aguarda evento limitado e só aceita arquivo quando o conteúdo inicializado existe; vazio sem prova continua erro fechado. Testes cobrem shutdown pendente, admissão SQLite adiada, offline/enabled sobrepostos, dois pedidos iguais, close, restart por processo independente e bloqueio de listener. `test:unit:g4` 75/75, reproducers A1–A4, regressões G1/G2/G3 52/52, E2E G4 e runner Windows oficial passaram. Fingerprint Windows final `2a4e19d84f7dea3b32ae374efb149ec9a7023a42c80a529c9962ab7518ea6350`. A4 aguarda reauditoria focal independente antes do checkpoint/G5.


### A4 — validação final após teste adicional de precedência, 2026-11-13

O teste adicional cobre a ordem inversa: offline antigo aguarda shutdown e um pedido enabled explícito mais recente é confirmado; a continuação offline obsoleta falha em vez de retornar sucesso. npm run test:unit:g4: 77/77 PASS; reproducers A1–A3 e A4 PASS; regressões G1/G2/G3: 52/52 PASS; E2E G4 PASS.

Runner Windows oficial, checkout NTFS: compile e 100 testes focados PASS, incluindo 19 de intenção; E2E real G2/G3/G4 entre processos, remote-infrastructure 23/23, DPAPI/safeStorage e encerramento/cleanup PASS. Fingerprint 4b11a16784faf49df02295605c5256ea02c7b5a415bfda13153a977fc7f61199; runId 4e10e589-41fb-4cd7-b9e5-10f2deab8a0f; branch e HEAD G3 esperados. Sem processo residual.

A4 está RESOLVED pela implementação para reauditoria focal; o parecer independente permanece pendente e nenhum checkpoint/G5 está liberado. Produção não aprovada; sem commit/push/PR.


## Correção Luna A4 entre processos Main — 2026-11-13

A2 principal recebeu a correção autorizada por CAS durável. Toda gravação do store exige expectedRevision explícita; undefined é rejeitado. Main captura a revisão persistida antes de iniciar a espera de shutdown/preparação e a propaga sem atualizar estado como confirmado. SQLite compara a revisão dentro de BEGIN IMMEDIATE, antes do UPDATE. Revisão divergente retorna REMOTE_CONTROL_INTENT_REVISION_CONFLICT; não há retry nem conversão do conflito em sucesso. A mutação e COMMIT são síncronos. O estado em memória/listener só prossegue depois do retorno confirmado. Para instalação/recovery com DB ausente, expectedRevision null representa a ausência observada; apenas o processo que efetivamente inicializou a store pode prosseguir, se a revisão inicial permaneceu intacta. Dois inicializadores não podem reivindicar a mesma ausência.

O reproducer antes desta correção confirmou enabled/revisão 2 após offline confirmado por outro processo. O mesmo roteiro agora rejeita o Main antigo por conflito CAS, reabre SQLite em offline/revisão 1 e o novo Main recusa startup. Reproducer A4 original no mesmo Main, A1–A3 e suíte G4 77/77 PASS. Regressões G1/G2/G3 52/52 PASS; E2E G4 real WSS/G2/G3/G4 entre Management/Player independentes PASS.

Ownership do runtime de produto: `main.ts` só importa `main-runtime` depois de `app.requestSingleInstanceLock()`; no contexto empacotado, o gate global da instalação também é adquirido antes da composição. Uma segunda instância normal não importa o runtime, e a invocação administrativa encerra antes dessa composição. O teste estrutural `node --test scripts/installation-binding-build.test.cjs` passou nesta revisão e verifica a ordem do lock local, gate empacotado e abertura do runtime. A reauditoria e os testes multiprocessos exercitam owners independentes sobre SQLite compartilhada; o CAS protege a revisão durável mesmo fora desse bootstrap. Não foi introduzido um segundo lock distribuído.

Windows nativo pelo runner oficial: PASS em 2026-11-13, runId `5dffb033-02c0-4189-8056-f376d8d9a89c`, fingerprint `42f2ee6231c1444b4637672933358c67af478cf813f23c41c11b51e59d1c0e34`, branch e HEAD G3 esperados. O manifesto continha 496 arquivos e seus hashes coincidiram com a working tree no momento da execução. A execução incluiu compilação Windows, regressões focadas de intenção/reconexão/reconciliação/store/protocolo/migração, reproducer cross-process A4, E2E G2/G4 com WSS e processos independentes, infraestrutura remota, DPAPI/safeStorage e cleanup. Após o runner, somente documentação foi atualizada; código, testes e scripts testados permanecem iguais ao snapshot. A1–A3 continuam aprovados independentemente; esta seção registra a implementação Luna e não altera o parecer independente FAIL da reauditoria cross-process. Nova reauditoria focal pendente antes de checkpoint/G5. Sem commit/push/PR.

## Parecer independente final A4 cross-process — 2026-11-13

O parecer vigente de `docs/g4-independent-audit.md` é PASS: A1–A4 e G4.1–G4.4 aprovados independentemente. G4 está apta para checkpoint e tecnicamente apta para G5; G5 segue não iniciada e produção permanece não aprovada. Os FAILs e bloqueios anteriores são históricos e preservados. G6/H5 mantêm a homologação física; H3 mantém aplicação operacional/ACK de negócio transacional. Permanecem a pendência de manutenção dos seis advisories moderados de minimatch e o limite documentado de rollback total sem evidências externas. O diário contém runId/fingerprint Windows e a comparação do snapshot executado.
