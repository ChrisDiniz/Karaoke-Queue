# Fase D1 — Auditoria arquitetural e proposta para `src/`

**Data:** 2026-11-07
**Escopo original:** D1.1 — auditoria; D1.2 — proposta. Naquele momento, D1.3, D1.4, D2, alterações de código, testes, banco, V1, Doop e roadmap estavam fora do escopo.

**Decisões posteriores do proprietário — 2026-11-07:** D1.2 aprovada na alternativa A; D1.3 registrada como concluída sem movimentação de arquivos; a baseline D1.4 foi aceita com limitações históricas que não bloqueiam D2. O proprietário também declarou C9 e a Fase C concluídas/aprovadas; divergências de status abaixo foram preservadas apenas como histórico da auditoria inicial.

## 1. Contexto e método

A auditoria partiu do checkpoint `5cd541f` (`checkpoint: conclude Standalone C10 and C11`), na branch `feature/remote-player-lan-integration`. O working tree estava limpo. Não foram executados builds ou testes e não houve alteração em código, banco, perfil, V1 ou frames Doop.

Foram consultados `AGENTS.md`, o roadmap, o índice do backlog, os três tickets da Fase D, todos os onze tickets da Fase C, os documentos de playback, arquitetura remota, persistência, biblioteca, catálogo, UI, testes Windows, release e regras operacionais. Também foram lidos `package.json`, `tsconfig.json`, os entrypoints Electron, scripts de build e runners, testes relevantes, workflows CI e configurações dos agentes locais.

O código é a evidência do que está implementado; o roadmap e os tickets registram direção, fases e aprovações. Nomes de arquivos, tamanho ou uma futura intenção de produto não foram tratados isoladamente como defeitos.

### Divergência documental de status — histórico da auditoria inicial

No checkpoint usado pela auditoria, o proprietário informou que a Fase C estava concluída, enquanto roadmap/backlog ainda registravam C9 sem aprovação; esta divergência descreve o estado documental daquele momento. O proprietário posteriormente declarou C9 e a Fase C concluídas/aprovadas em 2026-11-07. Esse registro atual prevalece; as limitações de cobertura e aprovações anteriores são históricas e não reabrem validações nem bloqueiam a Fase C.

## 2. Conclusão executiva

A estrutura atual tem pouca organização física além de `src/ui/`, mas os nomes e contratos dos módulos já separam Gestão, Standalone, playback, catálogo, biblioteca e serviços de plataforma. A UI de Gestão está agrupada; o domínio Standalone usa prefixos próprios; a fila Standalone e a fila operacional da Gestão têm autoridades distintas.

A análise estática das 58 fontes TypeScript em `src/` encontrou 134 arestas de imports relativos e nenhum ciclo. Não foi encontrada duplicação comprovada das regras da fila, nem um segundo writer operacional. As fronteiras existentes estão mais claras no código e nos contratos do que na árvore de diretórios.

**Recomendação: alternativa A — manter a estrutura atual e não mover arquivos em D1.3.** O proprietário aprovou formalmente essa alternativa em 2026-11-07, e D1.3 foi registrada como concluída sem mudanças de código. A concentração mais relevante, `main.ts`, reúne composição por modo, criação de janelas, handlers IPC e lifecycle de startup/shutdown. Apenas deslocar módulos para pastas não corrige essa concentração; sua modularização será tratada separadamente em D4. Os módulos grandes que sustentam sequência, playback e UI também são coesos em torno de estados e contratos críticos; seu tamanho não justifica divisão nesta D1.

O benefício de pastas adicionais seria principalmente de descoberta e sinalização física. Contra esse ganho há muitas referências diretas por caminho em Main, Preload, tipos globais, bundles, verificadores de artefato, testes, HTML/CSS e empacotamento. O código atual continua compreensível sem uma movimentação ampla, e a separação existente é suficiente para distinguir responsabilidades durante a futura limpeza. Uma movimentação sem problema concreto de manutenção aumentaria o risco sem corrigir a concentração real.

Na data da auditoria, a alternativa A ainda aguardava decisão. A aprovação posterior encerrou D1.2 e D1.3 conforme registrada no ticket; a alternativa B não foi aprovada. D1.4 continua obrigatória.

## 3. Inventário do repositório

### 3.1 Contagem e organização física

`src/` contém 58 arquivos `.ts`, cinco arquivos HTML, cinco arquivos CSS e quatro imagens. Onze módulos TypeScript estão em `src/ui/`; os outros 47 estão diretamente na raiz de `src/`. A árvore tem um diretório funcional de UI e um de assets, mas não separa fisicamente Gestão, Standalone, playback compartilhado ou compatibilidade do Player antigo.

### 3.2 Mapa de responsabilidades

| Área | Módulos e arquivos atuais | Responsabilidade e consumidores principais |
|---|---|---|
| Gestão — regras | `src/queue-rules.ts`, `round-robin-rules.ts`, `debut-cadence-rules.ts`, `fixed-turn-rules.ts`, `frozen-queue-rules.ts`, `history-rules.ts`, `singer-suggestions.ts`, `app-state-validation.ts` | Regras da fila operacional, sessões/histórico, proteções, cadência e validação do estado. Consumidos por `src/application.ts`, UI de Gestão e testes de regras/aplicação. São necessários à Gestão/Combined e à futura H1. |
| Gestão — aplicação e persistência no Renderer | `src/application.ts`, `src/state-repository.ts` | `KaraokeApplication` coordena mutações; `StateRepository` implementa o contrato de leitura/gravação e reconciliação por meio da bridge. A UI chama operações da aplicação; gravações SQLite continuam no Main. |
| Gestão — interface | `src/app.ts`, `src/ui/*.ts`, `src/index.html`, `src/style.css`, parte de `src/assets/` | Shell, navegação, fila, histórico, sessões anteriores, configurações e interações da Gestão. `app.ts` compõe os componentes e as regras de visualização. |
| Catálogo musical | `src/music-catalog.ts`, `src/music-catalog-service.ts` | Parser/normalização e serviço de catálogo. O parser é puro; o serviço conversa com o repositório provido pelo Main. O catálogo atende os contextos Controller/Combined e Player, com armazenamentos diferentes conforme o modo. |
| Biblioteca de vídeo | `src/video-library.ts`, `src/video-library-configuration.ts`, `src/video-library-service.ts` | Regras de código/extensão, configuração de raízes e indexação/lookup Main-side. Usada pelos contextos Player e Combined; caminhos locais não são contratos da UI. |
| Playback e recovery | `src/player-playback-contracts.ts`, `src/player-playback-service.ts`, `src/chromium-playback-host.ts`, `src/player-media-protocol.ts`, `src/player-playback-renderer.ts`, `src/player-playback-recovery-contracts.ts`, `src/player-playback-recovery.ts`, `src/player-playback-recovery-store.ts`, `src/player-video-window.ts`, `src/player-playback.html`, `src/player-playback.css` | Serviço de estado/ordenação de playback, host Chromium, bridge do renderer técnico, protocolo local, recovery e gerenciamento de janela/superfície. Alguns serviços são reutilizados entre modos; reutilizar engine não compartilha a fila operacional. |
| Controle manual do Player existente | `src/manual-playback-service.ts`, `src/player-ui-contracts.ts`, `src/player-control-renderer.ts`, `src/player-control.html`, `src/player-control.css` | Compatibilidade com o shell de controle do Player anterior e seus contratos. O serviço e os caminhos Main-side ainda são consumidores reais; não são descartáveis por terem origem no modo Player antigo. |
| Sequência Standalone | `src/standalone-player-*.ts`, `src/standalone-player.html`, `src/standalone-player.css` | Domínio de sequência independente, operações e transições Main-side, contratos IPC, opções, interação/teclado e UI. Não usa fila, sessões ou histórico da Gestão. O adapter conecta a sequência ao serviço de playback existente. |
| Configuração e plataforma | `src/operating-mode.ts`, `src/licensing.ts`, `src/license-service.ts`, `src/logging.ts` | Configuração de modo transitória, política/estado de licença e logs. Consumidos principalmente por `main.ts` e, para contratos de UI, pela Gestão. |
| Welcome transitório | `src/welcome-renderer.ts`, `src/welcome.html`, `src/welcome.css` | À época da auditoria, a janela selecionava os modos atuais. A direção então registrada atribuía a escolha final ao instalador; essa proposta foi posteriormente substituída pela decisão aprovada da Fase E: seleção de Reprodutor/Tudo em um na primeira abertura, fora do NSIS. |
| Assets | `src/assets/` | Imagens usadas por superfícies existentes. `scripts/copy-assets.ts` copia a árvore para a saída de build. |

O agrupamento acima descreve consumidores atuais, não uma declaração de que cada área deva virar um diretório.

### 3.3 Entry points e arquivos fora de `src/`

- `main.ts` é o entrypoint Electron (`package.json` aponta para `build/main.js`) e o composition root atual.
- `preload.ts` define as APIs da Gestão e da bridge de Player expostas à janela de Management.
- `player-preload.ts` define a bridge restrita para o host Chromium de playback.
- `player-control-preload.ts`, `standalone-player-preload.ts` e `welcome-preload.ts` são bridges de superfícies específicas. O Preload Standalone de produção é empacotado a partir dos módulos compilados pelo script de assets.
- `database.ts` mantém a fronteira SQLite e cria o banco operacional (`karaoke.sqlite`) e o banco isolado de catálogo Player (`player-music-catalog.sqlite`).
- `types.d.ts` contém tipos globais de estado e interfaces `window.*`; alguns tipos referenciam diretamente módulos em `src/`.
- `scripts/copy-assets.ts` copia HTML, CSS e imagens para `build/src/` e gera bundles CommonJS para os Renderers e um bundle de Preload.
- `tests/` contém testes unitários/integrados, harnesses Electron/Playwright, helpers e fixtures. `scripts/` contém runners de build, release e validação Linux/Windows.
- Configuração do Electron Builder fica em `package.json`; não foi localizado arquivo separado de configuração Electron Builder/Forge. `tsconfig.json` compila entrypoints da raiz, `src/**/*.ts`, `tests/**/*.ts` e `scripts/**/*.ts`, com `rootDir: "."` e `outDir: "build"`.
- `.github/workflows/pr-validation.yml` executa compile, unitários, release/configuração, E2E Linux, build Windows e smoke test do executável empacotado. `release-windows.yml` é fluxo manual de release e não autoriza publicação.

## 4. Dependências e fronteiras atuais

### 4.1 Fluxo de Gestão

```text
src/app.ts e src/ui/*
  → KaraokeApplication / regras / StateRepository (Renderer)
  → preload.ts (API nomeada e restrita)
  → IPC do main.ts (validação do estado recebido)
  → database.ts (SQLite, transação e repository)
```

O Renderer não recebe conexão, SQL ou API genérica de filesystem. As regras puras de ordenação e histórico são consultadas pela UI para projeção; as mutações operacionais passam pela aplicação e pelo repositório existente.

### 4.2 Fluxo de Player e playback compartilhado

```text
main.ts
  → biblioteca / catálogo / PlayerPlaybackService / recovery / PlayerVideoWindow
  → ChromiumPlaybackHost ligado ao WebContents autorizado
  ↔ player-preload.ts ↔ player-playback-renderer.ts
```

O protocolo `kq-media` recebe grants opacos revogáveis e resolve a mídia pela biblioteca. A UI não envia caminho arbitrário de arquivo. O catálogo pode usar o banco Controller/Combined ou o banco isolado do Player, conforme a composição em `main.ts` e `database.ts`.

### 4.3 Fluxo Standalone de produção

```text
main.ts
  → uma StandalonePlayerSequence
  → PlayerPlaybackService + recovery + catálogo/biblioteca existentes
  → StandalonePlayerMainIpcBridge + Standalone Preload restrito
  ↔ standalone-player-renderer.ts
```

`StandalonePlayerSequence` é a autoridade da sequência e de suas transições, reservas e limite de 30 pendências. A sequência é volátil por contrato. `operationId` correlaciona intenção/deduplicação dentro da execução. Recovery persistente de playback é separado da sequência.

### 4.4 Dependências cruzadas e ciclos

Uma varredura textual dos imports relativos em `src/**/*.ts` encontrou 134 arestas entre os 58 módulos e zero ciclos. Essa verificação cobre imports relativos estáticos reconhecíveis no texto; não é análise completa de resolução/runtime do TypeScript e não inclui APIs Electron/Node.

Acoplamentos transversais confirmados:

- `main.ts` importa e compõe praticamente todos os serviços Main-side e define handlers IPC que capturam referências de janela/serviços.
- `database.ts` importa tipos e funções do catálogo para servir dois contextos SQLite. Isso mantém parser/contrato de catálogo próximo da persistência, mas não demonstra por si só dependência circular ou autoridade concorrente.
- `src/player-ui-contracts.ts` agrega tipos de playback, recovery, catálogo, biblioteca e `PlayerVideoWindow` para a bridge do controle Player. É um contrato de superfície ampla, distinto dos contratos Standalone.
- `types.d.ts` aponta para tipos em `src/ui/ui-scale`, `src/player-ui-contracts`, `src/standalone-player-ipc-contracts` e `src/licensing`.
- `scripts/copy-assets.ts` mantém listas explícitas de módulos para os bundles da Gestão, controle Player, Welcome, Standalone e Preload Standalone.
- Main, `PlayerVideoWindow`, scripts de cópia/verificação e testes usam caminhos físicos de HTML/CSS gerados sob `build/src/`.

Não foi identificada regra de Round Robin, cadência, fila ou sequência duplicada entre Gestão e Standalone. São domínios diferentes por requisito e por implementação. O serviço de playback, catálogo, biblioteca e recovery são infraestrutura técnica reutilizada; isso não transforma as filas dos modos em uma fila compartilhada.

## 5. Ciclo de vida Electron e composição de vídeo

### 5.1 Startup e janelas

`main.ts` adquire `requestSingleInstanceLock()` antes de inicializar serviços. Em `app.whenReady()`, lê a configuração `operating-mode.json`, calcula capacidades, inicializa biblioteca/catálogo/recovery e escolhe a janela conforme o modo atual. O repositório ainda possui `controller`, `player` e `combined`; a futura escolha entre `player` e `combined` na primeira abertura, definida depois desta auditoria, não substitui esse código antes das fases autorizadas. `controller` permanece compatibilidade transitória.

As janelas de Welcome, Player e Standalone usam `nodeIntegration: false`, `contextIsolation: true`, `sandbox: true` e `webSecurity: true`. A janela de Gestão explicita `nodeIntegration: false` e `contextIsolation: true`, mas não explicita as duas últimas opções. Isso é uma diferença de configuração observável, não uma vulnerabilidade confirmada nesta auditoria.

### 5.2 Superfície atual de vídeo Standalone

No startup Standalone real, `createStandalonePlayerWindow()` em `main.ts` cria a janela de controle, forma o URL documental esperado, chama `PlayerVideoWindow.attachControlWindow()` e instala a bridge IPC Standalone antes de carregar o HTML. Depois do `loadFile`, aguarda `playbackHostReady`.

`attachControlWindow()` cria `ChromiumPlaybackHost` para o `webContents` da própria janela Standalone e anexa esse host ao mesmo `PlayerPlaybackService`. `standalone-player.html` inclui `player-playback.css`; a camada de mídia Chromium e overlays/UI Standalone compartilham compositor/WebContents. O E2E de produção verifica que não há `WebContentsView` legado cobrindo os overlays. Portanto, o comportamento atual não deve ser descrito como uma janela de vídeo separada da interface Standalone.

`PlayerVideoWindow` também preserva suporte a `WebContentsView` e janela de saída para superfícies Player que ainda usam essa composição. Não remover esse comportamento nem o host por causa da composição Standalone atual.

### 5.3 Foco, fullscreen, listeners e shutdown

O Renderer Standalone registra tratamento de teclado em fase de captura e remove listeners no ciclo de página. `PlayerVideoWindow` observa a janela de controle, bounds, visibilidade, reparenting, foco, fullscreen e dispose. F11 Standalone passa por handler Main validado para a janela/frame/documento; Esc continua no menu/painéis. A superfície de controle precisa manter foco e receber comandos após cliques.

O shutdown Standalone em produção usa confirmação única, estado Main-side, fechamento de novas admissões, drain de operações, Stop de shutdown sem EOF sintético, verificação de recovery antes/depois do dispose e liberação ordenada de recursos. `will-quit` limpa bridge, subscriptions, `PlayerVideoWindow`, protocolo, biblioteca e bancos. O teardown de Management também protege escrita/flush e decisão de encerramento de sessão. Esses fluxos foram estabilizados durante C9 e são dependências críticas; extração ou movimentação que altere ordem/ownership não é uma simples organização física.

## 6. Persistência, autoridade e dados

| Estado | Autoridade/armazenamento atual | Implicação para D1 e fases futuras |
|---|---|---|
| Gestão: fila, sessões, apresentações, histórico, prioridade/pins/congelamento/cadência | `KaraokeApplication`/`StateRepository` coordena candidatos; Main detém `DatabaseSync`; `database.ts` grava em `karaoke.sqlite` com transação. | Preservar módulos, writer e compatibilidade para Combined/H1. Nenhum movimento pode separar inadvertidamente regras da aplicação ou reclassificar o Controller como removível. |
| Catálogo Controller/Combined | Repositório no banco operacional existente. | Não criar segundo writer ou banco operacional. Import/substituição é transacional e serializada no serviço. |
| Catálogo Player | Banco próprio `player-music-catalog.sqlite`, validado contra alias do banco Controller. | Manter separado e isolado; não converter, juntar ou migrar nesta fase. |
| Sequência Standalone | Estado Main-side volátil em `StandalonePlayerSequence`; a ordem da fila e a prioridade não são persistidas. | Não mover para SQLite operacional nem chamar a fila Controller. O limite 30, FIFO/LIFO e idempotência pertencem ao contrato atual. |
| Recovery de playback | `PlayerPlaybackRecoveryStore` persiste journal versionado no `userData`; coordenador observa transições do serviço. | Não remover por ser parte do Player antigo; necessário à recuperação e a fluxos futuros de playback. Não confundir com fila/histórico. |
| Configuração de biblioteca e modo | Arquivos sob `userData`; Main resolve caminhos e configuração. | Caminhos e formatos são persistência real. Exclusividade atual é por perfil; exclusividade de computador é E3. |
| Preferências de UI e licença | Main persiste arquivos de configuração/estado próprios. | Manter contratos e políticas; nenhuma alteração de dados ou licença está autorizada. |

`KaraokeApplication` serializa mutações dentro da instância, prepara candidato, aguarda o repositório e publica após confirmação. Escritas relacionadas no SQLite usam transação; reconciliação de estado incerto não reexecuta cegamente mutações. A proteção atual não equivale a lock de computador entre perfis/contas. O lock de instância do Electron por `userData` também não é essa garantia; exclusividade é tratada em E1/E3.

Não foi encontrado defeito concorrente confirmado nos caminhos examinados. Os limites de instância/perfil e a necessidade de preservar estado volátil versus persistente são riscos arquiteturais conhecidos e documentados, não justificativa para mudança nesta D1.

## 7. Regressões da Fase C e cobertura existente

### 7.1 E2E Standalone de produção

`tests/standalone-player-production-electron.ts` inicia a composição real de `main.ts`, com Electron/Playwright, Preload e IPC de produção, perfil temporário, SQLite e recovery isolados, além de MP4 real externo via `KQ_PLAYER_TEST_MEDIA_DIR`. O script específico é `npm run test:e2e:standalone-production:headless`; o runner oficial Windows tem a variante `test:e2e:standalone-production:windows`.

O E2E contém assertions para a composição de vídeo e controles no mesmo WebContents, estado de playback e progresso `currentTime`, overlays e Próximas, foco depois de cliques, pause/resume, transições CSS, repetição de F11 e estado real fullscreen, fila cheia, rejeições sem mutação, shutdown/recovery e ausência de recuperação da sequência volátil após restart. Os screenshots são capturados em estados nomeados. A asserção automatizada combina DOM/CSS, estado de janela e mídia real; a existência de screenshot não compara sua aparência com pixels de referência.

O histórico de C9 registra a criação do E2E para o Main de produção depois que se confirmou que harnesses anteriores iniciavam uma composição própria; C9–C11 ampliaram essa suíte e a suíte UI, enquanto C11 acrescentou assertions de limite/reserva na Sequence. Esses testes recentes fecham parte da lacuna anterior de produção, mas não convertem captura em aprovação visual nem input Playwright em input físico.

### 7.2 Matriz de comportamento crítico

| Cenário | Cobertura atual observada | Limite que deve permanecer explícito em D1.4 |
|---|---|---|
| Vídeo visível sob Adicionar, Informações e menu Esc | E2E de produção verifica superfície real, `videoPaused === false`, avanço de `currentTime`, estados visíveis e captures da composição. | Capturas não são golden-image assertions; inspecionar a aparência real contra frames/desenhos aprovados quando aplicável. |
| Tela preta/ocultação indevida ao abrir painéis | Mesmo E2E verifica camada de mídia ativa, visibilidade dos painéis e progresso do vídeo, incluindo tela de saída. | DOM/progresso não comprovam sozinho a percepção visual; revisar screenshots Electron. |
| Comandos após cliques sucessivos | E2E de produção clica em superfícies, confirma foco/entrada e volta a acionar Space/teclas. O listener Standalone é captura. | Playwright não é teclado físico/driver Windows. |
| F11 alternado, Esc e fullscreen | E2E envia F11 repetidamente e verifica `BrowserWindow.isFullScreen`, dica e retorno ao modo janela; Esc abre/fecha menu sem sair do fullscreen. | Injeção física repetida de F11 no Windows permanece `NOT RUN` quando o harness não comprova foreground. |
| Próximas esconde/retorna após painéis | E2E verifica fila visível com pendências, ocultação por Adicionar/Informações e restauração após Esc; a sequência de produção preserva snapshot mais recente. | O frame C9 registra que Próximas é implementação existente e sem frame Doop específico; não inventar referência visual. |
| Indicadores Pausado/Retomando | E2E observa estado de playback, visibilidade, nome/duração da animação, amostras de opacidade e screenshots em início/meio/fim. | Amostras DOM/CSS não equivalem a aprovação visual humana. Respeitar `prefers-reduced-motion`. |
| Shutdown, recovery, restart | E2E Main real cobre confirmação, operação em andamento, erro/recuperação, estado persistido e sequência volátil após restart; há testes de recovery e playback isolados. | Alt+F4 físico e experiência audiovisual ainda têm limites registrados em C9; não atribuir ao harness prova de energia/força física. |
| Limite de 30, FIFO/LIFO, prioridades | `standalone-player-sequence.test.ts`, runtime/IPC e E2E Main real cobrem admissões, retries, limite, concorrência e rejeição imutável. | D1.4 deve reexecutar regras e fluxo integrado após qualquer movimento dos módulos. |
| MP4 real e SQLite/perfil | E2Es Standalone recebem mídia somente leitura externa e criam perfil/SQLite temporários. | Linux/Xvfb não demonstra comportamento nativo de janela, foco ou driver Windows. Não usar dados/perfis operacionais. |

### 7.3 Lacunas observadas

- Não há comparação automatizada das capturas de tela com imagens Doop/golden. A inspeção visual humana das capturas continua necessária; DOM/CSS e contadores não substituem essa comparação.
- **Limitação histórica de cobertura:** algumas execuções Windows de F11/Alt+F4 não comprovaram input físico por falta de evidência de foreground. O proprietário encerrou e aprovou C9/Fase C em 2026-11-07; esses registros não são pendências atuais nem requisito de novo teste.
- Seleção de arquivo nativa não é exercida pelo Playwright nos testes C8; a automação usa uma porta de diálogo de teste. A validação manual anterior de C8 no Windows está registrada separadamente.
- MP4 real não está versionado no projeto; os E2Es dependem de amostra externa configurada. `currentTime`/decodificação não provam audibilidade no dispositivo/TV.
- E2Es de UI produzem captures, mas não substituem a comparação real Electron × Doop. Não usar `test:e2e:standalone-ui:headless` como substituto do E2E de Main de produção.
- **Histórico de cobertura C9:** os registros técnicos de então apontavam ausência de input físico Alt+F4/F11 em algumas execuções e pendência de avaliação visual humana. O proprietário encerrou e aprovou C9/Fase C em 2026-11-07; essas limitações não são pendências atuais, não reabrem validações e não bloqueiam a próxima etapa autorizada.

## 8. Achados e riscos arquiteturais comprovados

### Achados

1. **Composição/lifecycle concentrados em `main.ts`.** O mesmo entrypoint escolhe modo, inicializa serviços, cria janelas, instala vários handlers IPC, publica eventos e coordena encerramentos diferentes. Isso é um ponto de acoplamento e risco de alteração de startup/shutdown. Não é evidência de que a implementação esteja incorreta e não é resolvido por criar diretórios.
2. **Contratos de controle Player amplos.** `player-ui-contracts.ts` liga tipos de serviço, catálogo, biblioteca, recovery e janela. A interface existe por consumidores atuais; não há evidência de um ciclo. A sequência Standalone possui contratos próprios.
3. **Paths de build/teste são contratos executáveis.** `main.ts`, Preloads, `PlayerVideoWindow`, `types.d.ts`, `copy-assets.ts`, verificadores de build e testes montam paths explícitos. Uma movimentação de arquivo requer atualizar todos os pontos, inclusive cálculo do URL documental autenticado pelo IPC.
4. **Bundles de Renderer são listas explícitas.** O script de cópia cria bundles CommonJS com coleções manuais de módulos; mover um `.ts` sem atualizar a lista pode produzir erro de módulo ausente no Renderer mesmo que o TypeScript compile.
5. **Diferença de hardening entre janelas.** A janela Management não explicita `sandbox`/`webSecurity`, ao contrário de Welcome/Player/Standalone. `src/index.html` também não declara CSP, enquanto outros documentos têm política inline. Nenhuma exploração ou vulnerabilidade foi confirmada nesta auditoria; isso não integra a recomendação de organização nem autoriza alteração de segurança.

### Não encontrados

- Nenhum ciclo nos imports relativos estáticos da árvore `src/` auditada.
- Nenhuma duplicação comprovada das regras operacionais da Gestão ou da sequência Standalone.
- Nenhum writer SQLite no Renderer ou segunda fila operacional concorrente.
- Nenhum defeito confirmado de concorrência/recovery nos caminhos auditados por código/documentação.

## 9. Comparação das alternativas

| Critério | A — manter estrutura e corrigir pontos somente quando comprovados | B — criar diretórios por função/responsabilidade |
|---|---|---|
| Clareza atual | Preserva nomes prefixados e o agrupamento existente de `src/ui/`; requer que quem investiga siga imports/documentação. | Sinaliza Gestão, Standalone, playback compartilhado e controles anteriores diretamente na árvore. |
| Acoplamento | Não o altera. O composition root permanece em `main.ts`. | Também não reduz acoplamentos por si só; apenas muda caminhos. A extração de lifecycle seria outra mudança com risco próprio. |
| Benefício prático | Evita uma alteração mecânica ampla sem problema de manutenção reproduzível. Mantém a trilha dos contratos estabilizados na C9. | Melhora descoberta e torna mais visível o que não deve ser confundido/removido em D2; pode facilitar navegação quando o repo crescer. |
| Custo | Nenhum custo de path; mantém o trabalho futuro de leitura por prefixo/import. | Atualização coordenada de imports em testes e produção, TypeScript, `copy-assets`, HTML/CSS/assets, startup, runner Windows e verificador de pacote. |
| Risco | A concentração de `main.ts` e os contratos amplos continuam a exigir cuidado. | Erros de URL/preload podem impedir startup ou fazer a validação IPC rejeitar chamadas; um módulo omitido da lista do bundle pode quebrar somente em runtime. |
| Efeito em Combined/Standalone | Mantém a separação semântica já existente. | Pode comunicá-la melhor, desde que os serviços compartilhados fiquem em área explicitamente técnica e o Player de controle não seja tratado como descartável. |

### Recomendação

**Escolher A para esta D1.** A evidência atual não mostra que a topologia física esteja impedindo manutenção ou teste: os módulos são nomeados por responsabilidade, a UI de Gestão já está agrupada, os contratos de Standalone são separados e não foi detectado ciclo/duplicação. A principal fragilidade comprovada é a concentração do composition root e dos handlers no lifecycle Main, que uma movimentação de pastas não corrige.

Não proponho criar `shared/`, `core/`, `services/` ou outras pastas genéricas. Se um problema concreto posterior justificar B, primeiro aprovar um mapa específico e identificar consumidores; não usar a presente auditoria para presumir ou iniciar a movimentação.

## 10. Estrutura proposta e arquivos a movimentar

### Proposta recomendada

Manter a árvore física atual de `src/`, `main.ts`, preloads, `database.ts`, `types.d.ts`, scripts e testes. Portanto, **não há arquivos a mover nem imports/exports a alterar sob a recomendação A**. `src/ui/` continua como agrupamento da interface de Gestão; módulos Standalone mantêm o prefixo `standalone-player-`; módulos de playback, biblioteca e catálogo mantêm os nomes atuais.

Não extrair IPC de `main.ts`, separar a máquina de estados da sequência, dividir Renderers ou criar contratos/barrels nesta D1. Esses seriam refactors de responsabilidade e não são necessários para uma decisão de organização física.

### Estrutura alternativa B, caso seja preferida pelo proprietário

A seguinte árvore é apenas uma alternativa de discussão, **não recomendada nem aprovada**, e não autoriza movimentação:

```text
src/
  management/
    rules/                 # regras operacionais e validação de AppState
    application/           # KaraokeApplication
    persistence/           # StateRepository Renderer-side
    ui/                    # app.ts, componentes de src/ui, HTML/CSS da Gestão
  media/
    catalog/               # parser e MusicCatalogService usados por mais de um modo
    library/               # configuração, scan e lookup de vídeos
    playback/              # host, serviço, protocolo, recovery e janela técnica
  player-control/          # ManualPlaybackService e shell de controle existente
  standalone/              # sequência, runtime, interação, IPC, opções e UI
  platform/                # modo, licenciamento local e logging
  onboarding/              # Welcome transitório
  assets/                  # imagens existentes
```

Essa alternativa mantém entrypoints de processo, `database.ts`, preloads, contratos globais, testes e scripts fora de `src/`, mas altera muitas importações e referências de runtime. Se B for escolhida, o proprietário deve aprovar também o agrupamento de `manual-playback-service.ts`/`player-ui-contracts.ts` e a localização de cada HTML/CSS antes de D1.3. O desenho acima não deve ser aplicado parcialmente sem atualizar os bundles e os caminhos de runtime correspondentes.

## 11. Plano sugerido para D1.3

A alternativa A aprovada foi registrada em D1.3 sem mudança de código: nenhuma movimentação de arquivos ou diretórios. A decisão não inicia D1.4; a campanha continua planejada e depende de autorização própria.

| Grupo futuro | Módulos/movimentos | Motivo/dependências | Risco/teste e critério | Rollback |
|---|---|---|---|---|
| D1.3-A — registrar decisão de manter | Concluído: nenhum arquivo. A decisão foi registrada no ticket e os paths/contratos foram mantidos. | D1.2 aprovada pelo proprietário em 2026-11-07. Não se aplica dependência de código. | Critério atendido: nenhuma alteração em `src/`, entrypoints, builds ou comportamento. D1.4 permanece obrigatória. | Não se aplica rollback de código; eventual revisão exige nova decisão documental do proprietário. |
| Alternativa futura somente se B for aprovada — decomposição | O mapa final deve definir lotes pequenos, começando por grupos sem recursos de janela e terminando em Standalone/lifecycle. Não iniciar lote pela árvore alternativa acima sem detalhamento de consumidores/imports. | Requer aprovação específica de B e mapa atual→proposto. | Após cada lote: compile e testes diretamente afetados; teste de runtime para paths/bundles; nenhuma alteração de regras/ownership. Critério: imports, assets, entrypoints, testes e artefatos apontam para o destino, sem diff funcional. | Reverter o último lote de paths/imports como unidade; não avançar para o próximo se compilação/testes falharem. Preservar os lotes previamente validados. |

Como A foi aprovada, não há lista de arquivos ou grupos de movimentação: D1.3 encerrou-se sem movimentos. A tabela registra o resultado e não concede autorização para B.

## 12. Estratégia proposta de regressão para D1.4

D1.4 é obrigatória após D1.3 estabilizada, mesmo se o proprietário aprovar manter a estrutura. A matriz deve validar testes de regras e as superfícies reais do Electron. Os comandos abaixo existem no `package.json`; nenhum foi executado nesta auditoria.

### 12.1 Compilação, unitários e integração

| Objetivo | Comando disponível | Observação |
|---|---|---|
| Compilar TypeScript e gerar/copy assets | `npm run compile` | Produz `build/` e os bundles HTML/Renderer/Preload esperados pelo app. |
| Unitários gerais | `npm run test:unit` | Inclui compile e regras/aplicação/persistência/migração/Player playback, além de testes de bundles, runner e release engine. Não inclui toda a suíte unitária Standalone. |
| Contratos, runtime e recovery Standalone | `npm run test:unit:standalone-contracts`; `npm run test:unit:standalone-runtime` | Runtime inclui contratos, runtime e recovery. |
| Sequence, interação e transport | `npm run test:unit:standalone-sequence`; `npm run test:unit:standalone-interaction`; `npm run test:unit:standalone-interaction-transport` | FIFO/LIFO, prioridades, capacidade, transições e correlação conforme assertions existentes. |
| Adapter, opções, IPC e UI Standalone | `npm run test:unit:standalone-playback-adapter`; `npm run test:unit:standalone-options`; `npm run test:unit:standalone-ipc`; `npm run test:unit:standalone-ui` | O grupo UI também executa interação, metadados, IPC, opções e catálogo. |

### 12.2 Electron real, Playwright, IPC e SQLite

**Gestão/Controller e modos:**

- `npm run test:e2e:linux` executa o conjunto Linux em `scripts/run-e2e-linux.cjs`: smoke geral, drag, Round Robin, cadência, persistência, sessões anteriores/fechamento, licenciamento, menu da fila, autocomplete, sidebar e diagnósticos.
- Complementos focados existentes: `test:e2e:persistence:headless`, `test:e2e:ipc-validation:headless`, `test:e2e:multi-instance:headless`, `test:e2e:operating-modes:headless`, `test:e2e:video-library:headless`, `test:e2e:music-catalog:headless`, `test:e2e:drag:headless`, `test:e2e:round-robin:headless`, `test:e2e:cadence:headless`, `test:e2e:sessions:headless`, `test:e2e:session-close:headless`, `test:e2e:licensing:headless`, `test:e2e:queue-menu:headless`, `test:e2e:diagnostics:headless`, `test:e2e:singer-autocomplete:headless` e `test:e2e:sidebar-name:headless`.
- `test:e2e` e `test:e2e:headless` são smoke da UI principal. A suíte Linux agregada **não inclui** os E2Es Standalone; executá-los separadamente.

**Player, Standalone, playback/recovery e IPC:**

- Unit/integração Electron focados disponíveis na auditoria D1: `test:e2e:player-playback:headless`, `test:e2e:player-recovery:headless`, `test:e2e:standalone-playback:headless`, `test:e2e:standalone-ipc:headless`, `test:e2e:standalone-exit-ipc:headless`, `test:e2e:standalone-integration:headless`, `test:e2e:standalone-ui:headless`, `test:e2e:standalone-options:headless`, `test:e2e:standalone-exit:headless` e `test:e2e:standalone-production:headless`. A suíte Player Control foi uma observação histórica e foi removida na D2.
- O E2E `standalone-production` é o teste principal da composição Main real da C9/C10/C11. Requer mídia externa válida (`KQ_PLAYER_TEST_MEDIA_DIR` com `01001.mp4`), usa Electron/Playwright e cria perfil/SQLite temporários; não usar diretório operacional.
- As suítes de integração/harness que não iniciam o Main de produção complementam regras/bridge, mas não substituem `standalone-production` para lifecycle, confirmação, shutdown e composição atual.

**MP4, screenshots e validação visual:**

- Após a regressão automatizada, revisar screenshots reais da produção em dimensões equivalentes às referências aprovadas (1280×800 quando aplicável). Inspecionar vídeo + fila, Adicionar, Informações, menu Esc, Pausado, amostras de Retomando, fila restaurada, fullscreen/janela, mensagens e transições de saída relevantes.
- Comparar com frames Doop aprovados e suas descrições; “Próximas” não deve receber um frame inventado. Screenshots do teste são evidência para inspeção, não PASS visual automático.
- Diferenciar imagem/estado DOM, reprodução MP4 observada e aprovação humana; `currentTime` avançando não comprova áudio audível.

### 12.3 Runner Windows nativo e empacotamento

- Runner oficial: `npm run test:e2e:multi-instance:windows -- --approve-untracked --standalone-production`. Ele valida snapshot, branch/HEAD, hashes, checkout NTFS, Node/npm/Electron/Playwright Windows nativos, perfil temporário e fingerprint final. Usar o modo explícito `--standalone-production`; o conjunto padrão do runner não substitui esse modo focado.
- Variantes Windows registradas na auditoria D1: `test:e2e:standalone-playback:windows`, `test:e2e:standalone-integration:windows` e `test:e2e:standalone-options:windows`. A variante Player Control foi descontinuada na D2. A matriz atual e a classificação produção/harness estão em [Testes nativos do Windows](windows-native-testing.md); não há alias que, por si só, comprove input físico F11/Alt+F4 ou diálogo nativo.
- Testes de empacotamento/configuração existentes: `npm run test:release-workflow`, `npm run build:windows`, `npm run verify:windows-build`; `tests/packaged-windows-smoke.cjs` é invocado pelo workflow CI depois do build e verifica o aplicativo empacotado com perfil temporário. Build/teste Windows deve usar o fluxo documentado, sem executar aplicação nativa no checkout WSL.
- `npm run test:catalog:sample` existe, mas depende de amostra CSV local fornecida ao harness; não é substituto para banco/profile isolado.
- O runner Linux sintético `scripts/windows-native-runner.test.cjs` está incluso no `test:unit`; `scripts/run-e2e-linux.cjs` possui lista própria de suites e não cobre Standalone.

### 12.4 Sequência de validação proposta

1. Registrar HEAD/snapshot e working tree; executar `npm run test:unit`, que já inclui a compilação TypeScript. Usar `npm run compile` separado quando o gate de compilação precisar ser reportado independentemente.
2. Executar suites Management/Controller de persistence, IPC, modos, biblioteca, catálogo, fila, Round Robin/cadência, sessões e drag conforme a abrangência exigida por D1.4.
3. Executar unitários Standalone específicos e E2Es Player/Standalone, incluindo `standalone-production`, com MP4 real e perfil/SQLite temporários.
4. Capturar e inspecionar a composição Electron real nas transições C9/C10/C11; comparar visualmente com referências Doop aplicáveis e registrar limitações de screenshot, input, Windows e áudio.
5. Executar o runner Windows oficial no checkout NTFS isolado para composição, foco, fullscreen, lifecycle e playback; registrar fingerprint ou `NOT RUN` com causa/impacto.
6. Quando paths de HTML/bundles/pacote forem afetados, executar build Windows, `verify:windows-build` e packaged smoke conforme fluxo disponível/CI. Nenhum PASS pode ser inferido de compile isolado.
7. Após correções, repetir suites falhas e diretamente afetadas sobre o estado final; nenhuma mudança posterior pode ficar sem validação aplicável.

Esta campanha é apenas planejada. Não foi executada durante D1.1/D1.2.

## 13. Impactos e fases protegidas

- **Gestão/Combined e H1:** preservar `KaraokeApplication`, SQLite/repository, filas, sessões, histórico, regras Round Robin/cadência, prioridades e proteções. O código do Controller é domínio operacional necessário, não sobra removível.
- **Standalone:** manter Sequence/Runtime como autoridade própria, fila volátil e de até 30 pendentes. Não conectá-la à fila operacional nem persistir sua sequência por conveniência.
- **Playback e catálogo:** compartilhar infraestrutura onde os contratos atuais são compatíveis sem compartilhar autoridade de fila. Preservar recovery, banco de catálogo Player e biblioteca.
- **Fase E:** instalador, seleção de função, identidade e exclusividade por computador pertencem a E1–E5. O `operating-mode.json` e lock atual não garantem exclusividade por computador.
- **Fase G:** comunicação remota segura e estados de conectividade reais permanecem futuros; não criar stubs ou comportamento de rede nesta proposta.
- **Fase H:** integração operacional Combined/Player e autoridade/sincronização pertencem a H1–H8. Não presumir fila compartilhada, reconciliação ou reprodução local integrada antes das etapas aprovadas.
- **V1/Doop/licença/dados:** não foram alterados. Nada nesta proposta modifica comportamento ou política de dados.

## 14. Subagentes consultados

Todos os subagentes atuaram em leitura e planejamento, sem editar arquivos, compilar ou rodar testes:

| Papel | Resultado consolidado |
|---|---|
| Architecture Explorer | Confirmou composição por modo, consumidor/owner de módulos, composição de vídeo no WebContents Standalone, caminhos sensíveis e ausência de ciclo estático observado. Recomendou não extrair lifecycle durante movimentação mecânica. |
| Concurrency Auditor | Não encontrou defeito concorrente confirmado; documentou serialização/transações/reconciliação e limites do lock por perfil. Reforçou a separação entre fila volátil Standalone, banco operacional, catálogo e recovery. |
| Test Engineer | Confirmou assertions recentes do E2E Main real e lacunas entre screenshots, comparação visual, input físico e diálogo nativo. Identificou que `test:e2e:linux` não inclui as suítes Standalone. |
| Security Auditor | Não confirmou vulnerabilidade; destacou contratos de sender/frame/URL e dependência dos caminhos de bundle. Registrou diferença de opções de hardening da janela Management e CSP sem inferir exploração. |

Os achados independentes são consistentes; a recomendação final considera o código e os documentos, não a autoridade dos subagentes.

## 15. Decisões registradas e etapa pendente

1. **D1.2 — aprovada:** alternativa A, manter a organização física atual de `src/`.
2. **D1.3 — concluída:** decisão registrada sem movimentações, renomeações ou novos diretórios.
3. **D1.4 — campanha executada e baseline aceita:** a execução de 2026-11-07 está resumida abaixo e detalhada no ticket; as limitações aceitas são históricas e não bloqueiam D2.
4. **Fase C/C9 — concluídas e aprovadas pelo proprietário em 2026-11-07:** a divergência do checkpoint inicial foi resolvida; não há reteste ou validação adicional exigidos por esta decisão.
5. **D4 — estado histórico desta auditoria:** as diretrizes gerais de modularização incremental estavam aprovadas; D4.1/D4.2 ainda não tinham começado e D4.3 dependia da aprovação da proposta concreta. A auditoria e a execução ocorreram depois, conforme o documento D4 e seu ticket.

**Estado vigente deste documento:** D1.1–D1.3 concluídas e D1.4 aceita como baseline. As descrições de módulos/caminhos nas seções de auditoria abaixo refletem o código analisado antes da D2; consulte o registro pós-D2 ao final para a estrutura ativa.

## Referências consultadas

- `AGENTS.md`, `README.md`, `package.json`, `package-lock.json`, `tsconfig.json`, `types.d.ts`, `.codex/config.toml`, `.codex/agents/*.toml`.
- `main.ts`, `database.ts`, `preload.ts`, `player-preload.ts`, `player-control-preload.ts`, `standalone-player-preload.ts`, `welcome-preload.ts`, `src/**`.
- `scripts/copy-assets.ts`, `scripts/run-e2e-linux.cjs`, `scripts/run-windows-native-tests.cjs`, `scripts/verify-windows-build.cjs`, `scripts/standalone-c1-windows-manual.cjs` (inventário da época da D1; removido nesta auditoria), `scripts/player-control-renderer-bundle.test.cjs`, `scripts/windows-native-runner.test.cjs`.
- `tests/standalone-player-production-electron.ts`, `tests/standalone-player-ui-electron.ts`, `tests/standalone-player-playback-electron.ts`, `tests/standalone-player-integration-electron.ts`, `tests/standalone-player-sequence.test.ts`, `tests/standalone-player-runtime.test.ts`, `tests/standalone-player-ipc.test.ts`, além dos testes de persistência, modos, catálogo, biblioteca e fila.
- `docs/standalone-player-roadmap.md`, `docs/backlog/README.md`, `docs/backlog/0003-fase-c-interface-standalone/*`, `docs/backlog/0004-fase-d-modularizacao-limpeza-legado/*`.
- `docs/remote-player-architecture.md`, `docs/player-playback.md`, `docs/windows-native-testing.md`, `docs/windows-release-process.md`, `docs/sqlite-persistence-safety.md`, `docs/standalone-player-ui-plan.md`, `docs/standalone-one-screen-player.md`, `docs/video-library.md`, `docs/music-catalog.md`, `docs/legacy-session-compatibility.md`, `docs/round-robin-incremental.md`, `docs/cadence-reset.md`, `docs/drag-e2e-reliability.md`, `docs/licensing.md`.

## 16. Preparação documental para D4 e G — 2026-11-07

A organização documental aprovada da Fase D acrescenta D4, dedicada à auditoria e modularização das responsabilidades do Main antes da comunicação de rede da Fase G, e D5, regressão arquitetural posterior. Esta intenção explica por que a fronteira do Main merece atenção: uma futura alteração no protocolo não deve exigir mudanças em Round Robin/fila, playback, SQLite, recovery, UI ou comandos locais. É um objetivo de arquitetura, não uma garantia do código atual.

Uma leitura preparatória de `main.ts` confirma concentração de startup por modo, composição de serviços, creation/lifecycle de janelas, handlers IPC, subscriptions/event forwarding, diagnósticos e shutdown. Também confirma que as autoridades atuais são diferentes: Management mantém regras/application no Renderer e gravação transacional no Main/SQLite; Standalone tem sequência Main-side volátil; playback é coordenado por serviços atuais integrados ao host Chromium; o vídeo/UI de produção Standalone compartilham a mesma janela/WebContents. Uma conexão futura não deve criar outro playback, fila, writer ou recovery.

Handlers Player/Standalone e Welcome apresentam validações explícitas de janela, frame e/ou URL em seus caminhos observados. Parte dos handlers Management está registrada inline sem o mesmo guard explícito visível. Isso é uma inconsistência para auditoria futura, não prova de exploração. Subscriptions atuais publicam eventos para a janela; não são um contrato pronto para publicar eventos de rede. Shutdown e startup parcial dependem de ordem e ownership de recursos, portanto lifecycle exige lote e regressão próprios.

A recomendação preparatória para D4 é modularização incremental guiada por ownership e consumidores: manter `main.ts` como composition root; avaliar extração de registro IPC por domínio, composição de runtimes e coordenadores de shutdown; preservar chamadas às autoridades de operação existentes. A forma final, lista de arquivos e contratos será decidida somente na auditoria/proposta D4.1/D4.2 após D3; nenhum módulo foi extraído aqui.

O documento [`d4-main-remote-architecture-preparation.md`](d4-main-remote-architecture-preparation.md) desenvolve fatos observados, fronteiras candidatas, isolamento de transporte, comandos/eventos, segurança, logs, testabilidade, alternativas, riscos e decisões pendentes. O histórico `remote-player-architecture.md` contém referências anteriores para pairing/TLS/HTTPS/WSS que D4 deve reconciliar com o roadmap e com as aprovações de G, sem converter itens pendentes em decisões novas.

**Limites e status naquele registro preparatório:** o proprietário aprovou a filosofia C incremental da D4 e acrescentou quatro perguntas obrigatórias para D4.1/D4.2: aplicação independente de janela Renderer; padronização de segurança/autorização IPC e fronteira remota; semântica de execução/confirmados/publicação; avaliação de Outbox/Journal. Naquele momento, a preparação não concluía D4.1/D4.2 e D4.3 ainda dependia da aprovação explícita da proposta D4.2. A autoridade da fila após conexão/reconexão, conflito de controles locais/remotos, transferência de controle, estado não confirmado, quantidade de Players e retomada após desconexão prolongada permanecem reservados para G/H. Nenhuma rede ou código foi implementado naquela atualização.

## 17. Baseline da campanha D1.4 — 2026-11-07

A campanha executou compilação, suíte unitária agregada, scripts Standalone individuais, E2Es de Gestão e Standalone, recuperação, playback, release e catálogo. O runner Windows oficial passou para os modos padrão, Standalone production, Standalone integration e Player recovery, no checkout NTFS isolado. O fingerprint `f19e72704b86be85e160a8b6b00e81e2b4e40b140e2fff312d77113b50c85e8d` identifica o último snapshot de testes Windows; as atualizações documentais desta campanha ocorreram depois e não estão representadas nesse fingerprint. Os resultados por comando, alterações de teste, capturas examinadas e limitações estão registrados no [ticket D1](backlog/0004-fase-d-modularizacao-limpeza-legado/0001-d1-auditoria-reorganizacao-src.md).

O teste `player-control` não alcançou PASS: ficou sem progresso esperando a janela `player-control.html`/bridge legada, enquanto o startup Player atual abre `standalone-player.html`; a suíte atual de produção cobre a experiência ativa. A variante Windows `standalone-options` não iniciou por falha transitória de interop WSL/PowerShell, embora a alternativa Linux tenha passado. As capturas reais Linux e Windows foram abertas e inspecionadas; não houve comparação lado a lado com frames Doop ao vivo nem prova de Alt+F4/input físico. Esses pontos permanecem limitações explícitas. Uma espera ocupada no helper do adapter foi substituída por espera de evento race-safe; a suíte afetada e a agregada passaram após a mudança. Nenhuma implementação de produção, mudança de banco, V1 ou Doop foi realizada.

**Status histórico ao registrar a campanha:** aguardava avaliação do proprietário. Em 2026-11-07, o proprietário aceitou D1.4 como baseline e autorizou execução sequencial de D2 e D3; a D2 foi concluída e D3 está em validação.

## 18. Resultado da limpeza D2 — 2026-11-07

A auditoria D1 descrevia a árvore antes da limpeza. D2 removeu o shell sem startup/consumidor de runtime da implementação antiga do Player: `src/player-control-renderer.ts`, `src/player-control.html`, `src/player-control.css`, `player-control-preload.ts`, a função órfã `createPlayerControlWindow()` em `main.ts`, cópia e bundling dedicados em `scripts/copy-assets.ts`, o teste exclusivo de bundle e `tests/player-control-electron.ts`. Também foram removidos os scripts `test:e2e:player-control:*`, o modo `--player-control` do runner Windows e as expectativas de bundle ligadas à tela removida. A validação D2 (`compile`, `test:unit` e contracts Standalone) passou.

Foram preservados `ManualPlaybackService`, `PlayerPlaybackService`, `PlayerVideoWindow`, Renderer/host Chromium técnico, protocolo de mídia, biblioteca, catálogo, recovery/store, `player-ui-contracts.ts`, handlers `player:*` e a bridge tipada em `preload.ts`. Esses elementos têm uso na composição Main atual, playback/recovery, isolamento de remetente ou compatibilidade Controller/Combined; `player-playback.html/css` é host técnico, não a interface removida. A API geral ainda não mostrou consumidores Renderer atuais fora do antigo shell e permanece como compatibilidade transitória, sem sua remoção nesta etapa.

Os artefatos correspondentes em `build/` eram ignorados/gerados, não rastreados; outputs antigos foram removidos após inspeção e não são recriados pela compilação. A estrutura física de `src/` não foi reorganizada, e nenhum serviço operacional, banco, schema, dado de usuário, V1 ou Doop foi alterado. **Status quando este registro D2 foi escrito:** a regressão pós-limpeza ainda seria executada em D3; D4 ainda não tinha começado.

## 19. Encerramento da Fase D — 2026-11-07

D1–D3 estão concluídas; D4.1 foi concluída, D4.2 aprovada e D4.3 implementada nos oito lotes; D5 automatizada PASS em Linux e Windows e aprovada manualmente pelo proprietário. Em 2026-11-07, o proprietário usou o launcher oficial no Windows nativo com o código sincronizado do WSL2, verificou Reprodutor e Tudo em um, suas interfaces e funcionalidades operacionais, sem encontrar defeitos, e aprovou a D5 e a Fase D. Limitações específicas previamente classificadas `NOT RUN` permanecem assim quando não houve confirmação individual. **Fase D: CONCLUÍDA E APROVADA. Fase E: próxima, NÃO INICIADA.** Para os detalhes atuais e evidências da D4/D5, consulte [`docs/d4-main-remote-architecture-preparation.md`](d4-main-remote-architecture-preparation.md) e os tickets D4/D5.
