# 0004/0003 — D3: Regressão completa após a limpeza

## Identificação

- Ticket: 0004/0003
- Ticket pai: 0004 — Fase D: Auditoria, limpeza e modularização do Main
- Etapa canônica: D3
- Status: Concluída — campanha técnica registrada; encerramento da Fase D aprovado pelo proprietário em 2026-11-07.
- Roadmap: [Roadmap Standalone/Combined](../../standalone-player-roadmap.md)

## Objetivo

Após a conclusão de D2, executar toda a suíte automatizada existente e aplicável, corrigir regressões e preencher lacunas relevantes de cobertura. D3 deverá estar concluída antes da auditoria D4.1 e aprovada antes da implementação D4.3; a Fase E só poderá começar depois de D5, regressão arquitetural final da Fase D.

## Escopo e subetapas

### D3.1 — Inventário completo dos testes

- Consultar o `package.json`, runners e documentação vigentes para inventariar scripts e suítes reais; não presumir ou inventar nomes.
- Classificar cobertura, ambiente, requisitos de Windows/Linux/Electron/mídia/SQLite e dependências compartilhadas.
- Preparar perfis, bancos, builds e demais recursos isolados para impedir disputa entre testes concorrentes.
- Registrar previamente o plano de execução e as limitações ambientais conhecidas.

### D3.2 — Execução completa

- Executar todas as suítes automatizadas existentes e aplicáveis, incluindo compilação TypeScript, unitários, integração, regras de fila, persistência SQLite, concorrência, idempotência, playback, recovery, IPC, E2E Electron de Standalone e Gestão, licenciamento, instalação/release e runners nativos Windows.
- Usar Electron real e SQLite real nos limites críticos; navegador isolado ou mocks não substituem essas fronteiras.
- Não omitir suítes por conveniência, ignorar falhas preexistentes ou contornar runners nativos.
- Para testes obrigatórios que não puderem ser executados, registrar `NOT RUN`, motivo e impacto; não os declarar aprovados.
- Repetir obrigatoriamente, em Electron de produção com MP4 e perfil isolado, os cenários de estabilidade visual/interação estabelecidos pela baseline D1.4:
  - vídeo permanece composto e visível atrás dos painéis Adicionar, Informações e Esc;
  - cliques na janela e nos painéis não removem o foco necessário; atalhos continuam operando após cliques sucessivos;
  - F11 alterna fullscreen/janela em ciclos consecutivos sem comando intermediário e sem reiniciar/retroceder o MP4;
  - Próximas se oculta ao abrir os painéis correspondentes e retorna corretamente ao fechá-los;
  - transições Pausado e Retomando aparecem e terminam no estado esperado;
  - abrir/fechar painéis preserva o playback atual, tentativa, fila e sequência confirmada.
- Abrir e inspecionar as capturas renderizadas do Electron para os cenários acima e para estados de Gestão relevantes; assertions de DOM, IPC, métricas ou captura gerada sem inspeção visual não bastam. Comparar com frames/descrições Doop aprovados disponíveis, sem inventar frames para estados sem referência.
- Repetir no runner Windows oficial os cenários dependentes de foco/fullscreen quando o ambiente interativo permitir. Registrar separadamente eventos Playwright/CDP e input nativo confiável; se foreground/input físico não for comprovado, marcar `NOT RUN` para essa interação específica. Executar alternativas Linux quando Windows estiver indisponível, sem converter Linux em PASS Windows.

### D3.3 — Correções e cobertura adicional

- Corrigir regressões identificadas na produção.
- Adicionar testes de regressão para falhas reproduzíveis e testes adicionais quando lacunas relevantes forem encontradas nas fronteiras críticas afetadas.
- Priorizar imports/composição, IPC, modos, persistência, playback, recovery e empacotamento conforme o risco real da D1/D2.
- Preservar testes válidos, assertions e fixtures; nunca enfraquecer cobertura para obter aprovação.

### D3.4 — Reexecução e aprovação

- Reexecutar os testes que falharam, os diretamente afetados pelas correções e as suítes necessárias para confirmar o código final sem alterações posteriores não verificadas.
- Consolidar resultados, limitações, evidências e casos `NOT RUN`.
- Obter aprovação explícita do proprietário para D3 e, antes da implementação D4.3, obter a aprovação separada da proposta D4.2. A Fase E depende de D5 concluída, validada e aprovada.

## Dependências

- D1/D2 concluída: estrutura do `src/` estabilizada e limpeza controlada encerrada.
- A campanha completa deve ocorrer sobre o estado final da D1/D2.
- Correções após a campanha obrigam a reexecução dos testes afetados e a confirmação da regressão completa aplicável.
- D3 deve estar concluída antes de iniciar D4.1 e aprovada antes de implementar D4.3. Ela não aprova a extração de módulos nem substitui o gate de aprovação da proposta D4.2.

## Decisões aprovadas

- A D3 exige a suíte automatizada completa existente e aplicável, não apenas testes focados.
- A aprovação D3 é um dos gates para implementar D4.3; não autoriza essa implementação sem a aprovação separada da proposta D4.2.
- A disponibilidade de scripts, ambientes e suítes será verificada durante D3.1; nomes não são presumidos neste planejamento.
- D3 não substitui as campanhas prolongadas de 8, 12 e 24 horas pertencentes à H6.
- Falhas ou bloqueios de ambiente devem permanecer visíveis; não se altera expectativa de teste para mascarar regressões.

## Pendências

- Avaliação e aprovação explícita do proprietário sobre o relatório de execução D3 antes de iniciar D4. A execução não inicia D4 automaticamente.
- As interações físicas F11 e Alt+F4 não foram comprovadas pelo runner nativo e permanecem `NOT RUN`; os fluxos equivalentes automatizados/Window close foram cobertos nos limites descritos abaixo.
- Áudio audível não foi validado; avanço do `currentTime` comprova progresso de reprodução do MP4, não saída sonora.

## Riscos

- A reorganização pode afetar caminhos de import, assets, entrypoints e descoberta de testes.
- Testes podem disputar perfis, SQLite, builds ou recursos compartilhados se não forem isolados.
- Testes Windows, Electron ou mídia podem não estar disponíveis em todos os ambientes; isso reduz o alcance da validação e deve ser registrado como `NOT RUN`, sem declarar D3 integralmente aprovada.
- Correções tardias podem invalidar evidências anteriores se a campanha final não for repetida no estado atualizado.

## Critérios de conclusão

- O inventário D3.1 cobre todos os scripts e suítes encontrados nos manifests, runners e documentação consultados.
- Todas as suítes obrigatórias e aplicáveis foram executadas; cada indisponibilidade tem registro `NOT RUN` com causa e impacto.
- Falhas foram investigadas e corrigidas na implementação, e lacunas relevantes receberam cobertura proporcional sem enfraquecer testes existentes.
- As suites falhas/afetadas e a regressão completa aplicável passaram no estado final, ou D3 permanece sem aprovação com limitações explicitadas.
- Os seis cenários visuais/de foco/playback desta etapa têm evidência de Electron real, capturas abertas e inspeção registrada, além dos resultados de testes automatizados associados.
- Resultados automatizados e limitações estão documentados, e o proprietário aprovou explicitamente D3. A implementação D4.3 depende também da aprovação da proposta D4.2; o avanço para E depende da conclusão e aprovação de D5.

## Execução e evidências — 2026-11-07

### Estado validado

- Branch `feature/remote-player-lan-integration`; HEAD `5cd541f7a7aa232d73b346e09720c1a5716b4dc7`.
- O runner Windows validou o snapshot do código com fingerprint `abade6dc7f6f55830119283dc4650fe227414bb2ad0082be2e75183524cfae5d`. A documentação deste registro foi atualizada depois do snapshot; não houve alteração de código de produção após essa validação.
- Os artefatos de teste, perfis e SQLite foram isolados conforme cada suíte. O runner Windows usou checkout NTFS próprio, Node/npm/Electron/Playwright nativos e MP4 temporário real.

### Compilação, unitários e contratos

- `npm run compile` — PASS.
- `npm run test:unit` — PASS, incluindo regras de fila, aplicação, persistência/migrações, modos, biblioteca, catálogo, playback, Chromium, recovery, UI e testes unitários do runner. Repetido ao fechar a documentação e a revisão final em 2026-11-07 — PASS novamente.
- `npm run test:unit:standalone-contracts`, `:standalone-runtime`, `:standalone-sequence`, `:standalone-interaction`, `:standalone-interaction-transport`, `:standalone-playback-adapter`, `:standalone-options`, `:standalone-ipc` e `:standalone-ui` — PASS, cada comando executado individualmente além do agregador.
- `npm run test:catalog:sample` — PASS com CSV real somente leitura: 13.988 registros, 2 sem artista, 7 sem título, 21 vídeos e 21 associações; banco temporário isolado.
- `npm run test:release-workflow` — PASS (2 testes). `node --check tests/packaged-windows-smoke.cjs` — PASS.

### Gestão / Controller / Combined em Linux

- `npm run test:e2e:linux` — PASS no estado final. Suítes incluídas: `electron-smoke`, `drag-electron`, `round-robin-electron`, `debut-cadence-electron`, `persistence-electron`, `previous-sessions-electron`, `session-close-electron`, `licensing-electron`, `queue-menu-electron`, `singer-autocomplete-electron`, `sidebar-display-name-electron` e `diagnostics-electron`.
- Complementos focados — PASS: `test:e2e:ipc-validation:headless`, `test:e2e:multi-instance:headless`, `test:e2e:operating-modes:headless`, `test:e2e:video-library:headless` e `test:e2e:music-catalog:headless`.
- O primeiro agregado teve um timeout transitório no encerramento de `diagnostics-electron`; a suíte isolada passou e o agregado completo foi repetido com PASS. Não foi alterado timeout para mascarar a ocorrência.
- Cobertura e capturas inspecionadas incluem fila, ordem, fixações/posições protegidas, Round Robin, sessão encerrada e menu contextual. Evidências em `/tmp/karaoke-smoke-evidence-qSS2e4`, `/tmp/karaoke-rr-evidence-haCu8z`, `/tmp/karaoke-previous-sessions-shots-1794045308556` e `/tmp/karaoke-queue-menu-e2e-Ss3FL4/screenshots`.

### Standalone em Linux e inspeção visual

- PASS individual: `test:e2e:player-playback:headless`, `test:e2e:player-recovery:headless`, `test:e2e:standalone-playback:headless`, `test:e2e:standalone-ipc:headless`, `test:e2e:standalone-exit-ipc:headless`, `test:e2e:standalone-integration:headless`, `test:e2e:standalone-ui:headless`, `test:e2e:standalone-options:headless`, `test:e2e:standalone-exit:headless` e `test:e2e:standalone-production:headless`.
- O E2E de produção usou Main, Preload, IPC e Electron reais, MP4 válido e perfil/SQLite isolados. As assertions verificaram avanço do playback e preservação dos contratos de saída C9 e fila cheia C11.
- Capturas reais abertas e examinadas em `/tmp/karaoke-queue-standalone-production-screenshots-207553/` (Linux) e `C:\Users\Chris\AppData\Local\Temp\karaoke-queue-standalone-production-screenshots-26612` (Windows). Foi observado o vídeo por trás de Adicionar, Informações e Esc; pausa e retomada; retorno da fila Próximas; toast C11 sobre o vídeo; fullscreen; idle; countdown; celebração; código inválido; e modal C9. As capturas e asserts não comprovam áudio audível. A comparação com Doop não foi exigida nesta etapa.

### Windows nativo, build e pacote

- `npm run test:e2e:multi-instance:windows -- --approve-untracked --standalone-production` — PASS pelo runner oficial, em checkout NTFS isolado `C:\Users\Chris\source\karaoke-queue-d2-d3-final-20261107`; fingerprint `abade6dc7f6f55830119283dc4650fe227414bb2ad0082be2e75183524cfae5d`; relatório final `WINDOWS REPORT PASS` em `/tmp/karaoke-queue-d3-windows-final.log`.
- O runner instalou dependências Windows nativas, compilou, executou unitários relevantes e E2E Standalone de produção com MP4 real, SQLite/perfil isolado, recuperação, limite C11, modal nativo de confirmação C9, fullscreen automatizado e limpeza sem processo Electron residual. `WINDOW_FOCUS` não se aplicava ao modo focado.
- F11 via `SendInput` foi tentado, mas o Chromium não recebeu keydown confiável apesar do foco solicitado; a interação física ficou `NOT RUN`. O F11 via Playwright/CDP alternou fullscreen/janela em ciclos consecutivos. `Alt+F4` via `SendInput` não gerou fechamento da `BrowserWindow` e ficou `NOT RUN`; `SC_CLOSE` foi exercitado e o fluxo de modal, cancelamento e confirmação passou. Isso não é relatado como equivalência a Alt+F4 físico.
- `npm.cmd run build:windows` e `npm.cmd run verify:windows-build` — PASS no checkout NTFS; pacote unsigned como configurado, `Karaoke-Queue-Setup-0.5.0-x64.exe`, `app.asar` com 84 arquivos, `node:sqlite` e ícone válidos.
- `node tests/packaged-windows-smoke.cjs "dist/win-unpacked/Karaoke Queue.exe"` — PASS após corrigir uma fixture de teste: perfil descartável agora inicia em Controller para alcançar a superfície operacional real, validando bridges Renderer/Preload/IPC, escrita/leitura SQLite e persistência após restart. A primeira tentativa expirou porque o perfil limpo abria Welcome e o teste aguardava bridges de Controller; nenhuma alteração de produção foi necessária.
- `npm run build:windows` no ambiente Linux compilou, mas o electron-builder não pôde baixar dependência por DNS (`getaddrinfo EAI_AGAIN github.com`). O build nativo Windows acima passou; falha Linux é ambiental, não reportada como falha do produto.
- A tentativa Windows inicial, antes da correção, revelou que `verifyBuildOutput` mantinha outputs antigos do shell na lista de arquivos esperados. A lista ativa foi corrigida para verificar apenas o manifesto atual e o teste do runner agora afirma que outputs legados não são requeridos. Unitários e runner Windows oficial foram repetidos e passaram.

### Cobertura, limites e revisão

- A suíte `player-control-electron` foi removida de D2 por depender exclusivamente do shell antigo já removido. Os serviços técnicos compartilhados continuam cobertos pelos unitários e E2Es Standalone atuais; não foi removida cobertura de um consumidor ativo.
- Nenhum teste comportamental novo do Standalone foi necessário: os cenários visuais/foco/playback priorizados já estavam no E2E de produção e foram exercitados; a adição automatizada desta execução foi a asserção unitária do runner sobre o manifesto sem o shell legado. `tests/packaged-windows-smoke.cjs` recebeu somente inicialização explícita da fixture descartável no modo Controller.
- `NOT RUN`: entrada física F11 e Alt+F4 (limites reportados acima); áudio audível; instalação interativa do NSIS; comparações Doop. A variante Windows específica de Options que falhou por interop no D1.4 não foi reaberta; a alternativa Linux e a produção Windows cobriram a matriz aplicável acordada.
- Revisões independentes de arquitetura, concorrência, segurança e QA foram consultadas: confirmaram remoção restrita ao shell sem consumidor, preservação das autoridades de fila/persistência/playback, manutenção das fronteiras IPC/Preload e suficiência da matriz ativa atual. Nenhum risco novo de produto foi identificado.
- Sem defeito conhecido pendente. Os problemas observados foram um timeout transitório de encerramento em uma execução do agregado Linux (repetido com PASS), inventário desatualizado de outputs do runner (corrigido e retestado) e fixture de smoke empacotado que esperava Controller em perfil Welcome (corrigida e retestada).
- As limitações físicas acima são registradas como limites da automação, não como PASS; o relatório mantém distinção entre teste funcional, reprodução MP4, inspeção visual e input nativo.

### Resultado e gate

A campanha técnica aplicável de D3 foi executada após a estabilização de D2. Suítes Linux, runner oficial Windows, produção Electron com MP4/SQLite isolados, build/verificação do pacote e inspeções visuais terminaram com PASS conforme discriminado; a repetição final de `npm run test:unit` também passou. As limitações físicas específicas acima permanecem `NOT RUN` onde a evidência não as comprova. O proprietário encerrou e aprovou a Fase D em 2026-11-07, incluindo a conclusão de D3; esta aprovação global não altera os resultados individuais registrados nem converte limitações em PASS. A Fase E continua não iniciada.

## Histórico de execução

D3 iniciou imediatamente após a estabilização da D2, conforme autorização sequencial do proprietário em 2026-11-07. A execução técnica consolidada em 2026-11-07 não inicia D4 nem presume a aprovação explícita do proprietário.

## Referências

- [standalone-player-roadmap.md](../../standalone-player-roadmap.md)
- [windows-native-testing.md](../../windows-native-testing.md)
- [sqlite-persistence-safety.md](../../sqlite-persistence-safety.md)
- [remote-player-architecture.md](../../remote-player-architecture.md)
- [player-playback.md](../../player-playback.md)
- [Preparação arquitetural Main/rede para D4 e G](../../d4-main-remote-architecture-preparation.md)
