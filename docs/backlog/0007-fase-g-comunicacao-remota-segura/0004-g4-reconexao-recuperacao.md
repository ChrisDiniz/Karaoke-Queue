# 0007/0004 — G4: Reconexão e recuperação

## Identificação

- Ticket: 0007/0004
- Ticket pai: 0007 — Fase G: Comunicação remota segura
- Etapa canônica: G4
- Status: Planejado
- Roadmap: [Roadmap Standalone/Combined](../../standalone-player-roadmap.md)

## Objetivo

Tratar desconexão e resultados incertos sem perda, duplicação ou mudança automática de autoridade.

## Escopo

- Cobrir timeout, reconexão, ACK perdido, mensagens tardias, comando incerto e reinício de processo.
- Manter Player operacional independente quando desconectado.

## Decisões aprovadas

- Decisão deliberadamente adiada: “Definir o comportamento da autoridade sobre a fila quando um Player que estava funcionando independentemente estabelece ou restabelece conexão com um Controller.”
- Não presumir fusão/substituição/descarte da fila, transferência de autoridade, interrupção da música ou política de reconciliação.

## Pendências

- A autoridade da fila em conexão/reconexão exige análise e aprovação explícita antes do fluxo correspondente.

## Riscos

- Operação ambígua após perda de ACK pode ser executada duas vezes; reconexão pode encontrar estado divergente.

## Histórico de execução

Planejado. A decisão de autoridade está aberta por aprovação do proprietário.

## Validação

Simular desconexão/reconexão, ACK perdido, atraso, duplicata, reinício e estado incerto. Não validar política de fila até aprovação da decisão adiada.

## Referências

- [standalone-player-roadmap.md](../../standalone-player-roadmap.md)
- [remote-player-architecture.md](../../remote-player-architecture.md)
- [player-playback.md](../../player-playback.md)
