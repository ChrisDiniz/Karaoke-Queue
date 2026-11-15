# G5 — Plano integral para execução pelo Luna

## Fechamento funcional vigente — 2026-11-15

G5.1–G5.4 FUNCTIONAL **PASS**, G5 FUNCTIONAL VALIDATION **PASS**. Última lacuna comprovada no Windows oficial: marker G4 real de compactação além do cursor recebido, persistido pelo inbox SQLite, relido após restart Main e exibido no cartão do peer exato como `recovery_required`, sem reconciliação. Refresh/mDNS e repetição de snapshot não removem o marker; a IPC rejeita consulta direta. Não há limpeza genérica aprovada de marker G4: permanece cercado até procedimento com evidência específica.

Run `27bd0dc4-8968-429d-a211-ab52840fd924`, fingerprint `fa7730d988dfbb48b9cf69216c117e82235f887966f889c062c07895f367ce49`, `--remote-pairing` com `KQ_G5_G4_RECOVERY_ONLY=1`: build, E2E, cleanup e residual check PASS; Linux compile e reconciliação 10/10 PASS. Somente teste e três documentos consolidados alterados nesta rodada; nenhuma correção de produto. Detalhes, relatório/manifesto e hashes no início do [diário](evidence/g5-implementation/README.md). Documentação posterior ao run não é declarada como novo teste Windows. READY FOR VISUAL REFINEMENT YES; visual fidelity, proprietário e auditoria independente PENDING; checkpoint NO; sem commit/push/G6/H.

## Resultado técnico Sol — 2026-11-15 (histórico anterior ao fechamento G5.1)

O fechamento final acima substitui os estados PARTIAL das rodadas intermediárias. Cenários, causas e evidências foram consolidados no diário; não representam autorização visual ou de produção.

## Atualização de validação funcional — 2026-11-15 (registro anterior à validação dirigida)

Pairing, remote-ui, video-library e standalone-integration passaram no Windows. Standalone-production encontrou apenas a assertion visual C10.1. RunIds/fingerprints e limites permanecem no diário consolidado.

## Validação dirigida adicional — 2026-11-15

O run c199458a-f9d0-4ee7-8392-048c5b3a1817 comprovou overlays sobre MP4 real, playback contínuo e cleanup no Windows, preservando C10.1. Fechou G5.3 funcional; fidelidade visual permanece pendente.

## 1. Base conferida e gates

Branch `feature/remote-player-lan-integration-3`; HEAD/checkpoint G4 `318d4fa9cad08962aec7f09b4ac03598a66eae69` (`feat(g4): implement secure reconnection and state recovery`). Working tree inicialmente limpa. Ancestrais: G3 `ca6af2e`, G2 `c36fb1d`, G1 `97f48c7`. Auditoria independente G4 vigente: PASS A1–A4 e G4.1–G4.4, conforme seção final de `g4-independent-audit.md`; FAILs anteriores são históricos. Os registros “checkpoint não realizado” antecedem o commit agora existente. Não reabrir G1–G4 sem defeito reproduzível. O checkpoint não é homologação de produção.

Fontes: contrato pareado, plano executivo, plano UI, roadmap, tickets G1–G5, plano integral/auditoria/evidências G4 e código indicado abaixo. G1 foi aceita com limitações; G2/G3 tiveram reauditorias PASS. Evidências históricas Windows G4: runId `5dffb033-02c0-4189-8056-f376d8d9a89c`, fingerprint `42f2ee6231c1444b4637672933358c67af478cf813f23c41c11b51e59d1c0e34`. Não são testes G5 nem foram repetidos nesta análise documental.

A decisão atual permite código temporário na janela principal Player, inclusive TV espelhada. Mantém consentimento, oito dígitos, expiração/uso único, lockout, OPAQUE-3DH/kq-pair/2, binding TLS, pin, vínculo revogável, Main-only e ausência de log do código. Não criar janela privada obrigatória, USB ou QR. Nome do solicitante permanece não verificado antes das provas. O comentário `non-projected` em `PairingPresentationPort` está desatualizado; corrigir apenas seu texto durante G5, sem alterar o gate `approvedForProduction` ou contratos criptográficos.

## 2. Doop, inventário e execução visual

[Inventário completo e matriz](g5-full-execution-plan.md#g5-doop-matrix): os 31 frames originais continuam intactos e `ready_for_dev` por Chris. A inspeção atual encontrou Player `wsQwJ7ry4g` com 33 frames (18 originais + 15 novos) e Gestão `IY_IYI21QW` com 32 (13 originais + 19 novos). Os 34 novos frames são HTML editável, `draft`, e não têm aprovação humana. Screenshots Doop foram consultados após criação/edição; comparações Electron ainda pendentes, exceto o estado vazio Gestão já comparado qualitativamente. `get_frame` não retorna campo `description`; as descrições funcionais ficam associadas aos IDs reais no apêndice de matriz Doop abaixo.

Não recriar os dez estados Player, os avisos `Y47usa8PN0`/`kKJpUsOjMV` ou a divergência `yDsRajh7GQ` quando compatíveis. A base Gestão `5booCMOuTE` não contém Dispositivos. Criar variante com botão imediatamente à esquerda do sino, preservando original. Frames de Avançar/Recomeçar/Parar/Trocar/Apresentação/takeover pertencem H; aprovação visual não autoriza ativá-los em G5.

Para CADA estado visual distinto, antes de escrever UI: conferir contrato → reler frame atual ou criar HTML nativo editável → nomear/descrever estado, ações, atalhos e fechamento → capturar Doop e corrigir → registrar ID real/componente → implementar → testar em Electron real → comparar nas mesmas dimensões → corrigir → atualizar matriz e evidências. Screenshot não substitui frame. Novos frames horizontalmente, por fluxo, com separação clara; não mover originais. Reutilizar composição, tokens, ícones e modais escuros existentes. Decisões pequenas de layout/microcopy são delegáveis; não alterar significativamente frame aprovado sem autorização. Variantes novas podem preservar originais e explicitar correção contratual.

## 3. Matriz funcional das interfaces

Esta tabela descreve os fluxos; IDs e componentes concretos estão na matriz atualizada do inventário. P = canvas Player; M = Gestão. Variantes visualmente distintas têm frame editável. Os IDs só são afirmados quando retornados pelo Doop. Estado das interfaces implementadas: **Implementada — aguardando revisão visual do proprietário**; comparação visual Electron/Doop permanece pendente.

Canvas | Nome/estado a representar | Componente previsto | Fonte/ação Main | Lote
--- | --- | --- | --- | ---
P | Transporte autenticado, conciliando; desconectado cercado; erro TLS/autorização; recovery_required/blocked | PlayerConnectionView | G4 status/intent + estado Player G3 | G5.1
P | Offline confirmado | PlayerConnectionView | intenção persistida, nunca socket ausente; aproveitar LZhLxxiEgE apenas aqui | G5.1
M | Operação rejeitada; aceita pendente; consulta em andamento; concluída; consulta indisponível/timeout | RemoteOperationNotice | outbox/status G3, mesmo operationId | G5.2
P/M | Variantes responsivas e sobreposições distintas | componentes acima | sem nova autoridade | G5.3
M | Header Dispositivos; buscando; nenhum encontrado; encontrados não verificados; salvos/indisponíveis; conectado; reconectando/conciliando | DevicePanel | discovery + peers sanitizados + G4 | G5.4
M | Avançado/IP manual; erro de endereço | ManualEndpointForm | validação LAN G1, mesmo bootstrap | G5.4
P | Permitir descoberta/interface; rede/cofre indisponível | PlayerNetworkConsent | consentimento local + startPlayer G1 | G5.4
M | Solicitando/aguardando Player; digitar oito dígitos; verificando/salvando | PairingDialog | PairingControllerClient/presentation port | G5.4
P | Pedido não verificado Permitir/Rejeitar; código 4–4 e validade; confirmação/persistência | PlayerPairingOverlay | PairingPresentationPort | G5.4
P/M | Vínculo concluído; recusado; código incorreto; expirado; cancelado; ocupado; lockout; confiança inválida; persistência incerta | PairingResult | outcomes G2, não dedução Renderer | G5.4
P/M | Renovação 30/7 dias; certificado expirado; renovando; sucesso/falha | RenewalDialog | PairingRenewalCoordinator/G2 | G5.4
P/M | Gerenciar vínculo; confirmar revogação/remoção; removido; gravação falhou; recuperação bloqueada | PeerManagementDialog | autorização/store G2, nunca apagar journal | G5.4
M | Player explicitamente offline; vínculo salvo com recovery_required | DevicePanel | G4; retorno de negócio H continua bloqueado | G5.4

Não criar uma tela por enum quando composição e comportamento são equivalentes. Entretanto, mudança de texto/ações/hierarquia que produz estado visual distinto deve constar em frame/variante. Registrar em cada linha final canvas, ID, nome, estado, caminho real/componente, origem e revisão. Habilitar ações só conforme capabilities Main; ausência de port de negócio H deve aparecer como indisponível, sem handler fictício.

## 4. Integração real e contrato seguro proposto

Base observada antes da implementação: `main.ts` adquire locks antes de importar `main-runtime.ts`; este instancia `MainRemoteRuntime` e chama `resumeManagementReconnection` quando aplicável. A execução acrescentou fachadas sanitizadas nos Preloads/IPC e publicou snapshots/eventos dos estados reais, preservando serviços G1/G2/G4 e seus callbacks técnicos. Detalhes e limites vigentes estão na seção 7; logs continuam sem autoridade de UI.

Ports reais a reutilizar:

- `BonjourDiscoveryPort.getSnapshot/subscribe/refresh/stop` e `startManagementDiscovery`; anúncio só após escolha de rede local. Candidate é pista de endereço, não identidade. Não abrir segundo discovery concorrente ao de reconnect: compartilhar/coordenar snapshots no Main e cleanup por owner.
- `configurePlayerPairingPresentation`, `startPlayer`, `createPairingController`, `revokePlayerPairingLocally`, `setRemoteControlIntent`, `resumeManagementReconnection`; renewal usa coordenador e runtime existentes. Não contornar guard de configuração antes do listener.
- `PairingPresentationPort.requestConsent({displayName,purpose,expiresAt})`, `showTemporaryCode({groupedCode,expiresAt})`, `closePairing({outcome})`; Gestão `enterTemporaryCode({playerName,expiresAt,signal})`, close e `PairingControllerClient.pair/recover`. `pair` retorna `active-awaiting-reconciliation`, nunca controle pronto.
- `RemotePeerStatus` = playerId/state/reason/connectionId/synchronized/retryAt. `RemoteReconnectionService` tem disabled/backoff/connecting/authorized/reconciling/synchronized/conflict/recovery_required/stopping/blocked/closed. Não inventar estados de rede a partir de timers UI.
- `ManagementRemoteOutbox.get/recoverable/transmit/statusQuery/acceptStatus`, cliente operacional e reconciliation G3/G4. Não expor transmit genérico ao Renderer. G5 exibe status e consulta, sem iniciar comandos de playback H.

Os contratos abaixo registram a direção e os limites que as fachadas atuais devem cumprir; os nomes ilustrativos precedem os canais específicos implementados em `src/main-remote-ui-ipc.ts`, `preload.ts` e `standalone-player-preload.ts`. Manter serviços criptográficos intactos.

Interface | IPC/Preload proposto | Owner, validação e persistência | Restart/cleanup
--- | --- | --- | ---
Todas as views | getRemoteSnapshot / onRemoteSnapshot | Main snapshot com hostEpoch/revision, papel e capabilities; peers sanitizados; sem PEM/token/chaves/capabilities bootstrap | snapshot inicial coordenado com subscription, descartar respostas antigas; unsubscribe idempotente ao fechar/navegar/destroy
DevicePanel | refreshDevices / selectDevice | Main resolve candidateId atual; coalescer refresh, limites G1; anúncio expirado rejeita; texto escapado | cache não é vínculo; fechar painel não desliga reconnect autorizado
ManualEndpointForm | inspectManualEndpoint | Main valida IP privado/interface/porta pelos contratos G1; sem URL arbitrária, scan ou fetch genérico | endpoint só vira cache após identidade autenticada
Consentimento rede | enableDiscovery(interfaceId) | Player local, interface allowlist obtida Main; intenção persistir→publicar; falha não confirma enabled | persistir intenção pelas revisões/CAS G4; não assumir endereço estável após reboot
Pedido/código | startPairing(candidateId,purpose), answerConsent(requestId,revision,accept), submitCode(requestId,revision,code), cancelPairing(requestId,revision) | Main mapeia IDs opacos UI à sessão G2 real; validar papel, documento/frame/sender, sessão atual, finalidade, oito ASCII e separador 4–4; código só memória transitória | teardown cancela/encerra apresentação sem presumir rollback do commit; apagar DOM/input/código ao terminal/expiração; recover usa journal G2 após restart
Operações | queryOperation(playerId,operationId) | ID existente na outbox do peer autorizado, consulta limitada; nenhuma nova operação/retry de comando | pendência continua persistida ao fechar; reabrir reidrata outbox
Offline | requestOffline / confirmOffline(requestId,revision) | Main revalida idle e ausência de vez ativa; fence imediato, CAS G4; não chama Stop All implícito | offline/recovery_required persistem; conflito CAS apresenta falha e relê confirmado, sem retry automático
Vínculo | requestRevoke / confirmRevoke; requestRenewal | Main autorização/store/coordenador G2; confirmação local onde exigida; tombstones e geração preservados | falha de disco não confirma remoção; fechar não apaga provas ou journal

DTO público de pairing deve conter somente requestId opaco, revisão, fase, nome informado, purpose, prazo restante e código temporário exclusivamente para janela Player proprietária. Deadline G2 é monotônico: converter para remainingMs no Main; não tratar expiresAt como UTC. Deadline Renderer só atualiza exibição e limpa código; Main continua autoridade de expiração. Nunca incluir código em snapshot geral Gestão, logs, erros serializados, telemetria ou fixture de produção. Criar correlação no adapter porque os callbacks atuais Player não fornecem sessionId: não mudar a semântica G2 nem usar código como identificador.

Erro IPC deve ser enum sanitizado, sem stack/caminho/segredo. Resposta tardia precisa conferir requestId, geração e revision depois de awaits; consentimento antigo jamais atende novo pedido. Resolver Promise de consent/input uma única vez. Limitar subscriptions, pendências e tamanho de mensagens. Testar iframe, janela errada, subframe e documento navegado. Renderer não recebe Node, SQL, cofre, sockets ou funções criptográficas. Não persistir estado operacional em localStorage nem criar SQLite alternativo.

Remoção na Gestão é local e não prova revogação no Player remoto offline. Implementar pela autoridade G2 existente, mantendo tombstone e distinguindo resultado local/remoto; se faltar port público, adicionar adapter Main sobre store com sua transação/CAS e testes, sem inventar endpoint de revogação. Substituição de Gestão usa consentimento G2, nunca sobrescrita por clique remoto.

## 5. Estados, fluxos e lotes executáveis

### G5.1 — conexão

Objetivo: publicação real Main→IPC→Player, distinguindo conexão e controle. Reutilizar frames Player inventariados; criar variantes da matriz para erro/recovery/conciliando/desconectado cercado. Componentes: PlayerConnectionView e adapter snapshot remoto nos Preloads/IPC.

Mapeamento: disabled/closed → desconectado conforme intenção; connecting/backoff → reconectando com retryAt; authorized → transporte autenticado; reconciling → conciliando; synchronized → sincronização técnica concluída, sem concessão de controle H; conflict/recovery_required/blocked → erro contextual com ações restritas; stopping → encerrando, sem sucesso antecipado. Player precisa observação Main própria da eleição/autorização/canal G1/G3; não inferir seu estado pelo status exclusivo da Gestão. Perda de canal preserva playback. Restaurar link não inicia música, importa fila ou sai do offline. Toast verde que afirma controle só quando capabilities reais permitirem; caso contrário criar variante técnica.

Testes: tabela de todos os enums, perda/restauração real WSS, TLS inválido, callback tardio após disable, snapshot fora de ordem, offline/restart e cleanup. PASS: nenhum sucesso por socket aberto, nenhuma mudança de engine/fila, cada estado tem frame. Avançar após compile, testes focados e evidência visual do lote; integração completa com consentimento vem G5.4. Risco: confundir synchronized com controle de negócio; manter distinção explícita.

### G5.2 — operações

Objetivo: avisos reais sem reexecutar operações. Reutilizar Y47usa8PN0 para prova de não envio, kKJpUsOjMV para incerto e yDsRajh7GQ para divergência; novos frames para demais variantes na matriz. Componente RemoteOperationNotice, port queryOperation.

Fluxo: preparada/não enviada → enviada/resultado pendente → aceita ou rejeitada conforme status; aceita não é concluída. Timeout após envio → incerta; Consultar usa operationId original; timeout da consulta mantém incerta e permite consulta posterior explícita. Fechar só oculta aviso. Não usar timer para declarar sucesso/fracasso definitivo; spinner termina no prazo de consulta e deixa mensagem acionável. Erro anterior ao envio exige prova Main; só oferecer Tentar enviar se o contrato real permitir e o mesmo ID/payload permanecer válido. G5 não habilita envio de comandos H apenas para exercitar aviso. Reidratar pendências reais existentes; fixtures sintéticas somente testes.

Testes: ACK perdido, rejeição, conclusão, consulta atrasada/falha, fechar/reabrir/restart, peer errado e ID inexistente, ausência de duplicata/outbox preservada. PASS: consulta não transmite comando, pendência sobrevive aviso e resultado é durável antes de sucesso. Dependência G3/G4 e IPC G5.1. Avançar com compile, regressões afetadas e comparação visual; risco de implementar botões de H por arrasto deve ser bloqueado.

### G5.3 — fidelidade e comportamento transversal

Objetivo: consolidar render/foco/teclado/responsividade dos componentes e aplicar os mesmos critérios novamente ao encerrar G5.4. Sem criar camada visual paralela. Reutilizar design system e frames; novas variantes responsivas editáveis antes do código.

Referências Player 1280×800 e Gestão 1440×920; testar também 1366×768, 1920×1080 e menor tamanho permitido pelo produto/escala existente, sem redefinir mínimo da V1. Não cortar código, timer ou ações; scroll interno acessível quando necessário. Foco inicial seguro, Tab/Shift+Tab contidos só em modal, Esc fecha/cancela intenção transitória sem apagar fatos, Enter somente controle focado; restaurar foco ao gatilho vivo. Bloquear atalhos de música durante digitação do código; não adicionar hotkey global nova. Alertas não modais usam status/aria-live sem roubar foco; erros não dependem apenas de cor. Testar zoom/escala e nomes longos escapados.

Testes Electron com MP4 real: abrir/fechar sobreposição não pausa, reinicia, muda volume ou troca engine; relógio de reprodução continua. Confirmar z-order sobre superfície real de vídeo, inclusive Windows. Capturar Doop e Electron a DPR e viewport iguais; comparar geometria, fonte, ícone, texto, foco e recortes, tolerando apenas conteúdo real da mídia. PASS técnico/funcional/visual separados; revisão humana final pendente não impede lotes sob autorização integral futura. Riscos: foco atravessando modal e overlay atrás do vídeo; corrigir sem alterar playback.

### G5.4 — descoberta, pareamento e manutenção

Objetivo: fluxo completo por fachadas seguras G1/G2/G4. Frames novos da matriz nos respectivos canvases, reutilizando shell/modal/toasts. Componentes DevicePanel, ManualEndpointForm, PairingDialog, PlayerPairingOverlay, PeerManagementDialog e RenewalDialog.

Fluxo normal: operador Player permite descoberta na rede selecionada → Gestão abre Dispositivos e busca mDNS real → encontrado não verificado ou vazio/erro → selecionar candidateId → Main solicita G2 → Player mostra nome informado não verificado e Permitir/Rejeitar → aceitar gera código oito dígitos G2 → overlay principal Player mostra 4–4, validade e Cancelar → Gestão recebe input pelo port → Main executa OPAQUE, binding TLS e commit bilateral → código desaparece → vínculo ativo aguardando reconciliação → G4 autentica/reconcilia → UI mostra estado técnico verdadeiro. Nenhuma etapa dispara playback.

Atualizar coalesce busca; não inicia pairing. Lista reúne observações frescas e vínculos salvos sem duplicar por nome: ID só é confiável após G2. Salvo ausente aparece indisponível; salvo válido reconecta sem código. Avançado permite endpoint manual validado no mesmo fluxo, sem bypass de provas/pin. Busy/rejeição/cancelamento/expiração/lockout/confiança falha têm feedback próprio; nova tentativa respeita decisão G2 sobre sessão e quotas. Não inventar botão que zera lockout.

Cancelar antes da admissão G2 encerra só sessão corrente; depois da fronteira durável resultado pode ser incerto e exige recover da mesma operação, jamais nova vinculação cega. Encerrar janela, reload, queda de processo ou rede não apagam journal. Conclusão exige resultado active real; erro de persistência não vira sucesso. Renovação 30/7 dias usa stage/recover/promote já implementados; expirado exige caminho local consentido, sem ignorar certificado. Revogação Player cerca imediatamente e confirma só após durabilidade. Offline/recovery_required não se resolvem por refresh, novo anúncio ou toast. Recuperação local de DB corrompido continua explícita e preserva provas; não inventar assistente destrutivo. Retorno operacional e takeover pertencem H.

Testes: descoberta real local e fake determinístico unitário; dois processos independentes com G1/G2/G3/G4 reais, consentimento por UI, código certo/errado/zero inicial, expiração, rejeição, cancel nas fronteiras de commit, lockout/reboot, cofre indisponível, pin inválido, renewal/revoke concorrentes, restart e recovery incerta. PASS: nenhuma confiança por mDNS, nenhum segredo permanente Renderer, código some em todos os terminais, restart reconecta só intenção habilitada, offline persiste, playback segue. Dependências: G5.1–3 e gate de apresentação G2 real. Riscos: geração atrasada, relógio errado e produção liberada apenas por boolean; adapter aprovado não elimina gates G6/H5.

## 6. Validação planejada e encerramento

Executar compile e testes proporcionais ao diff. Scripts existentes úteis: `test:unit:g4`, `test:unit:remote-reconnection`, `test:unit:remote-reconciliation`, `test:unit:pairing`, `test:e2e:operational-process`, `test:e2e:standalone-production:headless` e suites IPC/interaction/playback diretamente afetadas. Conferir package.json antes de usar; selecionar casos G2 de lifecycle conforme extensão da ponte. Acrescentar testes G5 de DTO/reducer/IPC e E2E UI de produto com Main real; não chamar harness de aplicação de produção. Usar perfis/SQLite isolados, clocks e barreiras controlados, sem sleeps/retries que mascarem races. Fixture não autoriza consentimento em produção.

Windows: runner oficial `scripts/run-windows-native-tests.cjs`, checkout NTFS, flags existentes remote-infrastructure/operational-store e novos casos G5 integrados conscientemente. Registrar runId/fingerprint/HEAD e arquivos; não editar checkout durante runner. Comparar screenshots canônicos e verificar safeStorage/DPAPI, foco/overlay e duas instâncias com perfis isolados. Se interop/NTFS/pré-requisitos ausentes: NOT RUN, validação incompleta. Manual do produto só via `scripts/standalone-manual-windows.ps1`; não substituir por harness. Duas máquinas físicas ficam G6/H5. Workflows existentes `pr-validation.yml` e `release-windows.yml` permanecem intactos; sem publicação/release automática.

Evidência futura em `docs/evidence/g5-implementation/`: índice por lote, origem do snapshot, testes executados/omitidos, screenshots Doop/Electron sem códigos reais ou dados sensíveis, matriz com caminhos reais e divergências corrigidas/pendentes. Registrar aprovação visual humana apenas após declaração explícita. Atualizar somente ticket G5, docs afetados e roadmap; não reclassificar resultados históricos.

Execução Luna: autorização integral recebida → conferir Git/checkpoint/contratos → implementar cada lote com frame antes do código → testes e revisão do diff → atualizar evidências/matriz → avançar até G5.4 → repetir G5.3 sobre fluxo completo → relatório funcional/técnico/visual separado e revisão do proprietário. O progresso verificável e os gates atuais estão na seção 7. Nenhum commit/push sem autorização própria.

Decisões materiais exigem retorno ao proprietário: alterar criptografia, autoridade, offline, descarte de provas, replay incerto, regras funcionais, redesign significativo de aprovado ou comportamento operacional novo. Nenhuma decisão material nova é necessária para começar G5 no escopo aqui definido; autorização de execução futura continua necessária. D2 descarte/retorno definitivo da fila suspensa permanece fora de G5. G6 homologa rede física; H implementa aplicação de resultados/ACK transacional, sequência, playback remoto, retorno/takeover e demais operações de negócio. Não antecipar essas funções para tornar a demonstração G5 mais completa.

Validação da rodada de planejamento Sol: inspeção documental/código/Doop sem mudanças. O histórico desta linha é preservado; a execução posterior está registrada na seção 7.

## 7. Execução autorizada e estado vigente

Execução consecutiva G5.1–G5.4 autorizada pelo proprietário em 2026-11-13. Implementação e validação funcional PASS; checkpoint funcional local autorizado para o commit que contém este registro. Histórico, FAILs relevantes, causas comprovadas, runIds/fingerprints e hashes ficam no [diário consolidado](evidence/g5-implementation/README.md). A matriz Doop abaixo preserva IDs reais e componentes; os status de comparação visual são independentes.

## 8. Passagem para continuação funcional

Próximo marco: refinamento visual Doop↔Electron Player/Gestão, seguido por aprovação do proprietário e auditoria independente integral. Não iniciar essa rodada neste checkpoint. G6/H exigem autorização própria. C9 e C10.1 permanecem separados do gate funcional; assertions preservadas. G4 no checkpoint 318d4fa9cad08962aec7f09b4ac03598a66eae69; checkpoint G5 é funcional, sem aprovação de produção.

<a id="g5-doop-matrix"></a>

## Apêndice A — Inventário Doop e matriz Doop↔código

Inventário original da inspeção Sol em 2026-11-13 via `get_canvas`, `get_frame` (HTML editável) e `get_frame_screenshot`. A seção de execução abaixo atualiza o snapshot: Luna criou frames novos e implementou parte das interfaces. A inspeção atual confirma 33 frames Player (18 originais + 15 novos) e 32 Gestão (13 originais + 19 novos). Os 31 originais continuam no lugar; os 34 novos são rascunhos nativos/editáveis, sem aprovação humana. `get_frame` não expôs campo estruturado de descrição; os comportamentos abaixo ficam associados ao ID nesta matriz. Nenhum screenshot foi usado como substituto de frame.

As tabelas seguintes registram o inventário original da rodada Sol. Para os status atuais de execução consulte a matriz de execução ao final deste apêndice. Origem de todas as linhas abaixo: frame existente aprovado; ressalvas semânticas não revogam aprovação no Doop.

## Modo Player  - Pareado — wsQwJ7ry4g

18 frames; 1280×800. HTML e render consultados. Paleta escura, acento violeta, verde para confirmação e âmbar para conexão pendente; modais centrais e foco contornado. Player usa palco/footer em idle e toast superior sobre vídeo; Gestão preserva header/sidebar/fila.

Canvas | Frame ID | Nome | Estado/uso | Componente previsto | Origem | Status
--- | --- | --- | --- | --- | --- | ---
wsQwJ7ry4g | `KagjaYNZTB` | Player Only — Conectado — Ocioso | G5.1 referência | PlayerConnectionView | Frame existente aprovado | ready_for_dev; G5 não implementada
wsQwJ7ry4g | `-cYIWa7IlC` | Player Only — Conectado — Ocioso — Reconectando | G5.1 referência | PlayerConnectionView | Frame existente aprovado | ready_for_dev; G5 não implementada
wsQwJ7ry4g | `FKBFkDoBFM` | Player Only — Conectado — Ocioso — Conexão estabelecida | G5.1 referência | PlayerConnectionView | Frame existente aprovado | ready_for_dev; G5 não implementada
wsQwJ7ry4g | `V8JvnGlZ1D` | Player Only — Conectado — Ocioso — Conexão restabelecida | G5.1 referência | PlayerConnectionView | Frame existente aprovado | ready_for_dev; G5 não implementada
wsQwJ7ry4g | `LZhLxxiEgE` | Player Only — Desconectado — Ocioso — Controle manual | G5.1 referência | PlayerConnectionView | Frame existente aprovado | ready_for_dev; G5 não implementada
wsQwJ7ry4g | `pZYyL3yDQI` | Player Only — Conectado — Reproduzindo — Conexão estabelecida | G5.1 referência | PlayerConnectionView | Frame existente aprovado | ready_for_dev; G5 não implementada
wsQwJ7ry4g | `ZyDfIbwCB8` | Player Only — Conectado — Reproduzindo — Reconectando | G5.1 referência | PlayerConnectionView | Frame existente aprovado | ready_for_dev; G5 não implementada
wsQwJ7ry4g | `VJTmwS0mZn` | Player Only — Conectado — Reproduzindo — Conexão restabelecida | G5.1 referência | PlayerConnectionView | Frame existente aprovado | ready_for_dev; G5 não implementada
wsQwJ7ry4g | `5xay1Jhkka` | Player Only — Desconectado — Reproduzindo — Falha de reconexão | G5.1 referência | PlayerConnectionView | Frame existente aprovado | ready_for_dev; G5 não implementada
wsQwJ7ry4g | `hGwNy76Arh` | Player Only — Conectado — Carregando música | G5.1 referência | PlayerConnectionView | Frame existente aprovado | ready_for_dev; G5 não implementada
wsQwJ7ry4g | `3a9l_r00eg` | Player — Apresentação da Próxima Vez | H; preservar | PlayerConnectionView | Frame existente aprovado | ready_for_dev; G5 não implementada
wsQwJ7ry4g | `RVRxz-s16i` | Player — Confirmar Avançar — Música 1 | H; preservar | PlayerConnectionView | Frame existente aprovado | ready_for_dev; G5 não implementada
wsQwJ7ry4g | `2NjukUsCvh` | Player — Confirmar Avançar — Última Música | H; preservar | PlayerConnectionView | Frame existente aprovado | ready_for_dev; G5 não implementada
wsQwJ7ry4g | `ybFFiZIeQq` | Player — Confirmar Recomeçar — Pareado | H; preservar | PlayerConnectionView | Frame existente aprovado | ready_for_dev; G5 não implementada
wsQwJ7ry4g | `GxtqFzuqvy` | Player — Confirmar Parar Tudo — Pareado | H; preservar | PlayerConnectionView | Frame existente aprovado | ready_for_dev; G5 não implementada
wsQwJ7ry4g | `TuUROWWoPv` | Player — Confirmar transição para offline | H; preservar | PlayerConnectionView | Frame existente aprovado | ready_for_dev; G5 não implementada
wsQwJ7ry4g | `KSeuQePHvO` | Player — Erro de mídia e recuperação | H; preservar | PlayerConnectionView | Frame existente aprovado | ready_for_dev; G5 não implementada
wsQwJ7ry4g | `kEiJdRV0oQ` | Player — Espera após perda de conexão | H; preservar | PlayerConnectionView | Frame existente aprovado | ready_for_dev; G5 não implementada
## Modo Controller - pareado — IY_IYI21QW

13 frames; 1440×920. HTML e render consultados. Paleta escura, acento violeta, verde para confirmação e âmbar para conexão pendente; modais centrais e foco contornado. Player usa palco/footer em idle e toast superior sobre vídeo; Gestão preserva header/sidebar/fila.

Canvas | Frame ID | Nome | Estado/uso | Componente previsto | Origem | Status
--- | --- | --- | --- | --- | --- | ---
IY_IYI21QW | `5booCMOuTE` | Fila Atual - Pareado | G5.4 base; criar variante header | ManagementRemoteView | Frame existente aprovado | ready_for_dev; G5 não implementada
IY_IYI21QW | `oNE_AaxQym` | Fila Atual - opcoes extras da musica | H; preservar | ManagementRemoteView | Frame existente aprovado | ready_for_dev; G5 não implementada
IY_IYI21QW | `6yW_kHriT1` | Fila Atual - opcoes extras do turno | H; preservar | ManagementRemoteView | Frame existente aprovado | ready_for_dev; G5 não implementada
IY_IYI21QW | `Iul1JD9PBw` | Controller — Confirmar Avançar — Música 1 | H; preservar | ManagementRemoteView | Frame existente aprovado | ready_for_dev; G5 não implementada
IY_IYI21QW | `vihFyZq4qI` | Controller — Confirmar Avançar — Última Música | H; preservar | ManagementRemoteView | Frame existente aprovado | ready_for_dev; G5 não implementada
IY_IYI21QW | `N6Oj_XP92O` | Controller — Confirmar Recomeçar | H; preservar | ManagementRemoteView | Frame existente aprovado | ready_for_dev; G5 não implementada
IY_IYI21QW | `FOBeMzlUWv` | Controller — Trocar Música | H; preservar | ManagementRemoteView | Frame existente aprovado | ready_for_dev; G5 não implementada
IY_IYI21QW | `Y47usa8PN0` | Controller — Erro de envio de comando | G5.2 referência | ManagementRemoteView | Frame existente aprovado | ready_for_dev; G5 não implementada
IY_IYI21QW | `kKJpUsOjMV` | Controller — Comando com confirmação incerta | G5.2 referência | ManagementRemoteView | Frame existente aprovado | ready_for_dev; G5 não implementada
IY_IYI21QW | `9VZvnRMUbQ` | Controller — Erro de disponibilidade | H; preservar | ManagementRemoteView | Frame existente aprovado | ready_for_dev; G5 não implementada
IY_IYI21QW | `NZdmSCHivT` | Controller — Assumir Player local | H; preservar | ManagementRemoteView | Frame existente aprovado | ready_for_dev; G5 não implementada
IY_IYI21QW | `yDsRajh7GQ` | Controller — Divergência de reconciliação | G5.2 referência | ManagementRemoteView | Frame existente aprovado | ready_for_dev; G5 não implementada
IY_IYI21QW | `eghthO89ZV` | Controller — Retornar ao modo pareado | H; preservar | ManagementRemoteView | Frame existente aprovado | ready_for_dev; G5 não implementada

## Reutilização e divergências

Os dez primeiros frames Player são exatamente os dez mencionados no backlog. Toasts estabelecida/restabelecida idle e vídeo são variantes do mesmo componente, não duplicatas descartáveis. Menus extras Gestão são variantes de contexto H, não telas de dispositivos. Não há frames de descoberta, consentimento, código ou renovação nestes canvases.

LZhLxxiEgE é histórico quanto ao automatismo: controle manual só após offline explícito confirmado, jamais pela queda. Criar variante para desconectado ainda cercado, preservando original. KagjaYNZTB/FKBFkDoBFM/V8JvnGlZ1D/pZYyL3yDQI/VJTmwS0mZn dizem controle remoto: não usá-los para socket apenas aberto ou como prova de autoridade H. hGwNy76Arh é loading de mídia H, não verificação OPAQUE. KSeuQePHvO é erro de mídia H, não recovery de confiança. kEiJdRV0oQ só informa vez encerrada se fonte H real existir; em G5 reutilizar composição em nova variante genérica quando necessário. TuUROWWoPv serve confirmação offline idle, com revalidação Main; não implementar Stop All de H para liberar essa ação. vihFyZq4qI contém redação antiga sobre próxima vez, reservada à revisão H/D4. Nenhum frame precisa ser apagado. Nenhuma duplicação integral sem propósito foi identificada.

## Execução autorizada Luna — matriz Doop ↔ código (parcial)

Releitura via Doop MCP confirmou os IDs e nomes abaixo nos canvases oficiais. Os 34 frames novos permanecem `draft`; a implementação correspondente está identificada como **Implementada — aguardando revisão visual do proprietário**. Esse status não afirma aprovação visual humana nem equivalência Electron/Doop. Os frames originais estão preservados. As descrições de comportamento abaixo são a documentação funcional associada ao ID, pois a ferramenta consultada não ofereceu campo separado de descrição.

### Frames novos — Player (`wsQwJ7ry4g`, 1280×800)

Canvas | Frame ID | Nome | Estado, ações e fechamento | Componente | Origem | Status
--- | --- | --- | --- | --- | --- | ---
wsQwJ7ry4g | `17miiwgkG1` | G5 — Player — Permitir descoberta nesta rede | Consentimento local para anunciar/descobrir; permitir ou cancelar; mDNS não confere identidade | `StandaloneRemotePairingView` / diálogo de rede | Frame novo criado pelo agente | Implementada — aguardando revisão visual do proprietário
wsQwJ7ry4g | `WeQkDConG0` | G5 — Player — Solicitação de vínculo | Pedido com nome fornecido pelo peer marcado não verificado; aceitar ou rejeitar; Esc/fechar não aceita | `StandaloneRemotePairingView` / solicitação | Frame novo criado pelo agente | Implementada — aguardando revisão visual do proprietário
wsQwJ7ry4g | `RQeG5nd3KK` | G5 — Player — Código temporário | Código G2 efêmero 4–4 e contagem visual; cancelar/fechar termina apresentação conforme Main; nunca entra em snapshot geral | `StandaloneRemotePairingView` / overlay | Frame novo criado pelo agente | Implementada — aguardando revisão visual do proprietário
wsQwJ7ry4g | `lMb3d3PNI6` | G5 — Player — Vínculo salvo, conciliando | Binding durável, reconexão/reconciliação em andamento; não declara controle de negócio pronto | `StandaloneRemotePairingView` / status | Frame novo criado pelo agente | Implementada — aguardando revisão visual do proprietário
wsQwJ7ry4g | `gKbkOTE_Es` | G5 — Player — Pairing — Solicitação expirada | Expiração Main remove o código e apresenta resultado; dispensar aviso | `StandaloneRemotePairingView` / resultado | Frame novo criado pelo agente | Implementada — aguardando revisão visual do proprietário
wsQwJ7ry4g | `3Ve8i_evvD` | G5 — Player — Pareamento — Pedido recusado | Recusa local; fechar aviso; não cria vínculo | `StandaloneRemotePairingView` / resultado | Frame novo criado pelo agente | Implementada — aguardando revisão visual do proprietário
wsQwJ7ry4g | `hC76BM0uuT` | G5 — Player — Conexão — Recuperação necessária | Estado bloqueado exige recuperação local; sem novo pareamento implícito | `StandaloneRemotePairingView` / recuperação | Frame novo criado pelo agente | Implementada — aguardando revisão visual do proprietário
wsQwJ7ry4g | `IlOma2fM5W` | G5 — Player — Modo pareado — Descoberta desativada | Anúncio não habilitado; ação de consentir/ativar; fechar não cria intenção | `StandaloneRemotePairingView` / estado de rede | Frame novo criado pelo agente | Implementada — aguardando revisão visual do proprietário
wsQwJ7ry4g | `0bW_c0718h` | G5 — Player — Renovação guiada — Confirmação local | Consentimento local para iniciar renovação existente; confirmar ou cancelar | `StandaloneRemotePairingView` / renovação | Frame novo criado pelo agente | Implementada — aguardando revisão visual do proprietário
wsQwJ7ry4g | `-3Z-q5rvjt` | G5 — Player — Vínculo — Revogação local | Confirma revogação do binding local; cancelar mantém vínculo; não declara revogação remota quando offline | `StandaloneRemotePairingView` / revogação | Frame novo criado pelo agente | Implementada — aguardando revisão visual do proprietário
wsQwJ7ry4g | `wn-Z_ejzQq` | G5 — Player — Vínculo revogado localmente | Toast temporário acessível após resultado real Main; desaparece sem substituir estado de descoberta ou alterar playback | `StandaloneRemotePairingView` / action toast | Frame novo criado pelo agente | Implementada — aguardando revisão visual do proprietário
wsQwJ7ry4g | `LYrYkpsDVv` | G5 — Player — Descoberta ativa — Endereço local | Listener ativo em endpoint real; ação desativar; não promete peer autenticado | `StandaloneRemotePairingView` / descoberta ativa | Frame novo criado pelo agente | Implementada — aguardando revisão visual do proprietário
wsQwJ7ry4g | `-j085e8H3P` | G5 — Player — Reproduzindo — Gestão desconectada | Toast de transporte perdido; dispensar aviso não altera playback | `StandaloneRemotePairingView` / toast | Frame novo criado pelo agente | Implementada — aguardando revisão visual do proprietário
wsQwJ7ry4g | `f6kkY2kvzU` | G5 — Player — Reproduzindo — Transporte autenticado | Toast informa somente transporte autenticado; não sugere autorização H | `StandaloneRemotePairingView` / toast | Frame novo criado pelo agente | Implementada — aguardando revisão visual do proprietário
wsQwJ7ry4g | `QSVlg0PSWb` | G5 — Player — Descoberta — Iniciando serviço | Estado real `starting`; pareamento desabilitado até listener/capability confirmados | `StandaloneRemotePairingView` / descoberta | Frame novo criado pelo agente | Implementada — aguardando revisão visual do proprietário

### Frames novos — Gestão (`IY_IYI21QW`, 1440×920)

Canvas | Frame ID | Nome | Estado, ações e fechamento | Componente | Origem | Status
--- | --- | --- | --- | --- | --- | ---
IY_IYI21QW | `BDB-A9_OJv` | G5 — Gestão — Dispositivos — Buscando | Descoberta real em andamento; atualizar/fechar não inventa candidato | `RemoteDevicesView` | Frame novo criado pelo agente | Implementada — aguardando revisão visual do proprietário
IY_IYI21QW | `khXT-ViWGa` | G5 — Gestão — Dispositivos — Nenhum encontrado | Estado vazio real de discovery; atualizar, avançado ou fechar | `RemoteDevicesView` | Frame novo criado pelo agente | Implementada — aguardando revisão visual do proprietário
IY_IYI21QW | `2rtXT58X9B` | G5 — Gestão — Dispositivos — Candidato não verificado | mDNS não é identidade; solicitar pareamento por Main ou fechar | `RemoteDevicesView` | Frame novo criado pelo agente | Implementada — aguardando revisão visual do proprietário
IY_IYI21QW | `8UxaB2f1bz` | G5 — Gestão — Pareamento — Digitar código | Entrada ASCII de oito dígitos; Enter confirma quando habilitado; Esc cancela sem declarar rollback após admissão | `RemoteDevicesView` | Frame novo criado pelo agente | Implementada — aguardando revisão visual do proprietário
IY_IYI21QW | `ZlWeN-P6wB` | G5 — Gestão — Operação — Resultado incerto | Consulta usa `operationId` original; fechar aviso não remove outbox nem reenvia efeito | `RemoteDevicesView` / aviso | Frame novo criado pelo agente | Implementada — aguardando revisão visual do proprietário
IY_IYI21QW | `-AcCxJcbDY` | G5 — Gestão — Conexão — Recuperação necessária | `recovery_required`; somente ação G2 existente quando suportada; sem comando H | `RemoteDevicesView` | Frame novo criado pelo agente | Implementada — aguardando revisão visual do proprietário
IY_IYI21QW | `H18XLLE8rS` | G5 — Gestão — Operações remotas — Pendência recuperável | Outbox reidratada após restart; consulta mantém ID; dispensar aviso não apaga estado | `RemoteDevicesView` / outbox | Frame novo criado pelo agente | Implementada — aguardando revisão visual do proprietário
IY_IYI21QW | `3kjqZIR2rL` | G5 — Gestão — Dispositivos — Endereço manual | Configuração avançada; validação Main segue bootstrap OPAQUE/TLS comum | `RemoteDevicesView` | Frame novo criado pelo agente | Implementada — aguardando revisão visual do proprietário
IY_IYI21QW | `HZZGMYPL79` | G5 — Gestão — Pareamento — Código incorreto e bloqueio | Resultado real de verificação/lockout; sem botão que zere bloqueio | `RemoteDevicesView` / resultado | Frame novo criado pelo agente | Implementada — aguardando revisão visual do proprietário
IY_IYI21QW | `i7LB3MYCgb` | G5 — Gestão — Vínculo salvo — Remoção local | Confirma remoção do registro local; não a representa como revogação remota confirmada | `RemoteDevicesView` | Frame novo criado pelo agente | Implementada — aguardando revisão visual do proprietário
IY_IYI21QW | `unLENeahee` | G5 — Gestão — Pareamento — Recuperar journal persistido | Recupera somente journal em estado suportado por G2; cancelar mantém evidência | `RemoteDevicesView` / recuperação G2 | Frame novo criado pelo agente | Implementada — aguardando revisão visual do proprietário
IY_IYI21QW | `v6QlAKsTJf` | G5 — Gestão — Fila atual — Header Dispositivos | Variante editável; botão à esquerda do sino; original `5booCMOuTE` preservado | `#btn-devices` em `src/app.ts` | Frame novo criado pelo agente | Implementada — aguardando revisão visual do proprietário
IY_IYI21QW | `akUF6RNnWz` | G5 — Gestão — Pareamento — Journal G2 incerto preservado | Explica resultado incerto persistido; não oferece repetição de pairing nem exclusão de journal | `RemoteDevicesView` / bloqueio G2 | Frame novo criado pelo agente | Implementada — aguardando revisão visual do proprietário
IY_IYI21QW | `TBe-y_jXzk` | G5 — Gestão — Vínculo salvo — Transporte autenticado | TLS autenticado ainda não conclui reconciliação nem libera autoridade de negócio | `RemoteDevicesView` / status do vínculo | Frame novo criado pelo agente | Implementada — aguardando revisão visual do proprietário
IY_IYI21QW | `Qxv6xGkag2` | G5 — Gestão — Vínculo salvo — Conciliando estado | G3/G4 concilia snapshot/journal; estado pendente não promete controle remoto | `RemoteDevicesView` / status do vínculo | Frame novo criado pelo agente | Implementada — aguardando revisão visual do proprietário
IY_IYI21QW | `2cqvXqM44r` | G5 — Gestão — Vínculo salvo — Reconciliado tecnicamente | Conciliação técnica concluída; operações H continuam indisponíveis em G5 | `RemoteDevicesView` / status do vínculo | Frame novo criado pelo agente | Implementada — aguardando revisão visual do proprietário
IY_IYI21QW | `5YEyNDLF89` | G5 — Gestão — Vínculo salvo — Reconectando | WSS fechado; G4 aguarda nova tentativa com autorização e pin existentes | `RemoteDevicesView` / status do vínculo | Frame novo criado pelo agente | Implementada — aguardando revisão visual do proprietário
IY_IYI21QW | `vMKEpgyHAs` | G5 — Gestão — Vínculo salvo — Player indisponível | Vínculo local persiste sem canal autenticado; atualizar busca não revoga nem repete pairing | `RemoteDevicesView` / status do vínculo | Frame novo criado pelo agente | Implementada — aguardando revisão visual do proprietário
IY_IYI21QW | `32V1x92BP7` | G5 — Gestão — Vínculo salvo — Conectando | Tentativa real de conexão em andamento; TLS ainda não autenticado | `RemoteDevicesView` / status do vínculo | Frame novo criado pelo agente | Implementada — aguardando revisão visual do proprietário

### Frames existentes reutilizados

| Canvas | Frame ID | Uso atual | Status de código |
|---|---|---|---|
| Player | `KagjaYNZTB`, `-cYIWa7IlC`, `FKBFkDoBFM`, `V8JvnGlZ1D`, `LZhLxxiEgE`, `pZYyL3yDQI`, `ZyDfIbwCB8`, `VJTmwS0mZn`, `5xay1Jhkka`, `hGwNy76Arh` | Dez estados de conexão listados no backlog; reusados quando a semântica G5 é verdadeira. “Controle remoto” no copy não significa controle H pronto. | Estado conectado parcialmente; comparação Electron pendente |
| Player | `TuUROWWoPv` | Referência para consentimento do modo offline explícito; playback continua independente | Status/aviso parcial; frame aprovado não alterado |
| Gestão | `5booCMOuTE` | Base para variante do header `v6QlAKsTJf` | Original preservado; comparação pendente |
| Gestão | `Y47usa8PN0`, `kKJpUsOjMV`, `yDsRajh7GQ` | Referências de erro, resultado incerto e divergência; UI usa outbox real e não envia comandos H | Parcial, limitado por ausência de ports de negócio H |

`v6QlAKsTJf` e `akUF6RNnWz` foram criados após uma revisão detectar lacunas visuais correspondentes a partes de UI já escritas. As variantes nativas corrigem a representação, mas a regra de sequência “Doop antes do código” não foi seguida para esses dois detalhes; essa exceção e a comparação Electron pendente também constam do plano e do diário. `QSVlg0PSWb` foi criado antes do ajuste de código para o estado `starting`. Nenhum frame original aprovado foi editado, movido ou removido.

### Evidência de execução e comparação visual — 2026-11-14 UTC

- O smoke real Management exercitou o header Dispositivos, painel e foco, fechamento/Esc, retorno do foco, configuração avançada/IP manual e tamanhos 1366×768 e 1920×1080. Captura do painel em 1440×920: [`management-devices-panel-1440x920.png`](evidence/g5-implementation/management-devices-panel-1440x920.png).
- Comparação manual entre a captura Electron e o render atual do frame `khXT-ViWGa` encontrou correspondência próxima no painel lateral, hierarquia, texto de segurança, estado vazio e posição das ações. É evidência qualitativa de um estado, sem diff de pixels; o fundo da aplicação é real no Electron e apenas uma composição estática no frame.
- O E2E Windows percorreu candidato mDNS não verificado, pedido e recusa local, endereço manual, consentimento local, código real 4–4 visível no Player, digitação na Gestão, OPAQUE/TLS e vínculo persistido. IDs visuais diretamente associados: Player `17miiwgkG1`, `WeQkDConG0`, `RQeG5nd3KK`; Gestão `2rtXT58X9B`, `8UxaB2f1bz`, `3kjqZIR2rL`; variante de header Gestão `v6QlAKsTJf`. Em seguida, offline explícito encerrou o canal observado na Gestão; reativar o listener fez o vínculo salvo reconectar. O código não foi incluído em screenshot, fixture ou log versionado.
- O fluxo removeu a apresentação do código ao concluir e deixou o canal inicialmente autorizado, ainda não reconciliado. O E2E também confirmou pelo modal a saída do Player, reiniciou o mesmo perfil e verificou intenção offline, listener parado e vínculo ativo persistidos, além do vínculo retido na Gestão; depois reativou e reconectou via G4. Na extensão seguinte, confirmou que remoção local na Gestão não revoga nem encerra o Player e que a revogação local aceita no Player produz um toast acessível mantendo `DESCOBERTA ATIVA`. Ainda não foram comparados visualmente os frames Player com screenshots, nem exercitados por UI todos os estados de erro, expiry, lockout, renovação, revogação remota e recuperação. O restart de estados diferentes da intenção offline continua pendente.
- Runner oficial Windows mais recente: `runId` `34501dcd-7447-4617-9c88-8d746d875405`; fingerprint `bf5f5e0f67d979de11a6d351759be7f9c7fa2beb9dde9043b69518c1321cba16`; branch e checkpoint G4 conferidos; Node v24.11.0; foco e cleanup PASS; `testedAt` `2026-11-14T02:41:04.172Z` UTC. A automação atende à confirmação de saída com timeout de 30 segundos. O relatório de evidência completo está em [`docs/evidence/g5-implementation/README.md`](evidence/g5-implementation/README.md).

Esta evidência não altera o status `draft` dos 34 frames novos nem concede aprovação visual. Os 31 frames originais continuam preservados. A matriz Doop↔código está implementada parcialmente; as linhas novas significam que existe uma tela/componente correspondente, enquanto teste de fluxo e comparação visual são gates separados.

### Resultado técnico do bloqueio restart

Bloqueio resolvido e runner Windows relacionado PASS. Causa, cronologia e limites no [diário](evidence/g5-implementation/README.md#condição-exata-isolada-e-bloqueio-resolvido--sol-2026-11-14); não reproduzir a investigação nesta matriz. Refinamento/revisão visual continuam pendentes.
