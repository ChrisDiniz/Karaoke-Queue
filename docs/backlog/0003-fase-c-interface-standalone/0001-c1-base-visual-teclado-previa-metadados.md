# 0003/0001 — C1: Base visual, teclado real e prévia de metadados

## Identificação

- Ticket: 0003/0001
- Ticket pai: 0003 — Fase C: Interface Standalone
- Etapa canônica: C1
- Status: Concluído
- Roadmap: [Roadmap Standalone/Combined](../../standalone-player-roadmap.md)

## Objetivo

Implementar a primeira interface Standalone aprovada, teclado/numpad, buffer e prévia de metadados sem inferência pelo nome do arquivo.

## Escopo

- Conectar interação B2, snapshots e lookup Main/Preload tipado.
- Renderizar idle e reprodução segundo frames aprovados.
- Limpar/atualizar prévia em digitação, Backspace, Esc, timeout, reload e revisão do catálogo.

## Decisões aprovadas

- V1 e frames Doop aprovados governam o comportamento e a composição.
- CSV ausente não bloqueia playback.

## Pendências


## Riscos

- A mídia de fundo real não é comparada pixel a pixel com a ilustração Doop.

## Histórico de execução

Implementação validada; o proprietário aprovou manualmente no Windows teclado/numpad, prévia, Backspace/Esc, timeout e MP4 com áudio/vídeo reais.

## Validação

Compile, unitários standalone e E2E Electron/IPC com CSV e MP4 PASS no histórico; comparação Doop/Electron 1280×800 registrada.

## Referências

- [standalone-player-ui-plan.md](../../standalone-player-ui-plan.md)
- [standalone-one-screen-player.md](../../standalone-one-screen-player.md)
- [video-library.md](../../video-library.md)
- [music-catalog.md](../../music-catalog.md)
