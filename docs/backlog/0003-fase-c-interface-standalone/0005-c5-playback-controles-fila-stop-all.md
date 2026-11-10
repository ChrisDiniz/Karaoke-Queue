# 0003/0005 — C5: Playback, fila visível e Stop All

## Identificação

- Ticket: 0003/0005
- Ticket pai: 0003 — Fase C: Interface Standalone
- Etapa canônica: C5
- Status: Concluído
- Roadmap: [Roadmap Standalone/Combined](../../standalone-player-roadmap.md)

## Objetivo

Implementar controles de playback, projeção visual de Próximas e confirmação segura de Stop All.

## Escopo

- Pausar/retomar, Restart e Next conforme V1.
- Exibir até cinco entradas derivadas do snapshot Main, preservando ordem FIFO/LIFO.
- Confirmar Stop All sem EOF sintético nem autoplay e restaurar Próximas após Esc/timeout.

## Decisões aprovadas

- Modal não pausa mídia ou timers; cancelamento preserva estado.
- A fila visual é projeção; fila e prioridades continuam sob autoridade do Main.

## Pendências


## Riscos

- Permanecem riscos não bloqueantes registrados sobre operationId e resolução de blocked/uncertain antes da ativação.

## Histórico de execução

C1–C5 e a correção de Próximas foram aprovadas manualmente pelo proprietário no Windows; playback, áudio/vídeo, modal e fila foram validados.

## Validação

Compile, Sequence/UI unitários, E2E Electron/IPC/SQLite/MP4 e comparação Doop/Electron PASS conforme roadmap; suíte ampla de modos não foi alegada.

## Referências

- [standalone-player-ui-plan.md](../../standalone-player-ui-plan.md)
- [standalone-one-screen-player.md](../../standalone-one-screen-player.md)
- [player-playback.md](../../player-playback.md)
