# 0007/0003 — G3: Comandos, eventos e sincronização

## Identificação

- Ticket: 0007/0003
- Ticket pai: 0007 — Fase G: Comunicação remota segura
- Etapa canônica: G3
- Status: Planejado
- Roadmap: [Roadmap Standalone/Combined](../../standalone-player-roadmap.md)

## Objetivo

Transportar comandos e estados correlacionados sem criar outra autoridade de fila.

## Escopo

- Definir comandos, snapshots, confirmações, operationId/attemptId, deduplicação e proteção contra mensagens atrasadas/fora de ordem.

## Decisões aprovadas

- Uma única autoridade operacional.
- Idempotência distingue retry da mesma intenção de ação legítima nova.

## Pendências

- Contrato versionado e autorização G1/G2.

## Riscos

- ACK perdido, duplicata, reordenação ou estado obsoleto pode causar avanço duplicado ou incorreto.

## Histórico de execução

Planejado. Nenhuma implementação iniciada.

## Validação

Testes determinísticos de duplicatas, replay, ordenação, IDs, ACK e estado confirmado.

## Referências

- [standalone-player-roadmap.md](../../standalone-player-roadmap.md)
- [remote-player-architecture.md](../../remote-player-architecture.md)
- [player-playback.md](../../player-playback.md)
