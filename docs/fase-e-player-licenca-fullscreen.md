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


Reteste final pelo runner oficial Windows: **PASS**, snapshot `f1d03e6e777ee046fb4dfa1a7116304f10676a1da824287410d27f70b2422591`, HEAD base `ae2d7141925346bc4d64c23e76404cfdd2a47777`, código desta adição com a correção de foco. Log `/tmp/kq-player-license-windows-final.log`: binding/mutex/NSIS de fixture, atalhos, modos, licença compartilhada, Enter/Espaço, SQLite, acervo/catálogo e cleanup sem processos residuais. As edições seguintes são somente documentais. O CI do novo commit ainda deve gerar e identificar seu próprio candidato/artifact.
