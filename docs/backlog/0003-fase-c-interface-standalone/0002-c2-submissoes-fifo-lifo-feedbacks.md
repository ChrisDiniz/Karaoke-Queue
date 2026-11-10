# 0003/0002 — C2: Submissões FIFO/LIFO, erros e feedbacks

## Identificação

- Ticket: 0003/0002
- Ticket pai: 0003 — Fase C: Interface Standalone
- Etapa canônica: C2
- Status: Concluído
- Roadmap: [Roadmap Standalone/Combined](../../standalone-player-roadmap.md)

## Objetivo

Ligar Enter/P aos comandos Main-side, preservando FIFO/LIFO e relatando resultados autoritativos correlacionados.

## Escopo

- Validar a mídia no Main.
- Exibir feedback somente após confirmação e manter blocked/uncertain distintos.
- Preservar reprodução atual e estados de rejeição sem mutação.

## Decisões aprovadas

- operationId correlaciona intenção e retry; attemptId identifica playback.
- Timeouts do painel numérico e feedback são independentes.

## Pendências


## Riscos

- Falhas ou disponibilidade desconhecida não podem virar confirmação local.

## Histórico de execução

Fluxos automatizados e manuais foram verificados; o proprietário aprovou Enter/P, FIFO/LIFO, mídia, feedback e timeout no Windows.

## Validação

Testes focados de interação/IPC/catálogo/Sequence/transport e Electron E2E com IPC/SQLite/CSV/MP4 PASS conforme roadmap/UI plan.

## Referências

- [standalone-player-ui-plan.md](../../standalone-player-ui-plan.md)
- [standalone-one-screen-player.md](../../standalone-one-screen-player.md)
- [player-playback.md](../../player-playback.md)
