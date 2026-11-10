# 0003/0006 — C6: Informações da faixa atual

## Identificação

- Ticket: 0003/0006
- Ticket pai: 0003 — Fase C: Interface Standalone
- Etapa canônica: C6
- Status: Concluído
- Roadmap: [Roadmap Standalone/Combined](../../standalone-player-roadmap.md)

## Objetivo

Apresentar metadados da faixa confirmada por I, com correlação e invalidação de consultas antigas.

## Escopo

- Restringir I aos estados autorizados e respeitar precedência dos outros painéis.
- Renovar timeout, fechar por Esc/transição e invalidar respostas obsoletas.
- Ocultar Próximas enquanto o painel I está aberto e restaurá-lo conforme o snapshot atualizado.

## Decisões aprovadas

- Metadados ausentes seguem Doop; não inferir título/artista do filename.
- Overlay é visual e não altera sequência/playback.

## Pendências


## Riscos

- Preservar riscos técnicos não bloqueantes de C5 registrados no plano.

## Histórico de execução

O proprietário aprovou os 14 testes manuais funcionais/visuais/audiovisuais e quatro retestes focados da concorrência I/Próximas no Windows.

## Validação

Unitários e E2E Electron/IPC/SQLite/MP4 PASS; frames disponível/indisponível comparados em 1280×800; limitações de áudio do agente estão registradas.

## Referências

- [standalone-player-ui-plan.md](../../standalone-player-ui-plan.md)
- [standalone-one-screen-player.md](../../standalone-one-screen-player.md)
- [music-catalog.md](../../music-catalog.md)
