# 0004/0003 — D3: Regressão completa após a limpeza

## Identificação

- Ticket: 0004/0003
- Ticket pai: 0004 — Fase D: Modularização e limpeza do legado
- Etapa canônica: D3
- Status: Planejado / Não iniciado
- Roadmap: [Roadmap Standalone/Combined](../../standalone-player-roadmap.md)

## Objetivo

Após a conclusão de D2, executar toda a suíte automatizada existente e aplicável, corrigir regressões e preencher lacunas relevantes de cobertura antes de iniciar a Fase E.

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

### D3.3 — Correções e cobertura adicional

- Corrigir regressões identificadas na produção.
- Adicionar testes de regressão para falhas reproduzíveis e testes adicionais quando lacunas relevantes forem encontradas nas fronteiras críticas afetadas.
- Priorizar imports/composição, IPC, modos, persistência, playback, recovery e empacotamento conforme o risco real da D1/D2.
- Preservar testes válidos, assertions e fixtures; nunca enfraquecer cobertura para obter aprovação.

### D3.4 — Reexecução e aprovação

- Reexecutar os testes que falharam, os diretamente afetados pelas correções e as suítes necessárias para confirmar o código final sem alterações posteriores não verificadas.
- Consolidar resultados, limitações, evidências e casos `NOT RUN`.
- Obter aprovação explícita do proprietário antes de avançar para a Fase E.

## Dependências

- D1/D2 concluída: estrutura do `src/` estabilizada e limpeza controlada encerrada.
- A campanha completa deve ocorrer sobre o estado final da D1/D2.
- Correções após a campanha obrigam a reexecução dos testes afetados e a confirmação da regressão completa aplicável.

## Decisões aprovadas

- A D3 exige a suíte automatizada completa existente e aplicável, não apenas testes focados.
- A disponibilidade de scripts, ambientes e suítes será verificada durante D3.1; nomes não são presumidos neste planejamento.
- D3 não substitui as campanhas prolongadas de 8, 12 e 24 horas pertencentes à H6.
- Falhas ou bloqueios de ambiente devem permanecer visíveis; não se altera expectativa de teste para mascarar regressões.

## Pendências

- Inventariar scripts, suítes e runners reais ao iniciar D3.1.
- Determinar disponibilidade dos ambientes nativos e requisitos de mídia conforme esse inventário.
- Lacunas de cobertura só serão definidas após os resultados da auditoria e da campanha.

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
- Resultados automatizados e limitações estão documentados, e o proprietário aprovou explicitamente o avanço para a Fase E.

## Validação prevista

Campanha documentada em D3.1; execução integral das suítes existentes e aplicáveis em D3.2; regressões novas e correções em D3.3; reexecução e revisão do estado final em D3.4. Consultar `package.json`, runners e documentação de testes durante a etapa, sem executar esta campanha agora.

## Histórico de execução

Planejado / Não iniciado. Nenhuma execução ou aprovação de D3 ocorreu nesta atualização documental.

## Referências

- [standalone-player-roadmap.md](../../standalone-player-roadmap.md)
- [windows-native-testing.md](../../windows-native-testing.md)
- [sqlite-persistence-safety.md](../../sqlite-persistence-safety.md)
- [remote-player-architecture.md](../../remote-player-architecture.md)
- [player-playback.md](../../player-playback.md)
