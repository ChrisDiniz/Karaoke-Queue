# 0006/0001 — F1: Regressão geral após limpeza e instalador

**Status vigente — 2026-11-11: Concluído e validado pelo proprietário.** O aceite global da Fase F nesta sessão abrange esta etapa e suas subdivisões. [Encerramento consolidado e limites das evidências](../../fase-f-encerramento.md). O conteúdo abaixo preserva o planejamento e os checkpoints históricos; referências a não início ou homologação pendente estão superadas para acompanhamento, sem converter PARTIAL/NOT RUN/FAIL em PASS.

## Identificação

- Ticket: 0006/0001
- Ticket pai: 0006 — Fase F: Regressão e estabilização pós-instalação
- Etapa canônica: F1
- Status: Concluído e validado pelo proprietário (2026-11-11)
- Roadmap: [Roadmap Standalone/Combined](../../standalone-player-roadmap.md)

## Objetivo

Validar o estado integrado após a limpeza do legado e a implementação do instalador, corrigir regressões e obter aprovação explícita antes da comunicação remota.

## Escopo

- Inventariar os scripts e suítes existentes e aplicáveis no estado final de D e E.
- Executar compilação, unitários, integração e E2E relevantes, incluindo regressões dos fluxos afetados por limpeza, modos, instalação e persistência.
- Validar imports/composição, IPC, inicialização das funções, library/catalog, playback/recovery e empacotamento conforme os impactos reais.
- Priorizar Electron real/Playwright, SQLite e MP4 isolados e runner Windows nativo quando disponível.
- Corrigir regressões e criar cobertura adicional para lacunas relevantes sem enfraquecer asserções.
- Registrar como `NOT RUN` qualquer suíte obrigatória indisponível, com motivo e impacto.

## Dependências e gates

- D1–D3 concluídas e estrutura/limpeza estabilizadas.
- E1–E5 concluídas e aprovadas, incluindo instalador, função, exclusividade, manutenção e preservação de dados.
- Autorização explícita do proprietário para iniciar F1.
- F1 concluída e aprovada antes de iniciar F2.

## Critérios de conclusão

- Inventário cobre scripts e suítes aplicáveis consultados em manifests, runners e documentação.
- Regressões da limpeza/instalador foram investigadas e corrigidas; testes afetados passam no estado final.
- Testes não executados são identificados como `NOT RUN`, sem classificar Linux como validação Windows.
- Resultados e limitações ficam registrados e o proprietário aprova explicitamente avanço para F2.

## Validação prevista

Executar a suíte automatizada aplicável pós-D/E, incluindo build/compile e os testes unitários, de integração e E2E com Electron real; runner Windows nativo e validação do pacote conforme disponibilidade. Não iniciar comunicação remota nesta etapa.

## Histórico

Ticket criado nesta reorganização documental. Nenhuma regressão pós-instalador foi executada.

## Referências

- [Roadmap Standalone/Combined](../../standalone-player-roadmap.md)
- [Windows native testing](../../windows-native-testing.md)
- [Windows release process](../../windows-release-process.md)
- [SQLite persistence safety](../../sqlite-persistence-safety.md)
- [Remote player architecture](../../remote-player-architecture.md)

## Dependência F0 — registro histórico de 2026-11-10

A [F0](0000-f0-estabilizacao-critica-standalone.md) deve estar concluída e aprovada antes da execução geral de F1–F4. Esta atualização não inicia nem renumera esta etapa; as dependências sequenciais e autorizações individuais permanecem. E está encerrada por declaração do proprietário, sem converter limitações históricas em PASS.
