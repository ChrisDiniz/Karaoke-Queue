# 0008/0003 — H3: Autoridade e sincronização operacional

## Identificação

- Ticket: 0008/0003
- Ticket pai: 0008 — Fase H: Integração operacional Gestão + Player
- Etapa canônica: H3
- Status: Planejado / Não iniciado
- Roadmap: [Roadmap Standalone/Combined](../../standalone-player-roadmap.md)

## Objetivo

Manter o estado da fila de Gestão sincronizado com o playback remoto observado, preservando uma única autoridade operacional.

## Escopo

- Correlacionar apresentação, música, comando, `operationId` e `attemptId`.
- Registrar início e transições remotas relevantes na operação serializada existente.
- Concluir e persistir apresentação somente após término natural válido, correlacionado e confirmado.
- Tratar ACK perdido, eventos duplicados/atrasados, resultados incertos, reconexão e recovery.
- Evitar avanço duplicado, perda de apresentações e corrupção de histórico.
- Preservar as regras de fila, persistência e autoridade da Gestão.

## Dependências

- H2 e contratos F relevantes aprovados.
- Decisão G4 aprovada antes de implementar qualquer reconciliação que dependa da conexão/reconexão de um Player independente.
- Autorização explícita do proprietário para iniciar H3.

## Decisões aprovadas

- Stop, erro e desconexão não significam apresentação concluída.
- Nenhuma apresentação é concluída por suposição.
- Estado operacional persistido só é publicado como confirmado após persistência bem-sucedida.
- A fila e a persistência têm uma única autoridade operacional.
- Não inventar política de reconciliação nem fusão/transferência de filas.

## Pendências

- A decisão G4 sobre autoridade da fila ao conectar/reconectar continua aberta até aprovação específica.
- Critério de confiança/validação de fim natural deve seguir os contratos e decisões aprovados, sem pressupor que evento remoto isolado prove conclusão.

## Riscos

- Reexecução de comando após ACK perdido, duplicação de EOF ou evento fora de ordem pode avançar mais de uma vez.
- Estado incerto entre processos pode causar divergência entre fila, apresentação e playback.
- Publicação otimista pode expor conclusão que não foi persistida.

## Critérios de conclusão

- Cada comando e evento opera sobre a apresentação/tentativa correspondente e respeita idempotência.
- Stop, erro, desconexão e resultados incertos não concluem nem avançam a fila.
- Conclusões naturais válidas são persistidas antes da confirmação/publicação e não duplicam histórico.
- Recovery preserva integridade de fila e apresentação.

## Validação prevista

Testes determinísticos de concorrência/idempotência e eventos atrasados/duplicados; integração com SQLite real e E2E Electron/IPC em comunicação remota real. Exercitar commit, ACK perdido, falhas, recovery e ausência de avanço indevido.

## Histórico de execução

Planejado. Nenhuma implementação ou validação foi iniciada.

## Referências

- [Roadmap Standalone/Combined](../../standalone-player-roadmap.md)
- [Ticket H2 — Integração com Player remoto](0002-h2-integracao-player-remoto.md)
- [Ticket G3 — Comandos e sincronização](../0007-fase-g-comunicacao-remota-segura/0003-g3-comandos-eventos-sincronizacao.md)
- [Ticket G4 — Reconexão e recuperação](../0007-fase-g-comunicacao-remota-segura/0004-g4-reconexao-recuperacao.md)
- [Remote player architecture](../../remote-player-architecture.md)
- [Player playback](../../player-playback.md)
- [SQLite persistence safety](../../sqlite-persistence-safety.md)
