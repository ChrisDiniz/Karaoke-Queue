# 0004/0005 — D5: Regressão arquitetural final

## Identificação

- Ticket: 0004/0005
- Ticket pai: 0004 — Fase D: Auditoria, limpeza e modularização do Main
- Etapa canônica: D5
- Status: Automatizada PASS; validação manual aprovada pelo proprietário; D5 e Fase D concluídas em 2026-11-07.
- Roadmap: [Roadmap Standalone/Combined](../../standalone-player-roadmap.md)

## Objetivo

Validar o estado final após D4.3, incluindo comportamento de Gestão/Combined, Standalone, Main/Preload/IPC, reprodução, persistência, lifecycle e empacotamento afetado. D5 combina testes de regras com validação das superfícies Electron reais; PASS de DOM ou IPC isolado não demonstra correção visual nem de foco.

## Escopo de regressão

### Compilação, regras e integração

- Consultar `package.json`, `tsconfig.json`, workflows, runners e documentação vigentes; atualizar o inventário de D1/D3 para comandos realmente disponíveis no início de D5.
- Executar `npm run compile` e `npm run test:unit`, além de suítes focadas nos módulos extraídos e seus consumidores.
- Incluir regras de fila, Round Robin/cadência/prioridades, persistência, transações, recovery, biblioteca, catálogo, modos, playback, sequência Standalone, limite 30, FIFO/LIFO, idempotência e IPC.
- Usar `npm run test:e2e:linux` somente como a suíte Linux definida por seu runner; ela não substitui os E2E Standalone que seu escopo não inclui.

### Electron de produção, Main/Preload/IPC e UI

- Executar E2Es de Gestão e Standalone que exercitem Main, Preload, IPC validado, services reais e perfis temporários.
- Repetir o E2E de produção Standalone com MP4 real e armazenamento SQLite/perfil isolado; validar playback, composição no mesmo `WebContents`, panels, teclado, F11, foco, sequência, limite de pendências e shutdown/recovery.
- Validar os fluxos de Gestão com SQLite isolado: sessão, fila, regras, histórico, persistência e fechamento/recovery conforme os módulos alterados.
- Capturar as superfícies reais após mudanças de composição. Inspecionar screenshots visualmente e comparar dimensões/estados relevantes; captura automatizada sem comparação visual não é prova de aparência.
- Verificar foco e comandos após cliques sucessivos, painéis Add/Info/Esc durante playback, sequência Próximas ocultando/retornando, transições Pausado/Retomando e fullscreen sem comandos intermediários.

### Windows, empacotamento e validação humana

- Para comportamento Windows/Electron/mídia, usar o runner oficial em checkout NTFS com Node/Electron/Playwright nativos, perfil e bancos temporários; seguir `docs/windows-native-testing.md` e registrar fingerprint válido.
- Executar validação de empacotamento/artefato quando os caminhos de build, Preload, assets ou electron-builder forem afetados; distinguir build de desenvolvimento de execução empacotada.
- Registrar `NOT RUN` para requisitos sem ambiente, MP4 ou runner disponível; não declarar PASS Windows sem execução nativa verificada.
- Separar a evidência automatizada da inspeção manual de aparência e de interações que o harness não envia de modo confiável, como input físico de F11/Alt+F4 ou diálogo nativo. A aprovação visual/produto permanece do proprietário quando requerida.

## Matriz mínima

| Superfície | Evidência requerida | Limite que precisa ser registrado |
|---|---|---|
| TypeScript/assets | `npm run compile`; caminhos de bundles/HTML/CSS e Preload presentes no build | Compilar não prova que o pacote abre cada superfície |
| Regras Gestão/Combined | Unitários e integrações de application/persistência; testes de fila, Round Robin, pins, sessões, histórico | Não substitui fluxo de janela Electron e gravação real |
| Sequência Standalone | Contratos/runtime/sequence/adapter/options/IPC, incluindo FIFO/LIFO, teto 30 e dedupe | Sequência é volátil e independente da fila Gestão |
| IPC de produção | Electron real, Preload restrito, sender/frame/documento e payloads inválidos | Teste isolado de bridge não prova composição visual |
| Playback e superfície | Main real + Chromium + MP4 externo, progressão/pausa/stop/EOF e screenshots inspecionadas | `currentTime` prova avanço do elemento, não áudio audível em hardware |
| Foco e teclado | Playwright + Electron para cliques/teclado/foco; fullscreen e painéis na superfície real | Registrar separadamente qualquer input físico não exercitado |
| Persistência/recovery | SQLite e `userData` isolados, restart/shutdown/recovery e estado confirmado | Não usar perfis operacionais do proprietário |
| Windows nativo | Runner oficial, NTFS, hash/fingerprint válido, processos limpos | WSL/Linux não equivale à execução Windows |
| Empacotamento | Configuração de release, paths de artefato e smoke empacotado quando pertinente | Resultado de compile/build não equivale a instalação/uso físico |
| Rede futura | Nenhum teste de transporte nesta etapa, pois G implementa a comunicação | Testes de conexão, TLS, pairing e falhas reais pertencem a G |

## Scripts existentes para inventariar na entrada de D5

Os scripts abaixo existem no `package.json` consultado nesta preparação. Confirmar seus nomes e composição novamente ao iniciar D5, pois a reorganização pode atualizar os runners.

- Base: `npm run compile`, `npm run test:unit`, `npm run test:release-workflow`.
- Unitários Standalone: `npm run test:unit:standalone-contracts`, `npm run test:unit:standalone-runtime`, `npm run test:unit:standalone-sequence`, `npm run test:unit:standalone-interaction`, `npm run test:unit:standalone-interaction-transport`, `npm run test:unit:standalone-playback-adapter`, `npm run test:unit:standalone-options`, `npm run test:unit:standalone-ipc` e `npm run test:unit:standalone-ui`.
- Gestão/Controller E2E agregados: `npm run test:e2e:linux`; o runner Linux e sua lista estão em `scripts/run-e2e-linux.cjs` e não incluem a campanha Standalone completa.
- Electron focado: suítes de persistência, IPC, modos, biblioteca, catálogo, playback/recovery, fila/Round Robin/cadência/sessões e os E2Es `test:e2e:standalone-*`; executar `npm run test:e2e:standalone-production:headless` com MP4 externo `01001.mp4` e perfil/SQLite temporários.
- Windows nativo: `npm run test:e2e:multi-instance:windows -- --approve-untracked --standalone-production`, pelo runner oficial em checkout NTFS; selecionar outros modos do runner conforme impacto e critérios vigentes.
- Build/artefato: `npm run build:windows`, `npm run verify:windows-build` e `npm run test:release-workflow`; considerar o `tests/packaged-windows-smoke.cjs` invocado pelo workflow CI quando paths/Preload/assets/pacote forem afetados.

Os nomes são evidência dos scripts disponíveis nesta auditoria, não resultados de execução. O runner oficial deve ser revalidado contra `docs/windows-native-testing.md`; `NOT RUN` mantém-se visível quando a infraestrutura não estiver disponível.

## Sequência proposta

1. Registrar commit/working tree autorizados, matriz de impacto D4.3 e recursos isolados para testes.
2. Compilar e executar testes unitários/integrados e testes focados de cada lote D4.3.
3. Executar regressão de Gestão e Standalone em Electron real; inspecionar logs, eventos e capturas relevantes.
4. Executar runner Windows oficial e validação de pacote quando aplicável aos caminhos alterados.
5. Corrigir defeitos comprovados em etapa autorizada, repetir testes afetados e a campanha completa aplicável no estado final.
6. Registrar resultados, capturas, limitações, casos `NOT RUN`, revisão humana pendente e obter aprovação explícita de D5/Fase D antes de E.

## Dependências e gates

- D4.3 concluída e estabilizada; nenhuma alteração posterior sem validação correspondente.
- A matriz D1.4/D3 e os scripts vigentes devem ser reavaliados para considerar os módulos e consumidores alterados.
- Cada falha deve ser investigada; teste válido, assertion ou fixture não pode ser removido/enfraquecido para obter PASS.
- D5 concluída, tecnicamente validada e aprovada pelo proprietário é gate obrigatório antes de iniciar a Fase E.

## Lacunas conhecidas nesta preparação

- O E2E de produção Standalone captura screenshots e verifica estados DOM/CSS, janela, playback e IPC, mas não executa comparação automatizada de pixels contra Doop.
- Testes Playwright não equivalem a validação de todas as entradas físicas do Windows, escalas de monitor, diálogos nativos ou áudio audível.
- `npm run test:e2e:linux` não inclui por si só a campanha Standalone completa; runners e suítes adicionais precisam ser convocados explicitamente.
- A existência de testes reais de rede, TLS, pareamento, perda/duplicação/ordenação e múltiplos dispositivos pertence à Fase G; D5 não pode simular essa validação como se fosse implementação.

## Histórico

Registro de planejamento anterior à execução; resultados atuais abaixo o substituem sem apagar o plano aprovado.

## Resultado da campanha D5 — 2026-11-07

### Baseline

- Branch `feature/remote-player-lan-integration`; HEAD `5cd541f7a7aa232d73b346e09720c1a5716b4dc7`.
- Snapshot oficial Windows: fingerprint `e55833dc541c0c65c0265e1795c14a2956580c675e042b1d3ce9933c170e3033`, 259 arquivos. Working tree preexistente preservado; nenhum commit criado.
- MP4 reais: `01001.mp4` e `01002.mp4` em `C:\Users\Chris\Documents\Video musicas e catalogo`. Perfis e bancos de teste foram temporários/isolados.

### Compilação, unitários e release

- `npm run compile` — **PASS** (repetido nos agregadores Linux, runner Windows nativo e build Windows).
- `npm run test:unit` — **PASS**.
- Cada script Standalone ativo (`contracts`, `runtime`, `sequence`, `interaction`, `interaction-transport`, `playback-adapter`, `options`, `ipc`, `ui`) — **PASS individual**.
- `npm run test:release-workflow` — **PASS**, 2/2 testes de configuração/fluxo.
- Suítes focadas dos dez arquivos D4 (IPC Player/policy/Controller, window factories, media runtime, shutdown, Management close/host/IPC/client) — **PASS**, 10 arquivos.

### E2E Linux / Electron

- `npm run test:e2e:linux` — **PASS**: `electron-smoke`, `management-legacy-import-electron`, `drag-electron`, `round-robin-electron`, `debut-cadence-electron`, `persistence-electron`, `previous-sessions-electron`, `session-close-electron`, `licensing-electron`, `queue-menu-electron`, `singer-autocomplete-electron`, `sidebar-display-name-electron` e `diagnostics-electron`.
- Complementos focados — **PASS individual**: `video-library`, `music-catalog`, `player-playback`, `player-recovery`, `standalone-playback`, `standalone-ipc`, `standalone-exit-ipc`, `standalone-integration`, `standalone-ui`, `standalone-options`, `standalone-exit`, `operating-modes`, `ipc-validation`, `multi-instance` e `standalone-production`.
- A primeira execução de `player-playback` numa sequência em lote foi interrompida no wrapper enquanto o teste aguardava EOF natural. Reexecutada isoladamente, passou após observar EOF real de `01001.mp4` em 199 s; não há falha de produto pendente.
- E2Es de Gestão usaram Electron real, Main/Preload/IPC de produção e SQLite temporário. O teste IPC verificou payloads inválidos sem alteração das linhas persistidas, reload sem nova sessão/revisão e restart com recuperação.
- Host Gestão sem janela: testes diretos de `MainManagementHost` com SQLite isolado validaram inicialização única, snapshots DTO sem referências mutáveis, falha de persistência sem publicação/revisão, retry, dedupe após resultado não observado, mutações concorrentes e drain no fechamento. IPC complementar cobriu validação/rejeição sem efeitos.

### E2E Windows e pacote

- Runner oficial `npm run test:e2e:multi-instance:windows -- --approve-untracked` — **PASS nativo** em checkout NTFS `C:\Users\Chris\source\karaoke-queue-d2-d3-final-20261107`, Node `v24.11.0`, npm `11.6.1`, Electron/Playwright Windows. Snapshot/fingerprint validados; migration, operating-mode, video-library e music-catalog unitários; multi-instance, operating-modes, video-library e music-catalog Electron aprovados. `WINDOW_MINIMIZE` e restore/show/foco observados; sem processos residuais.
- Runner oficial `npm run test:e2e:multi-instance:windows -- --approve-untracked --standalone-production` — **PASS nativo** com Main `build/main.js`, Preload/IPC de produção, MP4 real, perfil SQLite isolado, recovery/shutdown, painéis, avanço de `currentTime`, limite 30/toast e ciclos fullscreen por Playwright; cleanup confirmado. `WINDOW_FOCUS NOT APPLICABLE` é a classificação do modo focado; foco de janelas foi validado no modo multi-instance.
- `npm run build:windows` — **PASS**, gerou pacote NSIS x64 local sem publicar/instalar. `npm run verify:windows-build` — **PASS**, 97 arquivos empacotados, Main/Preload/Renderer/assets verificados e SQLite embutido. `node.exe tests/packaged-windows-smoke.cjs "dist/win-unpacked/Karaoke Queue.exe"` — **PASS**, first-run trial, escrita/leitura SQLite via IPC de produção e persistência após restart com perfil descartável.
- `npm ci` reportou 6 vulnerabilidades moderadas no inventário e dependências depreciadas; dependências não foram alteradas nem `npm audit fix` executado nesta etapa.

### Capturas e inspeção visual

- Capturas Linux: `/tmp/karaoke-queue-standalone-production-screenshots-538606/`.
- Capturas Windows nativas: `C:\Users\Chris\AppData\Local\Temp\karaoke-queue-standalone-production-screenshots-13888\`.
- Capturas de Gestão: `/tmp/karaoke-smoke-evidence-DGtRRw/`, `/tmp/karaoke-rr-evidence-XgQn1o/` e `/tmp/karaoke-persistence-984LNa/`.
- Capturas foram abertas e examinadas. Em Linux e Windows, o MP4 permaneceu visível sob Adicionar, Informações e Esc; Próximas reapareceu ao fechar painéis; Pausado/Retomando e toast C11 foram vistos; capturas fullscreen foram examinadas. Também foram inspecionados sessão, fila Round Robin, posições protegidas e recuperação persistida de Gestão. A inspeção não equivale à aprovação visual do proprietário nem a comparação Doop.
- `currentTime` e EOF comprovam reprodução pelo elemento Chromium; **não comprovam áudio audível em hardware**.

### Validação manual do proprietário e limites específicos

- **Launcher manual após D4.3 — verificação parcial, não aprovação manual:** em 2026-11-07 o snapshot do working tree sincronizou para NTFS com fingerprint `53fb4de85bbe577637f92faced3a6709a52b434e681442a88e36325bdf19991d`; `npm run compile` Windows passou e o worker informou `MANUAL LAUNCH PASS` para `package.json.main` (`build/main.js`). Electron PID 24584 permaneceu aberto pelo executável do checkout e perfil vazio `E:\KaraokeQueue\manual-windows\profiles\fresh-20261107-211129-236f9af2`; o perfil não tinha `operating-mode.json`, banco operacional nem configuração de biblioteca. O modo não foi escolhido. A coordenação WSL/PowerShell não produziu o `WINDOWS MANUAL LAUNCH PASS` final e precisou ser interrompida após a janela de espera; portanto o launcher completo não recebe PASS nesta execução. O processo Electron de produção foi confirmado ativo e deixado aberto para validação do proprietário. Esta ocorrência não aprova os itens manuais abaixo.
- **Aprovação manual global — PASS, informada pelo proprietário em 2026-11-07:** o proprietário executou a aplicação real no Windows nativo pelo launcher oficial `standalone-manual-windows.ps1`, com o código sincronizado do WSL2. Verificou os modos Reprodutor (Standalone) e Tudo em um (Combined), suas interfaces e funcionalidades operacionais, e não encontrou defeitos. Essa validação manual global foi aceita como aprovação de D5 e da Fase D.
- **Limites físicos individuais sem confirmação separada:** a aprovação global acima não altera a evidência por cenário. Permanecem sem PASS individual registrado input físico F11/Alt+F4, diálogo nativo de seleção de arquivos e confirmação de áudio audível. A lista abaixo preserva os cenários manuais relevantes; não representa bloqueio da aprovação global da Fase D.
- **Cenários manuais registrados:**
  - Gestão/Combined: confirmar inicialização e operação normal.
  - Fila: adicionar, remover, arrastar itens e alterar posições; confirmar persistência e ordem.
  - Round Robin: observar distribuição e avanço entre mesas.
  - Sessões: iniciar, concluir e cancelar; conferir histórico e persistência.
  - Reanexar/recarregar o Renderer e confirmar que a inicialização e as sessões não são duplicadas.
  - Reiniciar o aplicativo e confirmar que os dados permanecem preservados.
  - Player: reproduzir MP4 real, ouvir áudio, pausar/retomar e abrir/fechar painéis durante a reprodução.
  - Usar teclado físico para F11 consecutivo e Alt+F4.
  - Abrir o diálogo nativo de seleção de arquivos.
- Playwright exercitou teclas e ciclos F11 automatizados; isso não substitui input físico. A inspeção de capturas automatizadas permanece evidência técnica separada da aprovação manual global informada acima.
- Sem comparação de pixels com Doop: D4 não alterou layout, cópias ou estilo; as capturas de produção foram inspecionadas para regressão de composição.
- **D5 automatizada: PASS. Validação manual e aprovação do proprietário: PASS, 2026-11-07. Fase D: CONCLUÍDA E APROVADA. Fase E: NÃO INICIADA.**

## Referências

- [Roadmap Standalone/Combined](../../standalone-player-roadmap.md)
- [Auditoria D1 e matriz de regressão inicial](../../d1-src-audit-and-proposal.md)
- [Preparação arquitetural Main/rede para D4 e G](../../d4-main-remote-architecture-preparation.md)
- [Windows native testing](../../windows-native-testing.md)
- [SQLite persistence safety](../../sqlite-persistence-safety.md)
- [Arquitetura Remote Player](../../remote-player-architecture.md)
- [Player Playback](../../player-playback.md)
