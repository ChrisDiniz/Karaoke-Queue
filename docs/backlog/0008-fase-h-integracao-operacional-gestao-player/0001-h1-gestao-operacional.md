# 0008/0001 — H1: Consolidação da gestão operacional

## Identificação

- Ticket: 0008/0001
- Ticket pai: 0008 — Fase H: Integração operacional Gestão + Player
- Etapa canônica: H1
- Status: Planejado / Não iniciado
- Roadmap: [Roadmap Standalone/Combined](../../standalone-player-roadmap.md)

## Objetivo

Preparar o Combined para ser o computador de Gestão na operação remota, preservando o domínio operacional atualmente atendido pelo Controller.

## Escopo

- Mesas, cantores, sessões e histórico.
- Fila inteligente, Round Robin, prioridades e posições protegidas.
- Persistência SQLite, regras de conclusão/cancelamento e recovery operacional.
- Integração dos serviços e componentes existentes necessários à Gestão.
- Preservação do domínio Controller mesmo após deixar de ser função final selecionável.

## Dependências

- Fases anteriores aprovadas, em especial limpeza controlada D2 sem remover consumidores necessários.
- Contratos e serviços de Gestão existentes inspecionados antes de alterações.
- Autorização explícita do proprietário para iniciar H1.

## Decisões aprovadas

- Gestão (Combined) mantém as funcionalidades operacionais do Controller.
- Controller independente deixa de ser função final, mas seus dados, regras e serviços necessários serão preservados.
- Uma única fila operacional e um único writer são autoridade para Gestão.
- Não alterar regras consolidadas sem requisito e autorização explícitos.

## Pendências

- A integração operacional final precisa refletir a arquitetura e os contratos aprovados para uso remoto.
- Lacunas reais encontradas durante inspeção deverão ser registradas antes de ampliar o escopo.

## Riscos

- Remoção ou duplicação de regras, histórico, estado persistido ou autoridade de fila.
- A limpeza de legado em D2 pode afetar serviços necessários se consumidores não forem mapeados.

## Critérios de conclusão

- Capacidades de Gestão listadas no escopo continuam disponíveis em Combined e usam a autoridade/persistência existentes.
- Nenhuma fila ou writer operacional concorrente é introduzido.
- Resultados e regressões relacionadas são documentados com evidências.

## Validação prevista

Testes focados de gestão, regras de fila, histórico, sessões, prioridades, persistência e recovery, ampliados somente aos consumidores realmente afetados.

## Histórico de execução

Planejado. Nenhuma implementação ou validação foi iniciada.

## Referências

- [Roadmap Standalone/Combined](../../standalone-player-roadmap.md)
- [Remote player architecture](../../remote-player-architecture.md)
- [Round Robin incremental](../../round-robin-incremental.md)
- [SQLite persistence safety](../../sqlite-persistence-safety.md)
- [Legacy session compatibility](../../legacy-session-compatibility.md)
