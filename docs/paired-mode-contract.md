# Modo pareado — contrato funcional e fronteiras G/H

## Situação e precedência

Planejamento de 2026-11-11, autorizado pelo proprietário. Decisões funcionais deste documento vêm da solicitação “Planejamento das Fases G/H e interfaces do modo pareado”. Nenhuma capacidade remota descrita aqui foi implementada ou testada nesta rodada. F permanece encerrada. Este contrato complementa a V1 sem alterar o Standalone independente e substitui propostas históricas conflitantes da arquitetura remota sobre fila completa, comandos PREVIOUS/STOP na Gestão, countdown e autoridade na reconexão.

Fontes: [roadmap](standalone-player-roadmap.md), [arquitetura histórica](remote-player-architecture.md), [playback](player-playback.md), [persistência](sqlite-persistence-safety.md), [plano executivo](paired-mode-execution-plan.md), [interfaces](paired-mode-ui-plan.md). Datas são registros documentais, não datas presumidas de implementação.

## 1. Autoridade e arquitetura

| Estado | Autoridade | Consumidor |
|---|---|---|
| Sessões, mesas/cantores, fila futura, Round Robin, promoção, dados administrativos | Gestão/Combined, aplicação Main-side existente | UI Gestão; Player recebe apenas dados da vez |
| Mídia disponível, execução, tentativa, contenção, EOF natural e cancelamentos operacionais | Main do Player e engine observada | Gestão aplica projeção administrativa dos resultados |
| Resultados operacionais confirmados | Registro durável do Player | Histórico da Gestão por aplicação idempotente |
| Histórico administrativo/manual | Gestão, writer existente | UI Gestão; origem manual explícita, sem fabricar EOF |
| Entrada local independente | Player em modo offline explícito | Nunca importada como fila operacional da Gestão |

Não são duas autoridades sobre o mesmo estado: a Gestão decide quem; o Player registra o que aconteceu. Rede e Renderer não escrevem diretamente no domínio. Renderer → Preload restrito → IPC validado → Main → serviço proprietário. Reutilizar engine, biblioteca, catálogo e recovery existentes; não compartilhar a fila Standalone com a fila Gestão. Um único dono do playback seleciona adapter independente ou pareado, sem dois orquestradores ativos.

G fornece mecanismos genéricos e contratos; H decide efeitos operacionais e aplica projeções. O journal G3 recebe eventos tipados pelo port; não importa `KaraokeApplication`, UI ou regras de Round Robin. H depende dos ports G, nunca o contrário. Não aguardar ACK da Gestão dentro de lock/transação do Player; callbacks de rede são processados fora de transações abertas.

## 2. Base real inspecionada e mudanças necessárias

| Código existente | Capacidade observada | Extensão planejada |
|---|---|---|
| `src/main-management-host.ts`, `management-contracts.ts`, `management-ipc.ts` | Uma aplicação Main-side; snapshot `hostEpoch/revision`; pedidos com `operationId`, ACK IPC | Outbox de operações remotas recuperável; projeção de eventos Player; ACK de negócio separado do ACK IPC |
| `src/application.ts`, `state-repository.ts`, `types.d.ts` | Candidato → persistir → publicar; `QueueEntry.id/sessionId`; duas strings de música; status por apresentação | Resultados por ocorrência, origem manual/remota/local e terminal da vez; migração aditiva a projetar em H1, sem inferir músicas de registros antigos |
| `completeAndAdvance`, `cancelAndAdvance`, `editEntry` | Conclusão/cancelamento selecionam próximo; edição pode alterar ambas as músicas e reparar rotação | Não chamar indiscriminadamente no pareado. Separar aplicar resultado, finalizar vez e promover; Stop All não promove. Edição administrativa não troca música ativa |
| `standalone-player-contracts.ts`, `standalone-player-sequence.ts` | `entryId` volátil, `operationId`, reserva, comandos e árbitro Main | Contrato pareado distinto: pacote de 1–2 ocorrências, apresentação e celebração por vez; não mudar contratos V1 por arrasto |
| `player-playback-contracts.ts`, `player-playback-service.ts`, `player-playback-recovery*` | `attemptId`, `commandId` do host, `hostEpoch`, observações sequenciadas, natural-end-candidate, erro/uncertain/contenção e recovery | Confirmar EOF em resultado durável; registro completo não existe no recovery atual; fences de modo/sessão e alvo exato |
| `main-media-runtime.ts`, `video-library.ts`, `music-catalog.ts` | Resolução local e catálogo opcional; indexação/validação/recovery F0 | Consulta remota sanitizada e revalidação de ambas as músicas antes do aceite e de cada música antes de tocar |

Não há HTTPS/WSS, pairing ou journal operacional remoto implementados nos módulos inspecionados. Persistir resultados não equivale a persistir a fila volátil Standalone. Caminhos novos de módulos serão definidos nos lotes antes de criar arquivos, evitando camadas sem necessidade.

## 3. Identidades e envelopes versionados

Nomes abaixo são contrato de planejamento; schemas executáveis serão produzidos em G3.1.

| Campo | Semântica e compatibilidade |
|---|---|
| `sessionId` | ID existente de `KaraokeSession`; sem associar legado ambíguo |
| `turnId` | Alias explícito de `QueueEntry.id`/`presentationId` histórico; nunca gerar segundo ID para o mesmo turno |
| `occurrenceId` | Nova identidade estável da posição lógica 1 ou 2 dentro da vez; não é código nem tentativa; pode mapear para `entryId` no adapter, sem reutilizar fila Standalone |
| `attemptId` | ID existente do serviço de playback; novo a cada execução/recomeço/troca, preserva ocorrência |
| `operationId` | Uma intenção imutável; retry usa mesmo ID e payload; ação distinta usa novo ID |
| `commandId` | ID interno do host permanece distinto. `commandId`/`playbackId` da proposta antiga mapeiam para operationId/attemptId apenas no contrato de compatibilidade, sem duplicar conceitos |
| `deviceId`, `controllerId` | Identidades estáveis de dispositivo autorizadas; não são segredos nem `hostEpoch` |
| `playerEpoch`, `hostEpoch` | Reinicializações de processo/host; invalidam comandos transitórios antigos, não invalidam resultados duráveis |
| `controlEpoch` | Geração de autoridade/modo; troca explícita invalida comandos antigos sem descartar resultados |
| `stateRevision`, `managementRevision` | Revisões de domínios distintos. Revisão de fila futura não invalida comando de playback ainda válido; comparar alvo e revisão operacional pertinente |
| `eventSequence`, `journalId` | Ordem durável monotônica por journal do dispositivo, atravessa restart; não substituir pelo contador efêmero de observação Chromium |
| `protocolVersion`, `schemaVersion` | Compatibilidade negociada; independentes de SemVer, schema SQLite e versão de política de fila |

Envelope: versão, operação/tipo, identidades autorizadas, sessão, geração de controle, turno/ocorrência/tentativa quando aplicável, revisão esperada e payload validado. Horários são diagnóstico, nunca ordenação entre máquinas. Rejeitar campos desconhecidos perigosos, tamanhos/formatos inválidos, IDs conflitantes e versões incompatíveis antes de efeitos. Não enviar caminhos locais, URLs de mídia/grants, SQL ou credenciais em respostas de negócio.

Pacote `ActivateTurn`: sessão, turnId, revisão imutável do pacote, cantor/mesa/dados administrativos necessários, lista ordenada de exatamente 1 ou 2 `{occurrenceId, trackIndex, musicCode}` e operationId. Código é texto; preservar normalização de mídia de cinco dígitos existente e catálogo opcional. Mesmo turnId já aceito não pode iniciar novamente nem com novo operationId; correção de pacote rejeitado exige revisão explícita, nunca substituição de vez aceita.

Snapshot Player: dispositivo/journal/epochs, vínculo autorizado, modo e controlEpoch, revisão, estado real observado, vez aceita/preparada, ocorrência/tentativa/reserva, disponibilidade/revisão da biblioteca, último cursor durável e operações conhecidas. Não contém fila futura da Gestão.

## 4. Aceitação e ciclo da vez

1. Gestão persiste promoção e intenção de envio no owning layer; envia pacote completo. Não publica “tocando” por envio/ACK.
2. Player autentica, valida identidade/estado/revisão e disponibilidade física de **ambas** as músicas. Falha em qualquer uma rejeita aceite sem iniciar, sem cantada e sem escolher outra pessoa.
3. Persistir aceite único e correlação antes de ACK accepted. ACK accepted não significa playback iniciado. Preparação antecipada de uma próxima vez durante celebração só após a anterior encerrada; nunca manter fila futura nem substituir silenciosamente a vez aceita.
4. Após celebração anterior, se aplicável, apresentação exclusiva pareada por 5 s, inclusive vindo de idle. Não há modal de início nem countdown adicional. Sem pacote aceito, espera sem prazo fixo no idle conectado existente.
5. Durante apresentação, vedar edição da vez, cancelamento/avanço e playback; uma geração/timer Main-side. Queda de conexão após aceite não interrompe apresentação nem vez.
6. Revalidar mídia imediatamente antes de cada execução. Música 2 começa automaticamente após EOF natural confirmado de 1 ou Avançar confirmado de 1. Sem celebração entre músicas. Falha em 2 preserva EOF de 1 e bloqueia para recuperação/correção, sem promover outra pessoa.
7. Última música em EOF natural confirmado: persistir cantada e encerramento da vez; celebração 5 s. Última cancelada por Avançar: persistir cancelamento/encerramento; sem celebração. Após conclusão natural ou Avançar confirmado da última música, a Gestão promove automaticamente a próxima vez pelo Round Robin, uma única vez após aplicar o resultado confirmado (D4). Player não calcula cantor; pacote preparado durante celebração só é apresentado após seus 5 s. Sem próxima, idle conectado.
8. Stop All confirmado no Player cancela atual e segunda pendente, registra terminal da vez e volta ao idle. Não desfaz EOF anterior, não promove outra pessoa nem limpa fila futura Gestão.

Estados operacionais planejados: `waiting-turn → validating-turn → presenting → loading → playing/paused → transitioning-track → loading`; `turn-ended → celebrating` somente se última terminou naturalmente; depois `waiting-turn/presenting`. Erro/uncertainty/recovery são condições explícitas, não EOF. Conexão (`connected/reconnecting/disconnected`) e modo (`paired/offline/reconciling`) são eixos separados. Um socket autenticado não libera por si só o controle operacional.

## 5. Comandos, edição e concorrência

Gestão: Play/Pause num botão, Recomeçar e Avançar; sem Voltar e sem Parar isolado. Só playing/paused liberam ações. Loading, apresentação, countdown e transições bloqueiam. Exceção: erro confirmado em loading permite recuperação/troca; não esperar playing inexistente.

Player pareado conserva Pausar/Retomar/Reiniciar/Avançar/Parar Tudo locais, validados no Main e registrados com origem local. Remove somente adicionar à fila no modo pareado. Não remover esses comandos por queda de rede. Restrições de fase/transição aplicam-se a ambas as origens. Standalone independente mantém seu comportamento original.

Recomeçar, Avançar e Stop All pedem confirmação; nenhum modal pausa música. Modal carrega token ligado a sessão/controlEpoch/turnId/occurrenceId/attemptId/revisão operacional. Confirmar revalida no Main. EOF, troca, avanço ou restart concorrentes invalidam token antigo. Abrir modal não reserva playback nem impede EOF.

Avançar primeira: cancelar sem cantada, iniciar segunda e oferecer troca na Gestão. Avançar última: cancelar sem cantada, encerrar sem celebração. Todas as origens entram no mesmo árbitro Main. Primeira ação válida vence; segunda obsoleta é rejeitada sem afetar próxima ocorrência. Play/Pause remoto deve transportar intenção absoluta derivada do snapshot (pause/resume), não toggle cego em retry.

Dados administrativos podem mudar sem reinício/interrupção, fora da janela de apresentação bloqueada. Mudanças não reescrevem resultados executados nem alteram correlação de sessão/turno. Não usar `editEntry` irrestrito no turno ativo.

Troca: exclusivamente ocorrência atual, playing ou paused, ou erro de loading confirmado. Validar novo código antes de conter anterior; ao confirmar, conferir alvo novamente, conter tentativa anterior, registrar substituição e criar nova tentativa do início na mesma occurrenceId. Não editar música cantada nem a segunda futura por esse controle. Sem status visual permanente “Substituída”. Registro interno contém código anterior/novo e tentativas. Falha/timeout de contenção não libera novo playback; resultado incerto exige consulta, nunca repetição cega. Reinício e troca não fabricam cancelamento/EOF nem alteram fila/cantadas anteriores.

## 6. Resultado durável e histórico

Somente **EOF natural confirmado pelo Player** marca automaticamente música cantada. `natural-end-candidate` do serviço é evidência a validar, não resultado já confirmado. Exigir início observado e evidência ended/duração/posição coerente da tentativa atual, com regras existentes de erro/contenção preservadas; um ended bruto não basta. Persistir evento terminal válido uma vez por ocorrência/tentativa; replay não duplica história. O sistema registra término de reprodução, não testemunha canto humano.

Separar journal operacional estruturado de logs de diagnóstico. Cada registro operacional contém journal/dispositivo, sequência durável, IDs de sessão/turno/ocorrência/tentativa/operação, origem local/remota/manual quando pertinente, código realmente executado, tipo, causalidade, resultado e revisão. Tipos mínimos: turn-accepted, attempt-started, natural-end-confirmed, cancelled, restarted, media-replaced, stop-all, turn-ended, playback-error, interrupted/uncertain, control-mode-changed e operation-result. Comando aceito e concluído são registros distintos.

Proposta técnica G3.2: armazenamento Main-only transacional isolado do SQLite operacional Gestão, com append e índices únicos, projeção/estado de operação e cursor de ACK atômicos. Escolher formato/store e política de backup/corrupção em design técnico antes de implementar; não reutilizar JSON descartável de inventário como ledger. Nenhum banco é modificado nesta rodada.

Persistir intenção/aceite antes de efeito; persistir resultado antes de publicá-lo como confirmado. Crash entre efeito físico e escrita não pode ser tornado atomicamente equivalente a uma transação SQLite: recuperar como incerto/interrompido quando não existir prova durável. Falha de gravação preserva evidências/contém novas transições; nunca reporta cantada sem commit. Restart restaura resultados confirmados, não timers/mídia ativa nem autoplay. Retomar vez aceita interrompida depende de reconciliação explícita.

Gestão aplica evento e cursor de consumo em uma transação no owning layer; publica depois do commit e só então ACK de recebimento durável. ACK perdido reenvia evento original. Não apagar journal após simples ACK de socket. Replay paginado/limitado pelo cursor contíguo; lacunas exigem replay/snapshot. Fora de ordem pode ser armazenado sem avançar cursor sobre lacuna.

Retenção: eventos não conciliados e operações incertas não expiram por TTL. Compactação somente após ACK durável e checkpoint verificável; manter tombstone/resultado mínimo de dedupe ou rejeitar epochs aposentados para que limpeza nunca permita reexecução. G3.2 define limites, falha por disco cheio, restauração/rollback de backup, dispositivos revogados e janela suportada de replay; política numérica e store exigem revisão técnica, não promessa de retenção infinita. G4 não libera comando se dedupe necessário foi perdido.

Histórico Gestão diferencia resultado de cada música e encerramento da vez. Origem manual offline explícita não gera evento natural-end no Player. Uma apresentação permanece um turno. D1 resolvida: uma música cantada e outra cancelada não alteram a lógica existente do Round Robin, rodadas ou rotação. Preservar os resultados individuais sem criar regra nova de contagem, estreia ou cadência. Não converter todo encerramento em `done` por conveniência.

## 7. Operações pendentes e reconciliação

Gestão mantém registro temporário **recuperável após restart**, separado de log: operationId, payload/hash imutável, alvo, sessão/epochs/revisão, envio e resultado. Não basta Map em memória para comandos enviados. Estados mínimos: prepared/not-sent, sent/unknown, rejected, accepted, completed; timeout é informação de comunicação, não prova de falha de execução. Spinner com prazo limitado termina em estado incerto visível; não descartar registro.

Falha comprovadamente antes de enviar permite envio da mesma intenção; rejeição é terminal conhecida; ACK accepted aguarda resultado; após envio sem resposta consultar operationId original. Nunca criar novo Avançar automaticamente. Novo ID para outra intenção só quando estado/alvo permitem. Mesmo ID com payload diferente é conflito.

Reconexão: autenticar e validar versão/sessão → snapshot atual → resultados duráveis desde cursor → comparar operações/revisões → aplicar idempotentemente e resolver incertas → atualizar histórico/UI → liberar novas operações seguras. EOF ocorrido durante handshake entra no journal/cursor e é aplicado uma única vez. Snapshot pode exigir nova leitura se revisão mudou; não congelar playback para reconciliar. Nenhum passo segura lock esperando outro processo.

Divergência insolúvel: preservar execução e evidências, bloquear só ações dependentes e mostrar decisão contextual na Gestão. Não sobrescrever história, duplicar turno nem liberar replay de mutação incerta. Sessão antiga permanece vinculada aos seus resultados; mudança de sessão não interrompe mídia por efeito colateral.

## 8. Offline, retorno e takeover

Queda simples: vez aceita continua, inclusive segunda música e apresentação; resultados ficam locais. Depois do terminal não inventar nova vez. Gestão continua administrativa, sem comandos ao dispositivo desconectado; marcação manual tem origem explícita e não duplica resultado remoto por coincidência de código/nome.

D3 resolvida: é proibido mudar para offline durante uma vez pareada ativa, inclusive apresentação, loading, música ou transição entre as músicas. Aguardar a conclusão da vez ou exigir Parar Tudo explicitamente, com confirmação e encerramento/contenção confirmados, antes de permitir a transição. O pedido de offline nunca aciona Stop All por efeito colateral. Revalidar ausência de vez ativa no Main ao confirmar, evitando corrida com aceitação de nova vez. Offline exige confirmação e cerca controlEpoch antes de habilitar entrada local. Resultados confirmados sobrevivem; comandos antigos não são executados. Não mudar função instalada player/combined: trata-se de modo operacional, não manutenção do instalador.

Reconectar socket não reassume controle remoto. Exigir reconciliação e confirmação. Se Player toca localmente, Gestão oferece aguardar fim da música ou encerrar local e assumir agora. Imediato: registrar cancelamento local somente após contenção confirmada, sem cantada; depois ativar vez remota. EOF concorrente é preservado se já venceu; confirmação antiga não cancela próxima música. Aguardar também exige fence para não deixar fila local iniciar outra enquanto assumir; a fila local fica suspensa ao assumir o pareado (D2), sem importação ou execução automática. Permanece pendente somente decidir descarte definitivo versus retorno posterior dessa fila suspensa.

Fila/vez Gestão prevalecem em pareado; não importar fila local. Nada autoriza apagar pendências locais silenciosamente, fundir perfis/bancos, descartar resultados ou converter a fila volátil em persistente. D2 está parcialmente resolvida: suspender a fila local ao assumir, sem importação ou execução automática. Não descartar definitivamente nem reativar automaticamente a fila suspensa; esses destinos continuam dependendo de decisão explícita. A suspensão não promete persistência da fila volátil após restart. D3 está resolvida pela proibição de transição durante vez ativa.

## 9. Consulta de mídia

Cadastro Gestão consulta código no Player: disponibilidade, título/artista opcionais, revisão/estado relevante da biblioteca, identidade da consulta. MP4 válido sem CSV é selecionável, com metadados indisponíveis. Resposta não é reserva de arquivo. Correlacionar consulta, dispositivo, código e revisão; ignorar resposta velha, comunicar timeout/desconexão/unknown/ambiguidade. Antes do aceite e antes de tocar, revalidar fisicamente. Não replicar catálogo/metadados na Gestão como pré-requisito, nem expor caminhos de arquivos. D5 resolvida: com Player conectado, bloquear cadastro de música comprovadamente inexistente; na operação administrativa offline, permitir cadastro marcado explicitamente como não verificado. Timeout, resposta obsoleta ou unknown não comprovam inexistência e não podem ser apresentados como mídia validada. A decisão não autoriza bloqueio por ausência de CSV. Disponibilidade continua obrigatória antes da reprodução remota, tanto no aceite quanto antes de cada música.

## 10. Decisões funcionais aprovadas e gates restantes

Atualização documental por decisão explícita do proprietário nesta sessão. D1, D3, D4 e D5 estão **resolvidas**; D2 está **parcialmente resolvida**. São requisitos para implementação futura, sem código ou testes novos e sem alteração de frames Doop.

| ID | Estado | Regra aprovada e impacto |
|---|---|---|
| D1 | Resolvida | Resultados individuais cantada/cancelada preservados; uma vez mista não altera lógica existente de Round Robin, rodadas ou rotação. H1.2/H3.1 verificam compatibilidade, sem novo gate funcional |
| D2 | Parcialmente resolvida | Ao assumir pareado, suspender fila local; não importar nem executar automaticamente. H3/H4 podem planejar suspensão; descarte definitivo versus retorno da fila suspensa continua pendente e bloqueia somente esses destinos |
| D3 | Resolvida | Não entrar offline durante vez pareada ativa. Aguardar conclusão ou Parar Tudo explícito e confirmado antes da transição. H3.3/H4 validam ausência de vez ativa no Main |
| D4 | Resolvida | Gestão promove automaticamente a próxima vez pelo Round Robin após EOF natural da última ou Avançar confirmado da última. Stop All não promove; replay não promove duas vezes. H1.3/H3.1 |
| D5 | Resolvida | Player conectado: bloquear música comprovadamente inexistente no cadastro. Administrativo offline: permitir cadastro marcado não verificado. Revalidar antes da reprodução remota. H1.1 |

As regras aprovadas não autorizam descartar evidências, alterar invariantes existentes, executar fila suspensa ou iniciar implementação. T1/T2 permanecem intactos:

| ID | Decisão técnica ou gate | Gate afetado |
|---|---|---|
| T1 | Modelo de confiança/certificados, descoberta/endereço e rotação/revogação, persistência segura de segredos | [Proposta G1.1 aprovada](g1-1-t1-secure-transport-proposal.md); G1.2-A–D implementadas. G1.3 permanece parcialmente validada: multicast real local passou após correção do bind; smoke focado do módulo discovery em ASAR passou. Windows nativo e LAN física entre computadores seguem pendentes; rebuild limpo posterior foi bloqueado por indisponibilidade de rede. Ver resultados e justificativas na proposta e no ticket G1. |
| T2 | Store isolado do journal, retenção/compactação, quotas e backup/recovery; prazo/capacidade suportados de replay | Design G3.2 antes de implementar persistência |

Novos frames ficam draft, revisáveis pelo proprietário; não são aprovação visual presumida nem autorização de código. T1 está aprovada. G1.2 foi implementada e G1.3 está em validação parcial; G2 permanece não iniciada. Demais gates e [sequência](paired-mode-execution-plan.md) impedem dependências circulares.

## Interface técnica LAN — proposta T1 revisada

O proprietário definiu o fluxo normal integral na UI/LAN: descoberta automática, seleção, confirmação segura e reconexão, sem arquivo/QR/IP/fingerprint obrigatório. A [proposta técnica LAN](g1-1-t1-lan-pairing.md) define DiscoveryCandidate não autorizado em G1, SRP-6a/binding de certificado e vínculo único em G2, reconexão automática em G4 e UI G5. Só provas/consentimento/persistência criam TrustedPeer; TXT mDNS não concede autoridade. Transporte reconectado não retoma Player explicitamente offline. T1 foi aprovada; G2.1 mantém revisão criptográfica antes de pairing em produção. G1.2 está implementada, sem pairing; G1.3 está parcialmente validada conforme proposta e ticket G1. Nenhum esquema operacional, D1–D5, T2 ou registro durável é redefinido.
