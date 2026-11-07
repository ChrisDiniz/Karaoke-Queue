# 0006/0003 — F3: Atualizações e migração

## Identificação

- Ticket: 0006/0003
- Ticket pai: 0006 — Fase F: Regressão e estabilização pós-instalação
- Etapa canônica: F3
- Status: Planejado
- Roadmap: [Roadmap Standalone/Combined](../../standalone-player-roadmap.md)

## Objetivo

Validar update, reinstalação e alteração de função com preservação de dados e recuperação.

## Escopo

- Testar bancos, configurações, atalhos e perfis anteriores.
- Investigar falhas e rollback sem apagar dados.

## Decisões aprovadas

- Não presumir conversão automática de bancos ou fusão de perfis.

## Pendências

- Depende dos fluxos instalador/manutenção D.

## Riscos

- Atualizações parciais e mudança de userData podem tornar dados inacessíveis ou inconsistentes.

## Histórico de execução

Planejado / Não iniciado. Nenhuma execução iniciada.

## Validação

Casos reais Windows para atualização, reinstalação, mudança de função e reinício/recuperação.

## Referências

- [standalone-player-roadmap.md](../../standalone-player-roadmap.md)
- [sqlite-persistence-safety.md](../../sqlite-persistence-safety.md)
- [legacy-session-compatibility.md](../../legacy-session-compatibility.md)
- [windows-release-process.md](../../windows-release-process.md)
