# 0002/0004 — B3.2: Host Chromium, recovery e playback real

## Identificação

- Ticket: 0002/0004
- Ticket pai: 0002 — Fase B: Base funcional Standalone
- Etapa canônica: B3.2
- Status: Concluído
- Roadmap: [Roadmap Standalone/Combined](../../standalone-player-roadmap.md)

## Objetivo

Validar a composição Standalone em harness Electron isolado com Chromium e mídia real, sem ativar a UI de produção.

## Escopo

- Usar BrowserWindow/Preload/ChromiumPlaybackHost, biblioteca, protocolo e serviço de playback reais.
- Exercitar MP4, EOF natural, pause/resume, Restart, Next, corrida Next/EOF, falha de mídia e recovery/crash.
- Manter perfil e amostras isolados e verificar cleanup.

## Decisões aprovadas

- O harness é proprietário das janelas; a sequência e o adaptador são proprietários dos serviços que compõem.
- Mídias de teste permanecem somente leitura.

## Pendências

- UX de recovery, áudio audível e composição visual de produto não foram aprovados nesta etapa.

## Riscos

- Estado de recovery incerto bloqueia sem autoplay; resolução/replay operacional segue pendente.

## Histórico de execução

B3.2 foi validada em Linux e Windows nativos no harness isolado; não inicia main.ts nem ManualPlaybackService.

## Validação

Compile, unidades focadas, E2E Electron/Chromium com MP4 e runner Windows oficial PASS conforme roadmap. Capturas técnicas não comprovam áudio audível nem aprovação visual/manual.

## Referências

- [standalone-player-roadmap.md](../../standalone-player-roadmap.md)
- [player-playback.md](../../player-playback.md)
- [windows-native-testing.md](../../windows-native-testing.md)
