# 0002/0006 — B4.2: Consolidação funcional isolada

## Identificação

- Ticket: 0002/0006
- Ticket pai: 0002 — Fase B: Base funcional Standalone
- Etapa canônica: B4.2
- Status: Concluído
- Roadmap: [Roadmap Standalone/Combined](../../standalone-player-roadmap.md)

## Objetivo

Exercitar o fluxo integrado B2 → Preload/IPC → Main → Sequence/Runtime → playback real no harness isolado.

## Escopo

- Compor uma sequência, adaptador, PlayerPlaybackService, biblioteca, protocolo, recovery, Chromium e bridges restritas.
- Validar comandos, retry correlacionado, reload, recovery incerto, EOF real, Next e cleanup.
- Manter o perfil sem banco operacional Controller.

## Decisões aprovadas

- Uma sequence e um writer Main-side do estado Standalone por processo de teste.
- Música local pode operar sem catálogo CSV.

## Pendências

- Captura de teclado/foco dentro da UI, interface visual e validação audiovisual humana pertencem à Fase C.

## Riscos

- Recovery não resolve pendência nem retoma playback automaticamente. Falha abrupta de Main durante escrita não foi coberta.

## Histórico de execução

B4.2 foi validada em Linux e Windows nativos em Electron isolado; não ativa o produto.

## Validação

Compile, unidades Standalone focadas, integração Electron/Linux com MP4 e recovery, runner Windows com MP4 PASS conforme roadmap. UI vazia de harness; não declara validação visual ou áudio humano.

## Referências

- [standalone-player-roadmap.md](../../standalone-player-roadmap.md)
- [player-playback.md](../../player-playback.md)
- [remote-player-architecture.md](../../remote-player-architecture.md)
- [windows-native-testing.md](../../windows-native-testing.md)
