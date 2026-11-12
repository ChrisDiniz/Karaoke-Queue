# 0006/0003 — F3: Atualizações e migração

**Status vigente — 2026-11-11: Concluído e validado pelo proprietário.** O aceite global da Fase F nesta sessão abrange esta etapa e suas subdivisões. [Encerramento consolidado e limites das evidências](../../fase-f-encerramento.md). O conteúdo abaixo preserva o planejamento e os checkpoints históricos; referências a não início ou homologação pendente estão superadas para acompanhamento, sem converter PARTIAL/NOT RUN/FAIL em PASS.

## Identificação

- Ticket: 0006/0003
- Ticket pai: 0006 — Fase F: Regressão e estabilização pós-instalação
- Etapa canônica: F3
- Status: Concluído e validado pelo proprietário (2026-11-11)
- Roadmap: [Roadmap Standalone/Combined](../../standalone-player-roadmap.md)

## Objetivo

Validar update, reinstalação e alteração de função com preservação de dados e recuperação.

## Escopo

- Testar bancos, configurações, atalhos e perfis anteriores.
- Investigar falhas e rollback sem apagar dados.

## Decisões aprovadas

- Não presumir conversão automática de bancos ou fusão de perfis.

## Pendências registradas antes do encerramento

- Depende dos fluxos de instalador/manutenção E (referência corrigida no encerramento documental).

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

## Dependência F0 — registro histórico de 2026-11-10

A [F0](0000-f0-estabilizacao-critica-standalone.md) deve estar concluída e aprovada antes da execução geral de F1–F4. Esta atualização não inicia nem renumera esta etapa; as dependências sequenciais e autorizações individuais permanecem. E está encerrada por declaração do proprietário, sem converter limitações históricas em PASS.
