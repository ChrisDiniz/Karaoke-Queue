# 0003/0003 — C3: Countdown e primeiro playback

## Identificação

- Ticket: 0003/0003
- Ticket pai: 0003 — Fase C: Interface Standalone
- Etapa canônica: C3
- Status: Concluído
- Roadmap: [Roadmap Standalone/Combined](../../standalone-player-roadmap.md)

## Objetivo

Executar a primeira submissão válida em idle com countdown Main-side antes do playback.

## Escopo

- Reservar o alvo durante countdown.
- Bloquear entradas/Next incompatíveis sem duplicar ou adiantar faixa.
- Expor estados loading e playing confirmados.

## Decisões aprovadas

- Countdown de 5s é pausável conforme decisões aprovadas.
- Somente playback confirmado habilita controles de reprodução.

## Pendências


## Riscos

- A validação de mídia e o efeito real de playback permanecem Main-authoritative.

## Histórico de execução

C3 foi validada com MP4 real, pausa/retomada e transições; os fluxos manuais foram aprovados no Windows conforme histórico.

## Validação

Sequence, UI e E2E Electron com MP4 e comparação visual Doop/Electron PASS, com limitações de asset registradas.

## Referências

- [standalone-player-ui-plan.md](../../standalone-player-ui-plan.md)
- [standalone-one-screen-player.md](../../standalone-one-screen-player.md)
- [player-playback.md](../../player-playback.md)
