# Backlog operacional do Karaoke Queue

## Aceite do proprietário — G1 homologada com limitações — 2026-11-12

O proprietário aceitou a G1 e determinou seu encerramento como **homologada com limitações**, após o parecer técnico independente favorável. G1.2 está concluída; G1.3 foi aceita com as limitações abaixo. Esse aceite substitui o estado anterior de “aguardando aceite final”; os resultados técnicos históricos permanecem preservados e a validação integral de todas as plataformas não é declarada.

- Windows nativo: NOT RUN; o runner oficial bloqueou o arquivo-fonte `src/remote-secret-protector.ts` pela heurística de nome sensível antes da sincronização. A execução nativa continua pendente.
- Empacotamento: smoke ASAR focado PASS; rebuild limpo pendente por indisponibilidade externa/DNS (`EAI_AGAIN github.com` na tentativa anterior).
- Multicast real local WSL: PASS; LAN entre computadores e plataformas nativas permanece para G6.
- E2E audiovisual com MP4: NOT RUN, sem fixture aprovada; não bloqueia o aceite da infraestrutura G1.

A G1 está tecnicamente apta para G2 e seu aceite pelo proprietário está registrado. G2 permanece não iniciada e depende de autorização própria. T2, D2 e os demais gates futuros permanecem vigentes. Nenhum resultado NOT RUN foi convertido em PASS. Este checkpoint não encerra a Fase G inteira.

**Encerramento vigente — 2026-11-11: Fase F CONCLUÍDA E VALIDADA pelo proprietário**, conforme declaração explícita nesta sessão, abrangendo F0–F4. [Registro consolidado, evidências e limitações](../fase-f-encerramento.md). Estados anteriores de F aberta/não homologada e F1–F4 não iniciadas são históricos e estão superados por este aceite; resultados PARTIAL/NOT RUN permanecem intactos. G/H aguardam planejamento e autorização específica.

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
| `0005` | E — Consolidação de funções, instalador e gerenciamento | [0005-fase-e-instalador-gerenciamento-funcoes](0005-fase-e-instalador-gerenciamento-funcoes/) | Concluída — encerramento explícito pelo proprietário em 2026-11-09; E0–E5 encerradas. Evidências e limitações históricas preservadas; F ainda não havia iniciado naquele encerramento. |
| `0006` | F — Regressão e estabilização pós-instalação | [0006-fase-f-regressao-estabilizacao-pos-instalacao](0006-fase-f-regressao-estabilizacao-pos-instalacao/) | Concluída e validada pelo proprietário em 2026-11-11, incluindo F0–F4. [Encerramento e limites das evidências](../fase-f-encerramento.md). |
| `0007` | G — Comunicação remota segura | [0007-fase-g-comunicacao-remota-segura](0007-fase-g-comunicacao-remota-segura/) | T1 aprovada. G1 homologada com limitações pelo proprietário em 2026-11-12; G1.2 concluída e G1.3 aceita com pendências ambientais. Multicast local WSL e smoke ASAR focado PASS; Windows nativo e rebuild limpo pendentes. G2–G6 não iniciadas; T2 e integração operacional H permanecem em seus gates. |
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

A decisão antiga F4, depois G4, foi detalhada pelo proprietário no [contrato pareado](../paired-mode-contract.md): Gestão mantém fila/promoção, Player executa vez aceita e registra resultados duráveis; offline/retorno são explícitos, sem importação de fila local. D1/D3/D4/D5 resolvidas e D2 parcialmente resolvida (suspender, sem importar/executar; destino final pendente); T1/T2 mantêm seus gates; a decisão ampla de autoridade não permanece aberta.

## Estados dos tickets

Use: Planejado; Pendente; Em implementação; Implementado — aguardando validação; Em validação; Concluído; Bloqueado. Separe implementação, automação, validação manual e aprovação explícita. Não declare aprovação humana sem registro do proprietário.

## Manutenção

Antes de iniciar uma etapa, consulte o roadmap, o ticket e os documentos técnicos e confirme a autorização aplicável. Registre escopo, arquivos, testes executados/omitidos, evidências, riscos e pendências no ticket correspondente. Após validação, atualize status com base em evidência e sincronize roadmap quando status ou aprovação mudar. A reorganização deste índice e dos tickets foi autorizada documentalmente; ela não autoriza implementação das fases.

## Histórico F — execução F0 em 2026-11-10

O ticket pai 0006 contém o filho [0006/0000 — F0](0006-fase-f-regressao-estabilizacao-pos-instalacao/0000-f0-estabilizacao-critica-standalone.md), subdividido em F0-01–07. Os sete lotes foram implementados e os gates automatizados disponíveis passaram após a correção de identidade de arquivo NTFS de 64 bits. F0 aguarda homologação: baseline no HD pessoal, USB físico e instalação do pacote ficaram `NOT RUN`. F1–F4 preservam IDs e permanecem não iniciadas; E continua concluída conforme declaração do proprietário.

**Decisões e escopo F0:** P1 (idle seguro no restart), P2 (recuperação runtime com contenção confirmada) e P3 (JSON Main-only e consistência eventual com revalidação seletiva) estão aprovadas. A autorização global cobre F0-01–07 e avanço automático pelos gates. A matriz de 31 grupos e INS-01–03 foi executada conforme pré-requisitos; nenhuma variante de HD/instalação foi convertida em PASS. Aprovação final F0 pertence ao proprietário e precede F1–F4.

## Histórico do planejamento pareado G/H — antes da aprovação T1

G1–G6 e H1–H8 foram revisadas sem novos IDs ou renumeração. Naquele estado, G/H permaneciam planejadas e G1.1 era a próxima análise proposta. A decisão e o status atuais constam no resumo acima; nenhum código, teste funcional, workflow ou dado operacional foi alterado. F preservada.

## Histórico G1.1 — proposta técnica T1 antes da aprovação

Naquele registro, a análise G1.1 estava concluída e T1 aguardava aprovação. Estado atual: [proposta T1](../g1-1-t1-secure-transport-proposal.md) aprovada em 2026-11-11. O bloqueio inicial de serial foi resolvido pelo proprietário: mínimo de 64 bits de entropia com `selfsigned@5.5.0`. G1.2-A–D estão implementadas; G1.3 segue parcialmente validada, conforme evidências e NOT RUN na proposta e ticket G1. T2 permanece pendente.

## Histórico da revisão T1 — descoberta e vínculo LAN (antes da aprovação)

O proprietário definiu o caminho normal pela UI/LAN sem arquivo/QR/IP/fingerprint obrigatório. O [complemento T1 LAN](../g1-1-t1-lan-pairing.md) recomenda mDNS/DNS-SD, SRP-6a com binding autenticado e consentimento bilateral, reconexão automática G4 e interfaces futuras G5/H4. G1/G2/G4/G5 e plano foram atualizados sem renumeração. Naquele registro, T1 aguardava aprovação; depois foi aprovada. A composição criptográfica exige gate específico G2.1 antes de pairing em produção. A execução ficou bloqueada pelo serial até a decisão posterior do proprietário. O status e os resultados atuais de G1.2/G1.3 estão no resumo desta página e no ticket G1; esse registro histórico não afirma o estado presente.
