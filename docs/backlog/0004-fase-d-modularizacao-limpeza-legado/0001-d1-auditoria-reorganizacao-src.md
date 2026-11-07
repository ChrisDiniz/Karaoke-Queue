# 0004/0001 — D1: Auditoria e reorganização do `src`

## Identificação

- Ticket: 0004/0001
- Ticket pai: 0004 — Fase D: Modularização e limpeza do legado
- Etapa canônica: D1
- Status: Planejado / Não iniciado
- Roadmap: [Roadmap Standalone/Combined](../../standalone-player-roadmap.md)

## Objetivo

Auditar a estrutura real do `src`, propor uma organização tecnicamente justificada e, somente com aprovação explícita, reorganizar a estrutura de forma incremental e validá-la completamente antes da limpeza do legado.

## Escopo e subetapas

### D1.1 — Auditoria da estrutura atual

- Investigar responsabilidades reais, consumidores, imports, dependências, acoplamentos e ciclos.
- Mapear as fronteiras de Gestão e Standalone e identificar serviços compartilhados.
- Avaliar Main, Preload, IPC, renderers, UI, HTML, CSS, assets, playback, biblioteca e catálogo.
- Considerar efeitos sobre Combined e comunicação remota.

### D1.2 — Proposta de reorganização

- Documentar problemas comprovados, estrutura atual relevante e proposta de organização.
- Justificar agrupamentos por responsabilidade e avaliar imports, build, testes, empacotamento e manutenção.
- Considerar explicitamente a alternativa de manter a estrutura atual.
- Não criar pastas por estética, depósitos genéricos, duplicação de serviços ou abstrações sem necessidade demonstrada.
- Apresentar a proposta ao proprietário para aprovação.

### D1.3 — Reorganização incremental, se aprovada

- Nenhum arquivo poderá ser movido antes da aprovação explícita da proposta D1.2.
- Migrar pequenos grupos coerentes, preservando contratos públicos e comportamento.
- Atualizar imports/exports, TypeScript, assets, HTML/CSS, entrypoints, Preload, IPC, scripts e testes afetados.
- Evitar refatorar lógica de negócio durante movimentações estruturais.
- Após cada grupo, compilar e executar os testes diretamente afetados; corrigir falhas antes de continuar.
- Se a proposta aprovada for manter a estrutura atual, registrar a justificativa e não realizar movimentações artificiais.

### D1.4 — Validação completa após reorganização

Subetapa obrigatória após estabilizar o resultado de D1.3, inclusive quando a decisão aprovada for manter a estrutura atual.

- Inventariar todos os scripts e suítes existentes.
- Executar compilação e a suíte completa aplicável: unitários, integração e E2E.
- Priorizar Electron real e Playwright; executar o runner Windows nativo sempre que disponível e usar Linux como alternativa quando houver limitação documentada.
- Criar testes adicionais se forem identificadas lacunas relevantes.
- Corrigir regressões conhecidas e repetir as execuções necessárias antes de iniciar D2.

## Dependências e gates

- C concluída e aprovada antes de iniciar a Fase D.
- D1.1 e D1.2 precedem qualquer movimentação do `src`.
- Aprovação explícita do proprietário é obrigatória entre D1.2 e D1.3.
- D1.4 deve ser concluída antes de D2.

## Critérios de conclusão

- Auditoria baseada em responsabilidades, consumidores e dependências verificados.
- Proposta compara reorganizar com manter a estrutura atual e registra impactos/risco.
- Nenhum movimento ocorre antes da aprovação explícita.
- Validação completa pós-reorganização concluída e regressões resolvidas antes de D2.

## Histórico de execução

Criado nesta reorganização documental conforme a estrutura aprovada. A auditoria D1.1–D1.4 não foi iniciada; nenhuma proposta ou aprovação estrutural foi registrada.

## Referências

- [Roadmap Standalone/Combined](../../standalone-player-roadmap.md)
- [Remote player architecture](../../remote-player-architecture.md)
- [Player playback](../../player-playback.md)
- [SQLite persistence safety](../../sqlite-persistence-safety.md)
- [Windows native testing](../../windows-native-testing.md)
