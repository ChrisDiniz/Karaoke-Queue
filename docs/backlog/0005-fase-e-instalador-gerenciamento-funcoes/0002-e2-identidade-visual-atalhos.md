# 0005/0002 — E2: Identidade Windows, atalhos e barra de tarefas

## Identificação

- Ticket: 0005/0002
- Ticket pai: 0005 — Fase E: Consolidação de funções, instalador e gerenciamento
- Etapa canônica: E2
- Status: Em revisão — links bootstrap pertencem ao helper; shell e atalhos NSIS silencioso PASS; validação visual/identidade por função pendente
- Roadmap: [Roadmap Standalone/Combined](../../standalone-player-roadmap.md)

## Objetivo

Aplicar a identidade Windows correspondente à função escolhida (Reprodutor ou Tudo em um) mantendo um executável e o instalador comum. A estratégia de ativos, nomes e integração com Windows deve respeitar os frames e aprovações visuais existentes; não inventar ícones ou telas.

## Escopo

- Aplicar o nome apresentado ao usuário e ícone de atalho apropriados à função, mantendo as duas funções no mesmo executável.
- Criar/atualizar somente o atalho correspondente na área de trabalho e no menu Iniciar, conforme a escolha persistida e o escopo de permissões aprovado.
- Aplicar título e ícone da janela e avaliar a identidade da barra de tarefas pelo suporte real do Electron/Windows, incluindo AppUserModelID quando apropriado.
- Testar as APIs disponíveis do Electron/Windows em versão empacotada; documentar quais superfícies aceitam identidade dinâmica.
- O instalador/ícone incorporado ao `.exe` pode manter identidade genérica. Não modificar binários já instalados para trocar o ícone e não presumir que atualizar um atalho altere o executável ou todas as superfícies da taskbar.
- Definir tratamento recuperável/idempotente para falha parcial ao aplicar nome, atalho, ícone, janela ou taskbar; só reportar identidade aplicada quando as superfícies necessárias estiverem confirmadas.
- Evitar atalhos duplicados, incorretos ou inconsistentes.
- Garantir que atualizações não recriem atalhos da função errada.
- Preservar a configuração de função estabelecida pela E1.

## Dependências

- E1 funcional e função instalada/persistida segundo a estratégia aprovada em E1.
- Autorização explícita do proprietário para iniciar E2.

## Atividades planejadas

- Auditar comportamento de AppUserModelID, ícone/título de janela, atalhos e taskbar antes de escolher as APIs; separar identidade genérica do executável da identidade por função.
- Aplicar nome/descrição, ícone de atalho, título/ícone de janela, AppUserModelID/taskbar e destinos de acordo com a função persistida e estratégia E1.
- Testar os dois modos com o launcher manual oficial e perfis isolados; validar atalhos/identidade no Windows nativo sem criar launcher por função.
- Verificar persistência após restart/update e atualização dos atalhos pela manutenção E4, sem modificar `.exe` instalado.
- Injetar falhas nas etapas de atualização de identidade/atalhos e confirmar recuperação sem atalhos duplicados ou estado silenciosamente divergente.

## Critérios de conclusão

- As superfícies Windows que suportam identidade por função (nome, atalho, janela e taskbar conforme APIs testadas) correspondem à função escolhida; limites da identidade genérica incorporada no `.exe` ficam explícitos.
- Somente o atalho da função escolhida existe nos escopos aprovados após configuração/alteração; nenhum atalho paralelo é criado por permissões silenciosas.
- Atualizações preservam a função e não recriam atalhos incorretos ou duplicados.
- A identidade visual é mantida sem criar um sistema de instalação separado desnecessário.

## Validação prevista

Em Windows nativo, inspecionar nome/ícone/destino dos atalhos Desktop e Start Menu, título/ícone da janela e taskbar/AppUserModelID em cada função. Confirmar persistência após restart/update. Testar a troca somente após E4 implementar manutenção. Usar um mesmo launcher manual com perfis separados para os dois cenários de produto; testes automatizados devem usar o modo de produção empacotado e respeitar a estratégia E3.

## Decisões aprovadas

- Reprodutor e Tudo em um terão identidade visual distinguível.
- Só os atalhos da função selecionada serão criados.
- Componentes compartilhados não exigem aplicativos ou instaladores independentes.

## Pendências

- Ativos finais de ícones, nomes e descrições seguem sujeitos à referência aprovada e à validação visual; A4 aprova a arquitetura de identidade, não esses ativos finais.
- Comportamento de atualização de atalhos deve seguir a estratégia aprovada na E1 e a função estabelecida na E1.

## Riscos

- Metadados de pacote ou atalhos podem divergir da função efetivamente configurada.
- Uma atualização pode recriar atalhos legados de outra função se o estado de instalação não for consultado corretamente.

## Aprovações arquiteturais e gates restantes — 2026-11-07

O proprietário aprovou A1–A7 no [plano executivo, seção 3.5](../../fase-e-plano-executivo.md#35-decisões-a1a7-aprovadas-pelo-proprietário--2026-11-07). Para E2, A4 aprova um executável genérico com nomes, títulos, ícones, AppUserModelID e atalhos específicos por função, preservando appId e caminhos de dados. Ativos visuais finais continuam sujeitos à referência aprovada. A1/A2 mantêm instalação única por máquina, função global e dados operacionais separados por conta; permissões e ACL concretas dos atalhos/estado global ainda serão verificadas em E1-01.

**Gates restantes no registro original:** E1-01 deveria verificar o detalhamento antes de liberar E1-02, e E2 dependia de E1 aprovada e autorização própria. APIs/superfícies Windows, persistência da identidade e falhas parciais exigem testes reais no pacote; A4 não é comprovação técnica nem aceitação dos ativos finais. E0 foi concluída e aprovada pelo proprietário em 2026-11-08 após validação manual Windows PASS. Naquele snapshot, E1-01 documental havia sido executada e E1-02 e posteriores não haviam começado. A autorização de desenvolvimento posterior e o gate vigente estão registrados abaixo; nenhum PASS técnico ou aceite visual é inferido.

## Atualização E1-01 — 2026-11-08

Seguir também o [contrato técnico E1-01](../../fase-e-e1-01-contrato-instalacao.md), em especial a tabela de ajustes dos lotes desta etapa. A1–A7 permanecem aprovadas; spike S1, aceite do gate e autorização E1-02 ainda pendentes. Esta atualização é documental e não inicia esta etapa nem comprova seus testes.

## Histórico

Ticket planejado e reorganizado antes do início da antiga Fase D (instalador, agora Fase E). Nenhuma implementação ou validação foi iniciada.

## Execução autorizada — 2026-11-08

O proprietário autorizou E2-01/E2-02 como parte do desenvolvimento sequencial E1-03→E5-03. Isso não aprova E2 nem altera A4; identidade final e validação visual continuam gates próprios.

- **E2-01 — implementação:** `src/windows-function-identity.ts` define nomes, títulos, AppUserModelID e assets por `player`/`combined`; Main aplica a identidade à janela e ao aplicativo sem mudar `appId`, nome do executável ou caminhos de dados. Os PNG/ICO são gerados deterministicamente por `scripts/build-function-icons.cjs` e empacotados fora do ASAR. `tests/windows-function-identity.test.ts` e `node scripts/packaging-config.test.cjs` passaram.
- **E2-02 — implementação:** `src/installation-shortcuts.ts` sincroniza atalhos comuns por função, valida destino/argumentos/ícone/AUMID por readback, só remove links reconhecidos como do produto e deixa o manifesto pendente até confirmar efeitos. `tests/installation-shortcuts.test.ts` passou; o runner inclui `tests/windows-shell-shortcut-electron.cjs` e o harness do runner passou nos testes estáticos.
- **NOT RUN:** atalhos Shell reais, Explorer/taskbar, AUMID no executável empacotado e restart/troca após NSIS não foram executados para o snapshot atual. O runner Windows atual está indisponível por `UtilBindVsockAnyPort:307: socket failed 1`; a captura Electron atual não iniciou. Evidência Windows do fingerprint E1 anterior não cobre esses arquivos/efeitos posteriores.
- **Doop:** imagens de `rKUlA0rV8m` e `gFR_COs4VP` foram consultadas diretamente; os textos dos cartões e do setup de acervo/CSV correspondem ao código. A promessa de alterar a função em Configurações no primeiro frame conflita com A7 e com o contrato de troca exclusivamente NSIS. O código preserva A7, o frame não foi modificado e não há screenshot Electron atual para aceite visual. Registrar a divergência como pendência, sem declarar PASS visual.

**Estado:** E2-01/E2-02 implementadas com testes locais PASS; testes de integração nativa, imagem do produto e aceite visual NOT RUN. E2 não está aprovada.

**Gate vigente:** a autorização global posterior permite desenvolver E2 dentro da sequência E1-03→E5-03 sem autorizações nominais entre lotes. As dependências técnicas E1/E2 e os critérios de aceite acima continuam obrigatórios para declarar E2 concluída/homologada; desenvolvimento autorizado não significa aprovação, e a evidência Windows/visual ainda pendente não pode ser promovida a PASS.

## Revisão independente inicial — 2026-11-08 (histórico)

R6/R7/R11: runner nativo falhou no cleanup do harness de atalhos, e uninstall não remove links próprios. UI/Explorer/taskbar e correção textual Doop continuam sem homologação. O fingerprint atual, evidências, recomendações e limites estão no [parecer independente](../../fase-e-revisao-independente.md). **NO-GO para PR de validação até correções; nenhuma aprovação da etapa.** Os registros anteriores de implementação/NOT RUN são históricos, sem promover testes omitidos a PASS.

## Correções da revisão independente — 2026-11-08

R6 foi corrigido: o cleanup remove apenas atalhos gerenciados confirmados por destino, argumentos, ícone e AUMID, preservando links conflitantes/de terceiros; testes unitários PASS. R7 foi corrigido e o harness de atalhos passou no runner Windows oficial, incluindo cleanup após saída do Electron e ausência de processo residual. R8 atualizou o sentinel para o `userData` lido do Main empacotado, mas o smoke NSIS que cria/remove o perfil continua NOT RUN. Build/verificador NSIS PASS no fingerprint `03aa4d34e91f5aa8bc102d75d5668f29cffe849925f41715221310bb2cdae173`. Explorer/taskbar, atalhos instalados, comparação de screenshot e a copy divergente do frame `rKUlA0rV8m` continuam pendentes; o frame não foi alterado. E2 segue sem homologação/aprovação. Ver [parecer atualizado](../../fase-e-revisao-independente.md).

## Coordenação estrutural F1–F3 — 2026-11-09

Links bootstrap têm um único writer no helper; retry após commit não repete sincronização. NSIS só confirma instalação após links verificados. Uninstall temporário hash-verificado mantém assertions de remoção dos links próprios. Não houve alteração de UI/frame nesta correção; divergência textual Doop sobre Configurações versus manutenção A7 permanece pendente.

**Evidência atual:** unitários/workflow/proveniência e runner Windows oficial Electron/Playwright/SQLite PASS no snapshot `3432e5d295cbffc241747061fd8704766b68d52f467a34da60dec28e654053fe`. Binding real, árvore de processos e probes NSIS GUI/silencioso/crash/falha/fences PASS em fixtures isoladas. Build NSIS x64/verificador/carga do addon final PASS; inputs `0b407cead36fb204ca2168f12a69a03bed81ab2e78ef92b0abaee0bfd530a423`, candidato SHA-256 `ae69327a4f5a0940fa8cae263478a04856b0124d4c3549fbcee6ac6d639bfd5f`. Atualização posterior somente documental.

[Contrato e matriz de interleavings](../../fase-e-coordenacao-instalacao.md); [parecer, status por achado e logs reproduzíveis](../../fase-e-revisao-independente.md#10-correção-estrutural-da-coordenação-f1f3--2026-11-09). Este registro substitui as descrições históricas de release GUI/abandono normal e o NO-GO anterior, sem apagar evidências.

**Gate:** GO técnico condicionado para revisão final/PR somente de validação. Não houve commit/push/PR/dispatch nem instalação no host. Instalação/update/uninstall/reinstall/crash reais, ACL elevada/cross-account, UAC, duas contas/sessões e validação humana continuam NOT RUN/pendentes. S1 PARTIAL, nenhuma E1–E5 homologada/aprovada; F não iniciada.

## Referências

- [Roadmap Standalone/Combined](../../standalone-player-roadmap.md)
- [Ticket E1 — Instalador e estratégia](0001-e1-instalador-unico-selecao-funcao.md)
- [Ticket E1 — Instalador e estratégia](0001-e1-instalador-unico-selecao-funcao.md)
- [Windows release process](../../windows-release-process.md)


### Primeiro CI integral e artifact — 2026-11-09

Run [42622477298](https://github.com/ChrisDiniz/Karaoke-Queue/actions/runs/42622477298), HEAD b92e950: ambos os jobs PASS; build/verify/N-API, provas nativas, smoke empacotado e NSIS silencioso install/uninstall/reinstall passaram, incluindo atalhos, recusa com Main ativo, tombstone e preservação de todos os arquivos do userData. Artifact baixado e SHA-256 verificado. [Snapshot, hash e limites](../../fase-e-revisao-independente.md#24-primeiro-ci-integral-pass-e-artifact--2026-11-09). Isso certifica somente os cenários executados; UAC interativo, contas/sessões, legado/N-1, manutenção interativa e aceite humano permanecem pendentes. Etapa sem homologação/aprovação; S1 PARTIAL.


### Adição autorizada — ativação Player e fullscreen (2026-11-09)

Proprietário autorizou ativação no topo ocioso do Player e fullscreen a cada início, preservando Tudo em um. Implementação usa o serviço/arquivo de licença existente e sender policy restrita, sem alterar decisões A1–A7. [Contratos, testes e limites](../../fase-e-player-licenca-fullscreen.md). Evidências incrementais locais são discriminadas por snapshot; CI e artifact do novo commit continuam obrigatórios. Sem homologação E2 ou aceite visual presumido.
