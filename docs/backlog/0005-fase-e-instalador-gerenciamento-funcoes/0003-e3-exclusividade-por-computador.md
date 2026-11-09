# 0005/0003 — E3: Exclusividade de uma função por computador

## Identificação

- Ticket: 0005/0003
- Ticket pai: 0005 — Fase E: Consolidação de funções, instalador e gerenciamento
- Etapa canônica: E3
- Status: Em revisão — mutex/árvore Win32 e ownership NSIS real PASS; ACL elevada, cross-account e sessões pendentes
- Roadmap: [Roadmap Standalone/Combined](../../standalone-player-roadmap.md)

## Objetivo

Implementar e validar a regra aprovada de uma única função instalada/ativa por computador, incluindo os limites entre contas Windows, conforme a estratégia técnica aprovada.

## Escopo

- Auditar/confirmar Electron Builder/NSIS e a instalação por máquina aprovada em A1, privilégios, múltiplas contas Windows, instalações existentes, locks e perfis antes de implementar exclusividade.
- Verificar o limite do lock atual por `userData`; não tratá-lo como garantia entre contas/perfis.
- Definir e implementar onde a função escolhida fica persistida e como as contas Windows observam uma escolha consistente dentro do escopo aprovado. Não usar `userData` individual como garantia por computador.
- Avaliar ACL/permissões para estado compartilhado, locks e atalhos globais. Não exigir privilégio administrativo silenciosamente; A1 já define instalação por máquina; E1-01 deve verificar as permissões/ACL e a implementação concreta.
- Aplicar mecanismo que impeça instalações, processos ou autoridades de função paralelos dentro do escopo aprovado para o computador, preservando um único executável e instalador.
- Proteger configuração da função, `userData`, bancos SQLite, biblioteca, catálogo e recovery; detectar cenários existentes e falhas parciais.
- Preservar componentes compartilhados e dados de funções anteriores. Não converter bancos nem fundir perfis sem decisão aprovada.
- Rejeitar ou recuperar estado parcial sem reportar sucesso antes de confirmar função, exclusividade e dados; não remover atalhos/dados ou deixar locks órfãos silenciosamente.
- Documentar incompatibilidades e resultados entre contas Windows quando o mecanismo aprovado os exigir.

## Dependências e gates

- E1 concluída/aprovada, incluindo gate técnico E1-01 verificado e aceito antes de E1-02; A1–A7 aprovadas não dispensam comprovação da implementação global em E3.
- E2 concluída/aprovada conforme a ordem do fluxo de instalação e identidade.
- Autorização explícita do proprietário para iniciar E3.

## Atividades

- Revisar a estratégia documentada e aprovada, sem substituir decisões pendentes por hipótese.
- Implementar a garantia de exclusividade conforme o escopo de usuário/máquina definido.
- Testar instalação, seleção no primeiro launch, inicialização e concorrência em perfis e contas Windows reais do escopo aprovado, usando o mesmo launcher manual e/ou executável de produção isolado.
- Testar seleção simultânea, instalação/processo já ativo, reinicialização e reanexação; confirmar que não surgem duas funções/autoridades.
- Exercitar falhas parciais nas etapas de persistência/identidade/atalhos/lock, sem deixar função, atalhos, locks ou dados silenciosamente inconsistentes.
- Testar permissões de estado/atalhos compartilhados sem assumir elevação administrativa.

## Critérios de conclusão

- Uma função por computador é garantida no escopo de contas Windows aprovado e testado.
- O resultado não depende somente do lock por perfil quando a regra exige exclusividade entre perfis/contas.
- Todas as contas cobertas leem a mesma função confirmada; apenas uma instalação/processo autorizado opera por computador conforme a estratégia aprovada.
- Instalações existentes, configurações e bancos são preservados conforme a estratégia aprovada.
- Falhas de instalação/ativação mantêm estado recuperável e são reportadas.

## Aprovações arquiteturais e gates restantes — 2026-11-07

O proprietário aprovou A1–A7 no [plano executivo, seção 3.5](../../fase-e-plano-executivo.md#35-decisões-a1a7-aprovadas-pelo-proprietário--2026-11-07). A1/A2 definem instalação única por máquina, função global por computador e `userData`, SQLite, históricos, sessões, bibliotecas e configurações operacionais separados por conta Windows. A3 aprova exclusividade global via mutex Win32, preferencialmente binding N-API mínimo, **condicionada à comprovação técnica real no Windows/Electron empacotado**. Se inviável, apresentar alternativa para nova aprovação; não substituir o mecanismo silenciosamente. A5/A6 preservam dados/perfis, bloqueiam conflitos inseguros e exigem recuperação segura sem downgrade incompatível.

**Gates restantes no registro original:** E1-01 verifica viabilidade, implementação concreta, permissões/ACL, NSIS, N-API e recuperação; E3 precisa comprovar mutex/ownership/lifecycle/ACL e exclusividade entre contas/sessões reais no Electron empacotado. O lock por perfil não é garantia global. E0 foi concluída e aprovada pelo proprietário em 2026-11-08. Naquele snapshot, E1-01 documental havia sido executada e os lotes seguintes ainda não haviam começado. A autorização de desenvolvimento posterior e o gate vigente estão registrados abaixo. A3 não equivale a implementação comprovada, teste PASS ou etapa concluída.

## Atualização E1-01 — 2026-11-08

Seguir também o [contrato técnico E1-01](../../fase-e-e1-01-contrato-instalacao.md), em especial a tabela de ajustes dos lotes desta etapa. A1–A7 permanecem aprovadas; spike S1, aceite do gate e autorização E1-02 ainda pendentes. Esta atualização é documental e não inicia esta etapa nem comprova seus testes.

## Histórico

Conteúdo redistribuído das antigas etapas D1 (auditoria/estratégia) e D2 (implementação de instalador/exclusividade). Naquela reorganização documental, nenhuma estratégia ou implementação havia sido aprovada/iniciada. O registro de aprovação arquitetural de 2026-11-07 acima é posterior a esse histórico e não inicia execução.

## Execução autorizada — 2026-11-08

O proprietário autorizou E3-01/E3-02 no conjunto E1-03→E5-03. A3 continua condicionada à comprovação técnica real do binding no Windows/Electron empacotado; o desenvolvimento do mecanismo não transforma exclusividade em PASS.

- **E3-01 — implementação:** `build-resources/native/kq-win32.c` implementa mutex `Global\com.karaoke.queue.runtime.v1`, DACL restrita e verificação exata de DACL/label, detecção de abandono e ownership pela mesma thread. `src/installation-runtime-gate.ts` e `src/installation-bootstrap.ts` adquirem o gate antes de carregar a composição operacional/bancos; o lock Electron por perfil permanece para foco/segunda instância local. O harness `scripts/windows-runtime-mutex-electron.cjs` compila addon de teste com nome isolado e cobre reentrada, concorrência, liberação errada, abandono e readback de ACL; o runner oficial também inclui-o. Testes unitários/static do gate e runner passaram.
- **E3-02 — contrato de isolamento:** manifesto global mantém somente a função; SQLite, histórico, sessão, biblioteca, catálogo e preferências continuam em `userData` individual. Cenários de duas contas e sessão não cooperante estão enumerados no plano/ticket; não houve alteração de banco/perfil nem criação de contas.
- **NOT RUN atual:** addon do código atual não foi compilado/carregado em Windows neste fingerprint; nenhum teste do mutex global executado no Electron Windows atual. Sem duas contas/sessões reais, DACL cross-account, conta comum sem escrita, SACL/label independente, competição entre processos do produto, crash/restart ou instalação antiga concorrente. A chamada PowerShell pelo WSL falhou antes do runner (`UtilBindVsockAnyPort:307: socket failed 1`). A evidência S1 de mutex anterior cobria somente protótipo/casos da mesma conta, não o binding atual.

**Estado:** implementação do gate presente e testes locais PASS; A3 e exclusividade de produto não comprovadas. S1 PARTIAL e E3 permanecem sem PASS/aprovação até testes no candidato real e cobertura cross-account/sessões.

**Gate vigente:** a autorização global posterior permite desenvolver E3 na sequência E1-03→E5-03 sem nova autorização nominal. As dependências técnicas e provas de A3 acima permanecem requisitos para declarar E3 concluída/homologada. Desenvolvimento do mutex não comprova o addon atual, ACL entre contas, duas sessões ou exclusividade de produto.

## Revisão independente inicial — 2026-11-08 (histórico)

R2/R3/R4: compilação e carga atuais demonstradas, mas primeira aquisição do mutex no Electron falhou com acl_error 1336. Bootstrap não relê função sob gate e NSIS não coordena update. Não há garantia E3 comprovada. O fingerprint atual, evidências, recomendações e limites estão no [parecer independente](../../fase-e-revisao-independente.md). **NO-GO para PR de validação até correções; nenhuma aprovação da etapa.** Os registros anteriores de implementação/NOT RUN são históricos, sem promover testes omitidos a PASS.

## Correções da revisão independente — 2026-11-08

R2: comparação de ACL/label corrigida; o runner Windows compilou o addon x64 e o Electron real passou contenção, ownership por thread, release, abandono e readback de ACL no mutex de teste. R3: bootstrap agora adquire o gate global antes de ler/revalidar a função; testes unitários e runner Windows final PASS. Fingerprint do snapshot: `03aa4d34e91f5aa8bc102d75d5668f29cffe849925f41715221310bb2cdae173`. Isso comprova os caminhos automatizados numa conta/desktop descartável, não exclusividade entre contas/sessões, low-integrity, instalação existente concorrente ou crash/restart de produto instalado; esses cenários permanecem NOT RUN. S1 continua PARTIAL e E3 segue sem homologação/aprovação. Ver [parecer atualizado](../../fase-e-revisao-independente.md).

## Evidências Windows após correções dos bloqueios finais — 2026-11-09

No snapshot `3485486b7bffb7470863c124b792def0cdd5daa1d26c0775c94496cf18771d60`, o runner oficial Windows compilou o addon nativo de teste com a mesma fonte Win32 e carregou-o no Electron 45 real. Passaram contenção entre processos, ownership por thread, release, mutex abandonado e readback ACL. O build candidato também compilou o binding de produção x64 para Electron 45, incluiu-o fora do ASAR e verificou o PE; uma carga isolada do `.node` empacotado pelo Electron 45 passou sem iniciar Main.

A coordenação do uninstall NSIS foi estendida para conservar os mutexes admin→runtime durante toda a seção de remoção. Em GUI, `un.onGUIEnd` libera os locks; em modo silencioso, NSIS omite callbacks GUI, então a thread proprietária termina após a seção e o Windows sinaliza o mutex abandonado. O tombstone impede startup operacional e exige retry/reinstall para reconciliação. Testes estáticos protegem a ordem/lifecycle; testes unitários cobrem tombstone, repetição, falha parcial/reinstall e preservação sintética. A semântica de callbacks NSIS e abandono de mutex está documentada em [NSIS](https://nsis.sourceforge.io/Docs/Chapter4.html?title=MessageBox) e [Win32](https://learn.microsoft.com/en-us/windows/win32/sync/mutex-objects), mas instalação e uninstall concorrente reais permanecem **NOT RUN**, assim como duas contas/sessões, low-integrity e usuário sem escrita. Portanto A3 e exclusividade global não estão homologadas.

Fingerprint dos inputs selados: `3cb0090a142900f8dcd534bd41b51ef930d1e1e5f15bc6f9f86db97fe4bbfae4`; SHA-256 do instalador candidato: `b8aef4fb40db719e554f849e3a07c72ec34cda59f4a59a22d09d67d709266885`. Nenhuma instalação, alteração de ACL/conta, ProgramData ou Program Files foi feita no host. S1 continua PARTIAL; E3 segue em revisão, sem homologação/aprovação.

## Coordenação estrutural F1–F3 — 2026-11-09

Job Object global coordena árvores NSIS/helper sem substituir o mutex runtime A3. Outra operação não pode consumir tombstone enquanto houver membro vivo; filho sobrevivente mantém a barreira após parent crash. Helpers exigem fences sob admin→runtime; NSIS revalida instalação/geração/ID/tipo antes de remover. GUI/silencioso liberam na worker, erros/abandono falham fechado.

**Evidência atual:** unitários/workflow/proveniência e runner Windows oficial Electron/Playwright/SQLite PASS no snapshot `3432e5d295cbffc241747061fd8704766b68d52f467a34da60dec28e654053fe`. Binding real, árvore de processos e probes NSIS GUI/silencioso/crash/falha/fences PASS em fixtures isoladas. Build NSIS x64/verificador/carga do addon final PASS; inputs `0b407cead36fb204ca2168f12a69a03bed81ab2e78ef92b0abaee0bfd530a423`, candidato SHA-256 `ae69327a4f5a0940fa8cae263478a04856b0124d4c3549fbcee6ac6d639bfd5f`. Atualização posterior somente documental.

[Contrato e matriz de interleavings](../../fase-e-coordenacao-instalacao.md); [parecer, status por achado e logs reproduzíveis](../../fase-e-revisao-independente.md#10-correção-estrutural-da-coordenação-f1f3--2026-11-09). Este registro substitui as descrições históricas de release GUI/abandono normal e o NO-GO anterior, sem apagar evidências.

**Gate:** GO técnico condicionado para revisão final/PR somente de validação. Não houve commit/push/PR/dispatch nem instalação no host. Instalação/update/uninstall/reinstall/crash reais, ACL elevada/cross-account, UAC, duas contas/sessões e validação humana continuam NOT RUN/pendentes. S1 PARTIAL, nenhuma E1–E5 homologada/aprovada; F não iniciada.

## Referências

- [Roadmap Standalone/Combined](../../standalone-player-roadmap.md)
- [Ticket E1 — Instalador único](0001-e1-instalador-unico-selecao-funcao.md)
- [Windows release process](../../windows-release-process.md)
- [SQLite persistence safety](../../sqlite-persistence-safety.md)
- [Remote player architecture](../../remote-player-architecture.md)
- [Legacy session compatibility](../../legacy-session-compatibility.md)
- [Windows native testing](../../windows-native-testing.md)
