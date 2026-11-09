# 0005/0005 — E5: Atualizações, migração e validação

## Identificação

- Ticket: 0005/0005
- Ticket pai: 0005 — Fase E: Consolidação de funções, instalador e gerenciamento
- Etapa canônica: E5
- Status: Em revisão — CI/NSIS silencioso install-uninstall-reinstall e preservação integral PASS; matriz restante/recovery/homologação pendentes
- Roadmap: [Roadmap Standalone/Combined](../../standalone-player-roadmap.md)

## Objetivo

Implementar e validar os fluxos de atualização, migração, rollback e preservação de dados conforme A5/A6 aprovadas, a estratégia técnica detalhada em E1 e a matriz confirmada em E3.

## Escopo

- Atualização entre versões, reinstalação e migração de instalações legadas.
- Preservação da função escolhida, `userData`, SQLite, sessões, histórico, filas persistidas quando aplicável, biblioteca, catálogo, preferências e dados de recovery.
- Preservação da escolha persistida em updates/reinstalação sem reexibir a seleção inicial ou redefinir a função; configuração de biblioteca adiada também permanece segura.
- Testes de identidade Windows (atalhos, título/ícone da janela e taskbar conforme suporte), troca via manutenção, reinicialização e isolamento entre perfis/contas conforme E1/E3.
- Rollback e recuperação após falha conforme a estratégia E3.
- Verificação em Windows nativo com perfis isolados.
- Não inventar conversão automática de bancos ou fusão de perfis.
- Usar um único launcher manual oficial e perfis separados para validar Reprodutor e Tudo em um; qualquer override de automação fica restrito a perfis de teste e não enfraquece exclusividade de produção.
- Auditar workflows GitHub Actions existentes antes de adicionar CI; reutilizar o build Windows/NSIS quando aplicável e identificar artifacts de validação por commit/fingerprint.
- Não publicar GitHub Release automaticamente, fazer deploy/push nem usar credenciais reais de assinatura para os artifacts E/F. Distinguir smoke de executável empacotado de teste de instalação NSIS.

## Dependências

- E3 concluída/aprovada: exclusividade comprovada e matriz de migração/preservação/recuperação confirmada, sob A5/A6 já aprovadas.
- E1 concluída/aprovada: gate técnico E1-01 aceito e instalador/seleção funcionais; exclusividade global implementada/comprovada em E3.
- E2 concluída/aprovada: identidade e atalhos funcionais.
- E4 concluída/aprovada: manutenção e alteração de função funcionais.
- Autorização explícita do proprietário para iniciar E5.

## Atividades planejadas

- Implementar os caminhos de update, reinstalação e migração aprovados.
- Validar persistência da função e integridade dos dados antes/depois de cada fluxo.
- Exercitar rollback e recuperação de falhas parciais sem sobrescrever perfis ou apagar evidências.
- Testar troca de função e atualização de atalhos após reinicialização.
- Registrar compatibilidade, limitações e evidências do pacote instalado.

## Critérios de conclusão

- Update e reinstalação preservam função, `userData` e dados cobertos pela estratégia.
- Reinício e update mantêm a função e não repetem onboarding; biblioteca/catálogo e preferências persistem segundo a estratégia aprovada.
- Migração legada segue decisões aprovadas, sem conversão ou fusão presumida.
- Identidade/atalhos seguem a mesma função após update ou manutenção; artifacts automatizados apontam ao commit/fingerprint validado e não criam Releases.
- Rollback/recuperação são exercitados nos cenários definidos em E3 e não causam perda silenciosa de dados.
- Troca de função, atalhos e persistência são verificados após reinicialização.
- Resultados de testes Windows e limites de compatibilidade ficam registrados.

## Validação prevista

Executar instalações/updates/reinstalações e cenários de migração em Windows nativo com perfis e bancos temporários isolados. Inspecionar dados antes/depois, testar rollback e recuperação de falhas, confirmar função/atalhos depois de reiniciar e registrar resultados sem declarar produto Combined completo.

## Decisões aprovadas

- Updates preservam a função escolhida e dados existentes.
- Alterar função não apaga os dados da função anterior.
- Não presumir conversão automática de bancos ou fusão de perfis.
- A5/A6 aprovam a direção arquitetural; E1 detalha/verifica a estratégia, E3 confirma a matriz e E5 implementa/valida os fluxos de dados com dependência de E3–E4.
- O Combined operacional completo permanece na Fase H.

## Pendências

- Cenários concretos de legado, compatibilidade, backup/restore e rollback ainda dependem do detalhamento verificado em E1-01 e da matriz confirmada em E3; A5/A6 não fornecem evidência de execução nem autorização de restauração com possível descarte de dados posteriores.
- Limitações de versão/instalador que exigirem decisão de produto devem ser apresentadas ao proprietário antes de mudar o escopo.

## Riscos

- Atualizações entre versões e instaladores antigos podem deixar dados divergentes ou inacessíveis.
- Downgrade não é estratégia segura de rollback para um banco já alterado.
- Falha parcial pode interromper instalação ou manutenção; dados anteriores devem permanecer recuperáveis conforme E3.

## Aprovações arquiteturais e gates restantes — 2026-11-07

O proprietário aprovou A1–A7 no [plano executivo, seção 3.5](../../fase-e-plano-executivo.md#35-decisões-a1a7-aprovadas-pelo-proprietário--2026-11-07). A5 aprova migração conservadora de instalações legadas: preservar dados/perfis; não mover, converter, fundir ou excluir automaticamente; conflitos não resolvidos bloqueiam operações potencialmente inseguras. A6 exige backups SQLite consistentes, recuperação segura e bloqueio de downgrade incompatível. **Restauração que possa descartar dados posteriores exige autorização específica**, não fornecida pela aprovação arquitetural. Instalar versão anterior não equivale a rollback seguro de SQLite.

A1/A2 mantêm instalação única por máquina, função global e dados operacionais separados por conta Windows; A4 preserva appId e caminhos de dados com identidade por função. Alternativas e riscos da auditoria permanecem no plano como histórico, sem autorização de migração/fusão ou mudança de arquitetura.

**Gates restantes no registro original:** E1-01 verifica viabilidade, implementação, permissões/ACL, NSIS, N-API e recuperação; a matriz de legado/recuperação é detalhada em E1 e confirmada em E3. E5 depende tecnicamente de E1–E4 e de provas reais de backup/restore, upgrade, adoção legada e falhas parciais em ambiente isolado. E0 foi concluída e aprovada pelo proprietário em 2026-11-08. Naquele snapshot, E1-01 documental havia sido executada e E1-02 e posteriores não haviam começado. A autorização posterior de desenvolvimento e o gate vigente estão registrados abaixo; nenhum PASS ou aceite E5 é inferido.

## Atualização E1-01 — 2026-11-08

Seguir também o [contrato técnico E1-01](../../fase-e-e1-01-contrato-instalacao.md), em especial a tabela de ajustes dos lotes desta etapa. A1–A7 permanecem aprovadas; spike S1, aceite do gate e autorização E1-02 ainda pendentes. Esta atualização é documental e não inicia esta etapa nem comprova seus testes.

## Histórico

Ticket planejado e retransferido para a Fase E. O texto inicial registrava a etapa não iniciada; a atualização abaixo documenta a implementação autorizada sem alterar as decisões A5/A6.

## Execução autorizada — 2026-11-08

O proprietário autorizou E5-01→E5-03 como parte do desenvolvimento E1-03→E5-03. A5/A6 e o contrato E1-01 permanecem vinculantes: preservação conservadora, sem mover/converter/fundir/excluir automaticamente, e sem assumir que rollback do instalador reverte schema SQLite. Restore com descarte de dados posteriores exige autorização específica.

- **E5-01 — backup SQLite implementado:** `src/sqlite-migration-backup.ts` cria snapshot consistente via `VACUUM INTO` na conexão owning, publica arquivo+manifesto exclusivos com SHA-256 e valida integridade, FK e `user_version`. `database.ts` cria backup antes de atualizar schema operacional ou catálogo Player. Verificação valida hash/schema e restore copia somente para destino novo e inexistente; não existe caminho que sobrescreva automaticamente o banco ativo.
- **Testes PASS:** `npm run test:unit` PASS, incluindo migração operacional, catálogo Player, checksum, integridade, WAL com commit ainda não checkpointado, restore isolado, detecção de tampering e preservação do banco vivo. `tests/database-migration.test.ts` e `tests/music-catalog.test.ts` usam SQLite real em diretórios temporários.
- **E5-02 — política conservadora implementada:** NSIS detecta entrada per-user em HKCU e bloqueia; manifesto global órfão/estado não configurado não comprovado também bloqueia. Não há migração automática de instalação/perfil/banco. Isso satisfaz fail-closed em conflito observado, mas não comprova atualização, reinstall, adoção, preservação de atalhos/dados ou versões antigas.
- **NOT RUN:** update/reinstall NSIS, troca de função seguida de reboot, N-1 artifact real, downgrade, duas contas, falha de disco/permite Windows, interrupção após replace, restore em cenário de produto, ou limpeza após uninstall no Windows. Nenhum banco/perfil operacional foi aberto ou alterado.
- **Limites:** backup por banco/schema, não conjunto atômico de `karaoke.sqlite` + catálogo ou perfis de todas as contas; sem retenção/expurgo automático; não restaura automaticamente após falha; restore requer seleção/procedimento explícito em destino isolado. A falha de NSIS após substituir binários pode exigir rerun/repair compatível e não é corrigida por restaurar SQLite. A instalação por usuário detectada e o estado órfão permanecem bloqueados para resolução segura.
- **E5-03 — fechamento parcial:** `npm run test:unit`, `npm run test:release-workflow`, packaging config, scripts `node --check` e `git diff --check` passaram. A revisão independente em contexto separado não foi executada; o candidato/artifact atual não foi gerado nem inspecionado, e checklist manual/aprovação do proprietário permanecem pendentes.

**Estado:** E5-01 tem cobertura unitária SQLite real PASS; E5-02 tem comportamento de bloqueio documentado, sem homologação de instalação; E5-03 não pode encerrar a fase. E5 e a Fase E continuam sem PASS/aprovação.

**Gate vigente:** a autorização global posterior cobre o desenvolvimento sequencial até E5-03 sem novas autorizações nominais. As dependências técnicas E1–E4 e toda a matriz de preservação/upgrade/recovery continuam necessárias para aceitar/homologar E5; nenhum NOT RUN foi dispensado e o desenvolvimento não autoriza instalação operacional ou restauração destrutiva.

## Revisão independente inicial — 2026-11-08 (histórico)

R4/R6/R8/R10: revisão independente executada; coordenação NSIS/recuperação e preservação precisam de correções. Sentinel não comprova userData e verificador aceitou output NSIS fracassado. SQLite real local PASS não encerra E5. O fingerprint atual, evidências, recomendações e limites estão no [parecer independente](../../fase-e-revisao-independente.md). **NO-GO para PR de validação até correções; nenhuma aprovação da etapa.** Os registros anteriores de implementação/NOT RUN são históricos, sem promover testes omitidos a PASS.

## Correções da revisão independente — 2026-11-08

R10: build Windows remove selo antigo, sela somente após sucesso e verify rejeita uninstaller intermediário, ausência/divergência de fingerprint e hashes/conjunto incompletos. Testes negativos de provenance PASS; dois builds NSIS fracassados foram recusados e o build atual completo/verificador PASS. O teste de backup SQLite no Windows revelou `EPERM` ao `fsync` em handle read-only; a restauração isolada agora abre o destino em `O_RDWR`, sem alterar bytes, e os 11 testes de migração/SQLite passaram no runner Windows. Candidato não assinado: SHA-256 `6ca793dce7fa8ea1cd6c71f948c025e6f88a9e990a7e31e453c61e300bf87b3b`, fingerprint `03aa4d34e91f5aa8bc102d75d5668f29cffe849925f41715221310bb2cdae173`. NSIS install/update/uninstall, artifact hosted, N-1 real, downgrade/rollback e recuperação instalada continuam NOT RUN; E5 e a Fase E permanecem sem homologação/aprovação. Ver [parecer atualizado](../../fase-e-revisao-independente.md).

## Coordenação estrutural F1–F3 — 2026-11-09

Reinstall só consome tombstone depois da árvore anterior terminar; fences obsoletas abortam antes da remoção. Smoke usa cópia temp do uninstaller e aguarda término real, mantém assertions de pasta/registro/links/perfil e cleanup conservador. Checksum oficial do Electron travado evita SHASUMS redundante sem desabilitar SHA/TLS. Selo rejeita parcial/antigo e inclui 223 inputs; nenhum banco operacional foi aberto pelo helper ou migrado/destruído.

**Evidência atual:** unitários/workflow/proveniência e runner Windows oficial Electron/Playwright/SQLite PASS no snapshot `3432e5d295cbffc241747061fd8704766b68d52f467a34da60dec28e654053fe`. Binding real, árvore de processos e probes NSIS GUI/silencioso/crash/falha/fences PASS em fixtures isoladas. Build NSIS x64/verificador/carga do addon final PASS; inputs `0b407cead36fb204ca2168f12a69a03bed81ab2e78ef92b0abaee0bfd530a423`, candidato SHA-256 `ae69327a4f5a0940fa8cae263478a04856b0124d4c3549fbcee6ac6d639bfd5f`. Atualização posterior somente documental.

[Contrato e matriz de interleavings](../../fase-e-coordenacao-instalacao.md); [parecer, status por achado e logs reproduzíveis](../../fase-e-revisao-independente.md#10-correção-estrutural-da-coordenação-f1f3--2026-11-09). Este registro substitui as descrições históricas de release GUI/abandono normal e o NO-GO anterior, sem apagar evidências.

**Gate:** GO técnico condicionado para revisão final/PR somente de validação. Não houve commit/push/PR/dispatch nem instalação no host. Instalação/update/uninstall/reinstall/crash reais, ACL elevada/cross-account, UAC, duas contas/sessões e validação humana continuam NOT RUN/pendentes. S1 PARTIAL, nenhuma E1–E5 homologada/aprovada; F não iniciada.

## Referências

- [Roadmap Standalone/Combined](../../standalone-player-roadmap.md)
- [Ticket E3 — Exclusividade por computador](0003-e3-exclusividade-por-computador.md)
- [Ticket E1 — Instalador único](0001-e1-instalador-unico-selecao-funcao.md)
- [Ticket E2 — Identidade visual e atalhos](0002-e2-identidade-visual-atalhos.md)
- [Ticket E4 — Manutenção e alteração de função](0004-e4-manutencao-alteracao-funcao.md)
- [Windows release process](../../windows-release-process.md)
- [SQLite persistence safety](../../sqlite-persistence-safety.md)
- [Legacy session compatibility](../../legacy-session-compatibility.md)
- [Windows native testing](../../windows-native-testing.md)

## Cleanup do smoke empacotado no CI — 2026-11-09

EPERM no finally podia ocultar falha anterior e o fechamento suprimia erros. Smoke agora fecha via app.quit/Playwright, exige exit0, aguarda processos da fixture por handles Windows antes de restart/remover e preserva arquivos se término não for comprovado; erros original/cleanup agregados e PASS só após limpeza. Cópia parcial também é registrada como fixture própria. Sem kill, retry arbitrário, mudança de ACL ou relaxamento das assertions SQLite/trial/IPC.

Teste Electron real em cópia temp cobre processo vivo/recusa sem kill, fechamento normal, descendentes e remoção com arquivo readonly. Integrado ao step existente do CI. Runner oficial focado **PASS**, snapshot `396f02660ea56287666ebe2a974a4bbdf420a2c0c0ed6dce9c8417127f5f49a3`; workflow/configuração/proveniência **PASS**. [Parecer, seção 12](../../fase-e-revisao-independente.md#12-cleanup-do-smoke-empacotado-windows--2026-11-09) contém logs e limites. Smoke completo protegido continua NOT RUN localmente e deverá ser confirmado pelo CI após push autorizado. Nenhuma homologação ou instalação operacional.

## Correção complementar: paths equivalentes na detecção de processos — 2026-11-09

O CI revelou lacuna do cleanup: apenas o diretório era normalizado e CIM sem ExecutablePath era descartado. Agora Get-Process fornece os objetos/handles, ambos os caminhos são expandidos via GetLongPathNameW e candidatos não consultáveis falham fechado. Teste exige erro específico de processo vivo e cobre long/long, prefixo estendido, short/long e long/short com alias 8.3 distinto real: **quatro PASS**. Nenhuma assertion de proteção foi removida.

Runner oficial focado, compile/addon/Electron/NSIS/cleanup **PASS**, fingerprint `87c82e883d4cdd910bfeccb28d4531272d8c761c1d5332b639742a8dcd0d0e17`; workflow/proveniência **PASS**. [Evidências, seção 13](../../fase-e-revisao-independente.md#13-detecção-de-processos-por-caminhos-windows-equivalentes--2026-11-09). Execução hosted/instalação protegida pendente; S1 PARTIAL, E1–E5 sem homologação. Commit/push autorizados pelo acompanhamento, sem instalação operacional.

## Fixture canônica antes do startup empacotado — 2026-11-09

Timeout DevTools após inspector Main revelou divergência da fixture: icacls gera D:PAI/ordem diferente do descritor exigido. Reproduzido por readback nativo em temp. Fixture agora criada por CreateDirectoryW com SECURITY_ATTRIBUTES/SDDL iguais ao NSIS e verificação nativa exata. Addon de produção valida diretório/manifesto antes do launch, sem alterar critérios de segurança. Variante sintética restringe-se a temp/SID atual; modo protegido exige GitHub-hosted/caminho conhecido.

Workflow/contratos **PASS**; runner Windows **PASS**, fingerprint `17d612aafe69704236901a2ebc57c8dacab48b82a8812ea88fced2dddc10ed3e`, com readback da criação sintética, lifecycle/caminhos e NSIS. [Detalhes, seção 14](../../fase-e-revisao-independente.md#14-fixture-de-acl-e-timeout-do-main-empacotado--2026-11-09). Preflight BA elevado/startup completo protegido continua NOT RUN localmente, a confirmar no CI após push. Nenhuma instalação/ACL operacional alterada; S1 PARTIAL e E1–E5 não homologadas.

## Falha de download e conclusão supervisionada do build — 2026-11-09

Raw log hosted confirmou HTTP504 na montagem NSIS, sem selo e com build marcado verde. Wrapper agora usa worker Node supervisionado; selo antigo é invalidado antes da tentativa e status zero só é aceito após selo novo e pacote/proveniência verificados pelo supervisor. Falha conserva logs e código não zero; sem alterar critérios de verificação, TLS/SHA, privilégios ou produto. Biblioteca já possui cache/retries limitados; 504 persistente continua FAIL do build, sem artifact aprovado.

Testes de subprocessos (HTTP504 injetado, reset de exitCode, tarefa não concluída, saída antiga) **PASS** em Linux fora do sandbox e Node Windows. Build NSIS x64/verify real **PASS** no snapshot `8f627470086ee5af4f53fa5c4cc8de39ad7c35a5b2c41d2445d4f740a6ddfae5`; candidato SHA-256 `d4e2c7f871fe64b799e10c7d43a05a6f44edb6f687d8152b12c0fd49a51d1bda`. [Evidências, seção 15](../../fase-e-revisao-independente.md#15-http-504-e-falsa-conclusão-do-build--2026-11-09). Reexecução hosted e instalação/startup protegido continuam pendentes; S1 PARTIAL, E1–E5 sem homologação. Commit/push do acompanhamento autorizado, sem dispatch/instalação operacional.

## Sincronização do menu no E2E Linux — 2026-11-09

Falha hosted de abertura por teclado após 4K→1280 não reproduzida na primeira execução local original. Corrigida lacuna verificável do harness: 100ms não confirmava resize/zoom Renderer e o botão não era posicionado no scrollport antes do foco. Agora aguarda viewport/zoom efetivos e confirma foco, mantendo a assertion original; diagnóstico enriquecido, sem retry/timeout maior. Regressão dedicada cobre o percurso e foco da primeira ação/retorno após Escape. Produção/segurança/regras de fila não alteradas.

Compile, suíte isolada e `npm run test:e2e:linux` completo: **PASS, 13 suítes**. [Evidências e limites, seção 16](../../fase-e-revisao-independente.md#16-menu-por-teclado-após-retorno-de-4k--2026-11-09). Reexecução hosted e novo pacote Windows pendentes; não se infere estabilidade CI de um PASS local. Commit/push do acompanhamento autorizado; S1 PARTIAL e E1–E5 sem homologação.


## Manifesto herdado e lifecycle do preflight — 2026-11-09

CI do HEAD e63ead7 recusou manifesto Win32 1336: ACEs corretos, mas bit AI ausente no readback do arquivo. C/NSIS agora normalizam somente esse metadado nos descritores privados, preservando owner, grants, flags ID/P e ACL dos diretórios. Corrigidas comparações textuais NSIS com constantes hexadecimais (atributos e abandono). Preflight .node migrou para subprocesso para não manter DLL da fixture bloqueada no pai.

Workflow/proveniência **PASS 19 testes**; runner oficial focado **PASS**, fingerprint `91c16d37e901bc55b5232e08bdaf8be445d52fb5c31db5e9e068397f55c66ffc`, incluindo addon/Electron real, ACL positiva/negativa, NSIS GUI/silencioso, abandono antes de mutações, fencing e cleanup. [Evidências, seção 17](../../fase-e-revisao-independente.md#17-readback-do-manifesto-atributos-nsis-e-lifecycle-da-dll--2026-11-09). Novo pacote e smoke protegido serão verificados no CI após commit/push autorizados; sem atribuir PASS ao candidato anterior. S1 PARTIAL e homologação E1–E5 pendente.


Acompanhamento do CI 42590711227: Linux/build/verify passaram, mas fixture NSIS substituía o owner BA permitido pelo SID sintético. Corrigida a fixture para preservar BA/SY e admitir SID atual somente no include temporário. Produção inalterada. Runner oficial focado **PASS**, fingerprint `4fc9a38b32d28b880089883b9711aad4bb93e975204225b64e8f986ded0d8224`; readback Owner/Sddl agora nos logs. [Seção 18 do parecer](../../fase-e-revisao-independente.md#18-proprietário-da-fixture-no-runner-elevado--2026-11-09). Smokes protegidos/artifact ainda pendentes do novo CI.


## Fechamento da sessão no smoke empacotado — 2026-11-09

Run 42611452057 passou Linux/build/proveniência/provas nativas e preflight de produção, mas aguardou no smoke empacotado e foi cancelada. O harness não respondia ao diálogo de saída da sessão que ele mesmo criara. Port explícito agora exige pergunta/opções corretas, escolhe sair sem encerrar sessão e registra marcador; término zero, drenagem e persistência após restart continuam obrigatórios. Não é teste visual do diálogo nativo nem bypass do coordenador/flush.

Compile e 5 testes de fechamento **PASS**; 19 de workflow/proveniência **PASS**; função close exata em Electron real/Main dev/SQLite isolado, sandbox Chromium habilitado **PASS**. Runner Windows focado **PASS**, fingerprint `3a49c35d1aba596063fbb7a2869ba3d88e171e6752006b1aeaba7b67a61de8c3`. [Seção 19 do parecer](../../fase-e-revisao-independente.md#19-saída-normal-com-sessão-ativa-no-smoke-empacotado--2026-11-09). Novo pacote/smokes/artifact pendentes do CI do próximo commit. S1 PARTIAL, E1–E5 sem homologação.


CI 42613588237: Linux e build/verificador **PASS**; diagnóstico Get-Acl **FAIL** por autoload de Microsoft.PowerShell.Security no Windows PowerShell hosted; etapas subsequentes **NOT RUN**. Substituída somente a leitura diagnóstica por IO.File.GetAccessControl (owner SID/SDDL, sem modificar ACL nem depender do cmdlet), mantendo status/JSON e testes NSIS positivos/negativos. Leitura real em arquivo temporário Windows **PASS**. [Seção 20](../../fase-e-revisao-independente.md#20-readback-sem-dependência-do-módulo-get-acl--2026-11-09). Nova execução CI exigida.


## Investigação da instalação silenciosa — 2026-11-09

Run 42614670826: primeira tentativa build sofreu crash Node 0xc0000409 e foi recusada; rerun somente do job falho/same SHA gerou build/verify/provas e **smoke empacotado PASS** (IPC, SQLite, licença, fechamento e restart). Instalação NSIS real retornou exit2 antes do artifact; causa ainda não localizada. Hipótese de flag NSIS herdada descartada por teste da função real; mantida nova cobertura de initializer positivo/negativo. Acrescentados códigos por etapa, sem relaxar guardas, e diagnóstico read-only das fixtures. Runner focado **PASS**, fingerprint `c447c7bbd2f25fce5b110c01a7a25b4dfeee76c384e6830a99aff715d156c302`; ajustes diagnósticos posteriores serão validados no CI. [Seção 21](../../fase-e-revisao-independente.md#21-diagnóstico-da-primeira-instalação-nsis-no-hosted--2026-11-09). Artifact/instalação ainda pendentes, E1–E5 sem homologação.


CI 42617458239 localizou o aborto da primeira instalação em FileOpen (215), após Linux/build/verify/provas/smoke empacotado PASS. ClearErrors delimita agora a flag dessa abertura; falha de IO continua fechada e informa 215000+Win32. Diagnóstico read-only usa Write-Host para não ser absorvido pelo retorno da função PowerShell. Origem hosted ainda a comprovar. Runner focado **PASS**, fingerprint `063d5795922f2a67716a8ed0d376351ce6b055d1dcd54308814064b8948b47c6`; prova positiva/negativa de initializer mantida. Instrumentação LF/CRLF validada por novo unitário; workflow/proveniência **PASS 20**. [Seção 22](../../fase-e-revisao-independente.md#22-abertura-do-manifesto-inicial--2026-11-09). Artifact e instalação real ainda pendentes.


## Preservação integral do perfil pelo helper — 2026-11-09

Run 42619186632: instalação NSIS e ACL de produção passaram; uninstall com Main ativo foi recusado com exit32/estado intacto. Uninstall normal detectou alteração de ShaderCache/index no userData. Reproduzido com Main real/rejeição administrativa em perfil sintético após drenagem: aguardar ready inicializava cache Chromium. Dispatcher passou a executar síncrono antes de ready, com os mesmos controles e sem runtime/Renderer/SQLite. Nenhum arquivo foi excluído da comparação.

Compile, 47 unitários de instalação+5 de binding e 20 de workflow/proveniência **PASS**. Runner Windows real **PASS**, fingerprint `9eedc1950675625bad917dfa4bd7550a64282198a67228750e42e4bdc70e98ae`: perfil aquecido byte a byte igual, perfil novo sem conteúdo, shell .lnk pré-ready validado. Electron cria contêiner vazio antes do JS; controle mínimo comprova esse baseline, sem contar diretório vazio como perfil operacional inicializado. Probes NSIS drenam descendentes antes dos hashes/cleanup. [Seção 23](../../fase-e-revisao-independente.md#23-helper-administrativo-sem-inicialização-do-perfil-chromium--2026-11-09). Smoke NSIS completo e artifact do novo SHA continuam a validar no CI; E1–E5 sem homologação.


### Primeiro CI integral e artifact — 2026-11-09

Run [42622477298](https://github.com/ChrisDiniz/Karaoke-Queue/actions/runs/42622477298), HEAD b92e950: ambos os jobs PASS; build/verify/N-API, provas nativas, smoke empacotado e NSIS silencioso install/uninstall/reinstall passaram, incluindo atalhos, recusa com Main ativo, tombstone e preservação de todos os arquivos do userData. Artifact baixado e SHA-256 verificado. [Snapshot, hash e limites](../../fase-e-revisao-independente.md#24-primeiro-ci-integral-pass-e-artifact--2026-11-09). Isso certifica somente os cenários executados; UAC interativo, contas/sessões, legado/N-1, manutenção interativa e aceite humano permanecem pendentes. Etapa sem homologação/aprovação; S1 PARTIAL.


### Ajustes solicitados pelo proprietário — 2026-11-09

Implementação de seletor de local protegido, manutenção informativa, nova escolha de função após uninstall/reinstall e Welcome com indexação/importação e relatório compartilhado. [Contrato, testes e resultados](../../fase-e-ajustes-instalacao-onboarding.md). Preserva bancos/perfis e protocolo de exclusão/fences; CI anterior não certifica esta alteração. Homologação da etapa permanece pendente.
