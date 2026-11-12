# Preparação arquitetural do Main para D4 e comunicação remota

> **Planejamento vigente G/H — 2026-11-11:** consultar o [contrato pareado](paired-mode-contract.md), o [plano incremental](paired-mode-execution-plan.md) e as [interfaces/IDs Doop](paired-mode-ui-plan.md). São capacidades planejadas, sem implementação nesta rodada. A Gestão decide fila futura/promoção; Player executa a vez atual e confirma resultados duráveis. Propostas históricas conflitantes abaixo (sincronizar fila inteira, PREVIOUS/STOP na Gestão, countdown pareado ou autoridade de reconexão indefinida) estão superadas por esse contrato. Standalone independente e histórico de implementação permanecem preservados.

**Data:** 2026-11-07

**Status atual:** D4.1 concluída; proposta D4.2 aprovada; D4.3 concluída nos oito lotes; D5 automatizada PASS e validação manual global aprovada pelo proprietário em 2026-11-07. Fase D concluída e aprovada; Fase E não iniciada.
**Escopo:** as seções 1–23 registram a auditoria e proposta; a seção 25 registra a execução D4.3 e a campanha D5. As seções de auditoria não alteraram código, testes, banco, interface, frames Doop ou configuração de rede.

**Leitura atual:** as seções 1–13 são o registro histórico preparatório; a auditoria formal e proposta estão nas seções 14–23; a seção 24 é o registro inicial histórico; a seção 25 contém o resultado final vigente de D4.3 e D5.

## 1. Objetivo e limites — preparação histórica

A D4 pretende modularizar responsabilidades concentradas no Main para que a futura comunicação segura entre Gestão/Combined e Reprodutor/Standalone possa ser implementada na Fase G com impacto mínimo sobre fila, regras, playback, persistência, UI e lifecycle Electron.

Esta análise complementa a auditoria D1 com observações preparatórias. Não conclui D4.1, não é a proposta formal D4.2, não aprova extrações e não inicia D4. A proposta executável deverá partir do estado validado por D3, ser detalhada em D4.1/D4.2 e receber aprovação explícita antes de D4.3.

O proprietário aprovou a filosofia incremental C para D4. Também determinou que D4.1/D4.2 respondam como uma fronteira de aplicação permite operações locais/remotas sem depender de janela Renderer aberta; como padronizar a segurança/autorização IPC e a futura fronteira remota; como comandos, eventos, confirmações e sincronização garantem que os resultados publicados foram efetivamente executados; e se será necessário Outbox/Journal. Este documento registra requisitos e alternativas preliminares, sem encerrar D4.1/D4.2 nem escolher contratos de G/H.

O código é a evidência da arquitetura existente. `docs/remote-player-architecture.md` contém decisões e propostas históricas importantes sobre LAN, pairing e segurança; o roadmap atual governa escopo, fases e gates. Recomendações abaixo não transformam itens ainda pendentes em decisões aprovadas.

## 2. Fatos observados no código atual

### 2.1 `main.ts` e composition root

`main.ts` tem cerca de 1.650 linhas e concentra startup, registro de handlers, composição por modo, criação de janelas, coordenação de eventos e shutdown. O volume, por si só, não é o problema. O risco demonstrado é que mudanças em responsabilidades diferentes compartilham estado global, referências de janelas e caminhos condicionais de startup/quit no mesmo módulo.

Responsabilidades presentes:

- Solicitar `requestSingleInstanceLock()`, registrar o esquema local `kq-media` e responder a `second-instance`.
- Resolver `operating-mode.json`, capacidades `controller`/`player` e seleção inicial; os modos implementados ainda incluem `controller`, `player` e `combined`.
- Inicializar serviços condicionalmente por modo: licença, bancos SQLite, biblioteca, protocolo de mídia, catálogo, playback manual, recovery, sequência Standalone e opções locais.
- Compor janelas Welcome, Gestão, Player Control e Standalone, escolher documento/preload, administrar foco, fullscreen, eventos de falha do Renderer e fechamento.
- Registrar operações IPC locais e enviar snapshots/eventos aos renderers.
- Coordenar fechamento de Gestão, decisão sobre sessão, drain/saída de playback, shutdown Standalone, deadlines, recovery e liberação de recursos.
- Registrar logs, encaminhar diagnósticos do Renderer, abrir logs e apresentar diálogos nativos.

Esse é um composition root funcional, mas detalhes de vários adaptadores e sequências de teardown também estão inline. O objetivo da futura modularização deve ser tornar ownership e lifecycle mais localizáveis, preservando a composição em alto nível.

### 2.2 Composição e autoridades por modo

- **Gestão/Controller atual:** Main abre `karaoke.sqlite`, instancia `MusicCatalogService`, licencia e IPC de estado. `KaraokeApplication`, regras de fila e `StateRepository` ficam no Renderer/`src`. A persistência real passa pelo Preload e por handlers Main, e `database.ts` detém transações SQLite. Os modos Controller e Combined compartilham capacidades de Gestão no código atual.
- **Player/Combined técnico:** biblioteca e protocolo de mídia são inicializados quando a capacidade Player está ativa. No Combined atual, Main instancia `PlayerPlaybackService`, `ManualPlaybackService` e recovery, mas não cria a sequência Standalone. Isso não é uma segunda fila da Gestão.
- **Standalone:** Main cria `StandalonePlayerSequence`, que é autoridade da sequência independente, volátil e limitada a 30 pendências, junto dos serviços de playback/recovery/catálogo. A interface da produção C9 usa uma janela e um `WebContents` para UI e composição Chromium.
- **Playback:** `PlayerPlaybackService` é a autoridade de estado/coordenação da reprodução no Main; o `ChromiumPlaybackHost` conecta essa autoridade ao `<video>` do Renderer. `ManualPlaybackService`, sequência e recovery mantêm contratos distintos. A UI não deve se tornar uma segunda autoridade de playback.

Esses contratos proíbem que uma nova camada de rede crie uma fila, playback engine, writer SQLite ou recovery paralelo. Também não autorizam mover regras de Gestão para Main sem uma decisão e análise específicas: o domínio atual de Gestão vive sobretudo em `KaraokeApplication` e nas regras aplicadas pelo Renderer.

### 2.3 IPC, validação e handlers

- A janela Welcome valida `webContents`, frame principal e URL esperada antes de aceitar a seleção de modo.
- Os handlers Player/Combined usam `requirePlayerIpcSender`, que limita modo, janela, frame principal e documento local.
- A bridge Standalone em `src/standalone-player-ipc.ts` recebe `webContents`/URL esperados e valida origem/frame/payload em seu próprio registro.
- `requireControllerIpcSender` valida a janela/frame/documento no handler de troca de modo.
- Parte do IPC de Gestão (`app-data:*`, `ui-scale:*`, `ui-preferences:*` e diagnósticos) é registrada inline sem a mesma validação explícita de sender/frame/URL visível nos fluxos Welcome/Player/Standalone. A exposição efetiva depende das janelas e bridges alcançáveis; isso é uma inconsistência verificável que merece auditoria de segurança no escopo apropriado, mas não prova, por si, uma exploração. A D4 deve evitar copiar esse padrão para handlers novos.
- Preloads existentes expõem operações específicas. Não há justificativa para transformar IPC em canal genérico de filesystem/SQLite nem para simular comandos remotos como se viessem do Renderer.

IPC e transporte remoto devem ser adaptadores de entrada independentes. Um handler remoto futuro não deve chamar `ipcMain`, manipular `BrowserWindow`/DOM ou escrever diretamente no banco; deve validar remetente/schema/autorização e encaminhar uma operação explícita a uma autoridade de aplicação.

### 2.4 Estado, eventos e publicação

Main encaminha eventos de `PlayerPlaybackService` e `ManualPlaybackService` a `webContents.send`, publica snapshots com revisão e envia estados ao host visual. A sequência Standalone tem seu próprio estado/eventos. Não há um event bus de domínio geral que possa ser assumido como contrato público.

Na Gestão, persistência/serialização são coordenadas por `KaraokeApplication`, `StateRepository` e `database.ts`; candidato operacional só é publicado após confirmação de escrita conforme o contrato existente. A sequência Standalone é volátil e independente. Eventos futuros não devem confundir:

1. observação do Renderer/playback;
2. comando recebido e validado;
3. comando aceito/iniciado;
4. efeito local executado;
5. mutação operacional persistida/confirmada;
6. evento publicado a outro dispositivo.

ACK de transporte não pode significar automaticamente que uma operação foi concluída ou persistida. O significado deve ser específico ao comando e à autoridade que o executa.

### 2.5 Startup, shutdown e recursos

`app.whenReady()` resolve modo, abre serviços/bancos, inicializa recovery, registra handlers, cria as janelas adequadas e conecta subscriptions. A sequência depende de capacidades e do modo. `before-quit` coordena confirmação, bloqueio de novas ações, shutdown de playback/catalog e reentrada em `app.quit()`; `will-quit` remove bridges/subscriptions, descarta `PlayerVideoWindow`, protocolo, biblioteca e bancos, e finaliza o logger.

O shutdown Standalone é particularmente sensível: confirmação única, fechamento de admissões, drain, Stop de shutdown, avaliação de recovery, dispose da sequência/host e liberação de recursos ocorrem em ordem. Reorganizar esses blocos pode mudar comportamento mesmo que handlers continuem respondendo. A ordem e o owner de cada recurso devem acompanhar o módulo extraído; `dispose()` precisa ser idempotente ou ter precondição explícita conforme o contrato.

### 2.6 Fronteiras Electron e segurança

As janelas Welcome, Player e Standalone usam `nodeIntegration: false`, `contextIsolation: true`, `sandbox: true` e `webSecurity: true`. A janela Gestão explicita `nodeIntegration: false` e `contextIsolation: true`, mas não explicita `sandbox`/`webSecurity`; isso permanece uma diferença de configuração observável, sem vulnerabilidade confirmada neste registro.

As APIs Main são privilegiadas: filesystem, dialogs, SQLite, protocolo de mídia e playback pertencem ao Main. Conteúdo Renderer e futuramente mensagens de rede devem ser tratados como entrada não confiável. Checagem de `Origin` de uma conexão de rede não substitui autenticação; validação do frame local IPC não autentica um dispositivo remoto.

## 3. Problemas e riscos arquiteturais demonstrados

1. **Concentração operacional:** criação/composição, IPC e teardown de vários domínios convivem em `main.ts` com estado global. Isso aumenta o custo de revisar a ordem e o alcance das mudanças, sobretudo em caminhos de startup parcial/shutdown.
2. **Políticas de validação desiguais:** algumas bridges validam janela, frame e URL explicitamente; vários handlers Management não mostram a mesma validação local. A D4 deve estabelecer um padrão explícito, sem concluir que já há exploração.
3. **Composição e side effects pouco isolados:** inicialização por modo instancia diretamente bancos/serviços, registra handlers e subscriptions e então cria janelas. Testar a composição completa sem Electron exige contornar o entrypoint; não há hoje uma fábrica de runtime única e pura para cada função.
4. **Gestão distribuída entre processos:** as regras e operações de domínio ficam no Renderer/application; Main detém SQLite e oferece load/save de estado. Um consumidor remoto futuro não deve obter uma capacidade de gravar snapshot genérico no banco; a fronteira de operações apropriada requer decisão e integração compatível com H1.
5. **Publicação de eventos acoplada a janela:** subscribers de serviços enviam diretamente para `mainWindow`. Isso funciona com superfícies atuais, mas um consumidor de rede não deve ser acrescentado às subscriptions sem política de confirmação, ordenação, backpressure e lifecycle.
6. **Caminhos de quit compartilhados:** modos e serviços têm flags, callbacks e ordem de teardown no mesmo entrypoint; extração sem testes de lifecycle pode reabrir regressões de vídeo, foco, playback e recovery da Fase C.

Não foram encontrados ciclos de import relativos no levantamento estático D1, duplicação comprovada das regras da fila ou segundo writer da fila operacional. Não se recomenda mover serviços apenas porque o Main é grande.

## 4. Fronteiras futuras sugeridas

As seguintes fronteiras são candidatas a D4.1/D4.2, não diretórios ou APIs aprovados.

| Responsabilidade | Autoridade/código atual | Fronteira candidata futura | Deve evitar |
|---|---|---|---|
| Composition root | `main.ts`, configuração de modo/capacidades | Main coordena factories/owners, ordem global e callbacks Electron | Transformar Main em container genérico ou esconder lifecycle |
| Ciclo de vida por função | branches de startup e quit em `main.ts` | runtime Management/Standalone com `dispose` explícito e ownership declarado | Mover o estado global todo para uma classe monolítica |
| IPC local | handlers inline, `standalone-player-ipc.ts`, Preloads | adapters por capacidade/domínio, validação centralizada e registro descartável | Um canal universal ou import circular para `main.ts` |
| Operações da Gestão | `KaraokeApplication`, regras, `StateRepository`, `database.ts` | contratos de casos de uso que preservem a autoridade e persistência confirmada; integração com H1 precisa ser avaliada | Transporte remoto alterando SQLite ou fila diretamente |
| Player/Standalone | `ManualPlaybackService`, `StandalonePlayerSequence`, playback, recovery | port/serviço estreito para operações já suportadas e seu resultado | Segunda sequence, engine, scheduler ou recovery |
| Eventos confirmados | subscriptions atuais e snapshots/revisions | publicação de eventos/snapshots com versão/cursor/estado confirmado definidos em G | Evento UI convertido automaticamente em evento operacional |
| Transporte remoto | ainda não implementado | adapter HTTPS/WSS com lifecycle próprio e dependências mínimas | lógica de rede, reconnect, autenticação ou retry dentro de `main.ts` |
| Diagnóstico | logger existente e eventos Main/Renderer | eventos estruturados com correlation IDs e redação | segredos, token, mensagem completa, caminhos sensíveis ou dados de cantor nos logs |

Recomendação preliminar: fazer extrações por responsabilidade e ownership, começando por handlers/factories de um domínio com contratos observáveis; manter composition root e decisões de modo em Main; deixar lifecycle de shutdown para um lote próprio de maior risco; não criar abstrações de transporte antes de haver o protocolo e consumidores aprovados em G.

### O que tende a permanecer no Main

- Entry point e single-instance lock do Electron.
- Resolução do modo/capacidades e decisão de quais runtimes iniciar.
- Composição de alto nível, registro de callbacks globais do Electron e ordenação entre runtimes.
- Ownership final de BrowserWindows/process shutdown e coordenação de encerramento do processo.
- Decisões de composição/segurança que dependem de recursos privilegiados Electron.

Factories podem construir janelas e runtimes, e módulos especializados podem registrar seus handlers. Main deve continuar claro como o lugar onde essas peças são conectadas e encerradas.

### O que pode ser extraído se D4.2 confirmar benefício

- Registro de handlers IPC de Player que hoje ocupa bloco extenso, passando dependências mínimas e retornando cleanup explícito.
- Composição da sequência de dependências de Gestão e Standalone em factories tipadas, mantendo Main responsável por escolhê-las.
- Coordenadores de lifecycle por runtime, se o lote provar ownership e ordem de dispose sem duplicar flags globais.
- Adaptador de diagnósticos para validação/redação e encaminhamento de eventos autorizados.
- Contratos de operação/aplicação reaproveitáveis por mais de um adapter, somente quando houver consumidores concretos. Gestão merece auditoria especial porque o domínio hoje está no Renderer e a autoridade de persistência no Main.

`standalone-player-ipc.ts` e serviços atuais demonstram que algumas fronteiras já existem; D4 deve consolidar padrões úteis em vez de duplicá-los com outra camada.

### Requisito de aplicação sem dependência de Renderer

Hoje `KaraokeApplication` e o fluxo de estado operacional estão no Renderer; o Main fornece IPC para carregar/salvar estado e detém o SQLite. Um servidor remoto futuro hospedado no Main não pode encaminhar uma operação para `BrowserWindow.executeJavaScript` nem depender de `mainWindow` existir para aplicar uma decisão de Gestão. D4.1/D4.2 devem comparar pelo menos estas opções e recomendar uma transição compatível com H1:

| Opção | Como atende chamadas locais e remotas | Benefício | Custo/risco |
|---|---|---|---|
| A — manter aplicação no Renderer e fazer ponte IPC do Main | Os dois adapters acabam chamando a janela de Gestão; deixa de funcionar quando Renderer está fechado/crashado | Menor mudança local inicial | Não satisfaz operação sem janela; janela passa a ser dependência da autoridade |
| B — uma única fachada de casos de uso no Main | Main instancia application service uma vez; UI chama seus métodos via IPC restrito e serviço remoto futuro usa a mesma instância por API interna | Sem janela como dependência; serialização, autorização e writer podem ter ownership explícito | Exige avaliar migração do application/state orchestration do Renderer e preservar atomicidade/invariantes sem duplicar `KaraokeApplication` |
| C — processo/serviço de aplicação separado | Main e UI atuam como adapters para um owner processual independente | Pode isolar lifecycle Electron | Mais IPC/processos/recovery e ownership distribuído; não há necessidade atual demonstrada para esse processo extra |

Recomendação para a proposta: detalhar B como candidata principal, com uma única implementação/instância de casos de uso que mantém regras existentes e escrita confirmada; comparar o esforço contra preservar a instância Renderer. Não implementar um segundo `KaraokeApplication`, uma API genérica de comandos ou migração de regras nesta preparação. D4.2 deve dizer quais módulos podem ser usados diretamente, quais interfaces seriam necessárias e como a transição preserva operação local e testes.

### Requisito de IPC e autorização

D4.1/D4.2 devem inventariar handlers e Preloads, classificar query/mutation/diagnostics e especificar validação de origem (`webContents`), frame principal, documento, payload, modo/função e autorização operacional. A proposta deve comparar registro por janela/domínio com guard reutilizável de sender e cleanup explícito dos handlers/listeners. Entrada remota terá identidade/autorização própria no Main; um dispositivo nunca será representado como sender IPC local. A aprovação de D4 não substitui decisões de pairing/autenticação em G.

### Requisito de comandos, confirmações e sincronização

A proposta futura deverá distinguir recebimento, validação, autorização, aceite, execução, confirmação durável e publicação. UI IPC e transporte remoto devem invocar o mesmo caso de uso autorizado quando a operação for equivalente. Eventos de estado operacional só são publicados depois que a autoridade persiste o efeito; observações de playback/Renderer são identificadas como observadas, não confirmadas pelo banco. D4.2 deverá apresentar como reportar rejeição, falha, timeout/resultado incerto, duplicata e ressincronização sem definir contratos wire ou a política de autoridade G4/H3.

### Avaliação de Outbox/Journal

D4.1/D4.2 devem avaliar a necessidade e o ownership de Outbox/Journal para publicação confiável após crash/reinicialização. Alternativas: (1) snapshot/estado atual reconciliável sem journal de eventos; (2) outbox transacional co-gravada na mesma transação SQLite da mutação operacional; (3) journal separado de eventos/command receipts; (4) memória apenas para estado efêmero. Comparar garantias, replay, deduplicação, ordem, retenção, migração de schema, atomicidade e custo de suporte.

Uma Outbox só oferece atomicidade se a mudança e o registro de publicação compartilham autoridade e transação; `database.ts` e os contratos de `StateRepository`/application precisam ser avaliados para isso. Um Journal separado adiciona coordenação de recuperação e pode duplicar o journal de playback existente em `PlayerPlaybackRecoveryStore`; esse store protege playback e não é automaticamente uma Outbox. Não há decisão nem schema autorizado nesta preparação. A escolha depende da semântica de eventos e reconciliação aprovada em G/H.

## 5. Isolamento da futura comunicação remota

### 5.1 Transporte e lifecycle

O documento histórico `remote-player-architecture.md` descreve uma proposta na qual Gestão/Controller inicia conexão de saída e o Player expõe HTTPS/WSS após configuração/consentimento local; propõe HTTPS para pairing/inventário e WSS para comandos/eventos. D4 deve tratar isso como material de referência a reconciliar com o roadmap e com as decisões de G, sem reimplementar nem congelar silenciosamente detalhes de protocolo.

Recomendações para a fronteira:

- Separar server/listener e client/conexão em adapters de transporte pequenos; cada runtime/função inicia apenas o papel que vier a ser aprovado.
- O transporte cuida de sockets, TLS, timeouts, limite de tamanho/frequência, framing, parsing inicial e close/reconnect. Ele não conhece fila, sequência, playback, DOM ou SQLite.
- O runtime local controla start/stop e `dispose`; shutdown fecha novas conexões, cancela/resolve operações pendentes segundo contrato, envia fechamento quando possível, fecha sockets e remove listeners antes do encerramento final do Electron.
- Uma interrupção de rede não bloqueia operação local. Falhas e timeouts tornam o resultado remoto incerto quando não há confirmação suficiente; não repetir automaticamente mutações não idempotentes.
- Reconnect reconstrói/sincroniza a comunicação por contrato versionado. Política de qual lado prevalece, epoch/cursor/snapshot inicial e resolução de operação incerta permanecem em G/H.
- Validar schema e versão em cada transporte/IPC. Mudanças incompatíveis devem falhar de modo claro, sem executar parcialmente uma mensagem.

### 5.2 Comandos, ACKs e eventos

Fronteira futura sugerida: mensagem autenticada → validação de versão/schema → autorização por dispositivo e comando → deduplicação/correlação → caso de uso/autoridade local existente → resultado real → ACK tipado → publicação de eventos confirmados.

- Manter IDs distintos para conexão/sessão, comando, `operationId` e `attemptId` de playback quando seus contratos pedirem. O mapeamento e a persistência de deduplicação devem ser definidos em G/H; não impor TTL/eviction sem análise.
- Distinguir ACK de recebimento, aceite, execução e confirmação durável. Cliente não deve traduzir ACK de transporte em “música concluída” ou “fila persistida”.
- Eventos de Gestão que alteram turno/sessão só são publicados após a gravação ser confirmada pela autoridade existente. Observações de playback permanecem eventos observados; somente a regra operacional aprovada interpreta seus efeitos.
- Definir ordenação por stream/sessão e versão/snapshot/cursor. Rejeitar mensagem antiga fora de contexto; gaps pedem ressincronização especificada, não replay indiscriminado.
- Reutilizar serviços/casos de uso locais. O adapter remoto não chama uma nova API de fila, não escreve no banco e não contorna validação/idempotência local.
- Perda, duplicação, atraso ou ACK perdido devem produzir estado explícito e correlação para consulta; retry é do mesmo intent apenas quando idempotência está definida.

### 5.3 Segurança e decisões reservadas a G

A rede é uma nova fronteira não confiável; permissões Electron locais não autorizam um dispositivo. A seção 14 de `remote-player-architecture.md` já recomenda pairing explícito, TLS, autorização allowlist, validação de schema, limites e redação de logs. A Fase G deverá confirmar e aprovar os contratos reais, incluindo pelo menos:

- Identidade de dispositivo e dos papéis, consentimento/pairing, revogação e rotação.
- Verificação do certificado/fingerprint, pinning, trust store e reação à mudança de identidade.
- Armazenamento de chaves/tokens por plataforma e comportamento quando não há armazenamento seguro disponível.
- Bind address, interface/porta, exposição em redes públicas, firewall e ativação/desativação do serviço.
- Allowlist de comandos, autorização por dispositivo/escopo, rate/size/concurrency limits e tentativas de abuso.
- Origens aceitas para clientes aplicáveis, mantendo claro que `Origin`/CORS não são autenticação.
- Política de versões suportadas e rejeição segura de incompatibilidade.
- Timeout, limite de conexões simultâneas, sessão ativa e encerramento seguro.
- Segredos/dados que podem ser mantidos em repouso ou em logs, retenção, rotação e auditoria.

Nenhum novo canal de rede deve ser exposto via Preload. A página Renderer deve receber estado remoto somente por bridge local estreita, autenticada no Main e alimentada pelo serviço autorizado.

## 6. Diagnóstico e logs

Proposta de eventos estruturados, com `connectionId`, `deviceId` pseudonimizado quando cabível, `messageId`/`commandId`, `operationId`/`attemptId` quando disponíveis, versão do protocolo, tipo de evento, modo/runtime, resultado, duração e motivo categorizado. Separar recebimento de comando de aplicação do efeito; um correlation ID acompanha cada salto sem incluir credenciais.

Registrar estados distintos:

1. conexão TCP/TLS estabelecida;
2. identidade autenticada e autorizada;
3. comando/mensagem recebido;
4. schema/versão validados;
5. autorização e deduplicação decididas;
6. comando aceito ou rejeitado;
7. operação executada ou resultado incerto;
8. persistência/evento confirmado pela autoridade;
9. ACK enviado/recebido;
10. timeout, perda percebida, duplicata, desconexão, reconexão ou sincronização divergente.

Aplicar redação e allowlist de campos. Não registrar tokens, chaves, payload completo, caminhos absolutos, nome de cantor, SQL ou conteúdo de catálogo. A estratégia concreta de armazenamento/retention e suporte deverá ser aprovada em G; não acrescentar telemetria de rede nesta D4.

## 7. Testabilidade

### D4/D5: testar modularização sem rede

- Units de factories, registro/dispose e validação usando fakes de Electron para lifecycle específico, com contratos que também possam ser chamados sem abrir UI.
- Testes de Main/Preload/IPC reais para provar que handlers só aceitam a janela/frame/documento esperados e validam payloads; testes unitários sozinhos não provam autorização de produção.
- Injeção explícita de dependências em módulo extraído, sem importar o entrypoint `main.ts`; isso permite testar operação e cleanup sem inicializar toda UI Electron.
- E2E Electron/Playwright para confirmar lifecycle, foco, teclado, playback e persistência real após mudanças de composição.
- Testes específicos de falha parcial de startup, shutdown com operação em andamento, listeners removidos, close/retry e recovery, conforme o lote tocado.

### Fase G: testes da comunicação real

Quando transporte existir, adicionar integração com HTTPS/WSS local real e certificados de teste, além de testes de reconexão/multi-processo conforme necessário. Cobrir conexão/desconexão, timeout, perda de ACK, mensagem perdida, duplicada, fora de ordem, conexão interrompida durante música, reinício de cada dispositivo, shutdown com operação pendente, dispositivo não autorizado, versão incompatível, sincronização divergente e modo offline. Assertar estado SQLite/sequence e eventos publicados, não apenas resposta HTTP/WS.

### Limite de operação offline

Testes de Gestão e Standalone sem rede devem confirmar que startup, biblioteca, playback, fila/sequence locais e shutdown continuam funcionais sem listener/conexão. Nenhum estado visual deve declarar conexão sem evento real da camada de transporte.

## 8. Alternativas e recomendação preliminar

| Alternativa | Benefício | Custo/risco |
|---|---|---|
| A — manter tudo em `main.ts` e acrescentar comunicação futura no mesmo arquivo | Menor mudança imediata | Amplia o ponto de acoplamento; mistura sockets com composition/lifecycle e dificulta testar falhas sem Electron |
| B — extrair todo o Main para uma arquitetura de serviços genérica agora | Muitas unidades isoláveis em tese | Mudança ampla e especulativa; pode duplicar autoridades e reorganizar responsabilidades que H1/G ainda precisam definir |
| C — extração incremental guiada por ownership e consumidores reais | Isola handlers, composição e lifecycle por lotes, preserva autoridade e permite interromper | Exige disciplina de contratos/cleanup e regressão após cada lote; lifecycle não é uma simples movimentação |

**Filosofia C aprovada pelo proprietário.** A D4.2 deve priorizar fronteiras que já tenham responsabilidade e consumidor comprovados, conservar Main como composition root e preparar chamadas aos mesmos casos de uso. Essa aprovação não aprova árvore de diretórios, API interna, mudança de autoridade, Outbox/Journal ou extração específica; essas opções precisam constar da proposta concreta D4.2. Não escolher framework/servidor nem criar camada de transporte antes da Fase G.

## 9. Plano incremental a propor em D4.2

1. **Inventário e congelamento de contratos:** listar handlers, callbacks, dependências, paths, listeners, donos e ordem de teardown; registrar baseline de comportamento.
2. **Lote de adapter IPC de um domínio:** se D4.1 comprovar benefício, extrair registro de handlers Player para módulo com dependencies tipadas, validação consistente e `dispose`; manter os mesmos canais e resultados.
3. **Lotes de composição por runtime:** separar a construção/ownership dos serviços Management ou Standalone um por vez. Main decide modo e liga resultados; revisar a sequência de startup/falha parcial.
4. **Lote de lifecycle:** avaliar shutdown de playback/Standalone e close de Gestão separadamente, só se owner e order puderem ser expressos/testados. Lote de alto risco; rollback próprio.
5. **Fronteira de operações/events:** documentar ou extrair o menor contrato de aplicação real necessário para um future adapter. Não portar regras de fila do Renderer para Main e não criar API remota genérica sem decisão H/G.
6. **Estabilização de cada lote:** compile + testes diretamente afetados, inspeção real quando IPC/UI/window changes, comparação do estado final; interromper se uma regressão exige mudanças fora do lote.

Para cada lote D4.2 deve apontar arquivos, importers/consumers, build assets, testes, critérios observáveis e comandos de rollback. D5 valida o resultado integrado.

## 10. Limites entre D4, G e H

| Fase | Responsabilidade |
|---|---|
| D4.1/D4.2 | Auditar Main e necessidades futuras; responder os quatro requisitos adicionais de fronteira de aplicação, segurança IPC/remota, resultados confirmados e Outbox/Journal; produzir proposta de módulos, contratos internos, ownership, alternativas, riscos, benefícios e sequência; obter aprovação da proposta antes da implementação. |
| D4.3 | Implementar apenas a modularização aprovada; não instalar listeners, abrir sockets, parear dispositivos nem simular rede. |
| D5 | Validar regressões finais do sistema após modularização; não declarar cobertura de transporte inexistente. |
| G | Aprovar e implementar HTTPS/WSS, identidade, pairing, autenticação/autorização, contratos versionados, comandos/eventos, recuperação de conexão e diagnósticos de rede. Resolver decisões necessárias antes dos fluxos correspondentes. |
| H | Integrar o domínio de Gestão/Combined, controle do Player, autoridade operacional/sincronização e reprodução local segundo H1–H8. Preservar uma fila e um writer. |

## 11. Decisões de produto/segurança ainda pendentes

| Decisão | Alternativas ilustrativas | Consequências a avaliar |
|---|---|---|
| Autoridade da fila ao conectar/reconectar | Manter authority local; transferir sob condições; sincronizar após resolução explícita | Risco de descartar/reordenar fila e efeito em pins, sessão e recuperação; G4/H3 já mantêm essa decisão aberta |
| Controle local Standalone durante sessão remota | Local permitido; remoto exclusivo; arbitragem/lease com consentimento | UX/offline, conflitos de pause/stop/next, interrupção e estados incertos |
| Transferência entre dispositivos | Não suportar; transferência explícita; fluxo de handoff com confirmação | Identidade, playback em curso, fila e ownership de operação |
| Estado não confirmado ao reconectar | Descartar/reconciliar; consultar authority; apresentar resolução | Necessidade de snapshots, dedupe, journal/cursor e ação do operador |
| Quantidade de Players controláveis | Um; limite pequeno configurável; múltiplos | UX de pairing, isolamento, recursos, identidade e sincronização paralela |
| Desconexão prolongada | Continuar local; pausar; exigir ação; política por estado de reprodução | Continuidade do evento, fila local, recovery e experiência do operador |
| Trust, credenciais e disponibilidade | Cert pin/SAS, storage por plataforma, revogação e fallback | Segurança operacional, recuperação de credenciais e suporte em Linux/Windows |

São exemplos para a etapa de decisão, não opções já aprovadas. A arquitetura proposta deve permitir que as escolhas sejam aplicadas sem reescrever Round Robin, fila, sequence, playback ou writer.

## 12. Fontes técnicas consultadas

- `main.ts`: entrypoint, criação de janelas, startup por modo, IPC, eventos, recovery e shutdown.
- `src/standalone-player-ipc.ts`, `src/player-ui-contracts.ts`, `preload.ts`, `player-preload.ts`, `standalone-player-preload.ts`, `welcome-preload.ts`: bridges e validação local.
- `src/application.ts`, regras em `src/`, `src/state-repository.ts`, `database.ts`: autoridade operacional, persistência e fronteira Main/Renderer.
- `src/standalone-player-sequence.ts`, `src/manual-playback-service.ts`, `src/player-playback-service.ts`, `src/chromium-playback-host.ts`, `src/player-video-window.ts`, recovery e library services: autoridade de sequência/playback e composição visual.
- `docs/standalone-player-roadmap.md`, `docs/d1-src-audit-and-proposal.md`, backlog D1–D5.
- `docs/remote-player-architecture.md`, `docs/player-playback.md`, `docs/sqlite-persistence-safety.md`, `docs/windows-native-testing.md`.

## 13. Estado na preparação anterior (histórico)

Esta preparação e a filosofia incremental C aprovada servem como entrada para a futura D4. D4.1 e D4.2 continuam não iniciadas; os requisitos adicionais devem ser respondidos formalmente em suas entregas. Nenhuma extração, decisão de Outbox/Journal ou decisão de rede foi aprovada por este documento. A aprovação explícita D4.2 permanece obrigatória antes de D4.3.

## 14. D4.1 — Auditoria formal do estado após D2/D3

**Registro:** 2026-11-07. As seções 1–13 preservam a preparação anterior; seus estados “não iniciado” e referências ao shell Player Control são históricos. As seções 14–23 constituem a auditoria D4.1 e a proposta D4.2 atuais, ainda sem aprovação de implementação.

**Baseline:** branch feature/remote-player-lan-integration; HEAD 5cd541f7a7aa232d73b346e09720c1a5716b4dc7, com working tree preexistente contendo D2/D3, documentação e infraestrutura Windows. Esta análise considera os arquivos atuais, não somente o commit. O proprietário informou D2/D3 executadas e validação manual de Player/Combined pelo launcher oficial, autorizando D4.1/D4.2. Isso não constitui aprovação da proposta abaixo. Nenhum teste de aplicação foi executado nesta tarefa documental.

### 14.1 Mapa atual e evidências

O Main atual tem 1.615 linhas. Os principais limites são verificáveis nos seguintes símbolos e consumidores; os números de linha são referências desta baseline e poderão mudar na implementação.

| Área | Implementação e consumidores atuais | Ownership e término |
|---|---|---|
| Processo e bootstrap | main.ts:45–71, second-instance, whenReady a partir de 1220, resolução em operating-mode.ts | Main solicita lock, registra esquema antes de ready e decide as capacidades. Lock atual não garante exclusividade entre contas Windows, reservada a E3. |
| Logger e falhas | main.ts:151–208, logging.ts; crashReporter, monitor de exceções, rejeições e child-process-gone | Main cria logger por userData e finaliza em will-quit. Falha de logging não deve decidir validade de commit. |
| Welcome | createWelcomeWindow, main.ts:74–112; welcome-preload.ts | Main cria e referencia janela; handler choose-mode removido em closed; seleção/relaunch continuam comportamento atual até E. |
| Gestão | createWindow, main.ts:269–480; preload.ts; src/app.ts | Main possui BrowserWindow, escala, preferências e diálogo de fechamento; Renderer instancia aplicação e controla os casos de uso. |
| Aplicação operacional | src/app.ts:28; application.ts:48–676; consumidores ui/app-shell.ts, queue-interactions.ts, queue-view.ts | Uma instância pública de KaraokeApplication no Renderer; candidatos privados são cópias transitórias, não autoridades concorrentes. Estado e fila de operações sobrevivem apenas à vida desse Renderer. |
| Persistência operacional | createRendererStateRepository em state-repository.ts:159; preload karaokeDatabase; main.ts:1319–1344; database.ts:874–1050 | Main possui conexão karaoke.sqlite. Repository no Renderer serializa saves/reconcilia resultado incerto; application serializa operações inteiras. SQLite grava transações síncronas. |
| Biblioteca/protocolo | main.ts:1260 em diante; VideoLibraryService e PlayerMediaProtocol | Main cria somente com capacidade Player; instala protocolo, fecha biblioteca e remove protocolo no teardown. O catálogo Combined toma emprestada a conexão operacional. |
| Combined técnico | PlayerPlaybackService, ManualPlaybackService e recovery em startup; registerPlayerIpcHandlers | Serviços Main-side; autoAdvanceOnNaturalEnd false. Não cria StandalonePlayerSequence nem janela de reprodução local integrada. Não é implementação H8. |
| Standalone | StandalonePlayerSequence.create, main.ts:1400 em diante; options e bridge | Sequência é autoridade volátil Main-side, com limite 30 e operação correlacionada. Compõe playback/recovery e callback disposeResources para options/catalog/library. Não usa a fila Gestão. |
| Superfície de vídeo | createStandalonePlayerWindow, PlayerVideoWindow, ChromiumPlaybackHost, player-preload e standalone-player-preload | Uma superfície visível Standalone, vídeo e overlays no mesmo WebContents. PlayerVideoWindow valida o sender das ações de superfície e administra o host; não deve ser substituído por nova janela de vídeo. |
| IPC e eventos | registerPlayerIpcHandlers, registerControllerModeChangeIpcHandler e installStandalonePlayerMainIpcBridge | Handlers inline são ligados ao processo/janela; bridge Standalone já tem dispose e ownership separado do runtime. Subscrições UI são referências globais no Main. |
| Saída | createWindow close; requestStandaloneExitConfirmation; beginStandaloneShutdown; before-quit/will-quit | Gestão drena via executeJavaScript no Renderer. Standalone fecha admissões, drena, verifica recovery/containment, descarta e autoriza quit. Recursos finais e logger são liberados pelo Main. |

Fluxo operacional atual:

~~~mermaid
flowchart LR
  UI["Gestão: src/app.ts e UI"] --> APP["KaraokeApplication no Renderer"]
  APP --> REPO["StateRepository no Renderer"]
  REPO --> PRE["Preload restrito"]
  PRE --> IPC["app-data load/save no Main"]
  IPC --> DB["database.ts / SQLite"]
  SUI["Standalone UI"] --> SIPC["Preload + standalone-player-ipc"]
  SIPC --> SEQ["StandalonePlayerSequence no Main"]
  SEQ --> PB["PlayerPlaybackService + recovery"]
  PB --> HOST["PlayerVideoWindow / Chromium"]
~~~

### 14.2 Problemas comprovados e riscos delimitados

1. **Fronteira Gestão dependente de janela — prioridade arquitetural alta.** src/app.ts instancia application/repository; main.ts:393–476 e 523–530 chama prepareToClose, flushState e endSessionAndArchive por executeJavaScript. Fechamento, troca de modo e operações da fila não são hoje casos de uso Main-side independentes de Renderer. O código funciona segundo a composição atual; isso é uma limitação concreta para o objetivo remoto.
2. **Persistência não é uma API de operação — prioridade alta antes de G.** app-data:save recebe snapshot completo validado, não “adicionar apresentação” ou “concluir turno”. Transação SQLite protege uma gravação, mas não rejeita dois snapshots preparados a partir da mesma base antiga. Acrescentar writer remoto ao lado do Renderer poderia perder atualizações. Não se reproduziu perda atual e não se propõe um segundo writer.
3. **Autorização IPC desigual — prioridade alta antes de novos consumidores.** Welcome, troca de modo Controller e Player validam remetente/frame/documento; Gestão registra app-data, license, ui-scale, sidebar e diagnostics sem a mesma checagem explícita. Schema e licença de save continuam verificados. Não foi demonstrada exploração externa: as janelas inspecionadas carregam conteúdo local e bridges restritas.
4. **Lifecycle distribuído — risco alto de regressão na extração.** Nullable globals, flags de quit, subscrições e recursos parcialmente adquiridos atravessam startup, close, before-quit, will-quit e closeStandaloneAfterStartupFailure. Há caminhos repetidos de dispose que dependem de idempotência. Isso dificulta provar a ordem; não comprova leak.
5. **Publicação acoplada à janela — prioridade média.** publishPlayerSnapshot e subscriptions chamam mainWindow.webContents.send. A revisão playerUiRevision cresce inclusive em leitura getPlayerUiSnapshot; não é cursor durável de eventos nem versão transacional. Não reutilizar essa revisão como sequência de protocolo remoto.
6. **Diagnóstico relata acontecimentos diferentes — prioridade média.** Eventos SESSION_* enviados pelo Renderer são relatos, não prova autônoma de commit. O logger já existe; rede precisa distinguir recebido, validado, aceito, executado e publicado.
7. **Dependências de caminho e registro — risco médio.** __dirname atual é a raiz de build. Extrair funções para build/src muda o significado de __dirname. Handlers de escala/preferências são registrados em createWindow; uma futura recriação de janela não pode tentar instalar canais duplicados. Não há recriação automática desse tipo demonstrada no fluxo atual.

Não se identificou duplicação atual de regras da fila, segunda autoridade operacional ativa ou ciclo de imports confirmado. A extração deve impedir módulos importando variáveis de main.ts; “acesso fácil ao global” criaria ciclos e esconderia ownership. Não se recomenda dividir serviços de domínio por tamanho.

### 14.3 Concorrência, startup e recovery existentes

KaraokeApplication.enqueue (application.ts:175–208) serializa preparação, gravação e publicação. Captura sessão/geração, prepara candidato privado, aguarda repository.save e só então publica. Erro invalida dependentes; resultado incerto bloqueia mutações até recoverPersistence. createStateRepository (state-repository.ts:73–156) mantém writeTail, baseline e candidato incerto, relê após erro e só repete contenção SQLite depois de provar ausência de commit. Essas garantias devem ser reutilizadas.

database.ts:132 aplica BEGIN IMMEDIATE/COMMIT/ROLLBACK; saveState:952 invalida cache diferencial em falha. Não há CAS/revisão de aplicação para múltiplos writers independentes. O lock Electron por perfil e o serializador de uma instância não substituem controle distribuído ou exclusividade por máquina.

Standalone já usa operationId, attemptId, revisões de snapshot, reservas e correlação de EOF. O dedupe existente não pode ser anunciado como durável entre reinícios. Timeout de Promise.race em withShutdownDeadline não cancela a operação original: o serviço pode continuar terminando. Preservar fences e verificação posterior; nunca reexecutar cegamente por expiração.

Startup adquire recursos por etapas e aguarda scan, criação da sequência e host. A checagem shutdownStarted depois do scan é relevante. O tratamento Player de falha parcial difere do fluxo Gestão/Combined, que pede app.quit. Uma fábrica não pode retornar sucesso antes de loadFile/host ready ou perder recurso adquirido antes de rejeitar.

Shutdown Standalone mantém o orçamento de 30 segundos, confirma recovery antes/depois do descarte, fecha IPC antes da sequência e distingue falha recuperável de falha após descarte irreversível. Se falhar antes do Stop e com playback comprovadamente idle, há restauração específica de admissão. Não substituir isso por um dispose genérico em ordem inversa. Será preciso testar cada prefixo adquirido e cada fase da saída.

### 14.4 Inventário das fronteiras IPC

| Família | Política atual | Proposta de tratamento |
|---|---|---|
| welcome:choose-mode | Window + WebContents + mainFrame + URL + enum | Extrair sem alterar contrato, com cleanup no fechamento. |
| settings:operating-mode:change | Guard Controller, licença, flush e modo | Preservar restrições transitórias; trocar callback Renderer por host somente no lote de migração. |
| app-data:load/save | Payload/licença em save; sem guard uniforme | Guard Gestão já na extração; manter temporariamente bridge restrita até o corte da autoridade. Nunca expor ao remoto. |
| license, ui-scale, ui-preferences | Validação específica e licença nas mutações pertinentes; sem guard uniforme | Autorizar janela Gestão/frame/documento antes dos serviços. Não alterar política de trial/ativação. |
| diagnostics:* | Limites/allowlist parciais; sem guard uniforme | Guard Gestão para relatos; preservar formato e redação do logger. Relato não pode confirmar mutação. |
| player:* técnico/compatibilidade | requirePlayerIpcSender; modo e serviços restringem operações | Extrair com dependências explícitas e preservar gates de biblioteca, modo, recovery e operações em andamento. |
| player-video:* | Frame/URL e verificação downstream no PlayerVideoWindow | Preservar a dupla proteção; fullscreen tem um único owner/handler por canal. |
| bridge Standalone | Guard comum, schema, correlação, admission/drain/dispose | Reutilizar módulo existente, sem nova bridge paralela. |

src/standalone-player-ipc.ts:441–478 também verifica URL atual do WebContents; setFullScreen em player-video-window.ts:288–293 exige sender da superfície atual e ação permitida. A falta de checagem owner diretamente no handler de fullscreen não configura bypass demonstrado, pois a checagem existe downstream. Controller explicita contextIsolation e nodeIntegration false; diferenças de sandbox/webSecurity explícitos frente a Welcome/Standalone precisam ser verificadas contra defaults e compatibilidade, sem alterar opções por suposição.

## 15. D4.2 — Alternativas e recomendação concreta

| Alternativa | Resultado | Custo e limite |
|---|---|---|
| Só extrair blocos mantendo aplicação Gestão no Renderer | Main menor e módulos testáveis | Não atende casos de uso sem janela. Pode ser marco intermediário, não conclusão dessa capacidade. |
| Extrair por ownership e hospedar uma única aplicação Gestão no Main | IPC local e futuro remoto chamam a mesma instância, sem DOM | Migração interna relevante de IPC/UI/persistência. Recomendada em lotes, com corte único e validação própria. |
| Processo de aplicação adicional | Independência de UI e isolamento processual | Outro protocolo/processo, deploy, recuperação e writer coordination sem necessidade atual demonstrada. Não recomendado. |

**Recomendação:** filosofia C, extrações coesas e migração interna da hospedagem da Gestão para o Main como lote específico de alto risco, submetido expressamente à aprovação D4.2. A autoridade lógica continua sendo o mesmo KaraokeApplication; muda seu processo hospedeiro. Isso não implementa a consolidação de funções Controller/Combined de H1, nem a seleção instalada de E, nem integração operacional remota de H2/H3.

Se o proprietário aprovar somente os lotes de extração, a entrega deverá declarar “extração concluída; aplicação Gestão ainda depende do Renderer”. Não criar um segundo KaraokeApplication público para afirmar atendimento parcial. A opção de postergar o lote de hospedagem para antes dos consumidores G/H é válida, mas deixa esse requisito arquitetural pendente e bloqueia qualquer consumidor remoto desses casos de uso até implementação e validação do host.

### 15.1 Árvore proposta e mapeamento

Preservar os diretórios e caminhos existentes; novos módulos coesos ficam no src atual. Não mover serviços, renderers, assets ou regras.

~~~text
main.ts                                  composition root e callbacks globais Electron
database.ts                              conexão, schema e transações existentes
preload.ts                               bridge Gestão; adaptação só no corte da autoridade
standalone-player-preload.ts              preservado
src/
  main-window-factories.ts                NOVO: criação Welcome/Gestão/Standalone e paths recebidos
  main-controller-ipc.ts                  NOVO: state/licença/diagnóstico/preferências locais
  main-ipc-policy.ts                      NOVO: guard local e registros com cleanup por owner
  main-player-ipc.ts                      NOVO: handlers técnicos/compatibilidade Player atuais
  main-media-runtime.ts                   NOVO: composição de biblioteca/catalog/playback por modo
  main-standalone-shutdown.ts             NOVO: coordenação de saída Standalone existente
  main-management-close.ts                NOVO: diálogo e fechamento Gestão
  management-contracts.ts                 NOVO: API interna tipada de casos de uso e leitura
  main-management-host.ts                 NOVO: único owner Main de KaraokeApplication
  management-ipc.ts                       NOVO: adaptação dos casos de uso ao IPC restrito
  management-client.ts                    NOVO: cliente Renderer e cache confirmado para UI
  management-queries.ts                   NOVO no lote 7: consultas puras compartilhadas
  application.ts                         regras e serializador existentes
  state-repository.ts                    createStateRepository(adapter) reutilizada; browser preservado
  app.ts                                 UI passa a consumir cliente após corte
  standalone-player-ipc.ts                bridge existente, reutilizada
  standalone-player-sequence.ts           autoridade volátil existente
  player-*, chromium-*, video-library-*, music-catalog-*   serviços existentes
  ui/                                    diretório atual preservado
~~~

São nomes propostos, não arquivos criados. Não haverá diretório shared, barrel genérico, framework DI, event bus global, servidor vazio ou stub de transporte. Se um arquivo novo não tiver consumidor real no lote correspondente, ele não será criado.

| Origem atual → módulo proposto | Responsabilidade e dependências recebidas | Registro/descarte |
|---|---|---|
| createWelcomeWindow/createWindow/createStandalonePlayerWindow → main-window-factories | BrowserWindow, paths absolutos, logger e callbacks específicos; somente criação/ligação de superfície | Root referencia janela; factory retorna janela e remover listeners próprios. Factory não possui application/DB. |
| guards + instalação manual → main-ipc-policy | Identidade do WebContents atual, frame, documento e capacidades | Retorna guard e dispose dos canais/listeners próprios. Não remove handlers de outro owner. |
| handlers Gestão e preferências → main-controller-ipc | Database port temporário, licença, logger, preferências e funções de janela | Registro uma vez por runtime; UI scale permanece ação de apresentação. Depois do corte, retirar apenas app-data do caminho ativo. |
| registerPlayerIpcHandlers/getPlayerUiSnapshot/publicação → main-player-ipc + main-media-runtime | IPC recebe API técnica limitada; runtime conserva gates/contadores e snapshots | Subscrições por consumidor; IPC não possui playback nem fecha banco. Snapshot continua compatível. |
| blocos player de whenReady → main-media-runtime | Modo, userData, catálogo repository emprestado, protocolo, fábricas de host/dialog e logger | Runtime possui biblioteca, catálogo serviço, recovery, playback e sequência apropriada; banco continua root-owned. |
| beginStandaloneShutdown e validação → main-standalone-shutdown | Bridge, sequência, playback, recovery, host e portas de diálogo/quit | Promessa coalescida, prazo/fences/estados terminais preservados; não possui nem recria serviços. |
| createWindow close + troca de modo → main-management-close | Porta prepare/summary/flush/end/cancel e diálogos | Primeiro pode encapsular callback Renderer existente; após corte aponta somente ao host. Root autoriza quit/relaunch. |
| new KaraokeApplication em app.ts → main-management-host | Instância única e repository com adapter SQLite injetado; logger/licença | Host inicia, fecha admissão, drena, reconcilia e publica; conexão é emprestada do root. |
| chamadas UI diretas → management-client + management-ipc | Contrato explícito dos métodos usados; cache de leitura confirmado | Client não prepara candidatos nem grava snapshots. Listener descartável e reconsulta ao reanexar. |

Root continua resolvendo modo, adquirindo lock, registrando esquema antes de ready, abrindo conexões adequadas, escolhendo runtime e ligando callbacks app/second-instance/quit. Coordena dependências entre owners e fecha bancos somente depois que seus usuários drenarem. Logger fecha por último. A decisão de modo não será escondida em um módulo bootstrap com side effects de import.

## 16. Contratos internos, dependências e operação sem janela

### 16.1 Gestão

management-contracts descreve somente operações atuais, com argumentos e retornos tipados derivados de application.ts: addEntry/addEntries, editEntry, cancelEntry/markDone e compostos cancelAndAdvance/completeAndAdvance, pinNext/unpin, moveTurn/promoteToCurrent/ensureCurrentTurn, freezeThrough/releaseFreeze, startNewSession/ensureSession/endCurrentSession, resetTableHistory, recoverPersistence e leitura confirmada. Não criar execute(string, any) nem expor saveState ao cliente futuro.

Consultas usadas sincronicamente por queue-view, queue-interactions e app-shell precisam de atenção: state, getPlayOrder, canMoveTurn, isTurnFrozen e flags de inicialização passam a ser projeções de leitura do snapshot confirmado. Propor a extração dos cálculos de getPlayOrder, previewTurnMove/canMoveTurn e isTurnFrozen, hoje métodos que leem estado privado, para uma API explícita de consultas puras com ReadonlyAppState e parâmetros id/posição. Testes de paridade são gate dessa extração. Essas funções ficariam em management-queries.ts, chamadas tanto pela aplicação quanto pela projeção do cliente sobre seu snapshot confirmado, reutilizando applyFrozenQueueOrder e moveTurnAndFix existentes. Não há cópia de Round Robin nem aplicação de mutações no cliente. Assim, consultas de drag permanecem síncronas sem pré-calcular uma matriz de todos os movimentos possíveis, cujo custo cresceria com a fila. Prévia de drag pode usar dados locais confirmados para apresentação, mas o host revalida a mutação no estado atual. Não converter essas consultas em chamadas assíncronas avulsas que alterem toda a UI.

ManagementOperations é uma facade proposta que coordena a classe existente; subscribe/getConfirmedView e seu envelope de confirmação não são APIs que já existam em KaraokeApplication. prepareToClose/flush/cancelClose delegam aos métodos atuais, sem novo scheduler de domínio.

O adapter SQLite Main-side será criado dentro de main-management-host.ts usando createStateRepository({ load, save }): load chama database.loadState; save valida e aplica a restrição de licença atual, chama database.saveState e retorna confirmação. O host recebe database como porta emprestada. O adapter Renderer/browser existente permanece para compatibilidade isolada, nunca como writer adicional da mesma base. endSessionAndArchive é hoje uma função de window.__kqueue que delega a endCurrentSession; a facade preserva esse mapeamento, não inventa um novo caso de uso.

Contrato ilustrativo (interno, não wire/protocolo aprovado):

~~~typescript
interface ConfirmedManagementView {
  hostEpoch: string; // identidade da execução do host
  revision: number; // somente sessão do host, não cursor durável
  state: ReadonlyAppState;
  playOrderIds: readonly string[];
  // projeções de proteções e flags usadas pelos consumidores existentes
}
interface ManagementOperations {
  addEntries(inputs: readonly NewQueueEntry[], selectCurrent?: boolean):
    Promise<{ result: readonly QueueEntry[]; view: ConfirmedManagementView }>;
  completeAndAdvance(id: string):
    Promise<{ result: QueueEntry | null; view: ConfirmedManagementView }>;
  // demais métodos explícitos, sem refletir nomes recebidos em acesso dinâmico
  getConfirmedView(): ConfirmedManagementView;
  subscribe(listener: (view: ConfirmedManagementView) => void): () => void;
  prepareToClose(): Promise<void>;
  flush(): Promise<void>;
  cancelClose(): void;
}
~~~

A implementação usa o mesmo serializador de KaraokeApplication. Captura do resultado e da view acontece como unidade ordenada, antes que uma próxima operação possa substituir a view da resposta; se necessário acrescentar um callback interno após publish no serializador existente, sem criar uma fila paralela com regras de admissão diferentes. Eventos emitidos somente após confirmação; falha de subscriber não desfaz commit nem transforma sucesso persistido em falha de negócio.

O cliente aplica a view antes de resolver a Promise vista pela UI, preservando os atuais awaits de formulários/drag. Evento/resposta duplicada não regride cache. O host registra o listener e entrega a view corrente sincronicamente, sem await entre essas ações; a mesma fila de publicação ordena alterações posteriores. No adapter IPC, o Preload instala o listener antes de pedir subscribe, guarda eventos recebidos durante o handshake e aplica snapshot/respostas/eventos por hostEpoch e revision. Epoch diferente exige novo snapshot e não comparação numérica com a execução antiga. Esse estado do cliente é somente cache confirmado + consultas puras, nunca outra aplicação/candidato/writer. Renderer suspenso pode exibir uma view antiga; comandos continuam revalidados no host, e retomada faz ressincronização sem replay automático de mutações. Reanexar Renderer não executa load/ensureSession/ensureCurrentTurn novamente no host já iniciado. Os flags didStartFreshSessionOnLoad/didRecoverEndedSession são entregues como metadados da inicialização original.

**Inicialização:** construir o host não executa load automaticamente. initialize é idempotente por execução, verifica licença e compatibilidade e preserva o bootstrap atual; o cliente local chama o mesmo ponto de inicialização antes de renderizar. Um teste sem janela chama essa API diretamente com armazenamento compatível. Nenhum reload repete reparos/sessão. Caso o perfil exija legado localStorage, o estado awaiting-legacy-import é exceção explícita de compatibilidade; não se promete carregar esses dados inacessíveis ao Main sem o handshake local.

**Licença e migração legada:** host executa as mesmas restrições de escrita e load readOnly quando expirado. application.load pode persistir reparos/criar sessão; preservar o ponto de inicialização, sem executar uma segunda inicialização em reload. localStorage legado só existe no Renderer: preservar fallback browser e desenhar handshake de importação validada, apenas se SQLite não tem estado e antes de abrir admissões, com remoção das chaves somente após commit confirmado. Se esse pré-requisito existir em um perfil, o host fica em estado awaiting-legacy-import; não cria sessão vazia nem admite comandos antes da decisão já prevista pela compatibilidade. Isso é compatibilidade local, não migração/fusão de dados E5.

**Corte único obrigatório:** retirar a construção da aplicação operacional no Renderer e a escrita app-data:save de produção no mesmo lote em que o host assume. Só podem coexistir adaptações de teste/browser que não apontem ao mesmo SQLite. Não manter temporariamente dois owners públicos contra a mesma base. Preload passa a expor métodos restritos, e UI muda suas dependências de classe concreta para interface. Não basta um novo host isolado sem migrar os consumidores.

### 16.2 Player e portas Electron

StandalonePlayerControl e seus comandos/resultados atuais já oferecem execute/getSnapshot/subscribe sem dependência de janela de controle. Reutilizá-los em vez de criar PlaybackService2 ou outra sequência. A engine ainda depende de um host Chromium/WebContents para reprodução real: “caso de uso sem Renderer de controle” não significa “MP4 sem superfície Chromium”.

Opções que abrem seletor, fullscreen, foco, abrir logs e confirmação visual são capacidades de UI/sistema local. Não viram comandos remotos automaticamente. Um futuro dispositivo não recebe caminhos arbitrários para importFile nem poder de abrir diálogo. Autorização dessas capacidades pertence a G/H.

### 16.3 Direções permitidas

~~~mermaid
flowchart TD
  ROOT["main.ts: composição e lifecycle global"] --> HOST["Host Gestão único"]
  ROOT --> MEDIA["Runtime mídia/Standalone"]
  ROOT --> WINDOWS["Factories e coordenadores de fechamento"]
  ROOT --> IPC["IPC local + guard"]
  IPC --> HOST
  IPC --> MEDIA
  HOST --> APP["KaraokeApplication / StateRepository"]
  APP --> DB["Porta SQLite / database.ts"]
  MEDIA --> SEQ["Sequência / playback / recovery existentes"]
  REMOTE["Futuro adaptador G: autenticar e autorizar"] -.-> HOST
  REMOTE -.-> MEDIA
  UI["Renderer cliente"] --> PRE["Preload restrito"]
  PRE --> IPC
~~~

Módulos especializados não importam main.ts. Domínios/repository não dependem de ipcMain, BrowserWindow, WebSocket ou TLS. Transporte futuro depende apenas de operações/view/eventos autorizados; não recebe database, janela ou protocolo de mídia. Autorização do dispositivo não é convertida em sender IPC falso. O root conecta providers de identidade/política aprovados em G; D4 só define a separação.

## 17. Fluxos de comando, confirmação, erro e publicação

### Operação local após migração proposta

1. UI solicita completeAndAdvance com ID existente via Preload; guard verifica janela, frame/documento, payload, capacidade e licença.
2. Adapter chama o host, que utiliza o serializador existente de application; operação é preparada a partir do último estado confirmado.
3. Repository grava por database.ts na transação existente; confirmação precede publicação e resolução.
4. Host entrega resultado + view confirmada; adapter devolve resposta, subscriber atualiza cache/UI. Não há sucesso de UI antes do resultado.
5. Falha comprovada preserva estado anterior; resultado incerto fecha admissões pertinentes e exige recoverPersistence. Diálogo de encerramento usa a mesma porta prepare/flush/end/cancel, sem executeJavaScript.

### Futura operação remota — somente arquitetura G/H

~~~mermaid
sequenceDiagram
  participant D as Dispositivo
  participant T as Adaptador de transporte G
  participant P as Autorização de dispositivo
  participant A as Autoridade de aplicação
  participant S as Persistência ou serviço playback
  D->>T: Solicitação identificada/versionada
  T->>P: Validar mensagem, identidade e permissão
  P-->>T: Permitir ou rejeitar
  T->>A: Caso de uso explícito autorizado
  A->>S: Executar pela autoridade existente
  S-->>A: Confirmado, rejeitado, falhou ou incerto
  A-->>T: Resultado e estado com semântica conhecida
  T-->>D: Resposta correlacionada / evento autorizado
~~~

Recebimento e aceite não são sinônimos de execução. Gestão tem confirmação durável; sequência volátil tem confirmação do comando em memória; playback tem tentativas/estados observados e confirmação de contenção/recovery. Não emitir “música tocou” só por enviar load ou avançar um timer.

Correlação e logs sugeridos: runId, domínio, operationId quando já disponível, attemptId e revisão local; recebido → validado → autorizado → aceito → executado → confirmado → publicado, com erro/timeout/incerto separado. IDs remotos, versão, retenção de dedupe e significado dos ACKs são contratos G3/G4. Um timeout do transporte após commit não autoriza repetir addEntry. Identificar nova intenção versus retry é requisito de G, não garantia dos IDs locais atuais.

Subscrições são descartáveis e reconexão consulta autoridade. Memória de publicação não guarda “eventos para sempre”; backpressure/coalescência de snapshots e retenção de eventos serão escolhidos quando existir consumidor real G. Falha de transporte ou autenticação não executa mutação, Stop, troca de sessão nem transferência de autoridade por efeito colateral.

## 18. Outbox, Journal e consistência após falha

| Opção | Garantia possível | Falha não coberta / custo | Recomendação |
|---|---|---|---|
| Snapshot confirmado ao reconectar | Reconstrói estado atual sem histórico completo de eventos | Não prova entrega de cada transição nem resolve apresentação em curso sem política G/H | Preferência inicial se o contrato de produto aceitar reconciliação por estado. Ainda depende de decisão. |
| Eventos efêmeros em memória | Atualizações enquanto consumidores estão conectados | Crash perde histórico; sem garantia de entrega após reinício | Adequado para progresso/observação e diagnóstico transitórios, não fato operacional irrecuperável. |
| Outbox transacional SQLite | Estado + evento registrados na mesma transação; reenvio recuperável | Schema/migration, retenção, dispatcher, dedupe do receptor, ordem e custos de escrita | Justificável se G/H exigir entrega de cada fato confirmado após crash. Não implementar em D4. |
| Journal separado | Registra intenção/receipt/resultado para investigar retries e resultados incertos | Dupla escrita deixa janela de crash entre journal e SQLite; exige protocolo de recovery próprio | Não preferir a Outbox para garantir atomicidade de evento operacional. Avaliar receipts duráveis se G requerer dedupe entre reinícios. |

Cenário decisivo: commit SQLite termina e processo cai antes do send. Sem outbox, snapshot pode reconstruir estado; não recupera automaticamente o evento perdido. Outbox só fecha essa janela se database.ts gravar evento e mutação na mesma transação; acrescentar append no subscriber depois do commit não é atomicidade. Não promete exactly-once na rede: o receptor ainda precisa deduplicar reenvio.

O journal PlayerPlaybackRecoveryStore já preserva tentativas e incerteza de mídia; não é fila de eventos, log de comandos remotos ou substituto da transação operacional. A sequência Standalone continua volátil. Não persistir a fila Standalone para simplificar reconexão.

**Decisão recomendada D4:** preparar ponto de publicação confirmado e ownership explícito, sem Outbox, journal novo, schema ou migration. Registrar o teste de crash commit/send para G/H após escolher garantias. A necessidade não está comprovada por consumidor remoto implementado nesta baseline.

## 19. Lifecycle proposto e registro IPC

Cada owner devolve dependências prontas, subscriptions próprias e métodos de shutdown claros. Factories não têm side effects no import. Aquisição parcial mantém referências locais e desfaz apenas recursos adquiridos; um owner não fecha conexão emprestada. Não adicionar um container genérico de recursos como condição para toda extração.

Ordem global proposta, preservando a semântica existente:
- Antes de ready: single-instance, esquema, logging e callbacks globais.
- Startup: modo → licença/DBs apropriados → serviços mídia/recovery → host Gestão quando aprovado → IPC → superfícies/host de vídeo → prontidão confirmada.
- Falha: marcar failed, manter dados/recovery, fechar admissões, drenar o que iniciou, limpar prefixo adquirido; erro de cleanup é explícito e não é saída normal.
- Quit: decisão local apropriada → fechar admissões de comandos → drenar → Stop/containment e recovery quando aplicáveis → descartar sequence/serviços → remover subscriptions/handlers → host/protocolo/biblioteca → fechar DBs → finalizar log. A ordem interna Standalone atual prevalece sobre essa visão resumida.
- Falha irreversível mantém processo protegido, sem repetir descarte por um segundo caminho before-quit.

main-ipc-policy receberá expectedWebContents e expectedDocumentUrl, nunca somente um boolean global trusted. Guard é chamado também em ipcMain.on; após await de diálogo sensível, revalidar origem e estado conforme a bridge atual. dispose remove somente registros daquele owner e tolera chamada repetida. Restringir handlers Gestão é uma correção de fronteira proposta e precisa testes de consumidores legítimos; não é uma movimentação puramente textual.

## 20. Plano incremental para D4.3

Registro histórico: na versão da proposta, nenhum lote havia sido iniciado e a execução dependia da aprovação. Em 2026-11-07, o proprietário aprovou a arquitetura incremental C e a sequência integral dos lotes 1–8, inclusive o corte único da autoridade operacional da Gestão no lote 7. A execução mantém a ordem abaixo e só avança após estabilizar os testes diretamente afetados.

| Lote | Extração/arquivos afetados e dependências | Risco e validação necessária | Critério de conclusão e rollback |
|---|---|---|---|
| 1 — IPC técnico Player | main.ts → main-player-ipc.ts; injetar serviços/gates/snapshots, manter Preload/canais | Registro duplicado e perda de gates. Compile; runner unit; playback/recovery e produção Standalone; Combined/modes reais | Canais/resultados iguais e dispose por owner; rollback só do lote restaura registros inline. |
| 2 — política local e Gestão IPC | main-ipc-policy.ts, main-controller-ipc.ts, main.ts; mesma validação de payload/licença | Rejeitar sender legítimo ou permitir indevido. Matriz sender/frame/URL/modo/payload e ipc-validation, persistência, licença, diagnostics/sidebar/scale reais | Todo canal sensível com política explícita; negados não mutam; desregistro sem afetar outros owners. Rollback conjunto do registro/política, sem dados revertidos. |
| 3 — factories de janela | main-window-factories.ts + main.ts; coordenadores de close permanecem callbacks | Paths build/src, host único, foco/F11. Compile/assets; modes/multi-instance + standalone-production com capturas inspecionadas | Mesmos HTML/preload/security prefs/tamanhos/superfície. Rollback da factory e chamadas; sem alterar assets. |
| 4 — runtime de mídia | main-media-runtime.ts + main.ts; manter APIs existentes sequence/playback/recovery/options | Owned vs borrowed, startup parcial, subscriptions, Combined sem Standalone. Unit lifecycle com falha por aquisição; library/catalog, integração e produção reais | Uma instância por serviço, nenhuma conexão fechada antecipadamente e cleanup determinístico. Rollback factory/consumidores como unidade. |
| 5 — saída Standalone | main-standalone-shutdown.ts + main.ts; depende ownership lote 4 | Alto risco C9: timeout não cancela, EOF indevido, double dispose. IPC exit, produção MP4, shutdown failure/retry, recovery e testes semânticos de canFinish | Mesma ordem, prazo, fences, reentrada e erro terminal; zero avanço artificial. Rollback do coordenador e chamadas sem restaurar dados de usuário. |
| 6 — fechamento Gestão | main-management-close.ts + main.ts; porta explícita com adapter Renderer transitório | Diálogos, cancelamento e flush; session-close/persistence/mode change | Mesmas decisões/efeitos, porta desacoplada dos detalhes da janela; ainda documentar dependência Renderer até lote 7. Rollback coordenador/callbacks. |
| 7 — host Gestão e corte único | main-management-host.ts, management-contracts.ts, management-ipc.ts, management-client.ts; main.ts/preload.ts/types.d.ts/app.ts/state-repository.ts/application.ts e UI tipada por interface | Maior custo: leitura síncrona, inicialização, legado localStorage, licença, commit/ACK, single writer e fechamento. A aprovação explícita do lote foi registrada em 2026-11-07. Testes sem janela + SQLite, paridade IPC/direto, todas regras e E2Es Gestão, restart, uncertain, Combined, produção Windows | Nenhuma instância operacional Renderer ligada ao SQLite; app-data:save não permanece writer paralelo; UI recebe confirmado antes de sucesso; initialize uma vez; close sem executeJavaScript. Fazer o corte completo em lote isolado revisável, sem etapas de produção com dois owners. Rollback de TODOS os consumidores/bridge/host juntos, sem rollback do SQLite nem limpeza de localStorage já migrado. |
| 8 — consolidação | Remover somente adapters transitórios introduzidos nos lotes aprovados; docs/registrations | Resíduo de handler, imports/entrypoints. Compile + testes de registro/caminhos e revisão independente | Sem módulos órfãos e imports de main.ts; mapa ownership atualizado. Depois segue D5 separada; não iniciar G/E. |

**Paths/build/pacote:** main.ts calcula e injeta caminhos absolutos dos documentos/preloads a partir do seu __dirname raiz de build. Um módulo em build/src não reutiliza seu próprio __dirname para esses assets. Novos módulos TS entram pelo include src/**/*.ts atual; o grafo de imports do cliente altera o bundle de app gerado por scripts/copy-assets.ts e deve ser verificado. Preservar nomes de HTML/CSS/preloads e os filters electron-builder; nenhum novo entry point nem dependência externa são necessários. Mudança no client/Preload exige revisar types.d.ts, bundle e smoke empacotado, não apenas tsc.

Todos os lotes exigem compile. Testes citados são seleção mínima por impacto, não autorização para omitir suíte afetada. O lote 7 é uma mudança interna coordenada mais extensa, não pode ser fatiado deixando dois writers operacionais. É possível preparar contratos/clientes com testes isolados antes do corte, mas eles não assumem a produção até a troca completa. Se o custo exceder o aceitável, parar nos lotes aprovados e reservar a migração sem janela como gate explícito antes de G/H.

Rollback é reversão seletiva dos arquivos do lote futuro, preservando mudanças anteriores e dados; nunca git reset/clean do working tree nem restauração de banco real. Esta proposta não fornece comandos destrutivos de rollback.

## 21. Testes e campanha D5 proposta

| Fronteira | Testes novos ou adaptados a implementar em D4.3 | Regressão existente a repetir |
|---|---|---|
| Registro IPC | Inventário de canais, duplicação, dispose repetido, owner destruído; sender incorreto/subframe/URL velha/atual/modo/payload; negado sem efeitos | ipc-validation e testes Standalone IPC; produção Main/Preload real |
| Host Gestão sem janela | SQLite isolado, mesmas operações por chamada direta e IPC; ordem de duas mutações, falha antes de commit, commit com resposta perdida, reconciliar antes de retry, publish depois de commit, sem regressão de revision | application/persistence/database-migration e todas regras de fila; Gestão Electron |
| Cliente e UI | View instalada antes de resolver operação, inscrição inicial sem gap, evento duplicado/atrasado sem reverter cache, reload sem nova sessão, drag validado novamente no host, legacy import confirmado | drag, Round Robin/cadência, sessões/histórico, menus, sidebar/autocomplete e license |
| Recursos e startup | Falha injetada em cada etapa, só adquirido é liberado, fechamento durante scan/load, listeners limpos e duas chamadas dispose | modes/multi-instance, library/catalog e recovery |
| Saída | Drain de aceitos, rejeição de novos, cancelamento restaura somente onde permitido, timeout não executa replay, erro após dispose não gera quit seguro | exit IPC, standalone-production e session-close reais |
| Visual e foco | Mesma superfície/vídeo, currentTime sob Add/Info/Esc, Próximas, clique+atalhos, F11 consecutivo, Pausado/Retomando e C11 | standalone-production real + screenshots efetivamente abertas; input físico relatado separado |
| Build/release | Paths HTML/preloads/bundles e todos novos outputs; pacote sem testes; nenhum require ausente | compile, release-workflow, build:windows, verify:windows-build e smoke empacotado quando paths mudarem |

D5 executará npm run compile e test:unit, unitários Standalone por impacto e o agregado test:e2e:linux com seus complementos; produção Standalone headless com MP4 e perfis isolados. Windows: test:e2e:multi-instance:windows e test:e2e:standalone-production:windows pelo runner oficial, snapshot/fingerprint e checkout NTFS nativos. Opções/playback/integration/recovery focados continuam harnesses úteis; não comprovam Main do produto. Usar docs/windows-native-testing.md para comandos/variáveis reais e launcher manual oficial para validação humana.

O source atual tem testes de domínio sem Electron, mas não um host de Gestão de produção sem janela. Falha parcial e nova política uniforme de IPC exigem cobertura específica; não inferir cobertura só pela quantidade de E2Es. Testes físicos F11/Alt+F4, diálogo nativo, áudio audível e julgamento visual continuam separados de Playwright. A validação manual de Player/Combined relatada pelo proprietário é evidência anterior, não teste executado nesta auditoria.

G adicionará testes reais de TLS/pareamento, autorização, limites de recursos, desconexão, timeout, mensagens perdidas/duplicadas/fora de ordem, restart/reconnect durante reprodução, versão incompatível, sincronização, shutdown com operações pendentes e operação local sem rede. Nenhum stub de rede D4 servirá como evidência dessas garantias.

## 22. Revisões independentes e resolução das recomendações

- **Arquitetura:** confirmou composição por modo, globals, ausência de application no Main e distinção produção/harness. Recomendou extrações Main-side primeiro e host como migração própria. A referência informal a renderer.ts foi corrigida para o consumidor real src/app.ts.
- **Concorrência/persistência:** confirmou serialização/commit-before-publish atuais; identificou risco futuro de snapshots concorrentes e dependência Renderer no close; não encontrou defeito atual confirmado de transação/serialização. Recomenda host único e Outbox somente com requisito de entrega.
- **Segurança:** confirmou bridge Standalone e verificação downstream fullscreen; classificou guards Gestão como inconsistência real sem exploração comprovada. Recomendou políticas por owner/capacidade e rejeição verificável.
- **QA:** confirmou quais E2Es iniciam package Main e quais montam harness; lacunas prioritárias são host sem janela, falha por etapa de startup e matriz IPC negativa. Nenhuma suíte foi executada por esses agentes.
- **Consolidação:** adotada extração incremental sem resource container genérico. Host Gestão integra a proposta como lote explicitamente sujeito à aprovação, pois só extrair IPC não resolve requisito sem janela. Nenhuma recomendação autoriza implementação por si só.

## 23. Decisões para avaliação do proprietário e estado final

Aprovar ou ajustar:
1. Os módulos e a ordem dos lotes 1–8, preservando estrutura física, regras e serviços atuais.
2. Incluir a hospedagem única Gestão no Main no lote 7 da D4.3, com troca coordenada de IPC/cliente e sem segundo writer; ou postergar esse lote e manter o requisito sem janela explicitamente pendente antes de G/H.
3. A política uniforme de sender/frame/documento/capacidade para IPC e seus efeitos esperados de rejeição de chamadas indevidas.
4. A estratégia de publicação confirmada e projeções UI sem Outbox nova em D4, condicionando entrega recuperável aos contratos G/H.
5. A matriz de validação por lote, D5 e o cuidado adicional com legado localStorage, licença e inicialização uma vez.

Permanecem em G/H: protocolo wire/HTTPS/WSS, papel de conexões de entrada/saída, pairing, certificados/trust/credenciais, identidade/revogação e autorização de dispositivos, controle local versus remoto, autoridade na reconexão, transferência, quantidade de Players, estados não confirmados, retomada e sincronização após desconexão longa. Alternativas da seção 11 não são decisões aprovadas. A hospedagem local da aplicação não decide autoridade entre computadores.

**D4.1: CONCLUÍDA.** Auditoria estática e revisões com evidências, contratos e riscos documentados.

**D4.2: APROVADA PELO PROPRIETÁRIO EM 2026-11-07.** A aprovação inclui os lotes 1–8, DTOs IPC explícitos e serializáveis, projeções confirmadas, corte single-writer no lote 7, sem Outbox/Journal novo e sem protocolo remoto.

**Registro histórico substituído pela seção 25:** quando esta nota foi escrita, D4.3 estava concluída e D5 automatizada PASS, mas a validação manual ainda aguardava o proprietário. A aprovação manual global posterior está registrada na seção 25.

## 24. Registro parcial inicial da execução D4.3 — 2026-11-07 (histórico)

Este registro foi escrito depois da autorização explícita da D4.3, mas antes de concluir os lotes 2–8 e iniciar a campanha D5. Naquele ponto, o lote 1 estava concluído e as validações de produção ainda seriam repetidas. A seção 25 registra o resultado final e substitui os status parciais abaixo.

O proprietário autorizou explicitamente a execução integral e sequencial da D4.3 e D5. As decisões aprovadas estão resumidas acima e no ticket D4. Nenhuma decisão de G/H, Outbox/Journal, V1, UI/Doop ou produto foi antecipada.

### Lote 1 — Extração técnica do IPC Player (registro inicial; histórico)

- **Status: CONCLUÍDO.** `main.ts` continua composição e injeta dependências/estado; registro de handlers Player foi extraído para `src/main-player-ipc.ts`. O handler de fullscreen Standalone possui contrato de dependências próprio, mais estreito.
- Canais, gates, validação de sender existente, chamadas de serviços, resultados, gates de modo, IPC Player do Combined e fullscreen Standalone foram preservados. Os owners devolvem `dispose`; registro parcial em falha limpa os canais já adquiridos e chamadas repetidas de descarte são idempotentes.
- `tests/main-player-ipc.test.ts` cobre inventário de canais, validação do sender antes de snapshot, rollback de registro parcial e dispose repetido, incluindo o registro de fullscreen Standalone.
- **PASS:** `npm run compile`; `node build/tests/main-player-ipc.test.js` (4/4); `git diff --check`.
- **NOT RUN:** `npm run test:e2e:standalone-production:headless` terminou antes de iniciar Electron por não haver `KQ_PLAYER_TEST_MEDIA_DIR` local configurado. `npm run test:e2e:operating-modes:headless` compilou, mas Playwright não iniciou Electron no ambiente Linux (`Process failed to launch!`). Nenhum desses resultados foi classificado como PASS de produção. A produção Standalone/Combined será coberta pela campanha D5; validação nativa Windows dependerá do runner oficial e recursos disponíveis.
- Arquivos do lote: `main.ts`, `src/main-player-ipc.ts`, `tests/main-player-ipc.test.ts`, `package.json` (inclusão do teste no agregador unitário). O diff de `main.ts` também contém remoções do Player antigo já existentes no working tree antes da D4.3; essas alterações não foram revertidas.

### Lotes 2–8 e D5 (registro inicial; histórico)

Ainda não iniciados naquele registro. A execução posterior está detalhada na seção 25.

## 25. Resultado final da D4.3 e D5 — 2026-11-07

### D4.3 — oito lotes implementados

- `main.ts` continua composition root e coordena a composição, mas as responsabilidades aprovadas foram extraídas para módulos com dependências/lifecycle explícitos: `src/main-player-ipc.ts`, `main-ipc-policy.ts`, `main-controller-ipc.ts`, `main-window-factories.ts`, `main-media-runtime.ts`, `main-standalone-shutdown.ts` e `main-management-close.ts`.
- A Gestão agora tem única `KaraokeApplication` operacional no Main e um writer operacional SQLite. O Renderer consome `ManagementClient` e DTOs serializáveis; não recebe referências mutáveis da aplicação nem APIs de banco. Operações Main-side não exigem uma janela para existir; IPC local é adapter da mesma autoridade.
- Contratos de Management estão em `management-contracts.ts`; projeções síncronas confirmadas e puras em `management-projections.ts`; adapter IPC Main em `management-ipc.ts`; Cliente Renderer em `management-client.ts`; handoff legado em `persistence-contracts.ts`; host em `main-management-host.ts`.
- A proposta da seção 20 chamou o módulo de consultas puras de `management-queries.ts`. Na implementação, o arquivo recebeu o nome `src/management-projections.ts`, que descreve com mais precisão sua responsabilidade de projetar consultas síncronas a partir do estado confirmado. A mudança de nome não alterou a fronteira aprovada nem duplicou regras; o módulo implementado e testado é `management-projections.ts`.
- O host usa `hostEpoch/revision`, snapshots clonados, subscriptions e respostas após conclusão confirmada pela aplicação. O cliente instala a inscrição antes de pedir o snapshot e ignora revisão repetida/atrasada. A flag de importação legada só confirma limpeza do `localStorage` após commit; falha mantém os dados de origem.
- A consolidação removeu o helper não utilizado `serializeManagementState`; não foi introduzida Outbox/Journal, rede, protocolo, credenciais, segundo writer, outra fila ou playback alternativo. A sequência Standalone continua volátil e independente da fila operacional.
- Testes focados dos dez arquivos D4 passaram; `npm run compile`, `npm run test:unit` e cada suíte unitária Standalone passaram.

### D5 — resultados automatizados

- `npm run test:e2e:linux`: **PASS** nas 13 suítes do agregado; complementos **PASS** para biblioteca, catálogo, playback/recovery, Standalone IPC/saída/integração/UI/opções, modos, IPC validação, multi-instance e produção Standalone.
- Gestão Main sem Renderer foi testada diretamente com `MainManagementHost` e SQLite isolado. Testes cobriram inicialização única, snapshots imutáveis, persistência confirmada, falha SQLite sem publicar revisão, retry, idempotência de operação/reconciliação, concorrência e drain. IPC de produção foi exercitado em Electron com reload/restart; entradas inválidas foram rejeitadas sem mutação. Importação localStorage foi verificada em Electron real, removendo as chaves somente após commit.
- E2E de produção Standalone passou em Linux e Windows com Main/Preload/IPC reais, Chromium e MP4 externos. Os cenários verificaram playback/currentTime, pause/resume, reinício/Next, limites de fila/toast, overlays, fila Próximas, foco por Playwright, fullscreen repetido, shutdown, recovery e respostas do modal de saída.
- Runner oficial Windows passou duas vezes no checkout NTFS: modo multi-instance/Controller/Player/Combined e modo focado Standalone de produção. Fingerprint `e55833dc541c0c65c0265e1795c14a2956580c675e042b1d3ce9933c170e3033`, branch `feature/remote-player-lan-integration`, HEAD `5cd541f7a7aa232d73b346e09720c1a5716b4dc7`; Node Windows 24.11.0/npm 11.6.1, focus minimize/restore verificado, sem processo residual.
- Build Windows, `verify:windows-build` e smoke do executável empacotado passaram. O smoke usou perfil temporário e confirmou first-run, gravação/leitura pelo IPC/SQLite e persistência após restart. Nenhuma instalação do NSIS ou publicação ocorreu.
- Capturas Linux foram abertas em `/tmp/karaoke-queue-standalone-production-screenshots-538606/`; capturas Windows foram abertas em `C:\Users\Chris\AppData\Local\Temp\karaoke-queue-standalone-production-screenshots-13888\`. Também foram inspecionadas capturas de Gestão de sessão, fila Round Robin/proteções e recuperação. A lista específica e os limites estão no ticket D5.
- **Limites humanos `NOT RUN`:** input físico F11/Alt+F4, diálogo nativo de arquivo, confirmação de áudio audível e aprovação visual/manual do proprietário. Playwright automatizou tecla/F11, mas não substitui input físico; `currentTime`/EOF comprovam o elemento de mídia, não áudio audível. Não houve alteração visual no D4.3 nem comparação Doop.
- `npm ci` no checkout de teste reportou 6 vulnerabilidades moderadas no inventário e dependências depreciadas; nenhuma dependência foi atualizada nesta etapa.

**Status atual em 2026-11-07:** D4.1 CONCLUÍDA; D4.2 APROVADA; D4.3 CONCLUÍDA; D5 AUTOMATIZADA PASS e validação manual global APROVADA PELO PROPRIETÁRIO. **Fase D CONCLUÍDA E APROVADA. Fase E NÃO INICIADA.** Limites específicos de input físico F11/Alt+F4, diálogo nativo e áudio audível continuam `NOT RUN` quando sem confirmação individual; isso não reverte a aprovação global. A Fase G permanece futura.


### Verificações finais da entrega

- D4.3 alterou código/testes conforme autorizado. Após a validação Windows, o código, testes, scripts e `package.json` não foram alterados; foram concluídos os registros documentais.
- Foram verificados 93 links Markdown relativos do repositório nos documentos D4/D5, índice e roadmap; nenhum destino relativo ausente. Doze caminhos absolutos para capturas temporárias históricas foram excluídos dessa contagem.
- `git diff --check` e `git diff --cached --check`: sem erros de whitespace.
- Roadmap, índice, tickets D1–D5 e esta página registram a Fase D concluída e aprovada pelo proprietário em 2026-11-07. A validação manual foi global para Reprodutor e Tudo em um; limites físicos específicos sem evidência individual continuam históricos `NOT RUN`.
- Nenhum teste de aplicação foi repetido durante esta checagem documental final; o código e os testes permaneceram inalterados desde a campanha D5 registrada acima.
