# 0004/0001 — D1: Auditoria e reorganização do `src`

## Identificação

- Ticket: 0004/0001
- Ticket pai: 0004 — Fase D: Auditoria, limpeza e modularização do Main
- Etapa canônica: D1
- Status: D1.1 concluída; D1.2 aprovada; D1.3 concluída — manter a estrutura atual sem movimentações; D1.4 concluída e aceita como baseline pelo proprietário.
- Roadmap: [Roadmap Standalone/Combined](../../standalone-player-roadmap.md)

## Objetivo

Auditar a estrutura real do `src`, propor uma organização tecnicamente justificada e, somente com aprovação explícita, reorganizar a estrutura de forma incremental e validá-la completamente antes da limpeza do legado.

## Escopo e subetapas

### D1.1 — Auditoria da estrutura atual

- Investigar responsabilidades reais, consumidores, imports, dependências, acoplamentos e ciclos.
- Mapear as fronteiras de Gestão e Standalone e identificar serviços compartilhados.
- Avaliar Main, Preload, IPC, renderers, UI, HTML, CSS, assets, playback, biblioteca e catálogo.
- Considerar efeitos sobre Combined e comunicação remota.

### D1.2 — Proposta de reorganização

- Documentar problemas comprovados, estrutura atual relevante e proposta de organização.
- Justificar agrupamentos por responsabilidade e avaliar imports, build, testes, empacotamento e manutenção.
- Considerar explicitamente a alternativa de manter a estrutura atual.
- Não criar pastas por estética, depósitos genéricos, duplicação de serviços ou abstrações sem necessidade demonstrada.
- **Decisão formal do proprietário — alternativa A aprovada:** manter a organização física atual de `src/`, sem mover arquivos ou criar diretórios somente por estética. Preservar a estrutura de módulos e responsabilidades.
- A alternativa B de reorganização não foi aprovada.

### D1.3 — Registro da decisão de manter a estrutura atual

- **Concluída por decisão aprovada:** registrar a alternativa A de D1.2 e manter a árvore física e os caminhos atuais.
- Nenhum arquivo foi movido, renomeado ou alterado; nenhum diretório foi criado.
- Não houve alterações em imports/exports, build, HTML/CSS, Preload, IPC ou testes.
- A modularização das responsabilidades concentradas em `main.ts` será tratada separadamente na D4.

### D1.4 — Regressão completa após a decisão de D1.3

Subetapa obrigatória após estabilizar o resultado de D1.3, inclusive quando a decisão aprovada for manter a estrutura atual.

- Inventariar todos os scripts e suítes existentes.
- Executar compilação e a suíte completa aplicável: unitários, integração e E2E.
- Priorizar Electron real e Playwright; executar o runner Windows nativo sempre que disponível e usar Linux como alternativa quando houver limitação documentada.
- Criar testes adicionais se forem identificadas lacunas relevantes.
- Corrigir regressões conhecidas e repetir as execuções necessárias antes de iniciar D2.
- A conclusão exige registrar também suítes obsoletas/não aplicáveis com evidência de substituição, indisponibilidades de ambiente e limitações de inspeção visual ou input físico; nenhum `NOT RUN` pode ser descrito como `PASS`.

## Dependências e gates

- C concluída e aprovada antes de iniciar a Fase D.
- D1.1 e D1.2 precedem qualquer movimentação do `src`.
- Aprovação explícita do proprietário é obrigatória entre D1.2 e D1.3.
- D1.4 deve ser concluída antes de D2.

## Critérios de conclusão

- Auditoria baseada em responsabilidades, consumidores e dependências verificados.
- Proposta compara reorganizar com manter a estrutura atual e registra impactos/risco.
- D1.2 tem decisão explícita do proprietário registrada; na alternativa A, D1.3 se encerra sem movimentação artificial.
- D1.4 permanece obrigatória e deve ser concluída antes de D2.

## Histórico de execução

Registro de criação do ticket: criado nesta reorganização documental conforme a estrutura aprovada. Naquele momento, a auditoria D1.1–D1.4 não havia sido iniciada e nenhuma proposta ou aprovação estrutural estava registrada.

### Auditoria e proposta D1.1–D1.2 — 2026-11-07

- **D1.1 — auditada:** inventário de módulos/consumidores, imports, fronteiras Electron, composição de playback, persistência, ciclo de vida e cobertura de testes registrado em [`docs/d1-src-audit-and-proposal.md`](../../d1-src-audit-and-proposal.md). Não foram alterados código, testes, banco, V1 ou frames Doop.
- **D1.2 — proposta apresentada, aguardando avaliação/aprovação naquele registro:** recomendação de manter a organização física atual; a auditoria não encontrou benefício suficiente para justificar movimentação nesta etapa. A alternativa de reorganização e seus custos/riscos também foram documentados.
- **D1.3 — não iniciada naquele registro.** Nenhum arquivo de `src/` foi movido ou renomeado.
- **D1.4 — não iniciada naquele registro documental.** Nenhum build ou teste havia sido executado até então; a campanha foi executada posteriormente e está registrada abaixo.
- A auditoria inicial registrou a divergência entre o relato de conclusão da Fase C e o status C9 do checkpoint. A declaração posterior do proprietário, registrada nesta atualização, encerra essa divergência documental.

### Aprovação de D1.2 e registro de D1.3 — 2026-11-07

- **D1.2 aprovada formalmente:** o proprietário aprovou a alternativa A — manter a organização física atual de `src/` e preservar seus módulos/responsabilidades.
- **D1.3 concluída:** a decisão foi registrada sem mover/renomear arquivos ou criar diretórios; a modularização de `main.ts` permanece separada na D4.
- **D1.4 planejada e não iniciada naquele momento:** a regressão completa seguia obrigatória antes de D2. A campanha ocorreu posteriormente, conforme o registro a seguir.
- O proprietário também declarou C9 e a Fase C concluídas/aprovadas; pendências mencionadas no registro inicial de D1 refletem o estado documental daquele momento.

### Complemento preparatório para a futura D4 — 2026-11-07

- A nova organização documental da Fase D acrescenta D4 (auditoria e modularização das responsabilidades do Main) e D5 (regressão arquitetural final). A auditoria preparatória e suas recomendações estão em [`docs/d4-main-remote-architecture-preparation.md`](../../d4-main-remote-architecture-preparation.md).
- O complemento registra responsabilidades atuais observadas em `main.ts`, fronteiras candidatas para separar transporte futuro de autoridades locais, riscos de lifecycle/IPC e decisões pendentes para G/H. É análise documental preparatória; não conclui D4.1 nem inicia D4.
- A aprovação de D1.2/D1.3 não inicia D1.4 nem autoriza D2, D3 ou D4. A proposta D4.2 e a implementação D4.3 mantêm seus próprios gates.

### Campanha D1.4 — 2026-11-07

- **Estado Git inicial/final:** branch `feature/remote-player-lan-integration`, HEAD `5cd541f7a7aa232d73b346e09720c1a5716b4dc7`, sem alterações staged. Na entrada já havia alterações documentais C9–C11, D1–D3, índice do backlog, arquitetura/playback/UI e roadmap, além dos documentos D1/D4 e tickets D4/D5 não rastreados; foram preservadas. Os dois arquivos de teste alterados nesta campanha foram `tests/operating-modes-electron.ts` e `tests/standalone-player-playback-adapter.test.ts`. O primeiro fingerprint do snapshot oficial Windows durante a campanha foi `054ad03bc3a334674de539a3560e3790cbef69a3fd2f591262a9375b3f3f8c59`; o fingerprint do último snapshot de testes Windows, após as alterações de teste, foi `f19e72704b86be85e160a8b6b00e81e2b4e40b140e2fff312d77113b50c85e8d`. As atualizações documentais desta campanha ocorreram depois desse runner; portanto esse fingerprint não representa o working tree documental final. Nenhum código de produção, banco, V1 ou Doop foi alterado.
- **Compilação/unitários:** `npm run compile` — PASS; `npm run test:unit` — PASS no estado final. Também foram executados individualmente os scripts `test:unit:standalone-contracts`, `runtime`, `sequence`, `interaction`, `interaction-transport`, `playback-adapter`, `options`, `ipc` e `ui`; todos PASS. O adapter foi repetido após a correção do helper de espera e passou.
- **Gestão/Controller:** `npm run test:e2e:linux` — PASS nas 12 suítes agregadas (smoke, drag-and-drop, Round Robin, cadência, persistência, sessões anteriores, encerramento, licenciamento, menu da fila, autocomplete, sidebar e diagnósticos). Complementos focados: validação IPC — PASS; multi-instância Linux/headless — PASS, com `WINDOW_MINIMIZE` não aplicável/não executado no desktop headless; modos de operação — PASS após atualizar expectativas obsoletas para a composição atual; biblioteca — PASS; catálogo — PASS. `npm run test:release-workflow` e `npm run test:catalog:sample` — PASS.
- **Player/Standalone Linux:** `test:e2e:player-playback:headless`, `test:e2e:player-recovery:headless`, `test:e2e:standalone-playback:headless`, `standalone-ipc:headless`, `standalone-exit-ipc:headless`, `standalone-integration:headless`, `standalone-ui:headless`, `standalone-options:headless`, `standalone-exit:headless` e `standalone-production:headless` — PASS. Electron real, MP4 real, Playwright e perfis/bancos temporários isolados foram usados nos E2Es indicados pelos respectivos harnesses.
- **Suíte histórica `player-control`:** suíte Player Control legada (comando removido na D2) foi iniciada e encerrada após cerca de nove minutos sem progresso (processo terminado, exit 137); a página de produção atual é `standalone-player.html`, enquanto o teste aguarda `player-control.html`/`window.karaokePlayer`. A checagem do código confirma que o startup atual chama `createStandalonePlayerWindow()` em `main.ts`; `createPlayerControlWindow()` permanece apenas como definição sem chamada. A variante Windows `--player-control` não foi iniciada porque se refere à mesma suíte/shell histórico. Classificação: **suite obsoleta para o fluxo atual; sem PASS e não usada como evidência**. A cobertura atual correspondente foi exercitada por Standalone UI/production e pelo teste de modos atualizado. Não se ocultou nem se converteu esse resultado em PASS.
- **Windows nativo:** o checkout NTFS Windows existente estava em outra branch; o preflight do runner bloqueou corretamente seu uso. Foi preparado checkout NTFS isolado a partir de bundle Git validado, sem modificar o checkout divergente. O runner oficial `test:e2e:multi-instance:windows -- --approve-untracked` passou nesse checkout, incluindo modos, migração, biblioteca, catálogo, multi-instância, minimize/restore e foco de janela. `--standalone-production`, `--standalone-integration` e `--player-recovery` passaram em execuções focadas com Electron/Node/Playwright/SQLite Windows nativos e MP4 real. `--standalone-integration` falhou inicialmente na espera ocupada do adapter; após trocar o helper por assinatura de evento com timeout limitado, passou no fingerprint final. `--standalone-options` foi tentado pelo runner oficial, mas não iniciou: a interop PowerShell/WSL falhou com `UtilBindVsockAnyPort:307: socket failed 1`. A alternativa Linux `standalone-options:headless` passou. Não se declarou Windows PASS para essa variante.
- **Alterações de teste durante a campanha:** `tests/operating-modes-electron.ts` agora verifica a janela Standalone composta, bridge restrita, estado inicial sem autoplay/fila volátil e schema de catálogo vigente, em vez do shell e schema anteriores. `tests/standalone-player-playback-adapter.test.ts` substituiu 100 voltas de `setImmediate` por assinatura race-safe de snapshot e timeout de 15 s; isso removeu uma flakiness de agendamento reproduzida no Windows sem alterar produção ou afrouxar assertions. `npm run compile`, adapter focado, integração Windows e `npm run test:unit` passaram após a alteração. Nenhum novo teste foi necessário: a suíte atual de produção já cobre os cenários críticos descritos abaixo.
- **Inspeção visual:** capturas Linux abertas e examinadas em `/tmp/karaoke-d1-4-standalone-production-linux`; capturas Windows abertas e examinadas em `/mnt/c/Users/Chris/AppData/Local/Temp/karaoke-queue-standalone-production-screenshots-17860`. Foram inspecionados vídeo sob Adicionar/Informações/Esc, Pausado/Retomando e pulsos, retorno de Próximas, fullscreen/janela, idle, countdown, código aceito/inválido, celebração, toast de fila cheia e encerramento. Capturas Gestão abertas e examinadas incluem fila, posições protegidas, congelamento, menu e sessão. Referências/descrições já registradas no plano consultado: Playing `GLd5IY2MH5`, informação `PQjsr4MODZ`, menu `KDOB_dc6LE`, saída `MdDG5yAHUb`, Pausado `ONYQ6OifFb`, Retomando `kauURA7rpT`, celebração `xH0aJd4ZwV`, countdown `1A-jEJyLia`, código inválido `h99n2h7yQj`, idle `oCIrIjb3Zc` e faixa numérica da fila `7lPOZR6Tps`. Próximas não tem frame específico documentado; o toast C11 foi aprovado sem frame. O E2E de produção confirma composição, foco após cliques e ciclos F11 via Playwright; input físico Alt+F4 e validação manual de áudio não foram comprovados. As imagens das capturas não foram comparadas lado a lado com frames Doop ao vivo nesta sessão; esse item permanece limitação explícita, sem aprovação visual do proprietário.
- **Limitações de cobertura:** o runner Windows provou foco em cenários `--approve-untracked`; o modo Standalone focado marcou `WINDOW_FOCUS NOT APPLICABLE`. F11 consecutivo e cliques foram exercitados por Playwright; não se atribui a isso prova de input físico. O seletor nativo de arquivo não é dirigido fisicamente pelo harness. Não houve comparação automatizada screenshot/golden.
- **Conclusão D1.4:** a campanha encontrou e corrigiu uma flakiness de teste, e as suítes atuais de produção passaram. Em 2026-11-07, o proprietário aceitou D1.4 como baseline com as limitações já descritas: a suíte antiga `player-control` foi classificada como obsoleta para a composição atual; `standalone-options:windows` ficou `NOT RUN` por falha de interop (`UtilBindVsockAnyPort:307`), com alternativa Linux PASS; a comparação lado a lado com Doop foi dispensada. As limitações são históricas e não bloqueiam D2, não exigem novos testes e não reabrem C9/C10.5/C11.

### Encerramento da Fase D — 2026-11-07

D1 está concluída: D1.1 auditada, D1.2 aprovada na alternativa A, D1.3 concluída sem movimentações e D1.4 aceita como baseline. As limitações D1.4 acima permanecem como histórico e não bloqueiam a conclusão da Fase D.
- **Evidências visuais:** as imagens foram geradas fora do repositório nos diretórios registrados acima e inspecionadas diretamente; não foram adicionadas ao working tree. As capturas devem ser regeneradas se os diretórios temporários expirarem.

## Referências

- [Roadmap Standalone/Combined](../../standalone-player-roadmap.md)
- [Remote player architecture](../../remote-player-architecture.md)
- [Player playback](../../player-playback.md)
- [SQLite persistence safety](../../sqlite-persistence-safety.md)
- [Preparação arquitetural Main/rede para D4 e G](../../d4-main-remote-architecture-preparation.md)
- [Windows native testing](../../windows-native-testing.md)
