# 0002/0003 — B3.1: Adaptador técnico de playback

## Identificação

- Ticket: 0002/0003
- Ticket pai: 0002 — Fase B: Base funcional Standalone
- Etapa canônica: B3.1
- Status: Concluído
- Roadmap: [Roadmap Standalone/Combined](../../standalone-player-roadmap.md)

## Objetivo

Compor a sequência Standalone com serviços compartilhados de playback por uma porta estreita e injetável.

## Escopo

- Reutilizar VideoLibraryService, PlayerMediaProtocol, PlayerPlaybackService e recovery quando fornecidos pelo Main.
- Manter catálogo opcional e fora da decisão de disponibilidade do vídeo.
- Liberar recursos sob ownership explícito do adaptador.

## Decisões aprovadas

- EOF natural e interrupções continuam eventos distintos e correlacionados.
- A composição não instancia ManualPlaybackService, janela, Chromium, Controller ou IPC.

## Pendências

- Host Electron real, MP4 decodificável e ciclo de vida de janela foram destinados a B3.2.

## Riscos

- Cancelamento individual de tentativa não é oferecido pelo serviço compartilhado; shutdown é o caminho de contenção documentado.

## Histórico de execução

Adaptador implementado e validado com serviços reais e host controlado.

## Validação

Compile PASS; adaptador 8/8 e regressões focadas de contratos/runtime/sequence/playback/recovery/biblioteca/catálogo PASS. MP4 real e E2E foram omitidos.

## Referências

- [standalone-player-roadmap.md](../../standalone-player-roadmap.md)
- [player-playback.md](../../player-playback.md)
- [video-library.md](../../video-library.md)
- [remote-player-architecture.md](../../remote-player-architecture.md)
