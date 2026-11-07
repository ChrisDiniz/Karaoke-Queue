# 0007/0005 — G5: Interface dos estados de conexão

## Identificação

- Ticket: 0007/0005
- Ticket pai: 0007 — Fase G: Comunicação remota segura
- Etapa canônica: G5
- Status: Planejado
- Roadmap: [Roadmap Standalone/Combined](../../standalone-player-roadmap.md)

## Objetivo

Apresentar dinamicamente os estados remotos conforme os frames Doop já aprovados.

## Escopo

- Estados: Conectado, Desconectado, Conectando/Reconectando, Erro e toasts previstos nos designs.
- Acompanhar o estado real do transporte; reutilizar componentes visuais C10 quando apropriado.
- Preservar operação independente do Player sem rede.

## Decisões aprovadas

- Frames Doop e descrições já existem; consultar novamente na G5.
- Não alterar frames sem autorização.
- C10 fornece base visual, sem implementar conectividade.

## Pendências

- A fonte do estado deve ser a conexão real; nenhum placeholder/simulação.

## Riscos

- Não inferir política de fila ou autoridade de reconexão a partir da UI.

## Histórico de execução

Planejado. Nenhuma interface remota iniciada.

## Validação

Comparar capturas Electron/Doop e exercitar conectado/desconectado/reconectando/erro com estados reais.

## Referências

- [standalone-player-roadmap.md](../../standalone-player-roadmap.md)
- [standalone-player-ui-plan.md](../../standalone-player-ui-plan.md)
- [remote-player-architecture.md](../../remote-player-architecture.md)
