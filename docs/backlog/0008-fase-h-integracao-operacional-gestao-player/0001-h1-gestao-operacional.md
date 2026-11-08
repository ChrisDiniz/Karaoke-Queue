# 0008/0001 — H1: Gestão Combined preparada para operação remota

## Identificação

- Ticket: 0008/0001
- Ticket pai: 0008 — Fase H: Integração operacional Gestão + Player
- Etapa canônica: H1
- Status: Planejado / Não iniciado
- Roadmap: [Roadmap Standalone/Combined](../../standalone-player-roadmap.md)

## Objetivo

Preparar a função `combined`, já consolidada como única função de Gestão pela E0, para participar da integração operacional remota com um Player. H1 mantém o foco na prontidão dos casos de uso, estado confirmado, persistência e serviços de Gestão necessários aos fluxos H2/H3; não repete a eliminação de Controller como função independente.

## Escopo

- Validar e preparar os casos de uso de Gestão utilizados durante a operação com Player remoto, reutilizando a autoridade Main-side estabelecida na D4.3.
- Preservar e validar mesas, cantores, sessões e histórico.
- Preservar e validar fila inteligente, Round Robin, prioridades e posições protegidas.
- Preservar e validar persistência SQLite, regras de conclusão/cancelamento e recovery operacional.
- Integrar somente serviços e componentes necessários aos fluxos operacionais remotos H2/H3, sem duplicar a aplicação, fila ou writer.
- Preservar o domínio, dados e regras originados no Controller já consolidado pela E0.
- Não implementar transporte, pairing ou sincronização, que pertencem à Fase G; não integrar playback local, reservado à H8.

## Dependências

- E0 concluída e aprovada: `combined` é a única função final de Gestão; compatibilidade de dados legados está documentada.
- Fases E e F concluídas e aprovadas, e infraestrutura/contratos da Fase G disponíveis conforme gates globais.
- Contratos e serviços de Gestão existentes inspecionados antes de alterações.
- Autorização explícita do proprietário para iniciar H1.

## Decisões aprovadas

- Gestão (Combined) mantém as funcionalidades operacionais do Controller.
- E0 consolida Controller como função independente antes da instalação; H1 não repete esse trabalho.
- Combined permanece a autoridade local de Gestão na integração remota, usando o host Main-side da D4.3.
- Uma única fila operacional e um único writer são autoridade para Gestão.
- Não alterar regras consolidadas sem requisito e autorização explícitos.

## Pendências

- Os casos de uso de Gestão ficam aptos a ser usados pelos fluxos remotos aprovados, sem depender da janela Renderer para aplicar regras ou persistir estado.
- A fronteira com transporte e comandos remotos respeita os contratos aprovados em G e não altera diretamente fila ou SQLite fora da autoridade existente.
- Lacunas reais encontradas durante inspeção deverão ser registradas antes de ampliar o escopo.

## Riscos

- Remoção ou duplicação de regras, histórico, estado persistido ou autoridade de fila.
- Alterações voltadas à integração remota podem duplicar lógica ou contornar a autoridade Main-side se os adaptadores não reutilizarem os casos de uso existentes.

## Critérios de conclusão

- Capacidades de Gestão listadas no escopo continuam disponíveis na única função `combined` e usam a autoridade/persistência existentes.
- Nenhuma fila ou writer operacional concorrente é introduzido.
- Nenhuma remoção da função Controller de produto é duplicada em H1; esse critério pertence à E0.
- Nenhum transporte da Fase G ou playback local H8 é antecipado.
- Resultados e regressões relacionadas são documentados com evidências.

## Validação prevista

Testes focados de gestão, regras de fila, histórico, sessões, prioridades, persistência e recovery, ampliados somente aos consumidores realmente afetados. Quando H1 alterar fronteiras de uso remoto, validar a interação com contratos G sem substituir os testes de transporte/pareamento, e manter dados isolados.

## Histórico de execução

Planejado / Não iniciado. A retirada de Controller como função independente foi transferida para E0 pela decisão aprovada pelo proprietário; H1 permanece dedicada à prontidão da Gestão Combined para integração operacional remota. Nenhuma implementação ou validação foi iniciada.

## Referências

- [Roadmap Standalone/Combined](../../standalone-player-roadmap.md)
- [Remote player architecture](../../remote-player-architecture.md)
- [Round Robin incremental](../../round-robin-incremental.md)
- [SQLite persistence safety](../../sqlite-persistence-safety.md)
- [Legacy session compatibility](../../legacy-session-compatibility.md)
