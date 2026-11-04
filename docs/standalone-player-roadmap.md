# Roadmap de migração — Standalone e Combined

## Objetivo

Registrar a migração do Player Only legado para o **Player Only (Standalone)** de tela única e a consolidação das funções operacionais atuais no **Tudo em um (Combined)**. Este roadmap é subordinado à especificação funcional V1 em [`standalone-one-screen-player.md`](standalone-one-screen-player.md); não a substitui nem autoriza funcionalidades adicionais.

> **AVISO DE TRANSIÇÃO**
>
> O Karaoke Queue está migrando para uma arquitetura com dois modos de operação: Player Only (Standalone) e Tudo em um (Combined). A implementação anterior do Player Only permanece temporariamente no repositório. Depois da validação funcional, visual e audiovisual do novo Standalone e da aprovação do proprietário, a UI, as regras e os testes exclusivamente antigos serão revisados e removidos somente quando comprovadamente obsoletos. Serviços técnicos compartilhados serão preservados e reutilizados quando apropriado.

O código ainda pode expor três valores de modo. Isso é compatibilidade transitória, não o produto-alvo. A seleção de modos não faz parte da A1 e não deve ser alterada antes da Fase E.

## Estado do checkpoint pré-migração

- **Branch base:** `feature/remote-player-lan-integration`.
- **HEAD pré-checkpoint:** `3f7d8597e51c52b8ec8990a119193a5c84dadddb`.
- A implementação das fases 5F-B3/B4/B5 e seus testes locais são preservados pelo checkpoint A1.
- A validação automatizada Linux e Windows da 5F-B5 foi registrada; a validação audiovisual manual no Windows continua pendente do proprietário. O checkpoint não representa aprovação audiovisual.
- A especificação V1 é a fonte funcional, foi fornecida no working tree e deve permanecer byte a byte inalterada até autorização explícita.

## Arquitetura-alvo

```text
Infraestrutura compartilhada
           ↓
Orquestração específica do modo
           ↓
Interface específica do modo
```

- **Standalone:** uma sequência local e independente, conforme a V1; não depende da fila inteligente, das sessões, do histórico nem do `AppState` Controller.
- **Combined:** preserva `KaraokeApplication`, `StateRepository`, SQLite operacional e as regras atuais do Controlador; controla reprodução local ou, em etapa própria, um Player remoto.
- **Compartilhado quando tecnicamente adequado:** engine Chromium/Electron, `PlayerPlaybackService`, resolução/validação da mídia, biblioteca, serviços de catálogo se aprovados no escopo V1, recovery, IPC seguro e gerenciamento de recursos/janelas.
- Reutilizar um serviço técnico não torna compartilhada a semântica de uma fila nem obriga reutilizar a interface antiga.

## Auditoria A1 — fatos que orientam a migração

### Infraestrutura de reprodução candidata à reutilização

- `src/player-playback-service.ts` mantém o estado e as tentativas de playback no Main, valida códigos, serializa transições e correlaciona observações do host.
- `src/chromium-playback-host.ts`, `player-preload.ts` e `src/player-playback-renderer.ts` implementam o limite Main/Preload/Renderer do host Chromium; `src/player-media-protocol.ts` fornece acesso local por capacidades opacas, sem passar caminhos pela UI.
- `src/video-library.ts`, `src/video-library-configuration.ts` e `src/video-library-service.ts` separam parser/configuração/indexação/lookup. O serviço de biblioteca é Main-side; caminhos absolutos não são contratos da UI.
- `src/player-playback-recovery-store.ts` e `src/player-playback-recovery.ts` fornecem persistência e coordenação de recovery sem criar histórico Controller.
- `src/player-video-window.ts` administra o host e a janela de vídeo da implementação atual. Sua reutilização futura depende das necessidades da nova interface e deve permanecer separada da orquestração.
- `src/music-catalog.ts`, `src/music-catalog-service.ts` e `database.ts` oferecem parser e persistência CSV. A interface e as opções do Standalone devem seguir a V1 aprovada pelo proprietário, não o fluxo antigo por inferência.

### Orquestração e UI legadas

- `src/manual-playback-service.ts` é o orquestrador da sequência antiga: current/pending/previous, adição, batch, remoção, reordenação, Next/Previous e avanço após EOF validado. É Main-side e não possui a fila/histórico Controller, mas suas regras não são equivalentes à V1.
- `src/player-control-renderer.ts`, `src/player-control.html`, `src/player-control.css` e `src/player-ui-contracts.ts` pertencem ao shell legado com áreas Controle, Reprodutor e Configurações. `player-control-preload.ts` expõe as operações desse shell.
- Entrada em lote, botões Previous/Stop, reorder/clear, menu, modal, telas separadas e configuração visual descrevem a implementação existente. Não devem ser transplantados para a V1 sem constarem na especificação.
- `src/player-playback.html` e `src/player-playback-renderer.ts` compõem o host técnico Chromium, distinto do shell visual.

### Funcionalidades V1 ainda ausentes ou com semântica diferente

- A UI atual não implementa os atalhos V1 para dígitos, `P`, Espaço, `Ctrl + →`, `R`, Backspace e Esc contextual; também não é uma tela única.
- A sequência atual adiciona faixas pendentes no fim. Não há prioridade LIFO: cada nova prioridade deve ficar à frente das anteriores.
- O `next()` atual, sem item pendente, retorna uma condição de borda e deixa a tentativa atual ativa. A V1 exige encerrar/remover a atual e voltar a ocioso quando não existe próxima música.
- Previous, reorder, clear, remoção de itens e outras operações da sequência antiga não aparecem na V1. Não expô-las no novo Standalone por conveniência.
- A fila V1 e seus comandos precisam ter uma única autoridade no Main. Eventos e ACK do host devem continuar correlacionados por tentativa; a identidade de tentativa de mídia não substitui um ID de intenção/comando quando uma operação for deduplicável.

### Domínio Controller preservado para Combined

- `src/application.ts` contém `KaraokeApplication` e as operações da fila/sessão; `src/state-repository.ts` coordena persistência e recuperação; `src/app-state-validation.ts` valida estado; `database.ts` e `main.ts` são proprietários da fronteira SQLite/IPC.
- `src/queue-rules.ts`, `src/round-robin-rules.ts`, `src/debut-cadence-rules.ts`, `src/fixed-turn-rules.ts`, `src/frozen-queue-rules.ts` e `src/history-rules.ts` mantêm regras de mesa, ordenação, proteção e histórico.
- `src/app.ts`, `src/index.html`, `src/style.css` e `src/ui/` compõem a UI operacional atual. Essas capacidades e dados passam ao Combined; não são alvo de remoção ou refatoração nesta A1/A2.

### Acoplamentos e riscos observados

- `main.ts` é o compositor atual e ramifica startup, IPC, bancos e janelas usando `OperatingModeCapabilities`. Há modo `controller`, `player` e `combined` em `src/operating-mode.ts`; a escolha persistida fica em `operating-mode.json`.
- Em Player, Main cria biblioteca, protocolo, playback, sequência, recovery e catálogo isolado, sem abrir `karaoke.sqlite`. Em Combined, cria serviços Controller e serviços técnicos de Player sobre a única conexão operacional, mas não cria o host/janela visual Player da implementação atual.
- `src/player-control-preload.ts` e `src/player-ui-contracts.ts` estão ligados à UI antiga. A nova interface precisará de contratos próprios ou de uma superfície mínima comprovadamente compartilhável; não se deve expor bridge genérica.
- `KaraokeApplication` e `StateRepository` vivem hoje no Renderer Controller, enquanto SQLite e IPC ficam no Main. Combined deve preservar um único estado operacional confirmado e não criar uma segunda instância de fila/writer para o Standalone.
- `main.ts::runPlayerOperation()` conta operações em curso; não fornece uma serialização global para todos os comandos. A ordem depende das filas/guards específicos dos serviços. A2 não deve documentar garantias que o wrapper IPC não oferece.
- A fila Standalone não deve ser conectada ao banco/fila/histórico Controller. A política de durabilidade da fila não está definida na V1; não inventar persistência nem prometer durabilidade antes de esclarecimento/aprovação.

## Fases

### Fase A — Preparação arquitetural

#### A1 — Checkpoint, documentação e auditoria arquitetural — concluída neste checkpoint

- Ler AGENTS, documentação e configuração de modos; inspecionar o working tree pré-existente.
- Registrar a direção Standalone/Combined no `AGENTS.md` e avisos curtos nos documentos que descrevem o Player legado.
- Auditar infraestrutura compartilhável, UI legado, domínio Controller e acoplamentos.
- Criar este roadmap e preservar a especificação V1 sem alterações.
- Criar um checkpoint Git local. Ele preserva a implementação 5F-B3/B4/B5, mas não substitui a validação audiovisual manual pendente.

#### A2 — Preparar isolamento e contratos — concluída, sem ativação no aplicativo

**Objetivo:** preparar fronteiras de modo para a base não visual do Standalone sem mudar UI, seleção de modo, comportamento legado, Combined ou rede.

##### A2.1 — Contratos e base isolada — concluída

- `src/standalone-player-contracts.ts` define estados operacionais V1, condição técnica do playback, itens da sequência, submissões completas, IDs de operação, resultados e eventos consumidos do playback.
- `StandalonePlaybackPort` é uma interface técnica estreita compatível estruturalmente com `PlayerPlaybackService`; não cria host, engine, biblioteca ou fluxo de execução duplicado.
- A porta recebe somente código canônico de cinco dígitos. A futura orquestração pode reutilizar `normalizeCatalogCodeForVideoMatch()` sem passar por `ManualPlaybackService`; `PlayerPlaybackService` revalida o código pela `VideoLibraryService`. `MusicCatalogService`/CSV permanece opcional e separado da elegibilidade de playback, para metadados quando a V1 aprovada precisar deles.
- `StandalonePlayerControl` descreve a futura fronteira da orquestração Main-side. A implementação ainda não está conectada ao `main.ts`, IPC, modos ou Renderer.
- A interface futura continua responsável pelo buffer numérico, Backspace e navegação/temporizadores de menus. O serviço recebe somente o código completo e a ação normal/prioritária.
- IDs de operação identificam intenções/retries; `attemptId` identifica exclusivamente uma tentativa de mídia. Reuso de ID com payload diferente deve ser rejeitado; cada intenção nova usa novo ID.
- Snapshot `ready` é uma união discriminada que não permite `idle` com current/pending nem `playing`/`paused` sem current. `blocked`/`uncertain` são snapshots técnicos separados dos três estados operacionais V1; preservam o último estado estável e pendências sem declarar um `idle` normal. `blocked` representa uma falha conhecida após efeito parcial (por exemplo Stop confirmado e start seguinte falho); `uncertain` representa resultado não confirmado. Nenhum autoriza avanço ou retry automático. A fila continua volátil; snapshot não promete persistência.
- `StandalonePlaybackEvent` reutiliza os eventos públicos correlacionados do `PlayerPlaybackService`, mas não transfere ao novo orquestrador toda a proteção do host: o orquestrador ainda deve comparar `attemptId` e `musicCode` com o current e deduplicar EOF por tentativa. O evento público não leva `hostEpoch` nem sequência do elemento.
- Se EOF/Next confirmar o fim da atual e o início da próxima falhar, preservar o head pendente e publicar estado `blocked`/resultado de erro; não declarar `idle` pronto, pular a faixa ou repetir playback automaticamente. Pré-validar o head reduz falhas conhecidas, mas o início revalida mídia e ainda pode falhar. A política de resolução operacional continua pendente antes de B3.
- Contratos exigem que retry da mesma intenção reutilize `operationId` e payload, que IDs diferentes representem novas intenções, e que o mesmo ID com payload diferente gere conflito. Isso ainda não implementa deduplicação. A retenção deve cobrir a vida do processo Main; não prometer deduplicação após restart porque a sequência é volátil. Em particular, um timeout de `toggle-pause` não deve levar a retry cego depois de perda/expiração do resultado.
- A recuperação existente não é diretamente conectável ao novo serviço: `PlayerPlaybackRecoveryCoordinator.attach()` exige `ManualPlaybackService` e suas ações de resolução encaminham para esse orquestrador legado. A2.1 não adaptou nem duplicou esse fluxo.
- Testes nesta subetapa verificam o snapshot inicial, o conjunto de comandos V1 e compatibilidade de tipos com o serviço de playback. Não validam regras da fila nem integração de reprodução.

##### A2.2 — Composição Main-side e coordenação — concluída

**Implementado nesta subetapa:**

- `src/standalone-player-runtime.ts` oferece uma composição Main-side injetável. Ela recebe uma factory de playback, recovery opcional, catálogo opcional, snapshot/correlação e callbacks de preparação de comandos e eventos. Cria exatamente uma instância técnica através da factory; não cria janela, IPC, fila, scheduler, modo ou serviço do Controller.
- A porta estreita continua compatível com `PlayerPlaybackService`. O normalizador padrão reutiliza `normalizeCatalogCodeForVideoMatch()`. O CSV/`MusicCatalogService` pode ser fornecido opcionalmente para metadados, mas não decide se o MP4 é reproduzível.
- A factory recebe a fronteira `PlayerPlaybackPersistence`; quando há recovery, o runtime inicializa e anexa o serviço técnico sem exigir o `ManualPlaybackService` legado. Os contratos públicos de snapshot/encerramento de recovery foram extraídos para `src/player-playback-recovery-contracts.ts`; `PlayerPlaybackRecoveryCoordinator.attach(playback, manual)` continua disponível sem mudança de chamada no Player antigo, e `attachPlayback(playback)` é a nova entrada estreita.
- `StandaloneTransitionArbiter` serializa decisões síncronas e rejeita callbacks assíncronos. Uma lane curta ordena apenas o início dos efeitos. A espera por readiness/ACK do playback fica fora da lane; comandos distintos podem concluir em outra ordem. Eventos de playback usam o árbitro síncrono e não esperam a conclusão de comandos. `StandalonePreparedCommand.execute()` retorna evidência técnica sem publicar snapshot; `commit()` é síncrono, roda no mesmo árbitro após o resultado e deve validar a reserva/tentativa atual antes de devolver o snapshot autoritativo. Quando criado, `attemptId` acompanha o resultado técnico e continua distinto do ID da intenção.
- `operationId` deduplica durante a vida desta instância Main: mesma identidade e payload compartilham a mesma Promise e resultado, payload divergente é rejeitado, e um ID novo representa outra intenção. O ledger é volátil e é limpo no descarte; não oferece deduplicação após restart.
- `attemptId` permanece identidade técnica da tentativa, separada de `operationId`. Evidência técnica pode informar seu `attemptId`; o commit deve compará-lo à tentativa/reserva atual. Eventos são aceitos somente se tentativa/código ainda correspondem ao estado autoritativo da engine e ao current ou à reserva fornecida pela orquestração. Uma reserva sem `attemptId` só é vinculada por `state-changed` compatível com o estado atual. EOF exige estado técnico `completed` e é entregue no máximo uma vez para a tentativa correlacionada. `interrupted` por Stop/Restart permanece distinto de EOF. O handler é síncrono por tipo e thenables recebidos em runtime são reportados como `INVALID_STATE`; essa defesa não desfaz efeitos que um callback JavaScript inválido já tenha iniciado, então handlers futuros devem permanecer tipados e síncronos.
- Recovery pendente/inacessível bloqueia a preparação de novos comandos. Não há autoplay nem resolução automática. Descarte é idempotente: fecha comandos, cancela sinais em andamento, remove listener de playback, descarta o serviço técnico para conter recursos, aguarda as operações e então descarta recovery. Adapters futuros devem observar `AbortSignal` e retornar resultado tipado.
- Falhas conhecidas são representadas por resultado `rejected` ou `blocked`; exceção não tipada após preparação é convertida em evidência `uncertain`. A composição só devolve `confirmed` após `execute()` retornar a evidência técnica e `commit()` aceitá-la sob o árbitro. Se o handler síncrono de EOF falhar, a ocorrência já fica deduplicada e o erro é encaminhado a `onCoordinationError`; não há retry automático. O dono de estado futuro deve converter essa falha em bloqueio/incerteza e reconciliar antes de aceitar nova mutação.

**Limites explícitos desta entrega:**

- O runtime está isolado e não foi conectado ao `main.ts`, preload, IPC, Renderer, modos ou fluxo de inicialização.
- A factory e os serviços são injetados: esta subetapa não instancia uma `VideoLibraryService`, `PlayerPlaybackService` ou `MusicCatalogService` real, não seleciona caminhos e não executa MP4/CSV. A reutilização concreta desses serviços permanece para a composição de produção futura.
- Não existe ainda proprietário real da sequência nem implementação completa de `StandalonePlayerControl` com publicação/assinatura de snapshots. `getSnapshot` é fornecido pelo futuro estado Standalone; fila, prioridades, estados, regras de EOF e confirmação de start ficam para B1/B3.
- A recuperação reutiliza a infraestrutura/coordenador existente, mas não expõe replay ou escolha de música através do `ManualPlaybackService`; decisões de recuperação e UX continuam pendentes e não iniciam playback automaticamente.
- Um efeito assíncrono não deve alterar snapshot autoritativo fora de `transitions.run`. A2.2 garante que o commit do resultado passa novamente pelo árbitro, mas a validação de `attemptId`, reserva e revisão do estado pertence ao callback futuro. B1/B3 deve reservar estado sincronamente, executar I/O fora do árbitro e voltar ao árbitro para confirmar/reconciliar; o limite de operação incerta deve bloquear mutações incompatíveis.
- A proteção `operationId` é somente em memória. Após reinício, uma sequência volátil e a deduplicação também volátil não permitem repetir cegamente um comando. O ledger retém fingerprints/resultados proporcionalmente ao número de intenções até o descarte; não há limite sem alterar a garantia de retry da vida do processo, então qualquer limite/expiração precisa ser decidido antes de expor essa API por IPC.

**Validação focada:**

- `npm run compile` passou. `npm run test:unit:standalone-runtime` passou na execução final: contratos A2.1 3/3, runtime A2.2 18/18 e recovery compartilhado 30/30; exit code 0.
- Os testes usam fakes e cobrem injeção/lifecycle, início ordenado de operações sem bloquear pelo ACK anterior, barreira Next versus EOF e commit reentrando pelo árbitro, deduplicação e conflito de IDs, IDs distintos, recovery bloqueado, falhas tipadas/incertas/bloqueadas, normalização, EOF duplicado/obsoleto, handler com falha reportada, rejeição de handler assíncrono, reserva inicial e separação Stop/EOF. O teste Next/EOF confirma que evento e commit são arbitrados sem lock de ACK; não prova a política de vencedor nem avanço único, que depende do dono real da fila em B1/B3. Não validam engine real, catálogo real, UI ou playback em mídia.
- E2Es Electron/Linux, testes visuais e runner Windows foram omitidos: a composição não está ativada nem altera UI ou fluxo do app. Suítes Controller/Combined também foram omitidas por não haver dependência ou alteração nesses módulos.

**Revisões independentes:** Architecture, Concurrency, Code Review e Security concluíram sem bloqueadores após a correção da lane de ACK e da assinatura síncrona do handler. Permanecem documentados o ledger de `operationId` sem limite e a obrigação dos adapters/commits de honrar cancelamento e reconciliar resultados incertos antes da integração de produção.

### B1 — Estados operacionais e fila Standalone — implementada, isolada e testada com fakes

**Implementado nesta subetapa:**

- `src/standalone-player-sequence.ts` implementa `StandalonePlayerControl` como proprietário Main-side da sequência volátil. A criação recebe a porta técnica por injeção através do runtime A2.2; a composição não está ligada ao `main.ts`, ao Electron startup, ao preload ou a IPC.
- Os snapshots `ready` representam somente os estados V1 `idle`, `playing` e `paused`. `idle` não contém música atual nem pendências. `transitioning`, `blocked` e `uncertain` são condições técnicas separadas, preservando pendências e último estado estável sem fingir ociosidade normal.
- Adições normais são ordenadas FIFO e prioridades são inseridas em LIFO na mesma lista pendente. Itens repetidos são ocorrências distintas. A prioridade não interrompe a atual nem retoma playback pausado. IDs de entrada/tickets mantêm ordem de intenção mesmo quando validações terminam fora de ordem.
- A primeira adição em idle reserva o head antes de iniciar a validação/tentativa técnica; a ocorrência continua pendente até playback confirmado. Falha conhecida ao iniciar deixa a sequência bloqueada com o head preservado; resultado incerto fica separado de bloqueio confirmado e não dispara autoplay/retry. Uma falha de validação conhecida não admite o item e permite que o próximo item já validado seja tentado.
- EOF natural confirmado reserva a próxima ocorrência; sem próxima, limpa o mídia concluída antes de publicar idle. `Next` reserva a atual, usa `stop(expectedAttemptId)` e inicia a próxima ou limpa mídia parada para retornar a idle; não sintetiza EOF. `Restart` preserva `entryId` e substitui apenas a tentativa. Pausar/continuar mantém música atual e pendências.
- **Linearização:** após validar a solicitação e consultar a deduplicação por `operationId`, o runtime captura o snapshot de submissão. A lane síncrona A2.2 arbitra preparação de comando, aceitação de EOF e commit; `Next` compara o attempt capturado e reserva a tentativa atual e seu head pendente durante a preparação. EOF já linearizado vence e torna Next obsoleto. Se EOF natural for confirmado pela engine antes do ACK de Stop, a mesma reserva de Next reconcilia a conclusão e produz apenas um avanço. Adições não confirmadas por validação não entram na fila; ordem FIFO/LIFO usa ticket de admissão alocado na preparação, e commits válidos inserem segundo esse ticket. EOF/Next reservam seu head; adições prioritárias linearizadas depois ficam atrás desse head reservado.
- `operationId` continua identificando retry/intenção e o ledger A2.2 devolve a mesma Promise para payload idêntico e rejeita o mesmo ID com payload divergente. `attemptId` só identifica uma tentativa técnica; eventos antigos são ignorados quando engine, current ou reservation já apontam para outra tentativa. EOF é deduplicado por tentativa no runtime.
- Efeitos automáticos de EOF/start são rastreados, erros de background são observados e `dispose()` fecha a composição, cancela recursos e aguarda tarefas rastreadas. A fila permanece volátil, sem persistência ou histórico.

**Validação B1:** `npm run compile` passou (exit 0); `npm run test:unit:standalone-sequence` passou com 38/38; `npm run test:unit:standalone-runtime` passou com contratos 3/3, runtime 18/18 e recovery compartilhado 30/30 (exit 0). Os testes B1 usam fake playback determinístico e cobrem os estados, FIFO/LIFO, validações concorrentes, pausa, EOF/Next e suas corridas, duplicação/conflito de `operationId`, tentativas antigas, bloqueio/incerteza, recovery bloqueado, falha de início, snapshots e descarte durante efeito automático. Esses testes não comprovam áudio/vídeo, host Chromium nem `PlayerPlaybackService` real. E2E Electron, Windows, Controller/Combined e testes visuais foram omitidos por não haver ativação, mudança de UI ou alteração nos fluxos do aplicativo.

**Limites e pendências:**

- O código usa a porta compartilhada tipada e fakes; não foi conectado a `PlayerPlaybackService`, biblioteca real, host Electron, CSV ou fluxo de recovery em execução. Playback real permanece para B3.
- `Next` sem current é idempotente e confirma sem efeito; chamadas de comandos concorrentes com uma reserva técnica são rejeitadas como estado inválido, exceto submissões de código que podem validar/admitir e respeitar o head reservado.
- Falha/resultado incerto bloqueia novos comandos. Não existe fluxo de reconciliação manual/UI nem política para retirar bloqueio; definir a integração com recovery antes de habilitar no produto.
- A fila é em memória e se perde com encerramento do processo. B1 não implementa o intérprete de teclado, buffer numérico, UI, canais IPC ou ativação no aplicativo.

### B2 — Interpretação de teclado e estado de interação — implementada sem UI

**Implementado nesta subetapa:**

- `src/standalone-player-keyboard.ts` interpreta somente os atalhos V1 em uma forma de evento independente de DOM. Aceita dígitos da fileira principal e do teclado numérico através do valor `key`; ignora repetição automática e combinações não aprovadas de modificadores. `Ctrl + ArrowRight` exige Ctrl sem Shift/Alt/Meta.
- `src/standalone-player-interaction.ts` mantém o buffer numérico e o estado lógico dos painéis/menu, separados da fila B1. O buffer preserva os dígitos exatamente como digitados, aceita até cinco, apaga um por Backspace e não completa zeros à esquerda.
- Enter/P com buffer não vazio produzem `StandalonePlayerCommandRequest` imutável para adição normal/prioritária. O código é limpo depois que a intenção é criada, o painel permanece aberto e a próxima entrada pode começar. Cada nova ação intencional recebe ID único do `createOperationId` injetado; consumidores devem reutilizar o mesmo request integral em um retry. `applyCommandResult` correlaciona respostas pelo `operationId`, retorna o status daquela submissão mesmo fora de ordem e atualiza o resumo `lastSubmission` somente quando a resposta corresponde à submissão mais recente. O estado mostra `pending`, `confirmed`, `rejected`, `blocked` ou `uncertain`, e uma rejeição não é tratada como sucesso.
- O painel expira após `digitPanelInactivityMs`, valor positivo obrigatório e configurável na integração visual. A temporização depende de um scheduler injetado, não usa timer global no módulo, e uma geração invalida callbacks antigos após reset/cancelamento. `dispose()` cancela o timer e remove listeners.
- Esc fecha e descarta primeiro o painel; sem painel abre o menu; no menu principal fecha; nas telas `commands`, `options` e `exit-confirmation` retorna ao nível principal. `selectMenuAction()` representa Lista de comandos, Opções, Voltar e Sair para futura UI; confirmação de Sair emite `request-application-exit`, sem diálogo ou encerramento real.
- Enquanto qualquer tela de menu estiver aberta, os atalhos operacionais/numéricos são ignorados, exceto Esc. Abrir ou navegar no menu não emite pause. Espaço, Ctrl+Right e R emitem somente os contratos B1 correspondentes; o interpretador não chama playback nem contém estado da engine.

**Validação B2:** `npm run test:unit:standalone-interaction` passou com 32/32 testes determinísticos usando scheduler fake. A suíte cobre teclas/modificadores/repetição, buffer, limite e zeros, Enter/P, estado e expiração do painel, Esc/menu/saída, resultado autoritativo B1 em ordem e fora de ordem, retries, descarte e listeners. Não comprova captura real de teclas, foco, UI nem funcionamento no Electron.

**Limites e pendências:**

- Não há HTML/CSS, DOM, atalhos globais, IPC ou ligação ao `main.ts`. A futura UI deverá mapear eventos reais para `StandaloneKeyboardStroke`, renderizar snapshots, despachar intentos ao B1 e repassar os resultados sem convertê-los em sucesso local.
- O módulo exige que a integração forneça um `createOperationId` único e um scheduler assíncrono; a duração de inatividade permanece por definir no Doop/integração visual.
- O estado `options` é apenas uma tela lógica vazia; nenhum conteúdo de configurações foi inventado. Lista de comandos e confirmação visual de Sair também aguardam a interface aprovada.

### B3.1 — Adaptador técnico de playback — implementada e validada com host controlado

**Composição entregue:**

- `src/standalone-player-playback-adapter.ts` fornece a composição Main-side `createStandalonePlayerWithSharedPlayback()`. Ela recebe uma `VideoLibraryService` já configurada/varrida, `PlayerMediaSourceProvider`, um `PlayerPlaybackHost` provisionado pelo lifecycle Main, e catálogo/recovery opcionais; então cria exatamente um `PlayerPlaybackService`, conecta o host e entrega essa porta à `StandalonePlayerSequence`/`StandalonePlayerRuntime`.
- O adapter não instancia `ManualPlaybackService`, engine, scheduler, Controller, Renderer, BrowserWindow nem IPC. Ele não é chamado por `main.ts` e não altera a seleção de modos.
- O início usa `normalizeCatalogCodeForVideoMatch()` antes de `validateMusicCode()` e `playImmediately()`. A biblioteca e `PlayerMediaProtocol` são a autoridade técnica do arquivo. Catálogo é apenas uma porta de metadados opcional; a sequência não consulta CSV para admitir nem iniciar vídeo.
- O serviço compartilhado confirma início após readiness e observação `playing`; mantém `attemptId` para correlacionar estados/eventos. O runtime continua deduplicando por `operationId`, separadamente. EOF só chega como candidato natural validado pelo `PlayerPlaybackService`; Stop/Restart continuam interrupções distintas. O runtime rejeita eventos de tentativa obsoleta e a sequência mantém sua arbitragem EOF/Next.
- `StandalonePlayerCompositionOptions.disposeResources` permite ao adapter liberar recursos que possui depois do playback/recovery. A composição também executa essa limpeza se a inicialização falhar. O adapter aguarda `PlayerPlaybackService.dispose()`/contenção do host e então encerra o provedor de mídia, catálogo e biblioteca; o callback de mídia deve remover também o handler Electron instalado.
- Recovery usa `PlayerPlaybackRecoveryCoordinator` como persistence e `attachPlayback()`, sem anexar o serviço manual legado. Estado de startup pendente continua bloqueando a sequência e não provoca autoplay. As ações `replayPrevious()` e `chooseAnother()` do coordenador ainda dependem de `ManualPlaybackService`; a recuperação completa/UX da nova sequência permanece pendente para B3.2.

**Garantias e limite de cancelamento:** a A2.2 verifica o `AbortSignal` antes do início de um efeito e, no shutdown, a composição encerra o `PlayerPlaybackService`, que solicita Stop/containment e fecha o host antes de drenar comandos. Não existe cancelamento individual de uma tentativa por `AbortSignal` no serviço compartilhado; shutdown controlado da instância é o caminho implementado. O host Electron de produção é fornecido externamente porque `PlayerVideoWindow` cria seu `ChromiumPlaybackHost` junto ao lifecycle de janela; conectar esse lifecycle pertence à B3.2.

**Validação B3.1 executada:**

- `npm run compile` — PASS.
- `npm run test:unit:standalone-playback-adapter` — PASS, 8/8. Usa `PlayerPlaybackService`, `VideoLibraryService`, `PlayerMediaProtocol`, `PlayerPlaybackRecoveryCoordinator` e store reais com host/protocolo controlados e arquivo de bytes temporário (não é MP4 decodificável). Cobriu normalização `1001`→`01001`, operação repetida, stream sem path na URL, catálogo opcional e não autoritativo, EOF com próxima, EOF final com limpeza da mídia e retorno a idle, EOF antigo, pause/resume, Restart, Next concorrente com EOF, Next sem próxima, falha conhecida, ACK incerto, recovery pendente, shutdown e cleanup também em erro de composição.
- Regressões afetadas: contratos Standalone 3/3; runtime A2.2 18/18; sequência B1 38/38; playback compartilhado 24/24; recovery 30/30; biblioteca 16/16; catálogo 22/22 — todos PASS, executados diretamente após a compilação.
- E2E Electron, reprodução de MP4 real, Chromium host real, Windows nativo e testes visuais foram omitidos: o compositor não foi ativado, não cria janela nem altera fluxo, IPC ou UI. Esses resultados são prioridade da B3.2; não se declara playback audiovisual real validado nesta subetapa.

### B3.2 — Host Chromium, recovery e playback real — implementada e validada em Linux/Windows

**Composição e ownership no harness isolado:**

- `tests/standalone-player-playback-electron.ts` inicia um processo Electron de teste dedicado, sem executar `main.ts`, registrar IPC de produto, alterar modos ou instanciar `ManualPlaybackService`. Usa uma única `BrowserWindow` com o host técnico existente `player-playback.html`, `player-preload` e `ChromiumPlaybackHost`.
- O harness é o único proprietário da `BrowserWindow`/`WebContents` e fecha o processo Electron. `StandalonePlayerPlaybackAdapter`/sequência possui o `PlayerPlaybackService`, que contém e descarta o host e remove seus listeners/canais técnicos; o callback de descarte do `PlayerMediaProtocol` remove o handler `kq-media`; o adapter fecha o catálogo opcional e `VideoLibraryService`. O registro de esquema `kq-media` é global ao processo Electron e por isso só é registrado dentro de cada processo isolado de teste, nunca concorrentemente no processo de produção.
- A biblioteca, protocolo de mídia, serviço de playback, recovery store/coordinator e host Chromium são instâncias reais. O perfil é exclusivo por cenário; os testes confirmam ausência de `karaoke.sqlite`. Uma pasta temporária separada contém apenas um arquivo MP4 propositalmente inválido para exercitar erro de decodificação conhecido.
- Um arquivo CSV foi encontrado no diretório local de amostras, mas não é aberto no harness. Isso comprova que a disponibilidade e reprodução dos MP4 não dependem de catálogo; catálogo continua opcional para metadados. Os MP4 originais são somente leitura e seus hashes são comparados antes/depois.

**Integração e recuperação comprovadas:**

- O serviço reutilizado confirma o início após readiness/observação `playing`; a sequência permanece autoridade de FIFO/LIFO e comandos. A B3.2 corrigiu uma corrida descoberta no Electron real: o ACK de pause/resume pode preceder o evento Chromium. A sequência agora só confirma a transição depois de observar `paused`/`playing` para o mesmo `attemptId` e código, com checagem de estado após assinatura, abort e limpeza de listener/timer. A falta de estado esperado expira como incerteza, sem declarar sucesso.
- O teste usa códigos sem zero inicial (`1001`, `1002` etc.) e os arquivos físicos de cinco dígitos (`01001.mp4`, etc.). Verifica decode e avanço do relógio de mídia, pausa/continuação, restart com a mesma ocorrência e tentativa nova, ordem de prioridades LIFO e normais FIFO, Next com/sem pendente, EOF natural real de Chromium com avanço, EOF final, retorno a idle e remoção do elemento de vídeo. Para a corrida Next/EOF, uma barreira determinística adia a chamada técnica Stop depois que Next reservou a transição; o MP4 continua tocando, Chromium emite `ended` real, e então Stop é liberado. O teste confirma uma única faixa consumida. O caso EOF posiciona o elemento real no trecho final e aguarda `HTMLMediaElement.ended`; não injeta EOF sintético.
- Outro cenário usa mídia inválida indexada para comprovar bloqueio por falha conhecida, sem confundir com idle. Um crash real do Renderer Chromium durante playback produz snapshot Standalone `uncertain` com erro `HOST_TERMINATED`, mantém o `attemptId` e registro de recovery correlacionados e rejeita nova música. O recovery pendente de startup também bloqueia sem autoplay; identidade divergente é rejeitada e resolução explícita como parada preserva o bloqueio Standalone até futura decisão de UI/runtime. Registro estruturalmente inválido é preservado sem quarentena/resolução automática. Recuperação visual, replay explícito e tratamento operacional completo de estado incerto permanecem pendentes; `replayPrevious()`/`chooseAnother()` do coordinator ainda são ações do legado e não foram conectadas à sequência Standalone.
- `PlayerPlaybackService.dispose()` encerra playback e remove recursos do host; a janela permanece viva até o cleanup do dono Electron. O E2E confirma shutdown, gravação de `shutdown-confirmed`, ausência de banco Controller e saída dos processos Electron isolados. Nenhuma execução manual do produto é encerrada.

**Validação executada nesta subetapa:**

- `npm run compile` — PASS.
- `node --test build/tests/standalone-player-sequence.test.js build/tests/standalone-player-playback-adapter.test.js build/tests/player-playback.test.js build/tests/player-playback-recovery.test.js` — PASS, quatro arquivos. Inclui regressão determinística de ACK antes de observação para pause/resume e regressões dos serviços compartilhados usados.
- `npm run test:e2e:standalone-playback:headless`, com `KQ_PLAYER_TEST_MEDIA_DIR` configurada localmente — PASS no Electron/Chromium real com amostras `01001.mp4`, `01002.mp4`, `01003.mp4`, `01004.mp4`, `01005.mp4` e `01008.mp4`; observou EOF natural e corrida Next/EOF com `ended` HTML5 real; hashes originais inalterados. E2E também cobriu falha conhecida, crash real do Renderer com recovery `uncertain`, recovery pendente/inválido e cleanup. Eventos EOF duplicados e de tentativa obsoleta continuam cobertos pelos testes determinísticos de B1/B3.1, não por injeção na fronteira Chromium. O CSV encontrado não foi aberto.
- `KQ_PLAYER_TEST_MEDIA_DIR=<pasta Windows de amostras> KARAOKE_QUEUE_WIN_CHECKOUT=<clone NTFS isolado> npm run test:e2e:multi-instance:windows -- --approve-untracked --standalone-playback` — PASS no Electron/Chromium nativo sobre a branch `feature/remote-player-lan-integration` e HEAD `8f224a0e2e6900636b2237efc2ab7dba3a9f97e8`; compilou com Node 24.11.0/npm 11.6.1, executou as unidades focadas e os cinco cenários Electron, incluindo crash do Renderer e recovery `uncertain`, removeu os perfis e confirmou ausência de processos residuais. O fingerprint exato consta no relatório de execução do runner. `WINDOW_FOCUS NOT APPLICABLE` é esperado neste modo sem assertion de foco.
- `node scripts/windows-native-runner.test.cjs` — PASS, 24/24, incluindo encaminhamento e allowlist de `--standalone-playback`.
- Revisões estáticas de arquitetura, concorrência, código e segurança não encontraram bloqueadores restantes após correções no teardown do harness.
- A captura é técnica/headless; não confirma áudio audível, sincronização audiovisual percebida, layout visual ou aprovação manual do proprietário.

### B4.1 — Ponte Main/Preload para o Standalone — implementada e testada em Electron Linux, não ativada em produção

**Contratos e fronteiras:**

- `src/standalone-player-ipc-contracts.ts` define os canais versionados `standalone:v1:get-snapshot`, `standalone:v1:execute`, `standalone:v1:subscribe`, `standalone:v1:unsubscribe` e o evento `standalone:v1:snapshot-changed`. A superfície Renderer expõe somente `getSnapshot`, `execute`, `subscribe` e `unsubscribe`; não há IPC genérico, acesso a arquivos, caminhos locais ou objetos Main.
- `src/standalone-player-ipc.ts` depende apenas de `StandalonePlayerControl`. Valida cada remetente contra o `WebContents` autorizado, o frame principal e a URL exata do documento; valida o número de argumentos, os campos permitidos e os comandos V1. Usa `validateStandalonePlayerCommandRequest()` do runtime para que o formato e os limites de `operationId`/payload continuem tendo uma validação autoritativa.
- `standalone-player-preload.ts` é um preload dedicado, com `contextIsolation`, `sandbox` e sem Node exposto. Não modifica `preload.ts`, `player-control-preload.ts` ou `player-preload.ts`; não está referenciado por `main.ts` nem pelas janelas de produção. O preload é autocontido no artefato compilado, sem `require` de módulos locais, e `build/standalone-player-preload.js` é explicitamente excluído do pacote de produção até sua ativação futura.
- A resposta de comando correlaciona `operationId`, resultado `confirmed`/`rejected`/`blocked`/`uncertain`, eventual erro e `attemptId` somente quando o resultado autoritativo da própria intenção o identifica. Adicionar uma música à fila ou rejeitar um comando enquanto outra toca não copia o `attemptId` da música atual. O envelope associado contém a revisão e o snapshot autoritativo mais recente; não devolve um snapshot antigo sem revisão como estado global. Intenções distintas continuam concorrentes e a deduplicação permanece no runtime.

**Snapshots e lifecycle:**

- O Main mantém revisão monotônica por instância da ponte. O subscribe instala a assinatura do `WebContents` antes de capturar o snapshot inicial. O Preload instala o listener local antes do invoke, bufferiza eventos recebidos durante o handshake, entrega o snapshot inicial primeiro e só aplica revisões crescentes. `getSnapshot` e respostas de comando também reconciliam pelo maior número de revisão visto.
- Cada assinatura recebe `generation` criado no Main. Há limite de oito assinaturas ativas por `WebContents`; `unsubscribe` atrasado só remove a mesma geração. Navegação do frame principal/reload e `render-process-gone` limpam subscriptions sem encerrar a ponte, permitindo nova assinatura. Destruição do `WebContents` ou `dispose()` descarta a ponte inteira: remove assinaturas, handlers e listeners, sem tomar ownership nem descartar playback/runtime. Se a resposta de subscribe chegar parcialmente inválida mas trouxer uma referência correlacionada válida, o Preload tenta desfazer a assinatura Main. Unsubscribe não pausa, cancela ou descarta playback/runtime.
- O Preload mantém um cache privado copiado e congelado. `getSnapshot`, respostas de comando e cada callback recebem cópias de DTO projetadas; a mutação de uma cópia no Renderer não altera o cache nem snapshots vistos por outras assinaturas.
- A instalação dos handlers faz rollback dos canais que conseguiu registrar caso haja colisão e libera o listener do controle; handlers preexistentes no canal em colisão permanecem intactos. Uma operação já admitida continua no runtime se a ponte for descartada, mas sua resposta IPC é rejeitada como `STANDALONE_IPC_DISPOSED`, evitando devolver envelope em cache potencialmente antigo.
- O DTO de snapshot é projetado campo a campo, inclusive `current`, sem copiar propriedades futuras ou internas por spread.
- O buffer de dígitos, menu Esc e temporizadores de B2 continuam no Renderer futuro. A ponte recebe somente intenções completas da V1. Nenhum atalho ou estado de interação foi movido ao Main.
- Os handlers são registrados somente pelo harness isolado desta subetapa. `main.ts`, seleção de modo e os preloads de produção permanecem sem integração Standalone.

**Validação B4.1:**

- `npm run compile` — PASS.
- `npm run test:unit:standalone-ipc` — PASS, 15/15 testes determinísticos: validação e origem, respostas correlacionadas, bloqueio/incerteza, revisões, geração, reload/crash/destruição, respostas fora de ordem, shutdown, rollback de registro e limite de assinaturas.
- `node --test build/tests/standalone-player-contracts.test.js build/tests/standalone-player-runtime.test.js build/tests/standalone-player-sequence.test.js build/tests/standalone-player-ipc.test.js` — PASS, quatro arquivos focados que cobrem os contratos, a deduplicação/runtime e a fila afetados pela ponte.
- `npm run test:e2e:standalone-ipc:headless` — PASS com Electron/Preload/IPC reais no Linux/Xvfb e documento temporário vazio. O harness cria uma `StandalonePlayerSequence` real com playback fake, sem `main.ts`, DB Controller, player legado ou MP4. Comprovou que mutar DTOs de callback, `getSnapshot` ou `execute` não altera o cache nem outra assinatura; comandos V1, dedupe/conflito, resposta atrasada, retry do mesmo `operationId` depois de reload, correlação causal de `attemptId`, pause/resume, Restart, Next concorrente com EOF entregue durante Stop, avanço único, atualizações por EOF injetado, revisões crescentes, unsubscribe/re-subscribe e ausência de APIs legadas/Node. A destruição do `WebContents` também remove os handlers sem descartar o runtime. Não é validação de playback real; essa evidência continua sendo a B3.2.
- A execução Electron foi feita no ambiente autorizado para o harness headless após o Chromium negar inicialização no sandbox padrão; nenhuma configuração de sandbox foi alterada. Uma primeira execução encontrou apenas uma expectativa incompleta no próprio teste (a adição de 1005 após EOF final inicia playback); a expectativa foi corrigida e a execução final passou.
- E2E Windows nativa, testes visuais e suítes legadas amplas foram omitidos: esta ponte usa APIs IPC comuns do Electron, não altera código ou lifecycle do Player legado e não adiciona comportamento visual. Não se declara validação Windows desta ponte.

**Recovery e limites:** reload reconecta ao snapshot atual e não resolve nem limpa recovery. Retry automático de uma operação desconhecida não é feito; o consumidor deve reutilizar exatamente o request e `operationId` apenas quando decidir repetir aquela intenção. A retomada de um registro de crash gerado em processo anterior e a política de replay/resolução operacional continuam pendentes; nenhuma UI de recovery foi criada.

### B4.2 — Consolidação funcional isolada — implementada e validada em Linux e Windows nativos

**Composição e fronteiras:**

- `tests/standalone-player-integration-electron.ts` inicia seu próprio processo Electron e compõe uma `StandalonePlayerSequence`, runtime, adapter, `PlayerPlaybackService`, `VideoLibraryService`, `PlayerMediaProtocol`, recovery e `ChromiumPlaybackHost` reais. Não inicia `main.ts`, não usa `ManualPlaybackService`, não registra atalhos de produção e não ativa os modos.
- O harness cria dois `BrowserWindow`/`WebContents`: a superfície técnica de mídia usa `player-playback.html` e `player-preload`; a janela de controle usa um documento HTML vazio e `standalone-player-preload`. Só há uma sequence, um PlayerPlaybackService, uma biblioteca e um handler de protocolo `kq-media` por processo de teste. O harness possui as janelas; o adapter/sequence possui e encerra playback, recovery, protocolo, biblioteca e listeners técnicos; cada bridge pertence ao `WebContents` de controle e é descartado quando ele fecha. O shutdown remove as bridges, a assinatura de eventos do harness e os owners uma única vez. A API de teste observa o `<video>` pela WebContents técnica; não é UI de produto.
- `src/standalone-player-interaction-transport.ts` encaminha intenções B2 pelo método explícito `execute` e correlaciona replies pelo mesmo `operationId`. `StandalonePlayerInteractionController.applyCommandOutcome()` mantém B2 independente de Electron e atualiza somente a submissão correspondente. Transporte perdido ou resposta com outra identidade não vira confirmação local; a intenção continua pendente para reconciliação/retry explícito.
- A captura de teclas reais, foco, buffer/menu visual e execução B2 dentro da futura janela continuam pendentes da Fase C. Nesta E2E, o controller B2 gera as intenções no processo Playwright do harness e elas atravessam o Preload/IPC real. Após recriar a janela, o teste retém de propósito o request no driver e reenvia o mesmo `operationId`; isso comprova deduplicação Main/runtime com ACK perdido enquanto o Main continua vivo, não persistência automática do estado local B2 através de reload.

**URL, snapshots e concorrência:**

- A ponte conserva a igualdade da URL documental completa, além de validar `WebContents` e frame principal. O harness confirma que variações de fragmento e query recebem `STANDALONE_IPC_FORBIDDEN`; menus/estado de navegação futuros devem continuar locais ao documento estático. O Preload só preserva códigos de erro IPC presentes na allowlist; texto arbitrário vira `STANDALONE_IPC_FAILED`.
- A assinatura via Preload recebe snapshot inicial e updates por revisões crescentes; o teste observa reload, nova subscription e reconsulta ao mesmo current/attempt. Replies continuam correlacionados pelo operationId, e retry não executa a tentativa de mídia duas vezes. Respostas fora de ordem são cobertas pelo teste unitário do transport e pelo teste IPC fake B4.1; esta E2E não simula respostas fora de ordem entre requests reais.
- No caso concorrente, o harness retém Stop depois que Next reservou a transição, espera o `ended` do elemento HTML5 real e também espera o handler da sequência marcar EOF para o mesmo `attemptId` enquanto a reserva Next ainda está ativa. Só então libera Stop. Isso verifica o ramo de arbitragem no Main sem EOF sintético e confirma um único avanço para a faixa reservada. Próximas EOFs naturais e a final também foram produzidas pelo Chromium reproduzindo o trecho final real do arquivo.
- Manual Next normal usa Stop e não emite `natural-end-candidate`; restart mantém `entryId` e troca `attemptId`. EOF final deixa snapshot `idle`, sem current/pending, e remove o elemento de mídia.

**Playback e recovery comprovados:**

- Os MP4 `01001.mp4` a `01006.mp4` e `01008.mp4` foram lidos no diretório de amostras Linux. O harness não abriu o CSV encontrado, comprovando playback local sem catálogo. SHA-256 dos MP4s selecionados antes/depois confirmou que as amostras não foram alteradas; o perfil não criou `karaoke.sqlite`.
- Pelo fluxo B2 → Preload/IPC → Main: adição normal, prioridade, entrada inválida/rejeitada, pausa/continuação, restart, Next, same-ID retry, confirmação após recuperar janela, estado incerto e snapshot correlacionado foram exercitados. A sequência confirma FIFO/LIFO, entrada durante pausa não retoma a mídia, e adição não interrompe current.
- Um crash real do Renderer de mídia durante reprodução cria recovery `uncertain` com código/tentativa preservados. Após shutdown controlado e relançamento do processo Electron usando o mesmo perfil, o IPC devolve estado bloqueado, não há autoplay, comandos retornam `RECOVERY_PENDING` e o arquivo de recovery permanece byte a byte igual. Um perfil separado com registro estruturalmente inválido também continua bloqueado e preservado. A resolução/replay operacional continua pendente de contrato e aprovação; este teste não cobre falha abrupta do Main no meio de uma escrita de recovery.

**Validação B4.2 executada:**

- `npm run compile` — PASS no código final desta subetapa.
- Testes focados Standalone, transport B2, IPC B4.1, adapter, `player-playback`, recovery e `node scripts/windows-native-runner.test.cjs` — PASS; incluem concorrência runtime/sequence, dedupe/conflito, erros, recuperação e allowlist do novo runner.
- `npm run test:e2e:standalone-integration:headless`, com `KQ_PLAYER_TEST_MEDIA_DIR` configurada localmente — PASS no Electron/Chromium Linux com EOFs reais do elemento HTML5, crash/relaunch de recovery e hashes originais inalterados. A execução foi repetida pelo mecanismo de execução aprovado porque o sandbox padrão bloqueou `sandbox_host_linux` com `Operation not permitted`; nenhuma configuração ou política do sandbox foi alterada.
- `npm run test:e2e:multi-instance:windows -- --approve-untracked --standalone-integration` — PASS no Electron/Chromium nativo Windows usando o runner oficial, checkout NTFS isolado e `KQ_PLAYER_TEST_MEDIA_DIR` com as amostras Windows. O runner confirmou branch e HEAD esperados; build Windows, suítes focadas, E2E MP4, verificação de processos residuais e limpeza do perfil passaram. O modo reportou `WINDOW_FOCUS NOT APPLICABLE`, conforme esperado para esta suíte.
- A primeira execução Windows revelou uma corrida de observação no harness entre `WebContents` destruído e o evento `BrowserWindow.closed`; a limpeza IPC já era acionada pelo evento do `WebContents`, mas a contagem do proprietário da janela ainda não havia sido atualizada. O harness passou a aguardar a promessa de fechamento registrada na criação da janela. A E2E Linux e a execução Windows oficial foram repetidas após essa correção; ambas passaram. Nenhum código de produção do app legado foi alterado para contornar o teste.
- O runner Windows informou 15 vulnerabilidades moderadas na auditoria automática de `npm ci`; a análise/atualização de dependências não fez parte desta fase.
- Doop, captura visual de composição, atalhos/teclado físico na janela e aprovação audiovisual humana não foram validados nesta subetapa. Não se afirma aprovação visual nem áudio audível.

### Próxima etapa — Fase C: Interface Standalone

- Aguardar os frames Doop aprovados para tela única, painel numérico, menus e estados V1; só então implementar interface/atalhos/foco segundo o design.
- Integrar a UI à ponte B4.1 pelo transport B2 sem mover buffer/menu ao Main, comparar screenshot real do Electron ao Doop e executar E2Es visuais/focadas.
- Antes da ativação em produção, obter os frames Doop aprovados, definir resolução operacional do recovery bloqueado e manter `main.ts`, seleção de modos e Player legado inalterados até a etapa que autorize a integração.

### Fase B — Base funcional Standalone

Subetapas sujeitas ao resultado da A2; usar a especificação V1 sem acrescentar comandos:

- **B1 — concluída:** estados ocioso/reproduzindo/pausado e fila normal/prioritária, incluindo regra LIFO; testes com playback fake, sem engine real.
- **B2 — concluída:** interpretação não visual das teclas V1, buffer numérico, estado contextual do menu e emissão de intenções B1; sem UI/Electron.
- **B3.1 — concluída:** adaptador Main-side conecta sequência/runtime ao `PlayerPlaybackService`, biblioteca e protocolo existentes; testes determinísticos com host controlado, sem ativação Electron ou MP4 real.
- **B3.2 — concluída e validada em Linux/Windows nativos:** harness Electron isolado e Chromium real reutilizam o adapter, serviço e biblioteca compartilhados; ambos os sistemas confirmaram playback MP4, EOF natural e contenção por crash do Renderer. Não ativa o app nem completa a UX de recovery.
- **B4.1 — concluída:** ponte tipada Main/Preload com IPC restrito testada em Electron real no harness Linux; nenhum canal Standalone foi registrado no app de produção.
- **B4.2 — concluída em Linux e Windows nativos:** integração real B2 → Preload/IPC → Main → sequence/runtime → adapter → PlayerPlaybackService → Chromium/MP4 e recovery relançado em harness isolado. Não ativa o produto nem aprova UI/audio humanos.

### Fase C — Interface Standalone

- Aguardar frames Doop aprovados para a tela única, painel numérico, menus e estados V1.
- Implementar UI própria e integrar atalhos/estado sem reutilizar visual legado incompatível.
- Comparar capturas do Electron real com o Doop, validar acessibilidade e executar E2Es da interface afetada.

### Fase D — Validação e limpeza controlada

- Executar testes focados e integração com os serviços compartilhados afetados em Linux e Windows apropriados.
- Fazer validação audiovisual e comparação visual manual no Windows; obter aprovação explícita do proprietário.
- Só depois classificar cada arquivo como UI antiga, regra obsoleta, teste exclusivo ou serviço reutilizável.
- Remover código/testes apenas quando sua obsolescência e ausência de consumidores forem comprovadas; repetir regressões afetadas.

### Fase E — Atualização dos modos

- Atualizar boas-vindas, onboarding e Configurações para oferecer somente Standalone e Combined.
- Migrar instalações com `controller` persistido sem sobrescrever ou perder `userData`, SQLite, sessões, fila, catálogo ou preferências.
- Preservar o modo legado durante rollout/recuperação até critérios de compatibilidade e rollback serem aprovados.
- Testar perfil novo, perfis antigos, troca/restart, banco e recuperação antes de remover suporte de leitura ao modo Controlador.

### Fase F — Integração remota segura (prioridade de produto após o Standalone)

- Fazer planejamento próprio antes da implementação, incluindo HTTPS/WSS, identidade e autenticação, consentimento/pareamento, validação de certificados, contratos e versionamento.
- Definir autoridade Combined sobre fila/comandos, IDs de item/apresentação, IDs de comando idempotente, `attemptId` do Player, deduplicação, eventos, snapshots, reconexão, timeouts e reconciliação de resultado incerto.
- Definir limites de acesso, revogação, logs, proteção de credenciais, limites de payload/requests, rede local e modelo de falha.
- Testar duplicatas, ACK perdido, ordem fora de sequência, desconexão/reconexão, processos reiniciados e isolamento entre perfis/máquinas.
- O Standalone independente continua funcionando sem rede e não muda seu contrato implicitamente.

### Fase G — Consolidação do Combined

- Integrar as funcionalidades Controller ao modo Combined e conectar a autoridade da fila ao Player local/remoto sem duplicar `KaraokeApplication` ou persistência.
- Implementar reprodução local e, após a Fase F, reprodução remota conforme contratos aprovados.
- Projetar e implementar interfaces/fluxos Combined somente com Doop aprovado.
- Validar operação com um computador, tela estendida/Player destacável, sessão remota, recuperação e regressões dos dados operacionais.

## Regras de avanço

- A ordem de aprovação é A1 → A2 → B → C → D → E → F → G. Preparação documental/arquitetural independente pode ocorrer em paralelo, sem antecipar implementação de fase futura.
- Não iniciar a subetapa seguinte automaticamente; exigir autorização e cumprir seus critérios de entrada.
- Toda subetapa deve registrar escopo, arquivos, testes executados/omitidos, riscos, documentação e critério de conclusão.
- Nenhuma fase remove a especificação V1, o histórico técnico ou serviços/testes legados antes da aprovação de migração correspondente.
