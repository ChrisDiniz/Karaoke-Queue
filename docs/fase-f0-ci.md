# F0 — Cobertura no CI existente

Revisão de 2026-11-11. P1/P2/P3 preservadas; F0 não homologada. Nenhuma funcionalidade de produção foi alterada nesta integração. Os workflows continuam sendo `pr-validation.yml` e `release-windows.yml`, com seus jobs e gates anteriores.

## Inventário e alcance

“Já coberto” significa caminho alcançável pelo workflow no working tree anterior a esta tarefa, não resultado remoto comprovado. Os novos arquivos F0 ainda não rastreados precisam ser incluídos no futuro commit; somente compilar localmente não os disponibiliza no GitHub.

| Grupo / arquivos em tests/ (salvo indicação) | Cobertura anterior | Integração / destino |
|---|---|---|
| `video-library.test.ts`, `video-library-index-store.test.ts`, `music-catalog.test.ts` | Linux `test:unit` | Preservada; Windows usa seletor `--video-library`, incluindo store agora |
| `f0-diagnostics.test.ts` | Linux `test:unit` | Preservada |
| `player-playback.test.ts`, `player-playback-recovery.test.ts`, `main-media-runtime.test.ts`, `chromium-playback-host.test.ts` | Linux `test:unit` | Preservada; Windows passa a executar seletor de regressões F0 |
| `player-media-protocol.test.ts` | Linux `test:unit` | Preservada; Windows incluído: Origin/token/Range, revogação durante open, cancelamento, EIO, fechamento tardio |
| `standalone-player-{contracts,runtime,sequence,interaction,interaction-transport,ipc,metadata-preview,options,playback-adapter}.test.ts` | Apenas scripts locais focados; ausentes de `test:unit` | Nove suítes acrescentadas ao gate Linux; runtime/Sequence/IPC e serviços compartilhados também Windows |
| `f0-bootstrap-electron.ts`, `f0-production-bootstrap-entry.ts`, `standalone-player-production-electron.ts` em modo bootstrap/startup | Seletor local Windows de produção; fora do CI | Linux `test:e2e:linux` e Windows `test:ci:f0:windows`: cinco barreiras Main e cinco recoveries herdados, sem MP4 externo |
| `video-library-electron.ts` | Seletor local Windows; fora dos workflows F0 | Windows: filesystem/IPC/Main/SQLite isolados, Player/Combined/compatibilidade Controller/configuração inválida |
| `usb-reconnect-synthetic-electron.ts` | Linux `test:e2e:linux`; local Windows | Preservado Linux; conectado ao job Windows |
| `storage-resilience-electron.ts` | Linux `test:e2e:linux`; local Windows | Preservado Linux; conectado Windows: vídeo WebM gerado, Main/IPC/Renderer, buffer, contenção, filas/prioridade, modal/teclado, recuperação manual, Stop e shutdown |
| `usb-campaign-electron.ts` | Linux `test:e2e:linux`; local Windows | Preservado Linux; conectado Windows: controller/checkpoints simulados e Main real, sem USB |
| `scripts/{usb-reconnect,usb-campaign,windows-native-runner}.test.cjs` | Linux `test:unit` | Preservado; unitários dos runners USB também Windows, sem chamadas físicas |
| `scripts/f0-ci.test.cjs` | Novo | Linux `test:unit` e Windows: seleção sem duplicação, exclusão de manual/mídia externa, fail-fast/exit code/sinal/erro de spawn |
| `standalone-player-production-electron.ts` completo / structural playback, `f0-production-validation.ts`, `player-playback-electron.ts`, `standalone-player-{playback,integration}-electron.ts` | Scripts locais, requerem mídia externa para suas campanhas completas | Fora da seleção automática quando exigem MP4 não versionado. Partes F0 são cobertas pelos unitários e pelos E2Es com mídia gerada; não se afirma equivalência integral das campanhas |
| Baselines F0 com acervos grandes, T2/T4 reais, T3 físico/campanha USB, avaliação A/V | Manual | Continuam fora do CI: hardware/intervenção humana/mídia não versionada |

Timers/countdown/celebração, eventos/ACKs antigos e ordem de prioridade têm cobertura determinística em Sequence/runtime/adapter; janelas físicas curtas não viram assertions de CI. WebM próprio gerado pelo Chromium valida mídia técnica, sem alegar MP4 físico/USB ou qualidade audível.

## Integração mínima

- Linux: acrescentar nove suítes Standalone ao comando existente `test:unit`, três testes de configuração e `f0-bootstrap-electron` à lista existente `run-e2e-linux.cjs`. T3/F0-08/campanha sintéticos já estavam nessa lista e não foram duplicados.
- Windows: um passo `npm run test:ci:f0:windows` em cada job `windows-build`, após build/compile. `scripts/run-f0-ci.cjs` é um adaptador de execução sequencial sobre `selectWindowsTestSuites('--video-library')` do runner oficial; não sincroniza, instala ou cria outra infraestrutura. No GitHub, checkout/dependências/build são responsabilidade dos passos existentes. Na validação WSL local, usar o orquestrador oficial, nunca testes Windows a partir do source WSL.
- Seletor Windows ampliado com store, Chromium host, runtime, bootstrap e configuração. Cada script é executado uma vez por seleção. A repetição Linux/Windows é intencional por plataforma.
- Falha/terminação de um filho interrompe a seleção e retorna código não zero; spawn com erro falha. Variáveis de campanha externa bloqueiam o adaptador antes de spawn.
- Testes físicos permanecem apenas nos aliases `test:manual:*`; nenhum workflow os referencia. Unitários simulam consentimentos/volumes e o PowerShell AST, sem executar consultas a dispositivos.

## Falhas encontradas na descoberta

1. Bootstrap dependia de MP4 externo antes de entrar nas assertions de startup. O harness agora cria sua fixture vazia também para `KQ_F0_BOOTSTRAP_CASE`, mantendo diagnóstico ativo. Essa fixture não é usada como evidência de playback. A tentativa intermediária de habilitar `STARTUP_ONLY` desligou as marcas necessárias e foi descartada; execução Windows intermediária foi cancelada pelo mecanismo oficial, com árvore/lock recuperados.
2. A lista exata esperada no teste do seletor Windows foi ampliada mantendo todos os casos anteriores.
3. Dois unitários antes fora do gate estavam desatualizados: comandos não incluíam as operações F0-08 aprovadas; adapter esperava bloquear recovery antigo. Expectativas agora seguem P1/F0-08, exigindo persistência `dismissed`, idle, ausência de autoplay e nova tentativa distinta. Não foram removidas assertions de falha/uncertainty dos serviços compartilhados/Gestão.

## Evidências locais

- Compile Linux e quatro E2Es focados: PASS antes do reboot. Bootstrap: cinco casos de barreira e cinco estados herdados; T3 sintético, F0-08 e campanha sintética: PASS com Electron/Main/IPC reais. Sem processos Electron dos perfis de teste ao encerrar.
- Windows oficial `--video-library`: PASS, exit 0; 459 unitários em 15 suítes, bootstrap (5+5), biblioteca Electron, T3 sintético, F0-08 e campanha sintética. Perfil/checkout NTFS internos, cleanup e residual-process check PASS. Fingerprint `c37269c90cc6689bc650bbf650637e6dc8e6ab8db9d5c696fce749eecfef22dd`, HEAD `bc3d37de09462485caa9ff027341eeabdd4b88cb`, branch `feature/remote-player-lan-integration-2`. Depois desse snapshot foram ajustadas somente as duas expectativas unitárias Linux descritas acima e documentação; não atribuir esse fingerprint ao working tree final inteiro.
- Os logs `/tmp/f0-ci-*` da etapa anterior foram perdidos no reboot; os resultados/saídas finais foram observados na conversa. Evidências Electron sintéticas Windows foram anunciadas em `%TEMP%\kq-campaign-evidence-huYiIr`. Os novos logs finais Linux são `f0-ci-unit-validation.log` e `f0-ci-workflow-validation.log` na raiz, ignorados pelo Git e fora do snapshot transferido.
- Sintaxe YAML dos dois workflows parseada localmente; testes de configuração verificam os passos reais e ausência de comando físico. GitHub Actions remoto: NOT RUN; nenhum dispatch.

Não há baseline confiável para estimar acréscimo de duração no runner hospedado. Riscos residuais: diferenças de ambiente gráfico/GPU/Chromium hospedado, ausência de MP4 versionado para campanhas completas e validação remota ainda pendente. Os watchdogs existentes não foram aumentados. Preservar FAIL/NOT RUN e investigar a primeira execução hospedada antes de afirmar CI verde. A integração não homologa F0 nem autoriza F1–F4.

Validação final após reboot: `npm run test:unit` **PASS exit 0** (inclui as nove suítes agora descobertas e os três testes do adaptador); `npm run test:release-workflow` **20/20 PASS exit 0**. A compilação faz parte do gate unitário e passou. Os skips de parser PowerShell em Linux são condicionais de plataforma; o parser Windows foi executado na validação nativa. `git diff --check`: PASS.

Contagem dos resumos TAP do gate Linux: 894 casos, 892 PASS e 2 SKIP de plataforma, sem FAIL. Fingerprint de código final (mesmo algoritmo do runner manual, excluindo docs): `74098ec5bbd887739ad1f179e423e06e3e0684b31b7714b33b6f72dbd988d29d`. Esse hash não substitui o fingerprint do snapshot Windows citado acima.

## Auditoria pré-commit do working tree

O proprietário autorizou auditar e consolidar o conjunto F0/CI em commit local antes da avaliação GitHub. Inventário revisado: fontes/documentos/testes em texto, sem mídia, bancos operacionais, perfis, binários, chaves privadas ou logs adicionados ao Git. JSONs e scripts CJS válidos; referências documentais novas resolvidas. Referências históricas a capturas em `/tmp` continuam temporárias e não são artifacts versionados.

A passagem adicional do pipeline Linux completo encontrou uma falha no E2E Round Robin existente (`A2` observado onde a assertion esperava `C1`). O teste original passou isolado, então não se concluiu alteração da regra de negócio. O harness lia a fila antes de aguardar o flush e não observava a publicação da conclusão após o clique. Foi reforçado para capturar a fila após flush, verificar o ID do clique contra o SQLite e aguardar a próxima apresentação esperada antes de permitir outra conclusão. Assertions de ordem, incremento exato do histórico, SQLite, prioridade/pins, cancelamento e reinício permanecem. Nenhuma regra de Gestão foi alterada. A suíte corrigida passou isolada; a repetição completa está registrada em `f0-precommit-e2e-final.log`.

Gates pré-commit: unitários PASS (892 PASS/2 SKIP de plataforma nos resumos TAP), workflow/release 20/20 PASS; compile PASS. Logs persistentes ignorados pelo Git: `f0-precommit-unit.log`, `f0-precommit-workflow.log`, `f0-precommit-e2e.log` (falha inicial), `f0-precommit-round-robin-investigation.log` (original isolado), `f0-precommit-round-robin-final.log` e `f0-precommit-e2e-final.log`. Nenhuma consulta a F:/D:, campanha física, instalação ou dispatch foi feita nesta auditoria.

Resultado final da auditoria pré-commit: **17/17 suítes do pipeline `npm run test:e2e:linux` PASS, exit 0**, após a sincronização do harness Round Robin. Inclui Gestão/SQLite, arraste, Round Robin/cadência, persistência/crash, sessões, licenciamento, menus, sugestões, sidebar, diagnóstico, bootstrap e três E2Es sintéticos F0. Compile, unitários e configuração/release PASS; nenhum processo Electron Linux residual. `git diff --check` PASS. Nenhum bloqueador restante identificado para consolidar o commit e realizar a avaliação GitHub; os limites físicos/de homologação permanecem. O commit local foi autorizado; push e execução remota ficam a cargo do proprietário.
