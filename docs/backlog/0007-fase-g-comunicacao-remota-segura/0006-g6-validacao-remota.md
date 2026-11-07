# 0007/0006 — G6: Validação remota

## Identificação

- Ticket: 0007/0006
- Ticket pai: 0007 — Fase G: Comunicação remota segura
- Etapa canônica: G6
- Status: Planejado
- Roadmap: [Roadmap Standalone/Combined](../../standalone-player-roadmap.md)

## Objetivo

Validar o transporte/estado remoto entre dois computadores, sem declarar concluída a integração operacional e a validação remota da Gestão em H2–H5.

## Escopo

- Testar conexão, desconexão, reconexão, timeout, duplicatas, atrasos, ACK perdido, reinício, segurança e contratos.

## Decisões aprovadas

- Validação remota de F não conclui a integração operacional da fila Combined em H2–H5 nem a prontidão para o primeiro release controlado H7.

## Pendências

- G1–G5 implementadas conforme aprovações.

## Riscos

- Ambiente de dois computadores e execução Windows nativa.

## Histórico de execução

Planejado. Nenhuma execução iniciada.

## Validação

E2E em duas máquinas; separar teste de transporte de reconciliação operacional da fila.

## Referências

- [standalone-player-roadmap.md](../../standalone-player-roadmap.md)
- [remote-player-architecture.md](../../remote-player-architecture.md)
- [windows-native-testing.md](../../windows-native-testing.md)
