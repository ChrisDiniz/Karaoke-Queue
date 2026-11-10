# Fase E — Ativação no Reprodutor e abertura em tela cheia

Solicitação adicional do proprietário em 2026-11-09, com autorização para implementar, testar, documentar, fazer commit/push e acompanhar o PR de validação até gerar artifact. Sem merge; E0 aprovada, E1–E5 sem homologação e S1 PARTIAL.

## Comportamento e contratos

- Reprodutor abre em fullscreen nativo em cada inicialização. F11 continua permitindo sair/voltar; não há loop impondo fullscreen durante o uso. Tudo em um conserva a janela e o dimensionamento atuais. Welcome permanece separado da janela operacional.
- Na tela ociosa do Reprodutor, o topo direito oferece o estado da avaliação e **Ativar Karaoke Queue**. O controle e o diálogo não aparecem em menu, comandos, opções, confirmação de saída, countdown, loading, reprodução, pausa, celebração ou estado técnico não confirmado.
- O diálogo permite digitar/colar a chave, ativar, cancelar e navegar por teclado. Enter/Espaço no botão não viram comandos de música. Escape cancela; Tab/Shift+Tab permanecem no diálogo. O retorno assíncrono do menu não pode retirar o foco de uma interação posterior com a licença.
- Após confirmação persistida, controle e diálogo desaparecem. Reinício e mudança de função reutilizam **o mesmo** `userData/license-state.json` e a mesma `LocalLicenseService`, tanto Player→Combined quanto Combined→Player. Não há arquivo por função, novo trial, migração, fusão de perfis ou cópia da chave. O isolamento por conta Windows continua valendo: isto não cria licenciamento global entre contas.
- [Política de licenciamento existente](licensing.md) preservada: duração, validação no Main, escrita atômica antes da confirmação e ausência da chave em logs/SQLite. Falha de gravação não ativa a interface nem substitui o estado confirmado; nova tentativa usa o serviço real.
- Player recebe somente `license:get-status` e `license:activate` pelo preload sandboxed. Main exige janela proprietária viva, frame principal, URL exata de `standalone-player.html`, função Player e shutdown não iniciado. Nenhuma permissão da Gestão/diagnósticos é concedida ao Player.

## Implementação e referência visual

`src/main-window-factories.ts` define fullscreen somente na factory Standalone. `src/main-controller-ipc.ts` compartilha os dois handlers de licença mantendo autorização distinta por superfície; `main-runtime.ts` compõe o serviço existente. `standalone-player-preload.ts` expõe somente o contrato restrito.

`src/standalone-license-view.ts` controla o diálogo e o estado confirmado; `src/standalone-player-renderer.ts` decide visibilidade a partir do snapshot autoritativo e das superfícies abertas. `scripts/copy-assets.ts` inclui os módulos no bundle existente; nenhuma API Node vai para o Renderer.

Frame Doop `oCIrIjb3Zc` consultado em HTML e imagem, status `ready_for_dev`, 1280×800. O proprietário autorizou explicitamente acrescentar a ativação no topo ocioso; o frame não foi modificado. Capturas Electron 1280×800 em `/tmp/kq-player-license-final-ui/` comparadas com o palco/rodapé de referência. O acréscimo usa a paleta e o diálogo existentes, com Ativar como ação principal. Isto não constitui aceite visual do proprietário.

## Evidências incrementais

| Verificação | Resultado / evidência |
|---|---|
| Compile e testes focados de licença, IPC/política de sender e factories | PASS; `/tmp/kq-player-license-unit-final.log` |
| Suíte unitária completa | PASS; `/tmp/kq-player-license-all-unit.log` |
| Campanha Linux completa de Gestão/Electron/SQLite | PASS; `/tmp/kq-player-license-linux-campaign.log` |
| Teste de persistência Linux, fechamento normal e novo restart com igualdade de todo o estado SQLite | PASS; `/tmp/kq-persistence-shutdown-native2.log` |
| Electron real nas duas funções: chave inválida, avaliação expirada, falha real de filesystem, retry, ativação, restart e troca de função | PASS antes do último ajuste de foco; `/tmp/kq-player-license-linux2.log`; reteste final registrado abaixo |
| Runner oficial Windows: compile, binding/mutex/NSIS de fixture, modos, acervo, catálogo, SQLite e cleanup | PASS no snapshot `36068c62029caa95cf9a2498214fbb895d06de8741570eb6c35bbd97d1694a24`, HEAD base `ae2d714`; `/tmp/kq-player-license-windows.log` |
| Player Main de produção Windows, MP4 da fixture temporária somente leitura, fullscreen/F11, playback, estados sem licença, recovery e shutdown | PASS no snapshot `444a252f4241093742a4a35f50d5392d2f857afb7af6edda81cfabac0913b00f`, mesmo HEAD base; `/tmp/kq-player-license-production-windows.log`. Posteriormente corrigido somente retorno de foco ocioso; não atribuir esse fingerprint ao candidato seguinte |

A primeira execução Linux dentro do sandbox da ferramenta não iniciou Electron: NOT RUN para comportamento. O teste fora desse sandbox passou usando os mesmos argumentos existentes, sem acrescentar bypasses ao Chromium.

### Falhas encontradas e corrigidas durante a validação

- CI [42734516214](https://github.com/ChrisDiniz/Karaoke-Queue/actions/runs/42734516214), HEAD documental `ae2d714`: o teste de persistência consultava o Main depois de solicitar seu fechamento; a desconexão do inspector antes do ACK gerava falso FAIL. Agora o stub da confirmação grava um recibo somente na fixture, os observadores são registrados antes do close, exige-se exit 0 sem signal, exatamente uma confirmação e igualdade de todo o SQLite após restart. Só a desconexão específica durante o close solicitado é aceita; crash, falha de persistência e demais erros continuam FAIL. Não usa término forçado no caminho normal.
- A primeira versão do recibo falhou porque `require` não existe no contexto de `app.evaluate`; substituído por `process.getBuiltinModule`, disponível no Electron efetivo. Reteste de persistência PASS; nenhuma mudança de produção para acomodar o teste.
- Prova específica do botão focado por teclado reproduziu Enter interceptado pelo atalho musical. Corrigido o roteamento somente para o botão da licença; teste exige Enter e Espaço.
- O teste ampliado após voltar de Opções detectou o `requestAnimationFrame` de restauração do menu retirando foco do botão recém-selecionado. A restauração agora preserva foco já transferido para os controles/diálogo de licença, mantendo o retorno habitual ao corpo nas demais situações. Não foi adicionado sleep, retry arbitrário ou timeout maior.

## CI e homologação

O resultado de build NSIS, verify/proveniência, smoke empacotado e instalação/repair/uninstall/reinstall deve ser lido **na execução do PR #4 correspondente ao novo commit**. O artifact anterior de [instalação/onboarding](fase-e-ajustes-instalacao-onboarding.md#resultado-consolidado--ci-integral-pass) comprova somente o snapshot indicado ali; não comprova esta adição.

Não há instalação, elevação, mudança de ACL, Registro ou ProgramData operacional nesta validação local. UAC interativo/conta padrão, contas/sessões diferentes, legado/N-1, interrupção/reboot instalado e julgamento visual/áudio continuam NOT RUN quando não executados. O runner hospedado descartável comprova seus próprios cenários NSIS, não substitui esses gates.

Checklist do proprietário: abrir Player duas vezes e conferir fullscreen/F11; abrir a ativação somente em idle e conferir foco/cancelamento; ativar e reiniciar; trocar função pela manutenção e verificar ausência de novo pedido de chave; conferir que o Tudo em um conserva seu comportamento e dados. Usar artifact identificado por run, SHA de origem e SHA-256 do instalador, sem tratar esta rodada como homologação E1–E5.

Reteste após a correção de foco: **PASS**, `/tmp/kq-player-license-linux-focus.log`. Inclui Enter/Espaço após sair de Comandos/Opções, chave inválida, falha de gravação, retry, ativação nas duas direções, restart e fullscreen. Testes focados novamente PASS em `/tmp/kq-player-license-unit-final.log`.


Reteste final pelo runner oficial Windows: **PASS**, snapshot `f1d03e6e777ee046fb4dfa1a7116304f10676a1da824287410d27f70b2422591`, HEAD base `ae2d7141925346bc4d64c23e76404cfdd2a47777`, código desta adição com a correção de foco. Log `/tmp/kq-player-license-windows-final.log`: binding/mutex/NSIS de fixture, atalhos, modos, licença compartilhada, Enter/Espaço, SQLite, acervo/catálogo e cleanup sem processos residuais. As edições seguintes são somente documentais. Naquele registro pré-push, CI/artifact ainda estavam pendentes; o resultado confirmado está abaixo.


## Fechamento do CI e retomada após reinício — 2026-11-09

Implementação enviada no commit `79f4040d3722723918533d2a90f8bbf116c7c0e9`, branch `feature/remote-player-lan-integration`, PR #4. Run [42737844704](https://github.com/ChrisDiniz/Karaoke-Queue/actions/runs/42737844704) **SUCCESS**, reconfirmada no GitHub após o reinício do computador. O CI testou o merge de validação `4367158d9c9fb33d745ce8a27c9fcedb6af18916` sobre a base `b7516bdaf092a03d841ea8efe3b41785eccdfeb1`; não houve merge do PR.

| Job / comprovação | Resultado |
|---|---|
| [Linux compile, unit and Electron E2E](https://github.com/ChrisDiniz/Karaoke-Queue/actions/runs/42737844704/job/129571347470), 3m37s | PASS: compile, unitários/workflow, Electron, Gestão, licenciamento, SQLite e fechamento/restart |
| [Windows x64 package and smoke test](https://github.com/ChrisDiniz/Karaoke-Queue/actions/runs/42737844704/job/129572741739), 3m42s | PASS: addon N-API x64, NSIS completo, verify/proveniência, mutex/Job/ownership, onboarding/ativação/fullscreen, smoke empacotado e upload |
| Instalação NSIS no runner Windows descartável | PASS: seleção GUI do diretório, manutenção/reparo/cancelamento, recusa de alteração com app ativo, confiança do caminho, uninstall/reinstall e preservação do userData |
| Integridade do artifact baixado | PASS: SHA-256 do exe coincide com manifesto e SHA256SUMS; nova cópia reconferida após o reinício |
| Validação manual do proprietário | EM ANDAMENTO: informou que baixou o artifact e iniciou testes; nenhum PASS manual ou aprovação final foi informado |

Artifact [Karaoke-Queue-PR-4-Windows-x64](https://github.com/ChrisDiniz/Karaoke-Queue/actions/runs/42737844704/artifacts/13727648716), ID `13727648716`, 124.949.973 bytes no ZIP. Instalador `Karaoke-Queue-Setup-0.5.0-x64.exe`, versão 0.5.0 x64, sem assinatura de distribuição.

- SHA-256 do **instalador**: `194d4f933ded71a486401ab06af759d2ad9543c4316986199cf92856fd98cef8`.
- Fingerprint de inputs selado e verificado no Windows: `503d8c40168039cb55f62b61ce52e48a23788b16d510a3f0188efb33f2f84dc7`.
- Digest do **ZIP do Actions**, distinto do exe: `sha256:ff509648ea89750f7c2d34e49355d3c3dfd535e6fb721cb81066ef845874fecb`.
- Manifesto: `sourceSha=4367158d9c9fb33d745ce8a27c9fcedb6af18916`, `runId=42737844704`, packageVerification/packagedElectronSmoke/nsisInstallUninstallSmoke `PASS`, `releasePublished=false`.

As referências `/tmp/` acima são evidências locais históricas e podem desaparecer após reinício; os links dos jobs mantêm a evidência persistente. Na retomada, a cópia temporária antiga do exe ainda tinha o checksum correto, mas seus dois pequenos metadados locais estavam preenchidos com zeros; o motivo não foi estabelecido. Sem alterar essa cópia, um novo download em `%TEMP%\kq-ci-42737844704-rechecked` confirmou manifesto, SHA256SUMS e checksum íntegros. Isso não foi uma falha do CI nem do artifact remoto, e não descreve o download independente do proprietário.

Este complemento é somente documental: o artifact identificado acima continua sendo o candidato de código em teste pelo proprietário. Novos commits documentais não alteram seus inputs de compilação nem constituem nova versão funcional. Permanecem os gates NOT RUN listados acima; S1 PARTIAL e E1–E5 sem homologação. Não houve instalação no host operacional por este agente, Release, tag ou merge.
