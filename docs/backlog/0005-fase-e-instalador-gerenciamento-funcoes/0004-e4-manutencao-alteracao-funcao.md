# 0005/0004 — E4: Manutenção e alteração de função

## Identificação

- Ticket: 0005/0004
- Ticket pai: 0005 — Fase E: Consolidação de funções, instalador e gerenciamento
- Etapa canônica: E4
- Status: Em revisão — F1–F3 corrigidos e provas NSIS de fixtures PASS; manutenção/UAC instalados pendentes
- Roadmap: [Roadmap Standalone/Combined](../../standalone-player-roadmap.md)

## Objetivo

Permitir alteração posterior da função pelo fluxo de manutenção do instalador, sem interromper processos de forma insegura nem destruir dados silenciosamente.

## Escopo

- Detectar instalação existente quando o instalador for executado novamente.
- Oferecer “Alterar função” no fluxo de manutenção.
- Manter a escolha inicial fora do NSIS: somente o onboarding do primeiro launch seleciona a função; configurações normais não oferecem troca.
- Aplicar a alteração pela manutenção do mesmo instalador/executável comum, atualizando a função persistida e identidade/atalhos conforme E1/E2.
- Exigir encerramento seguro do aplicativo e impedir alteração insegura com processos ativos.
- Aplicar a exclusividade cuja estratégia é detalhada em E1 e cuja implementação/comprovação pertence a E3, conforme A3 aprovada.
- Atualizar identidade Windows, AppUserModelID/taskbar e atalhos conforme as capacidades confirmadas em E2.
- Preservar SQLite, sessões, histórico, biblioteca, catálogo, preferências, recovery, configurações, perfis e dados das duas funções; não converter ou fundir implicitamente.
- Tratar falhas parciais segundo a estratégia aprovada.
- Avaliar integração com “Alterar” em Programas e Recursos sem torná-la requisito obrigatório inicial.

## Dependências

- E3 concluída/aprovada: exclusividade global implementada/comprovada e matriz de preservação/recuperação confirmada sob as decisões A1–A7.
- E1 concluída/aprovada: gate técnico E1-01 aceito, instalador e função persistida funcionais; exclusividade global implementada/comprovada em E3.
- E2 concluída/aprovada: identidade e atalhos por função.
- Autorização explícita do proprietário para iniciar E4.

## Atividades planejadas

- Implementar detecção e fluxo de manutenção do instalador.
- Coordenar encerramento/estado dos processos antes da mudança.
- Aplicar nova função e identidade/atalhos sem criar instalações ou autoridades paralelas; não alterar executável binário para trocar ícone.
- Preservar dados e oferecer rollback/recuperação segura em falha parcial, conforme E3; só reportar troca concluída quando função e identidade estiverem confirmadas.
- Validar troca de função em Windows nativo com perfis e bancos isolados.

## Critérios de conclusão

- Reexecutar o instalador detecta a instalação e permite alterar a função.
- A troca é oferecida somente na manutenção do instalador; Configurações do aplicativo não permitem a mudança.
- A troca não prossegue enquanto houver processo incompatível ativo.
- A função, título/ícone da janela, taskbar quando suportada e atalhos correspondem à função final persistida.
- SQLite, sessões, histórico, biblioteca, catálogo, preferências, recovery e configurações são preservados; nenhuma conversão/fusão/exclusão não aprovada ocorre.
- Falha parcial segue o fluxo de recuperação aprovado e não deixa o estado silenciosamente inconsistente.

## Validação prevista

Testar detecção, encerramento, manutenção, troca, exclusividade, identidade/atalhos e preservação após reinício em Windows nativo. Verificar os bancos/perfis antes e depois e exercitar os caminhos de falha definidos em E3. Distinguir smoke de executável empacotado de instalação/alteração interativa NSIS.

## Decisões aprovadas

- A alteração de função ocorre pelo instalador em um fluxo de manutenção.
- O aplicativo deve ser encerrado com segurança e a alteração não pode apagar dados silenciosamente.
- Integração à opção “Alterar” de Programas e Recursos pode ser avaliada, mas não é requisito obrigatório inicial.

## Pendências

- Suporte das páginas nativas NSIS, textos e fluxo final ainda precisam ser verificados/validados conforme A7; recuperação depende do detalhamento E1 e da confirmação E3, sem aprovação antecipada da UI final.
- Avaliação de Programas e Recursos permanece opcional.

## Riscos

- Processo ativo, segunda conta Windows ou atualização concorrente pode impedir uma troca segura.
- Falhas em etapas intermediárias podem deixar função, atalhos e perfis inconsistentes.
- Preservar dados não significa torná-los automaticamente acessíveis à nova função.

## Evidências da coordenação de uninstall — 2026-11-09

O hook de uninstall grava um tombstone durável antes de deixar o helper; o NSIS readquire os mutexes admin→runtime e os mantém durante a seção do electron-builder que remove arquivos e registros. Não há encerramento forçado do aplicativo. No modo GUI, `un.onGUIEnd` libera os locks depois da seção. No modo silencioso, a documentação do NSIS confirma que callbacks GUI não são invocados; a thread proprietária encerra após a seção e o Windows marca o mutex como abandonado. O tombstone mantém o bootstrap operacional bloqueado até retry/reinstall reconciliar a instalação.

`npm run test:unit`, `npm run test:release-workflow`, runner Windows oficial, build NSIS x64 e verificador passaram no snapshot registrado no [ticket E1](0001-e1-instalador-unico-selecao-funcao.md). O candidato NSIS não foi instalado. Uninstall concorrente real, cancelamento, crash durante remoção e retry via NSIS permanecem **NOT RUN**; S1 continua PARTIAL, E4 em revisão e sem homologação/aprovação. As referências de plataforma são [callbacks silenciosos NSIS](https://nsis.sourceforge.io/Docs/Chapter4.html?title=MessageBox) e [mutex Win32 abandonado](https://learn.microsoft.com/en-us/windows/win32/sync/mutex-objects).

## Aprovações arquiteturais e gates restantes — 2026-11-07

O proprietário aprovou A1–A7 no [plano executivo, seção 3.5](../../fase-e-plano-executivo.md#35-decisões-a1a7-aprovadas-pelo-proprietário--2026-11-07). A7 define preferência pela interface nativa NSIS para manutenção, alteração de função e mensagens de erro, evitando UI personalizada desnecessária; **textos e fluxo final permanecem sujeitos à validação**. A1 exige UAC explícito na manutenção, mantendo operação normal sem elevação. A2/A4 preservam dados por conta, executável genérico, appId e paths, atualizando identidade por função. A5/A6 impedem movimentação/conversão/fusão/exclusão automática e downgrade incompatível; restauração que possa descartar dados posteriores requer autorização específica.

**Gates restantes no registro original:** E1-01 deveria verificar implementação, viabilidade, permissões/ACL, NSIS, N-API e recuperação antes de E1-02; E4 depende tecnicamente de E1–E3, suporte NSIS, encerramento seguro, exclusividade e validação de textos/fluxo. A7 não aprova a interface final nem prova recuperação. E0 foi concluída e aprovada pelo proprietário em 2026-11-08. Naquele snapshot, E1-01 estava documentada e E1-02 e posteriores não haviam começado. A autorização posterior de desenvolvimento e o gate vigente estão registrados abaixo; isto não concede PASS nem aprovação de E4.

## Atualização E1-01 — 2026-11-08

Seguir também o [contrato técnico E1-01](../../fase-e-e1-01-contrato-instalacao.md), em especial a tabela de ajustes dos lotes desta etapa. A1–A7 permanecem aprovadas; spike S1, aceite do gate e autorização E1-02 ainda pendentes. Esta atualização é documental e não inicia esta etapa nem comprova seus testes.

## Histórico

No registro histórico de abertura do ticket, E4 estava planejada e não iniciada. Nenhuma implementação ou validação havia sido iniciada naquele snapshot.

## Execução autorizada — 2026-11-08

O proprietário autorizou E4-01/E4-02 como parte do desenvolvimento E1-03→E5-03. A7 permanece: troca exclusivamente pela manutenção NSIS; Configurações normais não alteram função. Textos/fluxo nativo e recuperação final continuam sujeitos à validação.

- **E4-01 — implementação:** `src/installation-control.ts` persiste uma intenção `pending` de troca mantendo a função anterior confirmada, avança geração/identidade somente após efeito/readback, e dá idempotência por `operationId`. `src/installation-admin.ts` exige Windows empacotado, elevação, imagem Program Files, diretório/manifesto protegidos e mutex administrativo + operacional; sincroniza/revalida atalhos antes do commit. `installation-admin-args.ts` aceita somente gramática fixa de troca. NSIS exibe página nativa em manutenção e chama a operação somente depois da seleção/commit do usuário; não há API de troca em Settings.
- **E4-02 — recuperação:** repetição retoma a intenção pendente para a mesma função/operação, divergência bloqueia, e falha em atalho ou ACL deixa estado recuperável sem promover alvo a função confirmada. Teste de retry após falha de atalho está em `tests/installation-admin.test.ts`. `npm run test:unit` e `node scripts/packaging-config.test.cjs` passaram.
- **NOT RUN:** compilação/instalação NSIS do snapshot atual, página interativa, UAC aceitar/cancelar, troca Player↔Combined real, processo ativo em outra conta, falha/reboot entre replace de links e manifesto, reparo após nova execução, inspeção de `Programs and Features` e teste de mensagens. O Windows runner não iniciou no ambiente atual; nenhum host operacional foi elevado.
- **Risco/limite:** o mesmo instalador em modo manutenção não oferece valor pré-selecionado; em updates silenciosos `$KQMaintenanceTargetRole` fica vazio e não troca a função. A instalação após desinstalar deixa estado ProgramData órfão/ambíguo e o instalador fail-closed bloqueia readoção automática conforme A5; esse cenário permanece pendente na matriz E5.

**Estado:** lógica e página de manutenção implementadas, com testes locais PASS. E4 não está homologada ou aprovada sem build/install NSIS, UAC, UI e recovery reais.

**Gate vigente:** a autorização global posterior permite desenvolver E4 na sequência E1-03→E5-03 sem nova autorização nominal. As dependências técnicas de E1–E3 e os critérios de homologação permanecem requisitos para aceitar a etapa; implementação local não substitui instalação/manutenção NSIS, UAC, teste interativo ou recovery real.

## Revisão independente inicial — 2026-11-08 (histórico)

R1/R4/R5/R6: macros NSIS impedem build, template pode forçar término sem flush e não há protocolo seguro durante replace. Pending inicial não tem retomada pelo fluxo NSIS; uninstall deixa atalhos. O fingerprint atual, evidências, recomendações e limites estão no [parecer independente](../../fase-e-revisao-independente.md). **NO-GO para PR de validação até correções; nenhuma aprovação da etapa.** Os registros anteriores de implementação/NOT RUN são históricos, sem promover testes omitidos a PASS.

## Correções da revisão independente — 2026-11-08

R4: removido o encerramento forçado e o plugin de processo ausente; pending durável e locks admin→runtime protegem o replace, com falha fechada se ocupado. R5: `repair-pending` retoma confirmação/troca/update de forma idempotente; R6: o helper de uninstall remove somente atalhos confirmados. Testes unitários e build/verificador NSIS completos PASS na fingerprint `03aa4d34e91f5aa8bc102d75d5668f29cffe849925f41715221310bb2cdae173`. A sequência real de manutenção/update/uninstall, encerramento/flush do processo, cancelamento UAC e recovery após restart continuam NOT RUN; não se declara E4 homologada. Ver [parecer atualizado](../../fase-e-revisao-independente.md).

## Coordenação estrutural F1–F3 — 2026-11-09

Handoff protegido pelo Job Object; manutenção exige associação herdada NSIS, --updated independente não recebe bypass. Seção final obrigatória faz release verificado na mesma worker depois da remoção/registro; não há release GUI nem abandono tratado como sucesso. Confirmação/troca/restore com ACK perdido são idempotentes sem efeitos de links repetidos. Nenhum processo operacional é terminado à força.

**Evidência atual:** unitários/workflow/proveniência e runner Windows oficial Electron/Playwright/SQLite PASS no snapshot `3432e5d295cbffc241747061fd8704766b68d52f467a34da60dec28e654053fe`. Binding real, árvore de processos e probes NSIS GUI/silencioso/crash/falha/fences PASS em fixtures isoladas. Build NSIS x64/verificador/carga do addon final PASS; inputs `0b407cead36fb204ca2168f12a69a03bed81ab2e78ef92b0abaee0bfd530a423`, candidato SHA-256 `ae69327a4f5a0940fa8cae263478a04856b0124d4c3549fbcee6ac6d639bfd5f`. Atualização posterior somente documental.

[Contrato e matriz de interleavings](../../fase-e-coordenacao-instalacao.md); [parecer, status por achado e logs reproduzíveis](../../fase-e-revisao-independente.md#10-correção-estrutural-da-coordenação-f1f3--2026-11-09). Este registro substitui as descrições históricas de release GUI/abandono normal e o NO-GO anterior, sem apagar evidências.

**Gate:** GO técnico condicionado para revisão final/PR somente de validação. Não houve commit/push/PR/dispatch nem instalação no host. Instalação/update/uninstall/reinstall/crash reais, ACL elevada/cross-account, UAC, duas contas/sessões e validação humana continuam NOT RUN/pendentes. S1 PARTIAL, nenhuma E1–E5 homologada/aprovada; F não iniciada.

## Referências

- [Roadmap Standalone/Combined](../../standalone-player-roadmap.md)
- [Ticket E3 — Exclusividade por computador](0003-e3-exclusividade-por-computador.md)
- [Ticket E1 — Instalador único](0001-e1-instalador-unico-selecao-funcao.md)
- [Ticket E2 — Identidade visual e atalhos](0002-e2-identidade-visual-atalhos.md)
- [SQLite persistence safety](../../sqlite-persistence-safety.md)
- [Windows release process](../../windows-release-process.md)


### Primeiro CI integral e artifact — 2026-11-09

Run [42622477298](https://github.com/ChrisDiniz/Karaoke-Queue/actions/runs/42622477298), HEAD b92e950: ambos os jobs PASS; build/verify/N-API, provas nativas, smoke empacotado e NSIS silencioso install/uninstall/reinstall passaram, incluindo atalhos, recusa com Main ativo, tombstone e preservação de todos os arquivos do userData. Artifact baixado e SHA-256 verificado. [Snapshot, hash e limites](../../fase-e-revisao-independente.md#24-primeiro-ci-integral-pass-e-artifact--2026-11-09). Isso certifica somente os cenários executados; UAC interativo, contas/sessões, legado/N-1, manutenção interativa e aceite humano permanecem pendentes. Etapa sem homologação/aprovação; S1 PARTIAL.


### Ajustes solicitados pelo proprietário — 2026-11-09

Implementação de seletor de local protegido, manutenção informativa, nova escolha de função após uninstall/reinstall e Welcome com indexação/importação e relatório compartilhado. [Contrato, testes e resultados](../../fase-e-ajustes-instalacao-onboarding.md). Preserva bancos/perfis e protocolo de exclusão/fences; CI anterior não certifica esta alteração. Homologação da etapa permanece pendente.
