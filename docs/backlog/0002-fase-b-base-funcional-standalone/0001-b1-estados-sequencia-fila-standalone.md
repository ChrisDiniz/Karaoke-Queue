# 0002/0001 — B1: Estados operacionais e fila Standalone

## Identificação

- Ticket: 0002/0001
- Ticket pai: 0002 — Fase B: Base funcional Standalone
- Etapa canônica: B1
- Status: Concluído
- Roadmap: [Roadmap Standalone/Combined](../../standalone-player-roadmap.md)

## Objetivo

Implementar a sequência Standalone Main-side, independente da fila Controller e de persistência operacional.

## Escopo

- Manter estados idle/playing/paused e condições técnicas transitioning/blocked/uncertain.
- Implementar FIFO normal, prioridades LIFO, validação/admissão, pausa/retomada, Next, Restart e EOF natural correlacionado.
- Preservar a fila em memória durante transições; não criar histórico ou SQLite para a sequência.

## Decisões aprovadas

- A sequência permanece volátil e isolada do Controller.
- operationId identifica a intenção; attemptId identifica tentativa de mídia.

## Pendências

- Integração com serviços reais e recovery operacional foi destinada a B3.
- Resolução manual da sequência blocked/uncertain permaneceu pendente.

## Riscos

- Não há reconciliação manual ou política de durabilidade da fila neste ticket.

## Histórico de execução

B1 foi implementada e testada com porta fake; não conectada ao startup de produção.

## Validação

Compile PASS; sequência 38/38; runtime A2 contratos 3/3, runtime 18/18, recovery 30/30. E2E Electron/Windows foi omitido nesta etapa isolada.

## Referências

- [standalone-player-roadmap.md](../../standalone-player-roadmap.md)
- [standalone-one-screen-player.md](../../standalone-one-screen-player.md)
- [player-playback.md](../../player-playback.md)
