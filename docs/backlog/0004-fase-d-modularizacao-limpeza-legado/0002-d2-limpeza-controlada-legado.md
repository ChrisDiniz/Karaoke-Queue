# 0004/0002 — D2: Auditoria e limpeza controlada do legado

## Identificação

- Ticket: 0004/0002
- Ticket pai: 0004 — Fase D: Modularização e limpeza do legado
- Etapa canônica: D2
- Status: Planejado / Não iniciado
- Roadmap: [Roadmap Standalone/Combined](../../standalone-player-roadmap.md)

## Objetivo

Remover gradualmente somente componentes comprovadamente obsoletos, depois que a estrutura resultante de D1 estiver aprovada e estabilizada.

## Escopo

- Identificar consumidores reais antes de qualquer remoção.
- Classificar UI, regras, serviços e testes segundo suas responsabilidades e usos.
- Reunir evidências de obsolescência e ausência de consumidores necessários antes de remover cada grupo.
- Preservar os dados, regras, serviços e componentes operacionais do Controller necessários à Gestão no Combined, especialmente à futura H1.
- Não tratar “legado” como sinônimo de descartável; não remover funcionalidade apenas por pertencer ao Controller independente.
- Remover em grupos pequenos e corrigir regressões entre grupos.

## Dependências

- D1.1–D1.3 concluídas segundo a decisão aprovada.
- A estrutura resultante estabilizada.
- D1.4 concluída, com regressões conhecidas resolvidas.
- Autorização explícita do proprietário para iniciar D2.

## Critérios de conclusão

- Cada remoção tem evidência de obsolescência e inventário de consumidores.
- O domínio de Gestão continua preservado: mesas, cantores, sessões, histórico, fila inteligente, Round Robin, prioridades/posições protegidas, SQLite, conclusão/cancelamento e recovery.
- Serviços compartilhados necessários a H1 e à comunicação remota futura permanecem disponíveis.
- Alterações e regressões verificadas ficam registradas para a validação D3.

## Histórico

Responsabilidade derivada da antiga subetapa E1.4. Nenhuma limpeza foi iniciada; este ticket não aprova remoções nem substitui a auditoria estrutural D1.

## Referências

- [Roadmap Standalone/Combined](../../standalone-player-roadmap.md)
- [Ticket D1 — Auditoria e reorganização do `src`](0001-d1-auditoria-reorganizacao-src.md)
- [Remote player architecture](../../remote-player-architecture.md)
- [Legacy session compatibility](../../legacy-session-compatibility.md)
- [Round Robin incremental](../../round-robin-incremental.md)
- [SQLite persistence safety](../../sqlite-persistence-safety.md)
