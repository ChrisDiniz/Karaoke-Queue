# Backlog operacional do Karaoke Queue

**Encerramento — 2026-11-09: Fase E CONCLUÍDA por decisão explícita do proprietário nesta sessão.** Este registro substitui os status anteriores de revisão/aceite pendente para o encerramento da fase e de E1–E5. E0 mantém sua aprovação de 2026-11-08. A solicitação de encerramento não é evidência de execução de testes adicionais: S1 permanece historicamente PARTIAL, e cenários registrados como NOT RUN não foram convertidos em PASS. Evidências, riscos e limitações anteriores ficam preservados. Fase F não iniciada nem autorizada por este encerramento.

As atualizações anteriores abaixo são histórico.

O roadmap continua sendo a fonte autoritativa da direção, escopo, dependências, fases, status e aprovações. Este backlog acompanha a execução e preserva evidências e pendências; não substitui o roadmap nem as especificações técnicas.

## Hierarquia e IDs

- Cada pasta numerada é o ticket pai de uma fase; cada arquivo Markdown dentro dela é ticket filho de uma etapa principal.
- Subetapas numeradas permanecem dentro do ticket filho apropriado, por exemplo C10.1–C10.5, D1.1–D1.4, D4.1–D4.3 e H6.1–H6.5.
- O ID hierárquico combina quatro dígitos do pai e quatro do filho, como `0003/0010` para C10.
- A reorganização aprovada pelo proprietário em novembro de 2026 renumerou/moveu tickets para alinhar as oito fases A–H. Esta é uma exceção documental específica à regra de estabilidade de IDs; os IDs atuais não devem ser renumerados em futuras mudanças de status.
- Tickets ficam em português brasileiro. Evite duplicar especificações técnicas; mantenha links para as fontes.

## Fases e tickets pais

| ID pai | Fase | Pasta | Status consolidado |
|---|---|---|---|
| `0001` | A — Preparação arquitetural | [0001-fase-a-preparacao-arquitetural](0001-fase-a-preparacao-arquitetural/) | Concluída conforme histórico. |
| `0002` | B — Base funcional Standalone | [0002-fase-b-base-funcional-standalone](0002-fase-b-base-funcional-standalone/) | Concluída conforme histórico. |
| `0003` | C — Interface Standalone | [0003-fase-c-interface-standalone](0003-fase-c-interface-standalone/) | C1–C11 concluídas conforme registros. C9 concluída/resolvida e aprovada pelo proprietário em 2026-11-07; suas limitações de cobertura anteriores são históricas, sem bloqueio ou reteste requerido. C10.5 aprovada explicitamente em 2026-11-06; C11 aprovada manualmente em 2026-11-07. **Fase C concluída e aprovada pelo proprietário.** |
| `0004` | D — Auditoria, limpeza e modularização do Main | [0004-fase-d-modularizacao-limpeza-legado](0004-fase-d-modularizacao-limpeza-legado/) | **Fase D concluída e aprovada pelo proprietário em 2026-11-07.** D1–D3 concluídas; D4.1 concluída, D4.2 aprovada, D4.3 concluída nos oito lotes; D5 automatizada PASS e validação manual global aprovada. Limites específicos anteriormente `NOT RUN` permanecem identificados como tais nos tickets. |
| `0005` | E — Consolidação de funções, instalador e gerenciamento | [0005-fase-e-instalador-gerenciamento-funcoes](0005-fase-e-instalador-gerenciamento-funcoes/) | Concluída — encerramento explícito pelo proprietário em 2026-11-09; E0–E5 encerradas. Evidências e limitações históricas preservadas; F não iniciada. |
| `0006` | F — Regressão e estabilização pós-instalação | [0006-fase-f-regressao-estabilizacao-pos-instalacao](0006-fase-f-regressao-estabilizacao-pos-instalacao/) | Planejada, não iniciada. |
| `0007` | G — Comunicação remota segura | [0007-fase-g-comunicacao-remota-segura](0007-fase-g-comunicacao-remota-segura/) | Planejada, não iniciada. A decisão de autoridade da fila em conexão/reconexão segue pendente em G4. |
| `0008` | H — Integração operacional Gestão + Player | [0008-fase-h-integracao-operacional-gestao-player](0008-fase-h-integracao-operacional-gestao-player/) | Planejada, não iniciada. |

**Estado E vigente — 2026-11-09:** primeiro CI integral PASS, run 42622477298, HEAD b92e950, artifact NSIS baixado e hash verificado. [Evidência e limites](../fase-e-revisao-independente.md#24-primeiro-ci-integral-pass-e-artifact--2026-11-09). S1 PARTIAL; E1–E5 sem homologação/aprovação, UAC interativo/contas/sessões/legado/manutenção/aceite humano pendentes. Registros anteriores abaixo são históricos.

## Estrutura completa

**Atualização Fase E — revisão independente e correções de 2026-11-08:** [parecer e resultados atuais](../fase-e-revisao-independente.md). R1–R10 corrigidos e testes focados/regressões passaram; build/verificador NSIS e runner Windows PASS na fingerprint registrada. Existe candidato local não instalado; não há artifact GitHub. GO condicionado para PR de validação depois da revisão read-only das correções. NSIS instalado, UAC, ACL entre contas, duas sessões e aceite visual continuam pendentes; S1 PARTIAL; nenhuma E1–E5 homologada/aprovada. Os relatórios anteriores ficam como histórico.

- **A — Preparação arquitetural** (`0001`): A1, A2.
- **B — Base funcional Standalone** (`0002`): B1, B2, B3.1, B3.2, B4.1, B4.2.
- **C — Interface Standalone** (`0003`): C1–C9, C10 (subetapas C10.1–C10.5) e C11 (somente limite de 30 músicas pendentes, sem a faixa atual).
- **D — Auditoria, limpeza e modularização do Main** (`0004`): D1–D3 concluídas; D4.1 concluída, D4.2 aprovada em 2026-11-07 e D4.3 implementada nos oito lotes; D5 automatizada PASS em Linux/Windows, incluindo pacote empacotado. Em 2026-11-07, o proprietário validou manualmente no Windows nativo, pelo launcher oficial, os modos Reprodutor e Tudo em um, suas interfaces e funcionalidades operacionais, sem encontrar defeitos, e aprovou a D5 e toda a Fase D. Limites específicos de input físico/áudio/diálogo sem confirmação individual permanecem registrados nos tickets. D2 preservou serviços e contratos compartilhados; D4 preparou fronteiras para G sem implementar rede. **Naquele fechamento, a próxima fase era E, ainda não iniciada; status atual abaixo.**
- **E — Consolidação de funções, instalador e gerenciamento** (`0005`): E0 aprovada. Primeiro CI integral Linux/Windows e NSIS silencioso install/uninstall/reinstall PASS com artifact verificado; [evidências](../fase-e-revisao-independente.md#24-primeiro-ci-integral-pass-e-artifact--2026-11-09). S1 PARTIAL, E1–E5 não homologadas/aprovadas; demais cenários reais e aceite humano pendentes, F não iniciada.
- **F — Regressão e estabilização pós-instalação** (`0006`): F1 regressão geral pós-D/E, F2 aplicativo instalado, F3 atualizações/migrações, F4 estabilidade/aprovação final.
- **G — Comunicação remota segura** (`0007`): G1 HTTPS/WSS, G2 pareamento, G3 comandos/eventos/sincronização, G4 reconexão/recuperação e pendência de autoridade da fila, G5 UI baseada em estados reais, G6 validação da comunicação.
- **H — Integração operacional Gestão + Player** (`0008`): H1 prepara a Gestão Combined consolidada em E0 para operação remota, H2 integração Player remoto, H3 autoridade/sincronização, H4 melhorias pontuais da UI de Gestão, H5 validação operacional remota, H6 campanha exclusiva de performance/estabilidade, H7 primeiro release controlado, H8 reprodução local integrada posterior.

**C11 e H6 estão separados:** C11 contém exclusivamente o limite de 30 músicas pendentes. H6 recebe a antiga campanha de performance, com baseline, endurance, acervos e validação final. Não existe uma Fase I.

## Mapeamento da estrutura anterior para a atual

| Origem | Destino atual | Correspondência e histórico preservado |
|---|---|---|
| A (`0001`) e B (`0002`) | A (`0001`) e B (`0002`) | IDs, escopo, histórico e status preservados. |
| C1–C9 | C1–C9 (`0003/0001`–`0003/0009`) | IDs, histórico e status preservados. |
| C10 (`0003/0010`) | C10 (`0003/0010`) | Mantém ID e passa a cinco subetapas. Evidências anteriores de C10.1/.2 ficam em seus tópicos; a antiga C10.3 continha auditoria, adaptação e comparações parciais, agora atribuídas respectivamente a C10.3/.4/.5. C10.4 foi concluída tecnicamente; o proprietário aprovou explicitamente C10.5 e encerrou C10 em 2026-11-06. |
| Antiga C11.1 — limite da fila | C11 (`0003/0011`) | Mantém-se exclusivamente como teto de 30 pendências, sem contar a faixa atual; implementada, validada tecnicamente e aprovada manualmente pelo proprietário em 2026-11-07. |
| Antiga C11.2–C11.6 — performance | H6 (`0008/0006`) | Transferida para H6.1–H6.5, sem alterar os critérios de baseline, endurance, acervos e otimização baseada em evidências. |
| Antiga Fase E: E1.1–E1.3, E1.4, E2 | D1.1–D1.3, D2, D3 (`0004/0001`–`0004/0003`) | Auditoria/proposta/reorganização do `src`, limpeza controlada e regressão pós-limpeza. A aprovação entre D1.2 e D1.3 e o gate D1.4 antes da limpeza são explícitos. D4/D5 são etapas adicionais autorizadas na nova organização da Fase D. |
| Antiga Fase D: D1, D2, D3, D4, D5 | E1, E1/E3, E2, E4, E5 (`0005/0001`–`0005/0005`) | Auditoria/estratégia de instalação de D1 é preservada como preflight de E1; instalador único e seleção no primeiro uso, antes previstos em D2, ficam em E1, com exclusividade técnica em E3; identidade D3 → E2; manutenção D4 → E4; updates/migração D5 → E5. |
| Planejamento anterior de H1 | E0 + H1 (`0005/0000` e `0008/0001`) | A retirada de Controller como função independente passa a E0; H1 preserva atividades da Gestão Combined necessárias à integração operacional remota. Os demais mapeamentos históricos de D para E1–E5 permanecem. |
| Antiga Fase E: E3–E5 | F2–F4 (`0006/0002`–`0006/0004`) | Aplicativo instalado, atualizações/migrações e estabilidade final. F1 é o novo gate de regressão geral pós-limpeza e instalador. |
| Antiga Fase F: F1–F6 | G1–G6 (`0007/0001`–`0007/0006`) | Mantida a ordem e o conteúdo da comunicação remota segura; pendência antiga F4 de autoridade da fila agora está em G4. |
| Antiga Fase G: G1–G5, G6, G7 | H1–H5, H7, H8 (`0008/0001`–`0008/0008`) | Domínio e validação operacional, release controlado e reprodução local posterior preservados; H6 foi reservado para performance. |

## Dependências e aprovações

A sequência permanece A → B → C → D → E → F → G → H. A Fase C foi concluída e aprovada antes de D. D1.1/D1.2 antecederam a decisão sobre a organização física do `src`; a alternativa A de D1.2 foi aprovada, D1.3 concluída sem movimentações e D1.4 aceita como baseline. D2/D3 foram concluídas antes de D4.1/D4.2; a proposta D4.2 foi aprovada explicitamente antes da implementação incremental D4.3. D5, campanha automatizada e validação manual global, foi aprovada pelo proprietário em 2026-11-07 e encerra a Fase D. **No fechamento D, em 2026-11-07, E era a próxima fase e ainda não havia começado.** E0 foi autorizada, executada e aprovada no dia seguinte após validação manual Windows PASS. Depois, E1-01/S1 foram registrados; S1 segue PARTIAL. A autorização mais recente cobre desenvolvimento sequencial E1-03→E5-03 e correções E1-02; ela não aprova etapas. O status atual e as lacunas ambientais estão no [ledger executivo](../fase-e-plano-executivo.md#12-ledger-da-execução-autorizada-e1-03e5-03). D2 preservou o domínio necessário à Gestão/Combined; D4 preparou fronteiras para G sem antecipar rede.

E concluída precede F; F precede G; G precede H. H1 precede H2. H2 e contratos remotos relevantes precedem os fluxos dependentes de H3. H1–H5 precedem H6; H6 concluída é requisito obrigatório para H7; H7 precede H8. Builds, distribuição, publicação e instalação efetiva de H7 exigem autorização específica do proprietário, cada uma quando aplicável. A validação presencial do estabelecimento é conduzida pelo proprietário e não pode ser presumida.

A decisão antiga F4 sobre autoridade da fila quando Player independente se conecta/reconecta é agora registrada em G4. Ela continua deliberadamente pendente; não presumir fusão, substituição, descarte ou transferência da fila. Resolvê-la antes de implementar fluxos G2/G3 que dela dependam e antes da reconciliação operacional dependente em H3.

## Estados dos tickets

Use: Planejado; Pendente; Em implementação; Implementado — aguardando validação; Em validação; Concluído; Bloqueado. Separe implementação, automação, validação manual e aprovação explícita. Não declare aprovação humana sem registro do proprietário.

## Manutenção

Antes de iniciar uma etapa, consulte o roadmap, o ticket e os documentos técnicos e confirme a autorização aplicável. Registre escopo, arquivos, testes executados/omitidos, evidências, riscos e pendências no ticket correspondente. Após validação, atualize status com base em evidência e sincronize roadmap quando status ou aprovação mudar. A reorganização deste índice e dos tickets foi autorizada documentalmente; ela não autoriza implementação das fases.
