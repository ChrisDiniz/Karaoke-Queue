# 0003/0007 — C7: Menu principal e Lista de comandos

## Identificação

- Ticket: 0003/0007
- Ticket pai: 0003 — Fase C: Interface Standalone
- Etapa canônica: C7
- Status: Concluído
- Roadmap: [Roadmap Standalone/Combined](../../standalone-player-roadmap.md)

## Objetivo

Adicionar menu principal e Lista de comandos, preservando playback e precedência de teclado.

## Escopo

- Setas, Tab/Shift+Tab, Enter e Esc com foco contextual.
- Bloquear atalhos do Player enquanto menu/modal estiver aberto.
- Opções e Sair indisponíveis antes das etapas correspondentes; não iniciar ações incompletas.
- Reproduzir literalmente a copy aprovada do frame Doop na Lista de comandos.

## Decisões aprovadas

- Menu durante countdown/celebração não pausa timers ou reprodução.
- A correção textual foi informada como concluída pelo proprietário; este ticket não acrescenta confirmação de validação manual após a correção.

## Pendências


## Riscos

- Não assumir que textos curtos do Doop substituem ou alteram a semântica V1; manter a divergência documentada.

## Histórico de execução

O proprietário informou que os comportamentos da C7 passaram e que a correção textual foi concluída. Não se registra aprovação manual adicional da correção textual.

## Validação

Testes focados e E2E Electron/IPC/MP4, foco/teclado e comparação Doop/Electron estão documentados; a aprovação manual da correção textual não é inventada aqui.

## Referências

- [standalone-player-ui-plan.md](../../standalone-player-ui-plan.md)
- [standalone-one-screen-player.md](../../standalone-one-screen-player.md)
