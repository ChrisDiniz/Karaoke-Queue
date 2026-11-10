# 0002/0002 — B2: Interpretação de teclado e estado de interação

## Identificação

- Ticket: 0002/0002
- Ticket pai: 0002 — Fase B: Base funcional Standalone
- Etapa canônica: B2
- Status: Concluído
- Roadmap: [Roadmap Standalone/Combined](../../standalone-player-roadmap.md)

## Objetivo

Implementar interpretação V1 de teclas e estado lógico de buffer/painéis/menu sem UI ou chamadas de playback.

## Escopo

- Reconhecer códigos numéricos, modificadores, repetição, Backspace, Enter/P e atalhos aprovados.
- Manter buffer, timeout, Esc contextual e estados de menu independentes da sequência.
- Correlacionar resultados de submissão por operationId e preservar respostas fora de ordem.

## Decisões aprovadas

- Menu aberto bloqueia comandos operacionais/números, exceto Esc; navegar não pausa playback.
- Timers dependem de scheduler injetável e não usam callbacks antigos após reset.

## Pendências

- Captura real de teclado, foco, DOM, IPC e UI ficaram para Fase C.

## Riscos

- A integração deve fornecer IDs e scheduler; não transferir decisões de playback para o intérprete.

## Histórico de execução

B2 foi implementada como módulos sem DOM/Electron e sem ligação a main.ts.

## Validação

Teste determinístico de interação PASS, 32/32; não comprova teclado físico nem foco na janela Electron.

## Referências

- [standalone-player-roadmap.md](../../standalone-player-roadmap.md)
- [standalone-player-ui-plan.md](../../standalone-player-ui-plan.md)
- [standalone-one-screen-player.md](../../standalone-one-screen-player.md)
