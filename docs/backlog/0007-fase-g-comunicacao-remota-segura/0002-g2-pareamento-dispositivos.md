# 0007/0002 — G2: Pareamento de dispositivos

## Identificação

- Ticket: 0007/0002
- Ticket pai: 0007 — Fase G: Comunicação remota segura
- Etapa canônica: G2
- Status: Planejado
- Roadmap: [Roadmap Standalone/Combined](../../standalone-player-roadmap.md)

## Objetivo

Autorizar e gerenciar a relação entre Gestão e Reprodutor.

## Escopo

- Identificar dispositivos; obter consentimento; criar, gerenciar e revogar pareamento.

## Decisões aprovadas

- Somente dispositivos autorizados podem estabelecer a relação.

## Pendências

- Experiência de confiança/certificados deve seguir decisões G1 aprovadas.

## Riscos

- Pareamento por código/IP sem autenticação não comprova identidade.

## Histórico de execução

Planejado. Nenhuma implementação iniciada.

## Validação

E2E de autorização, revogação, reinício e tentativas não autorizadas em dois computadores de teste.

## Referências

- [standalone-player-roadmap.md](../../standalone-player-roadmap.md)
- [remote-player-architecture.md](../../remote-player-architecture.md)
