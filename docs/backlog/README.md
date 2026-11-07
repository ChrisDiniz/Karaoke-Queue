# Backlog operacional do Karaoke Queue

O roadmap continua sendo a fonte autoritativa da direção, escopo, dependências, fases, status e aprovações. Este backlog acompanha a execução e preserva evidências e pendências; não substitui o roadmap nem as especificações técnicas.

## Hierarquia e IDs

- Cada pasta numerada é o ticket pai de uma fase; cada arquivo Markdown dentro dela é ticket filho de uma etapa principal.
- Subetapas numeradas permanecem dentro do ticket filho apropriado, por exemplo C10.1–C10.5, D1.1–D1.4 e H6.1–H6.5.
- O ID hierárquico combina quatro dígitos do pai e quatro do filho, como `0003/0010` para C10.
- A reorganização aprovada pelo proprietário em novembro de 2026 renumerou/moveu tickets para alinhar as oito fases A–H. Esta é uma exceção documental específica à regra de estabilidade de IDs; os IDs atuais não devem ser renumerados em futuras mudanças de status.
- Tickets ficam em português brasileiro. Evite duplicar especificações técnicas; mantenha links para as fontes.

## Fases e tickets pais

| ID pai | Fase | Pasta | Status consolidado |
|---|---|---|---|
| `0001` | A — Preparação arquitetural | [0001-fase-a-preparacao-arquitetural](0001-fase-a-preparacao-arquitetural/) | Concluída conforme histórico. |
| `0002` | B — Base funcional Standalone | [0002-fase-b-base-funcional-standalone](0002-fase-b-base-funcional-standalone/) | Concluída conforme histórico. |
| `0003` | C — Interface Standalone | [0003-fase-c-interface-standalone](0003-fase-c-interface-standalone/) | C1–C8 concluídas conforme registros; C8 aprovada manualmente. C9 revalidada tecnicamente em Linux/Windows, ainda sem aprovação do proprietário; Alt+F4 físico e revisão visual C9.2/C9.5 pendentes. C10 encerrada: C10.1–C10.4 tecnicamente concluídas e C10.5 explicitamente aprovada pelo proprietário em 2026-11-06. C11 concluída e aprovada manualmente pelo proprietário em 2026-11-07, após validação técnica Linux/Windows. A Fase C segue sem aprovação global por causa das pendências de C9. |
| `0004` | D — Modularização e limpeza do legado | [0004-fase-d-modularizacao-limpeza-legado](0004-fase-d-modularizacao-limpeza-legado/) | Planejada, não iniciada. |
| `0005` | E — Instalador e gerenciamento de funções | [0005-fase-e-instalador-gerenciamento-funcoes](0005-fase-e-instalador-gerenciamento-funcoes/) | Planejada, não iniciada. |
| `0006` | F — Regressão e estabilização pós-instalação | [0006-fase-f-regressao-estabilizacao-pos-instalacao](0006-fase-f-regressao-estabilizacao-pos-instalacao/) | Planejada, não iniciada. |
| `0007` | G — Comunicação remota segura | [0007-fase-g-comunicacao-remota-segura](0007-fase-g-comunicacao-remota-segura/) | Planejada, não iniciada. A decisão de autoridade da fila em conexão/reconexão segue pendente em G4. |
| `0008` | H — Integração operacional Gestão + Player | [0008-fase-h-integracao-operacional-gestao-player](0008-fase-h-integracao-operacional-gestao-player/) | Planejada, não iniciada. |

## Estrutura completa

- **A — Preparação arquitetural** (`0001`): A1, A2.
- **B — Base funcional Standalone** (`0002`): B1, B2, B3.1, B3.2, B4.1, B4.2.
- **C — Interface Standalone** (`0003`): C1–C9, C10 (subetapas C10.1–C10.5) e C11 (somente limite de 30 músicas pendentes, sem a faixa atual).
- **D — Modularização e limpeza do legado** (`0004`): D1 (D1.1 auditoria atual, D1.2 proposta, D1.3 reorganização somente após aprovação, D1.4 validação completa), D2 limpeza controlada, D3 regressão completa final.
- **E — Instalador e gerenciamento de funções** (`0005`): E1 instalador único/seleção e estratégia aprovada, E2 identidade/atalhos, E3 exclusividade por computador, E4 manutenção/alteração, E5 atualização/migração/preservação.
- **F — Regressão e estabilização pós-instalação** (`0006`): F1 regressão geral pós-D/E, F2 aplicativo instalado, F3 atualizações/migrações, F4 estabilidade/aprovação final.
- **G — Comunicação remota segura** (`0007`): G1 HTTPS/WSS, G2 pareamento, G3 comandos/eventos/sincronização, G4 reconexão/recuperação e pendência de autoridade da fila, G5 UI baseada em estados reais, G6 validação da comunicação.
- **H — Integração operacional Gestão + Player** (`0008`): H1 gestão operacional no Combined, H2 integração Player remoto, H3 autoridade/sincronização, H4 melhorias pontuais da UI de Gestão, H5 validação operacional remota, H6 campanha exclusiva de performance/estabilidade, H7 primeiro release controlado, H8 reprodução local integrada posterior.

**C11 e H6 estão separados:** C11 contém exclusivamente o limite de 30 músicas pendentes. H6 recebe a antiga campanha de performance, com baseline, endurance, acervos e validação final. Não existe uma Fase I.

## Mapeamento da estrutura anterior para a atual

| Origem | Destino atual | Correspondência e histórico preservado |
|---|---|---|
| A (`0001`) e B (`0002`) | A (`0001`) e B (`0002`) | IDs, escopo, histórico e status preservados. |
| C1–C9 | C1–C9 (`0003/0001`–`0003/0009`) | IDs, histórico e status preservados. |
| C10 (`0003/0010`) | C10 (`0003/0010`) | Mantém ID e passa a cinco subetapas. Evidências anteriores de C10.1/.2 ficam em seus tópicos; a antiga C10.3 continha auditoria, adaptação e comparações parciais, agora atribuídas respectivamente a C10.3/.4/.5. C10.4 foi concluída tecnicamente; o proprietário aprovou explicitamente C10.5 e encerrou C10 em 2026-11-06. |
| Antiga C11.1 — limite da fila | C11 (`0003/0011`) | Mantém-se exclusivamente como teto de 30 pendências, sem contar a faixa atual; implementada, validada tecnicamente e aprovada manualmente pelo proprietário em 2026-11-07. |
| Antiga C11.2–C11.6 — performance | H6 (`0008/0006`) | Transferida para H6.1–H6.5, sem alterar os critérios de baseline, endurance, acervos e otimização baseada em evidências. |
| Antiga Fase E: E1.1–E1.3, E1.4, E2 | D1.1–D1.3, D2, D3 (`0004/0001`–`0004/0003`) | Auditoria/proposta/reorganização do `src`, limpeza controlada e regressão completa final. A aprovação entre D1.2 e D1.3 e os dois gates de regressão são explícitos. |
| Antiga Fase D: D1, D2, D3, D4, D5 | E1, E1/E3, E2, E4, E5 (`0005/0001`–`0005/0005`) | Auditoria/estratégia de instalação de D1 é preservada como preflight de E1; installer/seleção de D2 ficam em E1 e exclusividade técnica em E3; identidade D3 → E2; manutenção D4 → E4; updates/migração D5 → E5. |
| Antiga Fase E: E3–E5 | F2–F4 (`0006/0002`–`0006/0004`) | Aplicativo instalado, atualizações/migrações e estabilidade final. F1 é o novo gate de regressão geral pós-limpeza e instalador. |
| Antiga Fase F: F1–F6 | G1–G6 (`0007/0001`–`0007/0006`) | Mantida a ordem e o conteúdo da comunicação remota segura; pendência antiga F4 de autoridade da fila agora está em G4. |
| Antiga Fase G: G1–G5, G6, G7 | H1–H5, H7, H8 (`0008/0001`–`0008/0008`) | Domínio e validação operacional, release controlado e reprodução local posterior preservados; H6 foi reservado para performance. |

## Dependências e aprovações

A sequência é A → B → C → D → E → F → G → H. A Fase C deve estar concluída e aprovada antes de D. D1.1/D1.2 antecedem movimentações do `src`; a aprovação explícita do proprietário é obrigatória entre D1.2 e D1.3. D1.4 deve passar antes de D2; D2 deve estar concluída antes de D3; D3 e a aprovação do proprietário são gates para E1. D2 preserva o domínio operacional necessário à Gestão/Combined.

E concluída precede F; F precede G; G precede H. H1 precede H2. H2 e contratos remotos relevantes precedem os fluxos dependentes de H3. H1–H5 precedem H6; H6 concluída é requisito obrigatório para H7; H7 precede H8. Builds, distribuição, publicação e instalação efetiva de H7 exigem autorização específica do proprietário, cada uma quando aplicável. A validação presencial do estabelecimento é conduzida pelo proprietário e não pode ser presumida.

A decisão antiga F4 sobre autoridade da fila quando Player independente se conecta/reconecta é agora registrada em G4. Ela continua deliberadamente pendente; não presumir fusão, substituição, descarte ou transferência da fila. Resolvê-la antes de implementar fluxos G2/G3 que dela dependam e antes da reconciliação operacional dependente em H3.

## Estados dos tickets

Use: Planejado; Pendente; Em implementação; Implementado — aguardando validação; Em validação; Concluído; Bloqueado. Separe implementação, automação, validação manual e aprovação explícita. Não declare aprovação humana sem registro do proprietário.

## Manutenção

Antes de iniciar uma etapa, consulte o roadmap, o ticket e os documentos técnicos e confirme a autorização aplicável. Registre escopo, arquivos, testes executados/omitidos, evidências, riscos e pendências no ticket correspondente. Após validação, atualize status com base em evidência e sincronize roadmap quando status ou aprovação mudar. A reorganização deste índice e dos tickets foi autorizada documentalmente; ela não autoriza implementação das fases.
