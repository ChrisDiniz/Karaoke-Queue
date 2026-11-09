# Fase E — Parecer da revisão independente

**Atualização vigente após correções F1–F3 — 2026-11-09: GO técnico condicionado para revisão final e PR exclusivamente de validação automatizada.** A seção 10 registra a implementação, revisão própria adicional e evidências do novo candidato; substitui o NO-GO da seção 9, preservada como histórico. Não constitui uma nova revisão independente read-only nem homologação E1–E5. Nesta execução não houve staging, commit, push, PR ou dispatch; a instrução vigente proíbe essas ações.

Data: 2026-11-08. **Recomendação histórica daquele snapshot: NO-GO para o PR de validação.** Houve falhas reproduzidas no Windows e defeitos de coordenação/recovery. A seção de atualização abaixo registra a correção e substitui a recomendação; ela não aprova E1–E5. E0 continua concluída/aprovada; S1 permanece PARTIAL; F não foi iniciada.

## Atualização após correções — 2026-11-08

Esta atualização substitui o status e a recomendação das seções anteriores para os achados R1–R10. A auditoria e seus detalhes continuam preservados como histórico. As correções não alteram A1–A7 nem homologam E1–E5.

### Status dos achados

| Achado | Resultado atual | Evidência e limite |
|---|---|---|
| R1 — NSIS/macro | **Corrigido; build PASS.** Radio buttons usam macros suportadas; `TrimNewLines` e comparação de JSON compilam; removida a dependência do plugin `nsProcess`, ausente no ambiente NSIS efetivo. | Build NSIS x64 completo e `verify:windows-build` PASS na fingerprint `03aa4d34…`; smoke de instalação/upgrade continua NOT RUN. |
| R2 — mutex/ACL 1336 | **Corrigido; Electron Windows PASS.** A validação compara ACEs/label normalizados, e o teste mantém referência ao objeto para comprovar abandono real. | Runner compilou addon Win32 x64 e passou aquisição, contenção, thread ownership, abandono, release e readback de ACL no Electron real. Duas contas/sessões e low-integrity continuam NOT RUN. |
| R3 — corrida função/mutex | **Corrigido; testes automatizados PASS.** Bootstrap adquire o gate global antes de ler/validar função e só então compõe o runtime. | `test:unit` e runner Windows PASS; não substituem competição entre duas contas Windows. |
| R4 — encerramento no update/manutenção | **Corrigido no protocolo; build PASS.** Não há encerramento forçado. A atualização grava pending, adquire mutexes em ordem admin→runtime e deixa a recuperação para a nova versão. Sem plugin de detecção de processo; um lock ocupado falha fechado e pede fechamento normal. | Build NSIS e testes estáticos PASS. Upgrade/manutenção interativos com aplicativo aberto, flush e cancelamento NOT RUN; não afirmar a transição NSIS homologada. |
| R5 — confirmação inicial pendente | **Recovery idempotente implementado; testes unitários PASS.** `repair-pending` retoma a intenção original por `operationId`, sincroniza efeitos e valida readback. | `test:unit` PASS. Reinício real no ramo elevado/UAC continua NOT RUN. |
| R6 — atalhos no uninstall | **Corrigido; testes unitários PASS.** Remove somente atalhos do produto identificados com todos os campos esperados; preserva conflitos/atalhos de terceiros. | Testes do shell/atalhos PASS. Remoção pelo uninstaller real continua NOT RUN. |
| R7 — cleanup do harness | **Corrigido; runner Windows PASS.** Perfil é removido após saída observada do Electron; falha original não é mascarada pelo cleanup. | Harness de atalhos, limpeza e verificação de processo residual passaram no runner atual. |
| R8 — sentinel `userData` | **Cobertura corrigida; teste de contrato PASS.** O smoke consulta o `userData` reportado pelo Main empacotado, grava sentinel SQLite ali e compara conteúdo/hash após uninstall. | Teste estático PASS; smoke NSIS não foi executado no host operacional, pois escreve em Program Files/ProgramData e exige instalação descartável hosted. |
| R9 — CSV inválido após adiar | **Corrigido; Electron Windows PASS.** “Configurar depois” envia configuração vazia, sem reenviar o CSV recusado, e preserva biblioteca já confirmada. | E2E real Main/Renderer/SQLite PASS no runner. |
| R10 — verificador aceita build parcial | **Corrigido; testes negativos e candidato PASS.** Build remove selo anterior, sela somente após sucesso e o verificador exige fingerprint, manifesto e conjunto/hash completos, rejeitando uninstaller intermediário. | Testes de provenance/workflow PASS; dois builds interrompidos anteriores foram recusados pelo verificador; candidato atual passou. |
| R11 — copy Doop/A7 | **Pendente, sem alteração autorizada.** O texto recomendado é dizer que a função muda na manutenção do instalador. | Frame `rKUlA0rV8m` não foi editado; validação textual/visual do proprietário continua pendente. |

### Validação do snapshot e candidato Windows

- Branch `feature/remote-player-lan-integration`, HEAD `10548d54e80825c6e6ddbdaf8f7038207bdabee3`; fingerprint do runner oficial para o snapshot testado: **`03aa4d34e91f5aa8bc102d75d5668f29cffe849925f41715221310bb2cdae173`**. Após esses testes, somente documentos/evidências deste fechamento foram alterados; código, testes e workflows não mudaram.
- Windows nativo: PowerShell `5.1.26100.9711`, Node `v24.11.0 x64`, npm `11.6.1`, Python `3.14.0`, Visual Studio 2019 Build Tools `16.11.36602.28`, Electron `45.0.0` / Node empacotado `24.22.0`.
- `npm run compile`, `npm run test:unit`, `npm run test:release-workflow` e `git diff --check`: **PASS**. O runner Windows oficial também passou compile e regressões com Electron, Playwright e SQLite temporários; incluiu multi-instância/foco, modos/onboarding, Gestão/Combined, Player, catálogo, biblioteca, migrações e cleanup sem processo residual.
- Build `npm run build:windows` e `npm run verify:windows-build`: **PASS**, sem instalar. Addon de produção x64 compilado e carregado pelo Electron empacotado (`loaded:true`, Electron 45.0.0, Node 24.22.0, `elevated:false`). O smoke somente carregou API e consultou elevação.
- Candidato: `E:\KaraokeQueue\e-independent-package3-20261108\checkout\dist\Karaoke-Queue-Setup-0.5.0-x64.exe`; SHA-256 `6ca793dce7fa8ea1cd6c71f948c025e6f88a9e990a7e31e453c61e300bf87b3b`; `sourceCommit=10548d54e80825c6e6ddbdaf8f7038207bdabee3`; fingerprint de conteúdo selado `e515438c7e6ac0d8acacb3de51dacdbcdc19341fe876744417242f06fd01b9ce`; 109 arquivos empacotados; addon em `win-unpacked/resources/native/win32-x64/kq_win32.node`; sem assinatura. Candidate build/verifier PASS não equivale a instalação NSIS PASS.
- Contrato estático do [workflow de PR](../.github/workflows/pr-validation.yml): **PASS** pelos testes de packaging/workflow. Configura binding antes do pack, build NSIS x64, suites, verify, smokes hosted e artifact identificado pelo SHA; permissões de conteúdo somente leitura e sem publicação Release. O [workflow de release](../.github/workflows/release-windows.yml) permanece separado e manual. Nenhum workflow foi executado.
- **NOT RUN:** instalação limpa/upgrade/uninstall NSIS, smoke protegido de `userData`, UAC, ACL cross-account/low-integrity, duas contas/sessões, recovery instalado após reboot/crash, UI/Explorer/taskbar em instalação real, Windows hosted CI, artifact GitHub, validação visual Doop e aceite humano. Nenhum workflow foi dispatchado.
- `npm ci` reportou seis vulnerabilidades moderadas no audit de dependências; não foi executado fix automático nem triagem fora do escopo destes dez achados. O candidato está sem assinatura.
- S1 continua **PARTIAL**; homologação e aprovação E1–E5 continuam pendentes; F não iniciada. A autorização de desenvolvimento e a existência de pacote candidato não removem esses gates.

### Recomendação

**GO condicionado para um PR de validação**, depois da revisão independente read-only das correções. O PR deve executar o workflow existente em runner hosted descartável, incluindo smoke NSIS e artifact identificado pelo SHA; nenhum Release pode ser publicado por ele. Isto não autoriza merge, instalação operacional, distribuição, nem declaração de PASS para os cenários NOT RUN. O PR não foi criado nesta execução.

Logs reproduzíveis em `/tmp`: `kq-phase-e-fix-windows-final.log` (SHA-256 `617d774d31ec5f9ad2ec38fd60e19458b0af5bcf27ad634181399380a8fea382`), `kq-phase-e-fix-package-final.log` (`da6c34c089dce5b3b102b694c409bfa6632ab6d550a097b924993dc7e9304e2e`), `kq-phase-e-fix-unit-final.log` (`1a51a2defa75bb0e06c1319c4d98419b0c4ee506154f3a69b53dd21f057e4de8`) e `kq-phase-e-fix-workflow-final.log` (`9b71ac8209fe6159c51fe8b6bbf3d5e6d97aef05e01c8fec401896d0b06664ce`).

## 1. Snapshot, método e limites

- Branch `feature/remote-player-lan-integration`, HEAD `10548d54e80825c6e6ddbdaf8f7038207bdabee3`, árvore suja preservada.
- Snapshot oficial do runner: **`745bcea049b6840578889ae716dd1d5f3510521a112ecf753349c20b6b274d48`**, 297 arquivos, 260 rastreados. Todas as execuções Windows abaixo usam esse código; não reutilizam os fingerprints históricos E0/E1-02.
- Inventário adicional antes desta documentação: SHA-256 `d46e91678735846128d14d1fd8a82073d34fde7a8748362651fe51f821415038` (hash de nomes e hashes dos arquivos retornados por `git ls-files -co --exclude-standard`, ordenados e deduplicados). Este algoritmo é diferente do fingerprint oficial.
- Leitura dos contratos, roadmap, tickets E1–E5, documentação Windows/SQLite/arquitetura, diff rastreado e arquivos novos. A extração Main→`main-runtime.ts` também foi comparada com `HEAD:main.ts` para separar movimentação de mudanças funcionais.
- Revisões read-only em contextos separados para segurança nativa, concorrência/persistência e instalador/CI; achados integrados e confrontados com o contrato pelo revisor principal. O primeiro parecer estático do instalador não detectou o encerramento forçado; a revisão dos templates efetivos confirmou-o. Nenhuma conclusão se baseia apenas no relatório do executor.
- Foram usados perfis/diretórios/SQLite sintéticos e o runner oficial. Sem instalação NSIS, elevação Windows, alterações em ProgramData/Program Files/Registro/contas/ACLs reais, dispatch, commit, push, PR ou publicação. O build escreve somente no checkout de validação e nos caches usuais de dependências/toolchain.
- As alterações posteriores a esse fingerprint são somente este parecer e seus vínculos/status documentais. Não atribuir execução de testes a documentos ainda não existentes naquele snapshot.

## 2. Achados por severidade

Nenhum achado **crítico/P0** confirmado. A classificação abaixo não afirma corrupção SQLite ou escalada de privilégio efetivamente observada.

### R1 — Alta: o instalador atual não compila

**Arquivo:** [installer.nsh:34](../build-resources/installer.nsh#L34), também linha 36.

O build nativo real terminou com `Invalid command: "${NSD_CreateFirstRadioButton}"`, seguido de `installer.nsh on line 34`. O `nsDialogs.nsh` efetivamente usado pelo Electron Builder fornece `NSD_CreateRadioButton`; as variantes First/Additional utilizadas não estão definidas nesse include. Os testes estáticos de packaging passaram apesar disso.

**Consequência:** `npm run build:windows` exit 1, sem instalador final válido; o workflow de PR para nessa etapa e não disponibiliza artifact.

**Correção:** usar os controles/macros suportados pelo NSIS instalado, com agrupamento/seleção de rádio corretos; compilar novamente com a toolchain efetiva e validar os dois estados da página em ambiente descartável. Não substituir o build por teste textual.

### R2 — Alta: aquisição do mutex falha na validação de ACL

**Arquivos:** [kq-win32.c:82](../build-resources/native/kq-win32.c#L82), [kq-win32.c:489](../build-resources/native/kq-win32.c#L489), [windows-runtime-mutex-electron.cjs:95](../scripts/windows-runtime-mutex-electron.cjs#L95).

O harness existente compilou o C atual com Electron 45/x64 e nome de mutex de teste exclusivo, carregou o addon no Electron real e falhou na **primeira aquisição**, retornando `{status:'acl_error',code:1336}` em vez de `acquired`. O caminho produz `ERROR_INVALID_ACL` quando a comparação serializada DACL/label diverge; o log não imprime os descritores, portanto a diferença exata ainda não foi identificada. Não concluir que a solução é relaxar permissões ou remover a comparação.

**Consequência:** o mecanismo atual não demonstrou nem a aquisição básica na conta normal; startup configurado e ramo administrativo dependem desse mesmo verificador. Concorrência, wrong-thread, abandono e segunda conta não chegaram a ser executados nessa tentativa.

**Correção:** diagnosticar os descritores esperado/efetivo em fixture descartável, corrigir a construção/comparação mantendo a política aprovada e repetir toda a suíte. Exigir comprovação adicional no Main empacotado e entre contas/sessões; o teste com nome exclusivo não é prova do produto instalado.

### R3 — Alta: leitura da função antes do mutex permite contexto obsoleto

**Arquivos:** [main.ts:65](../main.ts#L65), [installation-bootstrap.ts:5](../src/installation-bootstrap.ts#L5).

O bootstrap lê a função, adquire o mutex e publica o valor anterior sem reler o manifesto sob o mutex. Interleaving verificável: startup lê `player`; manutenção adquire admin→runtime, confirma `combined` e libera; startup adquire runtime e inicia com `player`. Também pode ignorar um `pending` publicado entre leitura e aquisição. A composição/identidade pode divergir da única autoridade global.

Foi reproduzido com `InstallationControlStore` real em diretório temporário e aquisição sintética determinística entre as chamadas: `captured=player confirmed=combined`. Essa reprodução confirma o defeito de ordenação; não simula prova Win32.

**Correção:** adquirir runtime e reler/verificar manifesto, função e geração antes de definir contexto/carregar a composição; reconciliar mudança sem abrir bancos com valor antigo. Cobrir o interleaving e a transição `unconfigured→ready`, além de pending/recovery concorrentes.

### R4 — Alta: NSIS ainda pode matar o app antes de preparar update

**Arquivos:** [installer.nsh:203](../build-resources/installer.nsh#L203), templates efetivos `node_modules/app-builder-lib/templates/nsis/installSection.nsh:33–66` e `include/allowOnlyOneInstallerInstance.nsh:105–142` (dependência travada no lockfile).

O template chama `CHECK_APP_RUNNING` antes do uninstaller antigo e da substituição de arquivos. Como não existe `customCheckAppRunning`, usa o encerramento padrão, que tenta parar processos e pode chegar a `Stop-Process -Force`/`taskkill /F`. O hook próprio só chama `change-role` **depois** de instalar os arquivos. Não existe protocolo `prepare-update`, pending de update ou aquisição dos mutexes no NSIS durante a substituição. Em update silencioso sem função selecionada, nem esse helper posterior é chamado.

**Consequência:** flush/drain e cancelamento do aplicativo podem ser contornados; há janela entre a inspeção de processos e substituição sem gate operacional/pending. Não foi observada perda de dados, mas o caminho de código contraria diretamente o contrato de preservação e encerramento seguro.

**Correção:** impedir o caminho de kill automático e implementar a preparação/pending e coordenação admin→runtime **antes** da substituição, conforme contrato E1-01. Falha/cancelamento de flush deve interromper a manutenção. Ensaiar app ativo, outra sessão, startup durante update e interrupção entre processos em Windows descartável.

### R5 — Alta: pending da confirmação inicial fica sem recuperação pelo fluxo normal

**Arquivos:** [installation-bootstrap.ts:15](../src/installation-bootstrap.ts#L15), [installation-admin.ts:137](../src/installation-admin.ts#L137), [installer.nsh:210](../build-resources/installer.nsh#L210).

Uma falha após `beginInitialRole` deixa `pending.kind='confirm-initial'`. O próximo startup recusa todo pending antes de carregar Welcome/broker. O retry existente no broker, portanto, não é alcançável após restart. A manutenção NSIS chama somente `change-role`, cuja recuperação aceita apenas pending `change-role`; para a confirmação inicial pendente, lança `INSTALLATION_RECOVERY_REQUIRED`.

**Consequência:** a primeira configuração pode bloquear todas as contas sem rota de reparo pelo aplicativo/instalador. Invocação administrativa manual com os argumentos originais não equivale a recovery implementado na manutenção.

**Correção:** oferecer reconciliação restrita da intenção inicial pela manutenção, preservando operationId, geração e alvo; não liberar operação normal sobre pending. Testar crash/falha de atalho, restart, retomada NSIS e resposta perdida com arquivos reais.

### R6 — Média: desinstalação deixa atalhos criados pelo próprio produto

**Arquivos:** [package.json](../package.json) (`createDesktopShortcut:false`, `createStartMenuShortcut:false`), [installer.nsh:223](../build-resources/installer.nsh#L223), `src/installation-shortcuts.ts`; template efetivo `uninstaller.nsh:190–205`.

Os flags geram `DO_NOT_CREATE_*`, que também suprimem a remoção padrão dos links no uninstaller. Os atalhos próprios, genéricos ou por função, não têm `customUnInstall` correspondente. O smoke remove os links no `finally`, sem verificar sua ausência após uninstall.

**Consequência:** links podem apontar ao executável removido; no cenário nunca configurado, a reinstalação permitida com manifesto unconfigured encontra os links genéricos preservados e aborta por conflito no `customInstall`. O defeito é confirmado na composição dos templates, ainda sem instalação real.

**Correção:** remover somente os links comprovadamente gerenciados durante uninstall, preservando perfis e manifesto. Testar ausência dos links **antes** do cleanup do harness e reinstall após uninstall, sem excluir links de terceiros.

### R7 — Média: harness de atalhos remove userData antes de encerrar Electron

**Arquivo:** [windows-shell-shortcut-electron.cjs:51](../tests/windows-shell-shortcut-electron.cjs#L51), também catch na linha 56.

O perfil Electron está dentro de `tempRoot`, que é removido antes de `app.quit()`. No Windows desta revisão, ocorreu `ENOTEMPTY`; o catch repetiu a remoção e lançou `EPERM` antes de `app.exit(1)`. O processo ficou até o timeout externo de 60s (`ETIMEDOUT`). A suíte do runner parou nesse primeiro caso, sem executar as demais regressões nativas.

**Correção:** coordenar saída e cleanup depois da liberação dos recursos Electron; garantir que falha de limpeza não suprima a saída/erro original. Repetir com o mesmo timeout, sem retries arbitrários ou exclusão da assertion. A consulta posterior não encontrou processos dos dois harnesses executados; isso não certifica processos de outros fluxos.

### R8 — Média: smoke NSIS afirma preservação de userData sem testá-la

**Arquivo:** [windows-nsis-install-smoke.ps1:21](../tests/windows-nsis-install-smoke.ps1#L21), linhas 91–95.

O sentinel fica em `$RUNNER_TEMP`, fora do caminho userData real que o uninstaller poderia excluir. Sua sobrevivência não comprova SQLite/perfil por conta, embora a saída declare `user_data_preserved=true`.

**Correção:** criar perfil/SQLite sintéticos no caminho de dados realmente usado pelo aplicativo da conta descartável, registrar hashes/conteúdo e verificá-los após uninstall/reinstall. Manter esse teste restrito ao Windows hospedado descartável; não usar o perfil real do proprietário.

### R9 — Média: “Configurar depois” repete a importação selecionada que falhou

**Arquivo:** [welcome-renderer.ts:148](../src/welcome-renderer.ts#L148), linhas 158–160.

`configureLater` só altera uma condição de entrada; ambos os botões enviam `selectedLibraryRoot` e `selectedCatalogFile`. Após selecionar CSV inválido e falhar no import, “Configurar depois” repete o mesmo import inválido. Não há ação para limpar a seleção. O usuário não consegue adiar aquele item opcional pelo botão oferecido.

**Correção:** definir a seleção que o comando de adiar efetivamente submete e permitir concluir sem o CSV/pasta problemática, mantendo alterações já confirmadas. Cobrir erro de CSV/pasta seguido de adiamento no Renderer→IPC→SQLite real. Não exigir novo layout.

### R10 — Média: verificador aceita o executável parcial de um build NSIS fracassado

**Arquivo:** [verify-windows-build.cjs:25](../scripts/verify-windows-build.cjs#L25).

Depois do build R1 exit 1, `npm run verify:windows-build` retornou **exit 0**, listando o arquivo com nome de installer e o ASAR de 109 entradas. O diretório tinha um EXE intermediário de apenas 324225 bytes e um `.__uninstaller.exe`. Portanto existência/nome/ASAR são insuficientes para afirmar que o instalador terminou com sucesso. O build começou com `dist` ausente; não é artifact anterior reaproveitado.

**Correção:** exigir evidência do build NSIS final bem-sucedido e rejeitar saídas intermediárias/incompletas; exercitar o verificador após um build interrompido. A ordem atual do workflow protege o upload porque o passo de build falha antes de verify/upload; não foi observado artifact inválido publicado.

### R11 — Baixa: texto Doop contradiz A7 (conhecido)

O rodapé do frame `rKUlA0rV8m` promete trocar função em Configurações; o contrato aprovado exige manutenção do instalador. **Correção textual recomendada:** indicar alteração posterior pela manutenção do instalador. Não foi alterado o frame aprovado, nem reintroduzida troca em Settings. Aceite do texto/frame e comparação Electron/Doop continuam pendentes.

## 3. Áreas revisadas sem outro defeito confirmado

- Manifesto usa parser limitado, pending/generation/operationId, publicação por arquivo temporário/rename e confirmação posterior aos efeitos/readback. A serialização depende do mutex do chamador, não de CAS interno do store; R3/R4 mostram lacunas nos consumidores.
- O ramo administrativo faz dispatch antes da composição operacional e valida gramática, token elevado e manifesto protegido. A chamada manual de CLI por administrador já elevado **não foi classificada como bypass de A7**, porque o contrato E1-01 reconhece expressamente essa fronteira. Não existe prova criptográfica de parent NSIS no contrato aprovado.
- A verificação de imagem nativa testa localização sob Program Files e reparse points, mas não estabelece, por si só, identidade registrada nem ACL de cada arquivo de código. O vínculo à instalação registrada/ACL da imagem exigido no contrato continua sem comprovação; não foi demonstrada escalada de privilégio nesta revisão. Deve entrar na validação de segurança do candidato antes da homologação.
- Mutex: direitos enumerados, ownership por thread e rejeição de recursão/abandono são implementados; R2 impede certificar sua execução. Precriação hostil, low-integrity e duas sessões permanecem testes obrigatórios, sem alegar vulnerabilidade comprovada.
- IPC Welcome usa a política existente de WebContents, main frame, URL esperada e estado da janela; payload de setup é validado em Main. A operação operacional permanece na Gestão/Main. Sem novo SQL/FS genérico exposto ao Renderer ou nova autoridade de fila identificada.
- Backup: `VACUUM INTO` na conexão proprietária, validação SQLite/FK/schema, hash e arquivo exclusivo; restore exige destino novo. As suítes com SQLite real passaram. Não há restore automático, snapshot conjunto de bancos/perfis ou garantia de downgrade binário; A6 continua dependente da matriz Windows/versões antigas.
- Legado: alias Controller de leitura preservado; instalação per-user observada e conflitos globais bloqueiam. Isso não comprova inventário de outras contas ou adoção/reinstall completos. Perfis/bancos não são convertidos/fundidos pelo novo instalador.
- Identidade preserva appId e caminhos; nomes/AUMID/assets são por função. Explorer/taskbar, link gerenciado elevado e ativos visuais finais não foram homologados.

## 4. Execuções desta revisão

Windows: PowerShell 5.1.26100.9711; Node nativo 24.11.0 x64, npm 11.6.1; Electron 45.0.0 com Node 24.22.0/N-API 10; node-gyp 12.4.0, Python 3.14.0, VS Build Tools 2019 16.11.36602.28. Linux/WSL: Node 24.15.0. O `npm ci` Windows registrou seis advisories moderados; não foi aplicado audit fix.

| Execução | Resultado do snapshot atual | Limite |
|---|---|---|
| `npm run test:unit` (inclui compile) | PASS, exit 0 | Regras Gestão/Player, persistência SQLite, instalação/identidade e infra locais; não Windows |
| `node --test` de broker/setup e oito arquivos Standalone/Player | PASS, 10 arquivos, exit 0 | Contratos unitários; não UI |
| `npm run test:release-workflow` | PASS, 2 arquivos | Testes estáticos não descobriram R1/R4/R6/R10 |
| Electron operating-modes sob Xvfb | NOT RUN funcionalmente; launcher exit 1 | `Process failed to launch!`, nenhuma assertion do app; sandbox não foi desativado |
| PowerShell no sandbox WSL | NOT RUN interop | `UtilBindVsockAnyPort:307: socket failed 1` |
| Mesmo PowerShell fora do sandbox do processo WSL | PASS | Sem UAC/elevação Windows ou política alterada |
| Runner oficial: sync/fingerprint/deps/compile Windows | PASS nesses passos | O pipeline completo falhou no teste seguinte |
| Runner oficial: windows-shell-shortcuts-electron | FAIL, ENOTEMPTY/EPERM/ETIMEDOUT | R7; regressões seguintes NOT RUN |
| PowerShell nativo: `node scripts/windows-runtime-mutex-electron.cjs` no checkout sincronizado | Compilação/carga do addon de teste PASS; aquisição FAIL 1336 | R2; demais assertions do mutex NOT RUN |
| Runner oficial `--package-candidate`: compile/beforePack | PASS nesses passos | Addon de produção x64 gerado; resources/ASAR gerados |
| Mesmo runner: NSIS | FAIL, exit 1 | R1; sem candidato final válido |
| Verificador executado separadamente no output fracassado | **Exit 0, falso positivo como gate de instalador** | R10; inspeção ASAR/addon passou, completude do instalador não |
| Carga do addon real de `win-unpacked` pelo próprio EXE com `ELECTRON_RUN_AS_NODE=1` | PASS limitado, exit 0; `loaded:true`, `elevated:false` | Somente ABI/carga, não Main, Renderer, UAC, ACL ou mutex de produção |
| Main empacotado, NSIS install/update/uninstall, ACL entre contas, UAC e duas sessões | NOT RUN | Proibidos no host operacional; usar Windows descartável apropriado |
| Reprodução de R3 com store real/ordenação sintética | Defeito reproduzido | Não é prova Win32 de concorrência |

O loader temporário teve duas falhas do próprio diagnóstico (política de execução do arquivo UNC e quoting/espera do EXE GUI). A política não foi alterada. A execução final utilizou Command fixo e `Start-Process -Wait -PassThru`, capturando exit 0. Esses erros de diagnóstico não são atribuídos ao produto.

Validação documental após o registro: `git diff --check` PASS; 211 destinos relativos conferidos em 16 documentos Markdown alterados, nenhum ausente. Esta revisão modificou somente documentação no repositório; fontes, testes e workflows auditados permaneceram intactos.

## 5. Reprodução, logs e outputs

Antes de repetir, revisar o estado/locks/markers dos checkouts conforme [procedimento oficial](windows-native-testing.md); não apagar evidência de execução fracassada. Não executar o smoke protegido no host operacional.

1. `npm run test:unit` e `npm run test:release-workflow` no WSL.
2. No WSL, fora do sandbox que bloqueia interop, encaminhar `KARAOKE_QUEUE_WIN_CHECKOUT` com `WSLENV` e executar `node scripts/run-windows-native-tests.cjs --approve-untracked` após revisar o inventário. Checkout usado: `E:\KaraokeQueue\e1-02-validation\checkout`.
3. No PowerShell nativo, nesse mesmo snapshot NTFS: `node.exe scripts/windows-runtime-mutex-electron.cjs`. O script existente gera nome de mutex exclusivo e fonte/perfis temporários.
4. O modo candidato exige `dist/` ausente. Foi criado clone **local** de validação em `E:\KaraokeQueue\phase-e-independent-20261108\checkout`, preservando o artifact antigo no outro checkout, e executado o mesmo runner com `--package-candidate --approve-untracked`.
5. Nesse checkout novo: `npm.cmd run verify:windows-build`, somente inspeção. Não executar os EXEs parciais como instalador.
6. Carga ABI: definir `ELECTRON_RUN_AS_NODE=1` apenas no processo de diagnóstico; iniciar `dist\win-unpacked\Karaoke Queue.exe` com `-e` para `require` do caminho absoluto de `resources\native\win32-x64\kq_win32.node`, imprimir versões e `isProcessElevated()`, capturar término com `Start-Process -Wait`; remover as variáveis ao terminar. Não chamar mutex fixo nem iniciar o Main nesse diagnóstico.

Logs locais desta revisão (temporários; os resultados e trechos essenciais estão preservados neste parecer): `/tmp/kq-phase-e-independent-{unit,extra,workflow,electron,windows,mutex,package,verify,artifacts,addon-command,repro}.log`. Script temporário de carga: `/tmp/kq-phase-e-review-addon.ps1`. O cleanup do harness de atalhos falhou; seu diretório sintético pode conter resíduos. Não se apagaram manualmente locks, markers ou backups dos checkouts após falha.

Output NSIS **inválido/incompleto**, somente para identificar a evidência de R10:

- `Karaoke-Queue-Setup-0.5.0-x64.exe`: 324225 bytes; SHA-256 `E9267351A607F9ACC663FECA834E384B78749788FCB2F7A886B918E713280585`.
- `Karaoke-Queue-Setup-0.5.0-x64.__uninstaller.exe`: 232192 bytes; SHA-256 `D69D14372AF4C0EEB42DC75AF6510624FC22E26ABF71F3C77D1EE15D3092FC73`.
- Ambos têm metadado ProductName; nem isso nem os hashes transformam o build fracassado em candidato válido. Não foram instalados/distribuídos.


### Checksums dos logs de validação

| Log em `/tmp/kq-phase-e-independent-*.log` | SHA-256 |
|---|---|
| `unit` | `e607b27d4e8b0ea25777f5609b618a7d693c8bce34785a18689a7735f8d5d731` |
| `extra` | `6c3fcaa5cdefe99dd15fbda06fef8faadc0c0a4f5b91b7e15da520086cc75d2e` |
| `workflow` | `cf3fe6eed100769c45fa40d623525b303aa801ecf3d5c8396c873c5740f66010` |
| `electron` | `ac54bdc3df4fb1a3291a9ddb7c66009748d46796c2a861ddd0948dbe02d9baec` |
| `windows` | `8ef0d7bbebfbc9ffd62928325de6245637e53589b4d75bd6660684db0dd15882` |
| `mutex` | `0b4590007e6efd96ab9808aa5995edd7d05128a83b65835049887be5d75262e3` |
| `package` | `5b0e08e987f9587207650c65f9e67f250debcc76453deb50060c06b526858407` |
| `verify` | `f3ab2136e2e91a5a71f7288200bc2c6a7324edc1fb958e0bd922c47b69e35c4a` |
| `artifacts` | `ad25065857eaf0c21a3d34e440845a93fe06a0a47b729f8c54270019c6faf58f` |
| `addon-command` | `4c980deb19f6a65ac80af00aac565f117dc860d4ea499828ed61dd1275864ea3` |
| `repro` | `9530c365f484f653dcd335f1aaa4faa6db2169aeb481d8d19618a48eb7dcc615` |

## 6. Workflow e artifact de PR

O workflow [pr-validation.yml](../.github/workflows/pr-validation.yml) tem `pull_request` para main e `workflow_dispatch`, permissões `contents:read`, compile/unit/workflow/E2E Linux; depois build NSIS x64, verify, metadados/assinatura, Main empacotado e smoke NSIS no hosted descartável. `beforePack` compila o binding para Electron e o coloca fora do ASAR; verify inspeciona PE x64 e recursos esperados. O manifesto do artifact registra SHA do evento (merge SHA no caso PR), ref, run ID, versão e checksum. O upload ocorre somente após os passos anteriores passarem. Não há publicação Release nesse workflow; o publisher é separado e manual.

**Impedimento comprovado no snapshot auditado:** R1 interrompia o build, R2 comprometia startup/smoke do Main configurado, o runner falhava em R7 e o verificador tinha a limitação R10. A seção de atualização registra a correção desses bloqueios de desenvolvimento; o workflow GitHub não foi disparado e ainda não há artifact hosted.

O smoke protegido prepara o manifesto com o store em fixture administrativa; não exercita confirmação inicial UAC nem toda a manutenção. O smoke de atalhos verifica a API Shell em arquivos temporários, não `synchronizeInitialFunctionShortcuts` com efeitos comuns elevados. O teste nativo do mutex altera apenas o nome para isolamento; não é teste instalado entre contas. Esses limites devem permanecer identificados nos resultados de CI.

## 7. Correções antes do PR e homologação restante

**NO-GO naquele snapshot para criar PR de validação com expectativa de candidato utilizável.** A recomendação era corrigir R1–R10, repetir compile/unit, runner, build/verifier e validar os casos negativos. Isso foi feito conforme o ledger de atualização no início deste documento; a nova recomendação está registrada na seção de atualização.

Depois de corrigir os bloqueios e repetir as provas seguras, um PR de validação pode ser usado para obter os testes hospedados sem afirmar homologação. A ausência de UAC interativo/duas sessões, por si só, não exige homologar antes de abrir esse PR; esses casos continuam gates para aceitar/distribuir E1–E5.

Homologação obrigatória ainda pendente: instalação limpa e per-user legado, confirmação inicial/restart por conta, maintenance/upgrade com app ativo e cancelamento/flush falho, retomada de pending, ACL/token/credenciais alternativas, low-integrity, duas contas/sessões, legado concorrente, uninstall/reinstall/atalhos, N-1 real, downgrade incompatível e recovery após interrupção. Executar os casos automatizáveis no GitHub-hosted descartável; UAC e sessões reais exigem Windows remoto/laboratório descartável interativo, sem VM local do proprietário. Corrigir/aceitar a copy Doop e validar identidade/Explorer/taskbar e UI no candidato real.

E0 permanece aprovada. **S1 PARTIAL; E1–E5 não homologadas/aprovadas; F não iniciada.**

## 8. Correções dos quatro bloqueios finais — 2026-11-09

Esta atualização substitui os estados técnicos anteriores somente para os quatro bloqueios listados abaixo e para o snapshot indicado. O primeiro build NSIS desta execução falhou porque as variáveis do desinstalador eram declaradas também durante a compilação do instalador; a saída parcial foi preservada fora do checkout. As variáveis e hooks foram limitados a `BUILD_UNINSTALLER`; o build subsequente passou. Nenhum aplicativo foi instalado e nenhum estado global do Windows foi alterado.

| Bloqueio | Correção e evidência | Resultado técnico | Limite que permanece |
|---|---|---|---|
| Update com função `null`/`unconfigured` | `installation-admin.ts` preserva o intent e `operationId`; `repairPendingInstallation` conclui em `unconfigured` sem escolher função. Testes cobrem falha parcial, retry e reconstrução após restart. NSIS encaminha pending para reparo em qualquer função. | Código/testes unitários **PASS**; regressões Windows Main/SQLite **PASS** no fingerprint final. | Upgrade NSIS instalado, interrupção real e recovery após restart/UAC **NOT RUN**. |
| Concorrência durante uninstall | Helper publica tombstone durável; após sua saída, NSIS readquire admin→runtime e mantém ambos durante a seção que remove arquivos e registros. No modo GUI, `un.onGUIEnd` libera explicitamente os locks após a seção. No modo silencioso, NSIS não chama callbacks GUI: a thread proprietária termina somente depois da seção e o Windows sinaliza o mutex abandonado. O tombstone mantém o runtime bloqueado até retry/reinstall adquirir os gates e reconciliar o estado. Nenhum hook encerra processos à força. | Testes unitários de falha/retry/manifesto/dados, verificações estáticas de ordem e regressões Windows **PASS**. | Uninstall concorrente real, cancelamento/crash/retry do NSIS e startup de outro processo durante remoção **NOT RUN**. O caminho silencioso está fundamentado nos contratos documentados do [NSIS](https://nsis.sourceforge.io/Docs/Chapter4.html?title=MessageBox) e do [mutex Win32](https://learn.microsoft.com/en-us/windows/win32/sync/mutex-objects), mas ainda não foi exercitado pelo smoke NSIS descartável. |
| Smoke NSIS | `Get-ExpectedUninstallDisplayName` foi retirada do here-string JavaScript e agora roda no escopo PowerShell; usa `build.productName`, `version` e template efetivo do Builder. Cleanup de Program Files exige correspondência da `installationId`; atalhos só são removidos se apontam ao executável exato. | PowerShell Parser nativo **PASS**; `test:release-workflow` **PASS**. | Instalação/desinstalação do smoke em runner hospedado **NOT RUN**; o script exige GitHub-hosted descartável. |
| Fingerprint de build | Inventário cobre `src/`, `build-resources/`, `scripts/`, `tests/`, fontes TypeScript da raiz, package/lock e tsconfig; inclui `player-preload.ts`, `standalone-player-preload.ts` e `scripts/copy-assets.ts`. Testes alteram cada classe de input e adicionam input novo para provar invalidação. | Testes de provenance **PASS**; selo atual e hashes verificados pelo `verify:windows-build`. | Smoke hospedado e artifact GitHub **NOT RUN**; o selo local não é prova de instalação. |

### Validação do snapshot final

- Branch `feature/remote-player-lan-integration`, HEAD `10548d54e80825c6e6ddbdaf8f7038207bdabee3`; fingerprint do snapshot submetido ao runner Windows: **`3485486b7bffb7470863c124b792def0cdd5daa1d26c0775c94496cf18771d60`**. Depois da campanha, somente documentação/evidências foram alteradas; código, testes, workflows e inputs de build permaneceram iguais.
- Linux/WSL: `npm run test:unit` (inclui compile) **PASS**; `npm run test:release-workflow` **PASS** (3 arquivos); `git diff --check` **PASS**.
- Windows nativo: PowerShell 5.1.26100.9711, Node 24.11.0 x64, npm 11.6.1, Electron 45.0.0, Python 3.14.0 e VS 2019 Build Tools 16.11.36602.28. Runner oficial de regressão **PASS** com Electron, Playwright, SQLite isolado, migrações, onboarding/modos, Management/Combined, Player, biblioteca/catálogo, mutex Win32 e cleanup sem processo residual.
- `npm run package:windows:candidate -- --approve-untracked`: **PASS** no mesmo fingerprint. O binding de produção x64 foi compilado por node-gyp/MSVC para Electron 45 e incluído fora do ASAR; o verificador confirmou NSIS x64, ASAR com 109 arquivos e selo sem intermediário. Carga isolada do `.node` do pacote pelo Electron 45 (`ELECTRON_RUN_AS_NODE`) **PASS**; não iniciou o Main nem chamou APIs de instalação.
- Fingerprint de inputs selado pelo build: **`3cb0090a142900f8dcd534bd41b51ef930d1e1e5f15bc6f9f86db97fe4bbfae4`** (218 inputs). SHA-256 do candidato `Karaoke-Queue-Setup-0.5.0-x64.exe`: **`b8aef4fb40db719e554f849e3a07c72ec34cda59f4a59a22d09d67d709266885`**. Artefato somente em `E:\KaraokeQueue\e-independent-windows-final-20261108\checkout\dist`; não foi enviado ao GitHub.
- Smoke do executável que grava Program Files/ProgramData, smoke NSIS install/uninstall, UAC, ACL entre contas, duas sessões e recuperação de instalação **NOT RUN**. Não foi feito dispatch. S1 continua PARTIAL; homologação/aprovação E1–E5 e distribuição continuam pendentes.

### Recomendação atual

**GO condicionado para abrir um PR exclusivamente de validação automatizada**, após revisão read-only destas quatro correções. O workflow existente deverá executar os smokes protegidos em Windows hosted e produzir artifact identificado pelo SHA; não autoriza merge, distribuição, instalação operacional nem Release. O PR e o workflow não foram criados/disparados nesta execução.

## 9. Revisão independente direcionada antes do commit — 2026-11-09

Autorização: revisar somente os quatro bloqueios finais, com commit/push condicionados a GO; o proprietário criará o PR. A revisão inspecionou as implementações, consumidores NSIS, templates efetivos do electron-builder 26.18.0, testes, diff e workflow de PR. Não foi refeita a auditoria geral E. O parecer é **NO-GO**, pelos achados F1/F2 abaixo; não se iniciou staging nem publicação.

| Ponto revisado | Parecer |
|---|---|
| Update `role:null` / pending | **RESOLVIDO no código revisado.** `prepareInstallationUpdate` preserva confirmação inicial pendente; `repairPendingInstallation` e `commitInstallationUpdate` conservam função nula e geração idempotente. `customInstall` chama reparo mesmo sem função. As assertions verificam falha de commit, operação preservada, retry e ausência de seleção automática. NSIS real permanece NOT RUN. |
| Exclusividade durante uninstall | **PARCIAL.** Tombstone e locks impedem startup operacional enquanto a remoção está em curso, mas não impedem consumo concorrente do tombstone durante o handoff helper→NSIS (F1). O release GUI também tem uma premissa incorreta de thread (F3). |
| Smoke PowerShell | **PARCIAL / pipeline bloqueado.** Paths, escopo PowerShell, DisplayName e limites de cleanup foram corrigidos. Entretanto `_?=` mantém o uninstaller dentro da pasta cuja remoção completa é exigida logo após sua saída (F2). |
| Inputs/fingerprints | **RESOLVIDO no recorte.** Inventário corresponde aos includes do TypeScript e aos scripts/recursos de montagem; preloads e copy-assets estão incluídos. Assertions modificam cada classe de input e verificam invalidação; selo rejeita saída alterada, incompleta, ausente e outro commit. |

### F1 — ALTA: recuperação pode consumir a intenção de um uninstaller ainda ativo

**Referências:** `build-resources/installer.nsh:25` (helper e handoff), `:105` (aquisição sem releitura do manifesto), `:365` e `:474` (reinstall aceita tombstone), `:506` (restore após copiar arquivos); `src/installation-admin.ts:455` e `src/installation-control.ts:334` (restore consome a intenção). O template `node_modules/app-builder-lib/templates/nsis/installer.nsi:70` aplica `ALLOW_ONLY_ONE_INSTALLER_INSTANCE` ao installer; `uninstaller.nsh` não participa desse guard. Logo, esse guard não serializa installer contra uninstaller.

**Interleaving permitido pelo código:** (1) U executa `uninstall-cleanup`, grava intenção T e deixa o helper liberar admin/runtime; (2) antes de U readquirir os mutexes, R detecta T, adquire os gates, reinstala e executa `restore-after-uninstall`, que limpa T e publica `ready`/`unconfigured`; (3) U retoma, adquire os mesmos gates e entra na remoção sem revalidar T/operationId/generation; (4) os arquivos/registro recém-restaurados são removidos, embora o manifesto já declare restauração concluída. Não é necessário existir startup simultâneo para produzir o estado inconsistente. Bancos não são removidos por esse caminho, mas instalação/manifesto deixam de corresponder.

**Correção recomendada:** serializar o lifecycle externo de installer e uninstaller, inclusive os handoffs para helpers, e revalidar a intenção exata sob exclusão imediatamente antes da remoção. A recuperação deve distinguir intenção de processo ainda ativo de operação interrompida. Não usar PID isolado/timeout como prova nem aceitar qualquer tombstone como autorização para recuperação concorrente.

**Teste exigido:** barreira determinística entre a saída do helper U e a tomada dos locks pelo NSIS; tentar reinstall/recovery R; confirmar que R não consome T enquanto U pode prosseguir, ou que U obsoleto aborta antes da primeira remoção. Cobrir GUI/silencioso, duas operações, crash/retry e preservação do perfil. O teste atual `uninstall failure...` verifica helpers sequenciais; não exercita essa competição com NSIS. **Evidência: defeito de coordenação identificado por inspeção/interleaving; reprodução NSIS Windows NOT RUN.**

### F2 — MÉDIA, bloqueante do CI: smoke exige remoção do executável que ainda estava em uso

**Referências:** `tests/windows-nsis-install-smoke.ps1:145` usa `/S _?=$installDirectory`; `:147` exige ausência de toda a pasta; `:181` repete o mesmo padrão. O template efetivo `uninstaller.nsh:187` usa `RMDir /r $INSTDIR` e o smoke não remove o próprio uninstaller depois que ele termina.

A [documentação oficial NSIS, opções do uninstaller](https://nsis.sourceforge.io/Docs/Chapter3.html#uninstallerusage) estabelece que `_?=` impede a cópia/execução a partir do diretório temporário. Seu exemplo de `ExecWait` remove explicitamente o uninstaller e a pasta **após** o processo sair. No smoke atual, o executável permanece na pasta durante `RMDir`, impedindo sua remoção integral; a assertion seguinte falha antes do reinstall e do upload do artifact. A limpeza em `finally` ocorre depois da falha e não corrige esse contrato.

**Correção recomendada:** executar uma cópia verificada do uninstaller em diretório temporário exclusivo com `_?=` apontando à instalação, aguardando esse processo real até terminar; depois exigir ausência dos arquivos instalados. Alternativamente, aguardar corretamente o processo temporário criado pelo NSIS sem `_?=`. Preservar as assertions de remoção, manifesto, atalhos e hashes SQLite. Não remover silenciosamente resíduos para fabricar PASS antes da assertion.

**Teste exigido:** uninstall real silencioso em runner hosted, com verificação de término do processo, pasta ausente, registro removido, tombstone e perfil preservados, seguida de reinstall/uninstall. **Evidência: incompatibilidade entre o contrato oficial e o script/template; instalação real NOT RUN.** Os testes estáticos atuais passam, mas não verificam essa condição de execução.

### F3 — MÉDIA: callback GUI não é a thread proprietária dos mutexes

`build-resources/installer.nsh:105` toma ownership durante a seção e `:124` tenta liberá-lo em `un.onGUIEnd`, sem verificar o resultado de `ReleaseMutex` (`:48`). O [código primário NSIS Ui.c](https://github.com/kichik/nsis/blob/master/Source/exehead/Ui.c) executa as seções numa thread criada por `CreateThread(...install_thread...)`, enquanto `CB_ONGUIEND` roda na thread que chamou `DialogBox`. [ReleaseMutex](https://learn.microsoft.com/en-us/windows/win32/api/synchapi/nf-synchapi-releasemutex) exige a thread proprietária.

Portanto, no modo GUI o release explícito alegado no parecer anterior não está demonstrado e conflita com o threading do NSIS: após o fim da worker, o mutex pode estar abandonado; o callback marca ownership como liberado mesmo se a API falha. Isso não prova uma janela durante a seção de remoção, mas cria recuperação por abandono após sucesso normal e invalida a assertion textual de lifecycle. Em modo silencioso, o callback nem é chamado, como já registrado.

**Correção recomendada:** executar a liberação confirmada na mesma thread das seções, depois da última mutação relevante, deixando abandono reservado ao caminho de falha; manter tombstone e proteção contra a corrida F1. Testar IDs de thread, resultados das APIs, observador de contenção durante a seção e aquisição normal depois do sucesso GUI/silencioso, além de abandono após crash. **Evidência: incompatibilidade de ownership por inspeção do código NSIS e Win32; probe NSIS real NOT RUN.**

### Checks desta revisão e estado do CI

- `npm run compile`: **PASS**.
- `node --test build/tests/installation-admin.test.js build/tests/installation-control.test.js build/tests/installation-bootstrap.test.js`: **PASS** (3 arquivos). Testes usam stores reais isolados e portas nativas sintéticas; não comprovam NSIS/UAC.
- `node --test scripts/packaging-config.test.cjs scripts/windows-build-provenance.test.cjs`: **PASS** (2 arquivos), com as lacunas F1–F3 acima.
- Fingerprint local recalculado dos inputs: `3cb0090a142900f8dcd534bd41b51ef930d1e1e5f15bc6f9f86db97fe4bbfae4`, 218 arquivos, igual ao candidato documentado. A revisão não alterou esses inputs. Windows/build não foram repetidos: os defeitos encontrados exigem corrigir o código antes de produzir nova evidência relevante; os PASS anteriores não são provas dos cenários omitidos.
- O workflow tem os jobs `linux-validation` e `windows-build`, build NSIS x64/N-API/verify, smokes, manifesto SHA/checksum e upload somente após sucesso. Não publica Release. **F2 impede esperar um artifact bem-sucedido no fluxo atual**; F1 também exige correção antes do commit conforme o gate do proprietário.
- GitHub Actions desta execução: **NOT RUN**, nenhum PR/dispatch; artifact hosted: indisponível. `git diff --check`: **PASS**.

**Decisão:** NO-GO para staging/commit/push/PR até corrigir F1/F2 e a premissa de ownership F3, com testes proporcionais. A criação do PR continua reservada ao proprietário. S1 PARTIAL, E1–E5 sem homologação/aprovação; nenhuma instalação operacional ou Fase F iniciada.

## 10. Correção estrutural da coordenação F1–F3 — 2026-11-09

Autorização: corrigir o protocolo completo no recorte instalação/update/manutenção/uninstall/reinstall, adicionar testes e atualizar evidências. Não houve instalação ou elevação administrativa no host operacional. A1–A7 preservadas; E0 aprovada, S1 PARTIAL, E1–E5 sem homologação. Este registro é do executor, com segunda leitura adversarial dos caminhos modificados; não se apresenta como uma nova revisão independente.

### Causas, correções e cobertura

| Achado | Correção presente | Teste e resultado | Limite |
|---|---|---|---|
| F1 — handoff uninstall/reinstall, ALTA | Job Object global protege a **árvore completa** NSIS/helper, incluindo handoffs e descendentes de pai que morreu. Outra árvore não pode consumir tombstone vivo. Fence obrigatória `installationId`/generation/operationId/tipo é validada sob admin→runtime; NSIS a relê antes da remoção. Manutenção exige herança da árvore NSIS; `--updated` independente não obtém bypass. | **PASS**: Electron Win32 real, concorrente independente recusado, helper herdado, parent crash com helper sobrevivente, nova admissão só após término confirmado por handle OS. Probe NSIS real aborta alteração de geração, operação, instalação ou tipo preservando sentinel. Unitários de fence/retry/commit com stores isolados PASS. | Corrida com produto realmente instalado, duas contas/sessões e ACL elevada de produção **NOT RUN**. |
| F2 — uninstaller em uso na própria pasta, MÉDIA | Smoke copia o executável para temp exclusivo, confere hash, usa `_?=` apontando à instalação como último argumento e espera esse processo efetivo. Só depois exige pasta/registro/atalhos ausentes e perfil intacto; cleanup não antecede assertions. | **PASS** parser PowerShell e contratos automatizados. NSIS real executado nas fixtures dos probes GUI/silencioso/crash/falha, sem produto instalado. | Smoke install/uninstall/reinstall do produto **NOT RUN**; não inferir PASS instalado dos probes. |
| F3 — ownership por thread, MÉDIA | Release e CloseHandle verificados na seção worker; uninstall acrescenta seção final obrigatória após remoção/registro do Builder. Página interna de componentes é pulada. Nenhum release em `.onGUIEnd`/`un.onGUIEnd`. Erro/abandono falha fechado. | **PASS** NSIS compilado/real: IDs acquire==release nos modos GUI e silencioso; callback GUI tem ID distinto. Observador mantém referência e prova aquisição normal após sucesso e abandono explícito após crash/falha/obsolescência, seguido de recuperação. | Lifecycle do produto instalado/cancelamento interativo **NOT RUN**. |

Arquivos centrais: `build-resources/installation-operation.nsh`, `installation-fence.nsh`, `installer.nsh`, `build-resources/native/kq-win32.c`, `src/installation-admin[-args].ts`, broker e `main.ts`. Testes de regressão: `tests/installation-admin.test.ts`, `installation-role-broker.test.ts`, `installation-control.test.ts`, `scripts/windows-installation-operation.cjs`, `windows-nsis-coordination-probe.cjs`, `windows-runtime-mutex-electron.cjs` e contratos de packaging/proveniência. Ver [contrato e matriz de 14 interleavings](fase-e-coordenacao-instalacao.md).

### Segunda revisão própria e correções relacionadas

A releitura completa encontrou e corrigiu premissas adicionais no mesmo protocolo:

- Bootstrap inicial mantém `pending/prepare-update`, generation0, role null durante extração/registro; só confirma `unconfigured`, generation1, após o helper sincronizar os links genéricos. Falha/retry preservam ID e função nula. Pending reconhecido permite recópia sob locks mesmo sem helper antigo; controle órfão/corrompido ou legado ambíguo bloqueia.
- Confirmação inicial UAC inclui installationId, além de ID/geração: pedido antigo não confirma outra instalação. Retry confirmado de confirmação/troca não reexecuta writer de links; testes usam writer que lança erro para detectar replay. Restore/reparo reconhecem somente conclusão compatível.
- Ramo administrativo encerra com código em vez de abrir diálogo Electron que prenderia NSIS silencioso. Runtime ocupado retorna 32. Smoke hosted preparado exige exit32, manifesto idêntico e Main ainda vivo, antes de gerar hashes do perfil.
- `--delete-app-data` é rejeitado e conflito HKCU inclui UninstallString; não se antecipa limpeza/conversão de bases. O helper não abre SQLite.
- Diagnóstico **real Electron Windows** mostrou `app.getPath('appData')` diferente de `APPDATA` sobrescrito. O smoke agora usa o perfil padrão real, previamente inexistente, da conta descartável hosted; confere o caminho reportado pelo Main e limita cleanup ao perfil novo confirmado, sem reparse point. Assertions de preservação não foram relaxadas.
- A ordem de `customInstall`/seção final foi conferida nos templates efetivos do Builder 26.18.0: commit ocorre após cópia/registro; release do uninstall vem após as últimas mutações. Não há kill operacional, serviço permanente, novo launcher ou executável adicional de produto.

### Snapshot e resultados executados

Branch `feature/remote-player-lan-integration`, HEAD **`10548d54e80825c6e6ddbdaf8f7038207bdabee3`** (working tree com alterações preexistentes preservadas). Runner final e candidato têm fingerprint de snapshot **`3432e5d295cbffc241747061fd8704766b68d52f467a34da60dec28e654053fe`**, 307 arquivos. Depois desta campanha houve apenas atualização documental; os inputs selados permanecem iguais. Não se apresenta o HEAD antigo isoladamente como identificação do conteúdo modificado.

| Validação | Resultado e evidência local |
|---|---|
| TypeScript + unitários/regressões de domínio/persistência | **PASS**, `npm run test:unit`; `/tmp/kq-coordination-unit-final2.log`. Testes admin/broker adicionais também PASS. |
| Configuração de workflows, NSIS, checksums e invalidação de proveniência | **PASS**, `npm run test:release-workflow`; `/tmp/kq-coordination-workflow-final2.log`. |
| Runner oficial Windows final | **PASS**, `npm run test:e2e:multi-instance:windows -- --approve-untracked`; `/tmp/kq-coordination-windows-final3.log`. Electron real/Playwright, SQLite isolado, Combined/Gestão, Player, modos/onboarding, biblioteca/catálogo, foco e cleanup sem processos residuais. |
| Mutex Win32 N-API e árvore de processos | **PASS** no mesmo runner; recursão/thread incorreta/contenção/release/abandono/readback de ACL runtime, descendência e crash real. Job de fixture usa nome aleatório e SID de teste, não prova ACL elevada de produção. |
| NSIS fonte compartilhada | **PASS** no mesmo runner, modos silent/gui/crash/failure/stale-generation/stale-operation/stale-installation/stale-kind/fresh. Exclusivamente fixtures temp, sem registro/PF/PD do produto. |
| NSIS x64 completo + verificador | **PASS**, `npm run package:windows:candidate -- --approve-untracked`; `/tmp/kq-coordination-package-final2.log`. Addon produção compilado MSVC/node-gyp, 109 arquivos no ASAR, addon PE x64 fora do ASAR, selo com 4 hashes. |
| Carga addon final no executável empacotado | **PASS**, `/tmp/kq-coordination-packaged-load.log`: Electron45/Node24.22/N-API10/x64, APIs test-only ausentes, processo não elevado. Run-As-Node carrega somente `.node`, sem Main/instalação/mutex de produção. |
| Parser do smoke PowerShell | **PASS** no Windows nativo, mesmo log de carga. |
| Main empacotado completo e smoke de instalação do produto | **NOT RUN** neste host. Exigem o runner descartável protegido; carga do addon não é smoke integral. |
| UAC, outra credencial, ACL cross-account/integridades, duas sessões, upgrade N-1 e crash/reboot instalado | **NOT RUN**, homologação obrigatória preservada. |
| GitHub Actions/artifact hosted | **NOT RUN**; nenhum workflow/PR/dispatch/upload. |

Ambiente efetivo: Windows nativo x64, PowerShell5.1.26100.9711, Node24.11.0/npm11.6.1, Electron45.0.0 (Node24.22/N-API10), Builder26.18.0, NSIS3.0.4.1, Python3.14 e VS2019 BuildTools16.11. O runner usa `E:\KaraokeQueue\e-independent-windows-final-20261108\checkout` e perfis exclusivos. A fronteira WSL/sandbox falhou com VSock; a chamada aprovada PowerShell fora do sandbox funcionou com token Windows normal, sem alterar segurança do sistema.

Falhas intermediárias foram investigadas, não promovidas a PASS: fixture Electron precisava impedir o job kill-on-parent-close do libuv; append NSIS precisava FileSeek END; GUI do probe precisava auto-close; SDDL precisava representação canônica. Duas tentativas de pacote falharam HTTP504 no fetch SHASUMS, outra em include com separador misto e outra em warning6000 por variável declarada depois da expansão da macro. Foram corrigidas a configuração de checksum oficial do Electron travado, includes relativos e variável local já declarada. Builds parciais continuam rejeitados pelo selo e foram preservados fora de dist. Uma repetição teve EBUSY em default_app.asar por um processo da **própria fixture de diagnóstico**; somente essa árvore, identificada por caminho UUID/executável, foi encerrada, e a campanha final acima passou. Nenhum processo operacional foi encerrado.

### Candidato atual e limites

- Inputs de build: **`0b407cead36fb204ca2168f12a69a03bed81ab2e78ef92b0abaee0bfd530a423`**, 223 inputs. Inclui preloads, copy-assets, includes NSIS/N-API e os novos scripts/testes; saídas nativas geradas excluídas como antes.
- Instalador local não assinado: `E:\KaraokeQueue\e-independent-windows-final-20261108\checkout\dist\Karaoke-Queue-Setup-0.5.0-x64.exe`.
- SHA-256: **`ae69327a4f5a0940fa8cae263478a04856b0124d4c3549fbcee6ac6d639bfd5f`**.
- Binding final: `6eb49e1b9f2712d80fb63d570ce1e25e7e195ca4e8f799b6601d6141580d4bee`; app.asar: `1ae6c22793a05b7f00d70cc30f7ca4da79ebbf3e5d4c1d52ce39f54ccee9855e`. Verificador e Get-FileHash independente confirmaram o candidato/selo.

**Recomendação: GO técnico condicionado para revisão final/PR exclusivamente de validação automatizada.** As causas F1–F3 foram corrigidas, com provas reais dos mecanismos e regressões disponíveis; sua combinação no produto instalado ainda deve ser executada. O workflow de PR mantém Linux compile/unit/E2E e Windows build/verify, acrescenta as provas NSIS/Win32 isoladas, roda Main empacotado e smoke NSIS instalado no hosted, e só então gera artifact/checksum/manifesto SHA. Não publica Release nem recebe contents:write. Não há alegação de CI verde até a execução real.

A criação do PR continua com o proprietário; esta tarefa não autoriza commit/push. Antes de aceite/distribuição: conferir jobs, hashes e artifact, executar matriz instalada de concorrência/recuperação, UAC/contas/sessões e checklist humano. A divergência do rodapé Doop `rKUlA0rV8m` (Configurações versus manutenção A7) continua registrada; frame não alterado. Não há nova aprovação visual ou de produto. S1 PARTIAL, E1–E5 sem homologação/aprovação e F não iniciada.

Validação final documental/diff desta correção: **PASS** `git diff --check`; 225 links/caminhos/âncoras locais conferidos nos documentos afetados, sem erro. Doze referências históricas do roadmap para capturas `/tmp` ausentes continuam identificadas como histórico, sem alegação de imagens verificadas. Inspeção de diff e dos 48 arquivos untracked encontrou fontes, testes, documentos e ícones pertinentes à Fase E, sem banco/perfil/credencial/log privado ou instalador gerado para adicionar. Alterações preexistentes preservadas; nenhum staging realizado. Fingerprint de inputs recalculado após a documentação permaneceu `0b407cead36fb204ca2168f12a69a03bed81ab2e78ef92b0abaee0bfd530a423`.

## 11. Correção do probe NSIS no CI Windows — 2026-11-09

Após o commit de desenvolvimento `7cc18d176fda4eded92ebe9af6d0587c18a013f6`, o proprietário apresentou falha no step `node scripts/windows-runtime-mutex-electron.cjs`: mutex e árvore passaram, mas a assertion de thread comparou acquire `9668` com release `undefined`. A instrumentação usava substituição literal do cabeçalho terminado em LF. Fonte CRLF reproduz a ausência de instrumentação e o mesmo erro; isso explica a diferença entre checkout Git Windows e snapshot LF transferido pelo WSL. O erro não demonstrava ReleaseMutex em outra thread: faltava a medição de release.

`instrumentUninstallRelease` agora aceita LF/CRLF e exige exatamente um alvo antes de compilar; ausência/duplicação falha explicitamente. As assertions de igualdade de threads, abandono, sentinel e exclusão permanecem. O probe real força CRLF na fonte das funções, de forma que o runner WSL também exercite a representação que revelou o defeito. Testes em `scripts/packaging-config.test.cjs` usam o include real nos dois formatos e cobrem alvos ausentes/duplicados. Nenhum código de produto, ACL, mutex, workflow ou proteção foi alterado.

- `npm run test:release-workflow`: **PASS**, incluindo regressão LF/CRLF e contratos/proveniência; log `/tmp/kq-crlf-unit.log`.
- `npm run test:e2e:multi-instance:windows -- --installation-coordination`: **PASS**, runner oficial NTFS, compile, unitários de controle/admin/bootstrap, addon real recompilado, provas Electron Win32 e NSIS GUI/silencioso/crash/falha/fences com CRLF; cleanup sem processos residuais. Log `/tmp/kq-crlf-windows.log`.
- Snapshot testado: HEAD-base `7cc18d176fda4eded92ebe9af6d0587c18a013f6`, fingerprint `1002fcde3ec89fbac3baa27b075524fc0811d945f5792b28866f1bd167f545f9`, 308 arquivos. Depois, somente relatório/ticket atualizados.
- `git diff --check` e `git diff --cached --check`: **PASS** no fechamento.
- Nova execução GitHub Actions, novo build NSIS do produto e instalação real: **NOT RUN nesta correção**. Não se repetiu a campanha ampla por mudança restrita ao probe. O candidato da seção 10 pertence ao snapshot anterior; o CI deve gerar novo candidato/selo, pois scripts/testes integram a proveniência. Nenhum selo antigo foi reaproveitado como prova do conteúdo atual.

Autorização desta rodada inclui commit local da correção; push/PR/dispatch não foram executados. S1 PARTIAL, E1–E5 sem homologação; UAC/cross-account/sessões e matriz instalada continuam pendentes.

## 12. Cleanup do smoke empacotado Windows — 2026-11-09

O proprietário apresentou EPERM ao remover a pasta Program Files da fixture, no finally de `packaged-windows-smoke.cjs`. O trecho disponível comprova a falha de cleanup, mas não identifica o processo/handle que impediu a remoção nem informa se houve uma falha anterior. A inspeção confirmou dois defeitos: erros de fechamento eram suprimidos e um erro no finally substituía a falha original. A ausência de erro de `application.close` era indevidamente tratada como prova de término, mesmo sendo descartada; o script também não verificava descendentes que podem manter o diretório em uso no Windows.

Correção: fechamento via Playwright/app.quit, sem app.exit forçado, exigindo Main terminado com código zero; espera por handles dos processos cujo executável pertence à pasta exclusiva da fixture, com verificação final de ausência, antes do restart e da remoção. Caminhos 8.3 são canonicalizados. Não há kill, sleep, retry de rm ou mudança de ACL para obter PASS. Se término não for comprovado, arquivos/controle/perfil permanecem para diagnóstico. Erro original e erros de cleanup são reportados juntos por AggregateError; PASS só é impresso após o cleanup bem-sucedido. A pasta de staging agora é criada explicitamente e marcada como própria antes da cópia, permitindo tratar falha parcial de cópia com o mesmo contrato.

`scripts/windows-fixture-processes.cjs` implementa a espera restrita à fixture. `tests/windows-packaged-cleanup.cjs` usa cópia real do Electron em temp: mantém processo vivo, exige recusa explícita de cleanup sem kill, confirma arquivos preservados, termina-o por IPC, abre/fecha janela Electron real e comprova remoção após término dos processos, incluindo arquivo readonly. O teste foi integrado ao step existente `windows-runtime-mutex-electron.cjs`, usado no CI e no runner oficial; nenhum runner/launcher alternativo foi criado.

- `npm run test:release-workflow`: **PASS**, log `/tmp/kq-packaged-cleanup-unit.log`.
- Runner oficial Windows `--installation-coordination --approve-untracked`: **PASS** no snapshot final `396f02660ea56287666ebe2a974a4bbdf420a2c0c0ed6dce9c8417127f5f49a3`, HEAD-base `f1df68bf68b3547360623355545ff0b087c74a9e`, com dois novos arquivos revisados. Log `/tmp/kq-packaged-cleanup-windows-final.log`: compile, testes de instalação, addon recompilado, lifecycle/cleanup Electron real, mutex, árvore e probes NSIS PASS; sem processos residuais. Depois, somente documentação atualizada.
- Sintaxe dos scripts e `git diff --check`: **PASS**. Staging revisado e `git diff --cached --check` exigidos antes do commit.
- Smoke completo em Program Files/ProgramData e novo NSIS do produto: **NOT RUN localmente**, permanecem no GitHub-hosted descartável. As provas temp validam o lifecycle/cleanup, não substituem Main de produção instalado ou ACL de produção. Não houve instalação/alteração global no host. A confirmação de que o EPERM do CI desapareceu depende da próxima execução hosted; se houver falha funcional anterior, agora ela será preservada e visível.

Proprietário autorizou commit e push desta correção. Nenhuma mudança de produto, política de segurança ou assertion de trial/IPC/SQLite/persistência. S1 PARTIAL e E1–E5 sem homologação. O pacote anterior é histórico; o CI deve reconstruir e verificar o candidato do novo commit.

## 13. Detecção de processos por caminhos Windows equivalentes — 2026-11-09

O CI posterior a `f1b3a89` passou o mutex, mas o teste negativo de cleanup não encontrou o processo vivo. A primeira correção normalizava somente o diretório com realpath, comparando-o ao texto bruto de `Win32_Process.ExecutablePath`; valores CIM ausentes eram descartados. Não havia teste cruzando as duas representações do mesmo processo. O log hosted contém caminhos `runneradmin`/`RUNNER~1`; ele não inclui o valor bruto do CIM daquele processo, portanto não se afirma ter identificado remotamente qual dessas lacunas ocorreu.

A comparação agora consulta objetos Get-Process para os nomes de executável presentes na fixture, expande **ambos** os caminhos com GetLongPathNameW, normaliza prefixos estendidos e só então compara o diretório completo. Candidato vivo sem caminho consultável falha fechado, em vez de ser tratado como ausente. Os próprios objetos Process/handles são usados na espera, sem intervalo CIM→nova consulta por PID. Não há kill/retry/sleep ou relaxamento da exclusão. [Contrato oficial GetLongPathNameW](https://learn.microsoft.com/windows/win32/api/fileapi/nf-fileapi-getlongpathnamew).

O teste negativo exige agora a mensagem específica `Fixture process still alive`, impedindo que um erro incidental de consulta satisfaça a assertion. A matriz real usa long→long, long→prefixo estendido, short→long e long→short. As duas últimas só são executáveis quando a API retorna um alias 8.3 distinto; caso contrário ficam NOT RUN explicitamente. Nesta execução **as quatro foram executadas e PASS**, incluindo alias `KQ-PAC~2`, com processo Electron real e arquivos preservados. Fechamento normal, drain e remoção readonly também PASS.

- `npm run test:release-workflow`: **PASS**, `/tmp/kq-cleanup-path-unit.log`.
- Runner oficial Windows `--installation-coordination`: **PASS**, log `/tmp/kq-cleanup-path-windows.log`, fingerprint `87c82e883d4cdd910bfeccb28d4531272d8c761c1d5332b639742a8dcd0d0e17`, HEAD-base `f1b3a89e2923470065e562b25d32df8cd2a15f50`, 310 arquivos. Compile, addon real, controle/admin/bootstrap, lifecycle e quatro representações, mutex/árvore e probes NSIS PASS; cleanup sem resíduos. Somente documentação alterada depois.
- Sintaxe e `git diff --check`: **PASS**. Diff staged deve passar check antes do commit/push autorizados no acompanhamento desta correção.
- Reexecução hosted completa e smoke em Program Files: **NOT RUN localmente**, devem ser confirmados pelo CI após push. Nenhuma instalação/ACL/registro/conta do host foi alterada; as provas usaram somente cópias temp. O candidato anterior continua histórico, sem reutilizar selo como evidência atual.

Esta atualização corrige a lacuna de cobertura da seção 12; os PASS anteriores não comprovavam a matriz cruzada. S1 PARTIAL e E1–E5 sem homologação. Commit/push de correção autorizados; sem dispatch manual, PR novo ou Release.

## 14. Fixture de ACL e timeout do Main empacotado — 2026-11-09

O CI passou os probes e chegou ao smoke de produção, que mostrou a falha antes ocultada pelo cleanup: inspector Main conectado, mas handshake DevTools pendente até timeout de 60s. Não se aumentou timeout nem se desativou sandbox/segurança. A inspeção encontrou uma causa suficiente para bloquear esse startup: a fixture editava a DACL do diretório por icacls, enquanto o binding exige o descritor canônico criado pelo NSIS. Reproduziu-se em diretório temp próprio, com leitura **nativa** GetNamedSecurityInfo/ConvertSecurityDescriptorToStringSecurityDescriptor (sem depender da normalização .NET): icacls produziu `D:PAI` e ACEs AU/BA/SY; o contrato requer `D:P` e SY/BA/AU. O owner depois era ajustado, mas isso não corrigia a DACL. O Main recusa esse controle antes da composição e mostra um diálogo síncrono de erro; esse caminho explica o timeout de conexão em vez de um erro de assertion de ACL. O log hosted não inclui o diálogo, portanto a confirmação integral permanece com a reexecução CI.

Correção restrita à fixture: `scripts/create-windows-smoke-control.ps1` usa ConvertStringSecurityDescriptorToSecurityDescriptorW + CreateDirectoryW/SECURITY_ATTRIBUTES, como NSIS, com owner BA/DACL exatos. Compara o descritor nativo relido ao esperado; preexistência/erro/descritor divergente falham. O modo de produção é restrito ao caminho conhecido ProgramData/KaraokeQueue em GitHub-hosted descartável. O modo sintético é restrito a diretório temp exclusivo com SID do usuário atual e ACE própria, sem elevação ou alteração de ACL operacional. O teste agora exige que o **addon de produção empacotado** aceite diretório e manifesto antes de chamar electron.launch; erro passa a mostrar objeto e código Win32 imediatamente. O binding e seus critérios de ACL/owner permanecem intactos.

- Experimento temp icacls/readback nativo: **PASS na reprodução da divergência**; scripts locais `/tmp/kq-acl-shape-native.ps1` e `/tmp/kq-acl-create-shape.ps1` sustentaram a investigação. O segundo demonstrou que .NET DirectorySecurity também não preservava a ordem exigida; a solução final usa a API nativa de criação.
- Criação direta/readback nativo com SID atual: **PASS**, repetida pelo runner no teste `windows-packaged-cleanup.cjs`; não certifica owner BA elevado.
- `npm run test:release-workflow`: **PASS**, `/tmp/kq-control-acl-unit.log`; contratos impedem reintroduzir icacls no diretório e exigem preflight nativo.
- Runner oficial Windows `--installation-coordination --approve-untracked`: **PASS**, fingerprint `17d612aafe69704236901a2ebc57c8dacab48b82a8812ea88fced2dddc10ed3e`, HEAD-base `9fa715e0db9fa5bd72dbe4cbd3cd011e80a43fa0`, 311 arquivos, log `/tmp/kq-control-acl-windows.log`. Compile, criação canônica sintética, quatro formas de caminho, lifecycle, addon/mutex/árvore e NSIS PASS; sem processos residuais. Depois, somente documentação atualizada.
- Sintaxe e `git diff --check`: **PASS**; diff staged deve passar check antes do commit/push do acompanhamento autorizado.
- Token BA elevado, ACL de produção/preflight e startup completo em Program Files: **NOT RUN neste host**, reservados ao CI descartável após push. Nenhuma instalação, elevação ou mudança em ProgramData/ProgramFiles/Registro operacional. S1 PARTIAL, E1–E5 sem homologação; sem flags de privilégio/sandbox ou relaxamento de assertions.

A correção preserva os fixes anteriores de CRLF, identificação de processos e cleanup. O artifact anterior continua histórico; novo candidato deve ser reconstruído pelo CI. Commit/push desta sequência de correções autorizados; sem dispatch manual/Release.

## 15. HTTP 504 e falsa conclusão do build — 2026-11-09

O raw log fornecido pelo proprietário para a execução [42579412002](https://github.com/ChrisDiniz/Karaoke-Queue/actions/runs/42579412002) confirma HTTP 504 durante a montagem NSIS, depois do download 7zip. Não existe mensagem `Windows build sealed`; mesmo assim o step build terminou verde e o step verify falhou por ausência do instalador. Não é evidência de nome errado nem de sucesso seguido de remoção pelo antivírus. O ativo/endpoint exato do download que falhou e o callback que fez a saída ser zero não estão identificados no log. A CLI do próprio Builder 26.18.0 protege exitCode com listener de exit (`electron-builder/out/cli/cli-util.js`, referência upstream #2940); o wrapper do projeto só atribuía exitCode no catch e não verificava o resultado em um processo independente. Antes da correção, o mesmo HEAD 4d8fc75 gerou candidato local PASS: o cache existente não reproduziu o 504 hosted.

O entrypoint agora supervisiona um worker Node de build. Invalida o selo anterior **antes** de iniciar o worker, preserva stdout/stderr e exige status zero mais selo novo e verificação completa de proveniência/pacote no supervisor. Código zero de dependência não prova conclusão. Worker com falha/sinal, Promise que não concluiu ou ausência de selo nunca autoriza usar arquivos antigos. Catch mantém também exitCode não zero no exit, como faz a CLI upstream. Não há novo executável de produto/serviço, mudança no instalador, sandbox, ACL ou testes operacionais. Os critérios do verificador permanecem intactos.

Foram avaliados cache/downloads: a versão travada já valida checksums, mantém cache e possui retries limitados de downloads para erros 5xx. Não se desabilitou SHA/TLS, não se adicionou mirror alternativo ou retry cego de builds. HTTP 504 persistente continua sendo falha de rede e deve encerrar o **step de build**. Não se promete disponibilidade do servidor remoto nem se declara o NSIS instalado validado.

- Regressão por subprocessos reais: erro HTTP504 injetado, reset de exitCode para zero, tarefa pendente sem handles e término zero sem build, todos com arquivos/selo anteriores presentes: **PASS** na recusa. É teste de coordenação/saída, não chamada real ao endpoint que falhou.
- `npm run test:release-workflow`: **PASS**, 19 testes, `/tmp/kq-supervised-build-unit-final.log`. Tentativa inicial dentro do sandbox falhou por spawnSync EPERM em processos aninhados; repetição pela ferramenta aprovada fora desse sandbox passou. Nenhuma política global foi alterada.
- Regressão `node scripts/windows-build-provenance.test.cjs` com Node Windows no checkout NTFS verificado: **PASS**, 5 testes, `/tmp/kq-supervised-build-negative-windows.log`.
- `npm run package:windows:candidate` pelo runner oficial: **PASS**, `/tmp/kq-supervised-build-windows-final.log`. Addon x64 real compilado, NSIS completo, selo, supervisor e verificador subsequente PASS. Snapshot `8f627470086ee5af4f53fa5c4cc8de39ad7c35a5b2c41d2445d4f740a6ddfae5`, HEAD-base `4d8fc75a577038e68ac27ca389a94583067fda5d`; depois somente documentação alterada.
- Inputs selados (226): `8ed9ea2ac1d70be8dfdbc413615474b8e5580a0e2326a56188b71fd8f37b1e99`. Candidato local `E:\KaraokeQueue\e-independent-windows-final-20261108\checkout\dist\Karaoke-Queue-Setup-0.5.0-x64.exe`, SHA-256 `d4e2c7f871fe64b799e10c7d43a05a6f44edb6f687d8152b12c0fd49a51d1bda`. Candidatos intermediários preservados fora de dist; nenhum binário/log foi incluído no commit.
- `git diff --check`: **PASS**; staging/check cached antes do commit. Reexecução hosted, startup protegido com a fixture corrigida na seção 14 e smoke NSIS instalado: **NOT RUN nesta rodada**. Na execução citada, esses steps foram SKIPPED; não são FAIL nem PASS dos seus cenários.

Correção documentada para commit/push autorizados no acompanhamento. Sem dispatch manual, instalação operacional, PR novo ou publicação. S1 PARTIAL e E1–E5 permanecem sem homologação.

## 16. Menu por teclado após retorno de 4K — 2026-11-09

O proprietário apresentou falha Linux em `electron-smoke`: ArrowDown não deixou o menu de fila aberto após retorno de 4K/zoom automático para 1280x800. A primeira execução local do código original passou (`/tmp/kq-linux-menu-repro.log`); portanto o FAIL hosted não foi reproduzido deterministicamente nem se atribui a ele uma causa única comprovada. A inspeção confirmou uma lacuna na pré-condição: o teste usava 100ms após setContentSize, sem comprovar resize/zoom no Renderer. Produção fecha menus em resize por contrato (`queue-interactions.ts` e regressão existente). Um prazo fixo não garante que esse evento já terminou; foco programático também não aguarda previamente o botão entrar no scrollport.

Correção somente de E2E: aguardar viewport Renderer 1280x800 e confirmar zoom Main=1; posicionar o toggle com scrollIntoViewIfNeeded, focá-lo e confirmar activeElement antes de ArrowDown. A assertion original de menu visível permanece, sem retry de tecla/menu ou timeout maior. Se falhar, o erro inclui viewport, foco, aria-expanded, conexão e bounds; traces existentes continuam disponíveis. A suíte específica recebeu o percurso 4K→1280 e assertions adicionais de foco na primeira ação e retorno ao toggle após Escape. Nenhuma regra da fila, renderização, handler de teclado ou visual foi alterado; configuração de segurança existente dos testes não foi modificada.

- Compile TypeScript: **PASS** no snapshot final. Callback de diagnóstico recebeu tipo HTMLButtonElement após TS7006 na primeira compilação.
- `queue-menu-electron` isolado com Electron real/Xvfb: **PASS**, `/tmp/kq-menu-focused.log`; screenshots `/tmp/karaoke-queue-menu-e2e-n3Z24X/screenshots`.
- `npm run test:e2e:linux`: **PASS**, exit0, **13 suítes** com perfis/SQLite isolados; `/tmp/kq-linux-menu-final.log`. Smoke completo passou na assertion relatada; importação legada, drag, RR, cadência, persistência/rollback/IPC, sessões, licenciamento, menu, autocomplete, preferências e diagnósticos também passaram. Evidência smoke `/tmp/karaoke-smoke-evidence-I57bZa`, menu completo `/tmp/karaoke-queue-menu-e2e-UHlVYW/screenshots`.
- HEAD-base `7079a179b54dc40a4bbedb05408d125e86d9d40a`. SHA-256 de `tests/electron-smoke.ts`: `c77a4154b3093ec08a81f986f787e98e17a1d8402d0278b7e1f3e476bf20fa9c`; de `tests/queue-menu-electron.ts`: `545dd62bc5a814365790b54ee0701fcf803f6f2f1b1fc5fad556893eb60d9132`. Depois da campanha somente relatório/ticket atualizados.
- `git diff --check`: **PASS**; staging/check cached antes de commit/push do acompanhamento autorizado.
- Reexecução hosted e Windows/NSIS desta rodada: **NOT RUN**. Mudança restrita aos testes Linux, sem repetir campanhas Windows sem dependência; o próximo CI deve gerar novo pacote/selo porque testes fazem parte dos inputs. O candidato anterior é histórico. Não se declara estabilidade hosted comprovada por um PASS local.

Sem novas funcionalidades, dispatch manual, PR novo, instalação operacional ou Release. S1 PARTIAL, E1–E5 sem homologação; autorização de commit/push do acompanhamento preservada.


## 17. Readback do manifesto, atributos NSIS e lifecycle da DLL — 2026-11-09

A execução [42584134942](https://github.com/ChrisDiniz/Karaoke-Queue/actions/runs/42584134942), HEAD `e63ead7b7110c3843f0432de15ed1d003220380c`, passou Linux e build/verificador/provas Windows, mas o preflight empacotado recusou o manifesto com Win32 1336; cleanup posterior também falhou. Diagnóstico nativo em fixture temporária comprovou que o arquivo tem os ACEs herdados corretos **sem** o bit de controle AI, antes e depois de alterar seu proprietário. Portanto a hipótese de que setowner alterava os grants não se confirmou. O comparador literal exigia metadado de propagação além das permissões.

Correção compartilhada entre C e NSIS: remover somente `SE_DACL_AUTO_INHERITED` dos descritores privados de readback/esperado antes da comparação exata. Não modifica ACL no filesystem, owner, SID, ordem/tipo/máscara dos ACEs, herança ID nem proteção P. Diretórios continuam exigindo descritor protegido exato; owner SY/BA continua obrigatório. APIs: [controle do descritor](https://learn.microsoft.com/en-us/windows/win32/secauthz/security-descriptor-control) e [SetSecurityDescriptorControl](https://learn.microsoft.com/en-us/windows/win32/api/securitybaseapi/nf-securitybaseapi-setsecuritydescriptorcontrol).

A prova real NSIS expôs também comparação textual de atributos: `16` retornado por Win32 não corresponde à string `0x10`. Comparações agora usam a representação decimal, inclusive WAIT_ABANDONED=128 nos caminhos de uninstall/manutenção. Foi acrescentado cenário NSIS de mutex previamente abandonado: deve abortar sem remover o sentinel, liberar ownership na thread adquirente e permitir aquisição limpa seguinte. Não aceita abandono como sucesso.

O preflight do smoke agora carrega a DLL em subprocesso e exige término zero; carregar .node no processo pai mantinha o arquivo mapeado até sua saída e impedia cleanup da própria fixture. Regressão carrega cópia real do addon em filho, aguarda saída e exige exclusão imediata da DLL, preservando todas as assertions anteriores de processos vivos, encerramento normal e caminhos equivalentes.

- `npm run test:release-workflow`: **PASS, 19 testes**, `/tmp/kq-ai-release-final.log`.
- Runner oficial `--installation-coordination`: **PASS**, `/tmp/kq-ai-windows-final.log`, HEAD-base `e63ead7…`, fingerprint `91c16d37e901bc55b5232e08bdaf8be445d52fb5c31db5e9e068397f55c66ffc`; depois somente documentação alterada. Compile, unitários de instalação, addon x64 N-API/Electron real, matriz positiva/negativa de DACL, readback de arquivo real via NSIS, GUI/silencioso, abandono, crash/failure, fencing de identidades/gerações e cleanup passaram.
- Iterações intermediárias: teste NSIS confirmou strings DACL idênticas mas pasta recusada por comparação 16/0x10; o teste negativo sem grants exigiu restaurar herança **apenas no arquivo sintético** antes de cleanup. Erro de sintaxe intermediário do novo teste foi corrigido; não contado como PASS.
- Novo build/verify e smokes protegidos de instalação/empacotado: **pendentes no CI deste commit**, não se usa o candidato anterior como prova. O acompanhamento autorizado fará commit/push e verificará os jobs do SHA correspondente, sem dispatch manual, merge ou Release.
- Nenhuma instalação/elevacão operacional, ProgramData/Program Files/registro ou ACL real alterada. Testes locais só em temp/perfis sintéticos. Cross-account, duas sessões e UAC interativo continuam **NOT RUN**; S1 PARTIAL e E1–E5 sem homologação.


## 18. Proprietário da fixture no runner elevado — 2026-11-09

A execução [42590711227](https://github.com/ChrisDiniz/Karaoke-Queue/actions/runs/42590711227), commit `3244fc95651aedf483bf816f5d637ec77ef15cd6`, passou Linux, build/verify Windows e provas N-API/cleanup; a nova prova NSIS de arquivo herdado falhou antes dos smokes protegidos. A fixture substituía o owner permitido BA pelo SID sintético. Arquivos criados pelo token elevado podem ter owner BA, portanto essa substituição removia um proprietário **legítimo de produção** da prova, diferentemente do ambiente local sem elevação. A fixture agora conserva BA/SY e admite adicionalmente o SID atual somente no include temporário; nenhuma permissão ou proprietário adicional é aceito pelo produto. Acrescentado readback Owner/Sddl ao log. Hipótese hosted será confirmada na próxima execução; não declarada comprovada pelo PASS local.

Runner oficial `--installation-coordination`: **PASS**, `/tmp/kq-fixture-owner-windows.log`, fingerprint `4fc9a38b32d28b880089883b9711aad4bb93e975204225b64e8f986ded0d8224`, HEAD-base `3244fc9…`; depois somente documentação alterada. Todas as assertions de arquivo válido/inválido, mutex, ownership/abandono, estado obsoleto e cleanup mantidas. Build/instalação e artifact do próximo commit continuam pendentes do CI. Sem instalação operacional, elevação local ou mudança na política de produção.


## 19. Saída normal com sessão ativa no smoke empacotado — 2026-11-09

A execução [42611452057](https://github.com/ChrisDiniz/Karaoke-Queue/actions/runs/42611452057), commit `83018a50cf2ebb64831ea494e00af01e5ab47b8c`, passou Linux, build NSIS/verificador e todas as provas de coordenação Windows. O preflight do binding de produção também passou (`PACKAGED CONTROL PREFLIGHT PASS`). O smoke ficou aguardando após isso e foi cancelado pelo acompanhamento, sem contar esse cenário como PASS. Inspeção do caminho real identificou uma omissão do harness: `application.close()` chama app.quit, e MainManagementCloseCoordinator pede decisão nativa quando há sessão ativa. O smoke acabara de criar essa sessão, mas não tinha port de resposta para a pergunta. Não há decisão automática de produção.

Correção somente no teste: antes do fechamento, instalar explicitamente um port de diálogo nativo que verifica a pergunta e as três opções exatas e responde **Sair sem encerrar sessão**. O port grava o pedido em marcador temporário; o pai exige esse marcador, a pergunta/opções esperadas, término real do Main com código zero e ausência de processos antes de limpar/reabrir. O teste continua usando o coordenador, flush e lifecycle normais; não usa app.exit/kill nem remove handlers/locks. As assertions anteriores de fila, sessão, SQLite e licença após restart continuam obrigatórias. É automação da decisão pelo port, **não prova da interação visual com o diálogo Windows**. Novos logs distinguem launch, fechamento normal e assertions de restart.

- Compile **PASS**; testes de MainManagementCloseCoordinator **PASS, 5**; workflow/proveniência **PASS, 19**, logs `/tmp/kq-smoke-close-{compile,unit,release}.log`.
- Experimento focado com a função close exata do smoke atual, Electron real/Main de produção em dev, perfil/SQLite isolados e **chromiumSandbox:true**: **PASS**, `/tmp/kq-smoke-close-electron-sandbox.log`, fixture `/tmp/kq-management-close-proof-E9Fh3A`. Exigiu prompt, saída normal, entrada pending preservada e sessão sem ended_at no SQLite. Não prova pacote Windows nem UI nativa. Primeira tentativa encontrou uso de require indisponível na closure evaluate, corrigido para process.getBuiltinModule; seu FAIL foi preservado e a fixture foi fechada normalmente pelo inspector, sem kill.
- Runner oficial Windows `--installation-coordination`: **PASS**, `/tmp/kq-close-and-readback-windows.log`, fingerprint `3a49c35d1aba596063fbb7a2869ba3d88e171e6752006b1aeaba7b67a61de8c3`, HEAD-base `83018a5…`; depois somente documentação alterada. Inclui readback Owner/Sddl não vazio, addon real e todos os cenários NSIS de arquivo válido/inválido, exclusividade/ownership/fencing/abandono e cleanup.
- O readback diagnóstico anterior saiu vazio por composição incorreta do comando PowerShell. Agora usa variável de ambiente e exige JSON com Sddl; não tolera saída vazia como evidência.
- Build e smokes do próximo SHA serão acompanhados no CI. Smoke anterior cancelado, instalação NSIS e artifact ainda não concluídos nessa execução; não atribuídos PASS por inferência. S1 PARTIAL, homologação E1–E5 pendente. Sem merge/Release/instalação operacional.


## 20. Readback sem dependência do módulo Get-Acl — 2026-11-09

A execução [42613588237](https://github.com/ChrisDiniz/Karaoke-Queue/actions/runs/42613588237), commit `cdb14fe1a957f1ca3aef644f7a43daa34a1a0b37`, passou Linux e build NSIS/proveniência, mas falhou no diagnóstico Get-Acl: Windows PowerShell encontrou Microsoft.PowerShell.Security, porém não conseguiu carregar o módulo. Esse erro aconteceu antes da prova NSIS de arquivo e dos smokes protegidos, que não são PASS nessa run. A composição exata que impede o autoload no host não foi reproduzida localmente; não se alterou PSModulePath global nem políticas para contornar.

O diagnóstico usa agora `[IO.File]::GetAccessControl` do .NET Framework do Windows PowerShell e lê owner SID/SDDL, sem depender do cmdlet Get-Acl. Leitura apenas; continua exigindo status zero e JSON com Sddl. Teste Windows direto em arquivo temporário exclusivo: **PASS**, `/tmp/kq-dotnet-readback-proof.json`, JSON validado por Node; script sintaticamente válido e git diff --check PASS. Não repetida campanha local de produto: alteração só na leitura diagnóstica; as provas nativas e smokes completos serão novamente exigidos no CI deste commit. A etapa que testa ACL válida/inválida não foi removida nem teve assertions alteradas. Sem instalação/elevacão operacional.


## 21. Diagnóstico da primeira instalação NSIS no hosted — 2026-11-09

Run [42614670826](https://github.com/ChrisDiniz/Karaoke-Queue/actions/runs/42614670826), HEAD `bb7b55b2b855ae93b1f8fc03ab3b405f0fb879c0`: Linux PASS. A primeira tentativa Windows caiu durante packaging com status `3221226505` (`0xc0000409`) do worker Node, sem selo; supervisor recusou o build. Causa do crash não identificada. Reexecutado somente o job falho do mesmo SHA em runner novo: build NSIS, verificador, provas nativas/NSIS e **smoke empacotado com IPC/SQLite/licença/restart/fechamento normal PASS**. O crash não se repetiu, mas isso não comprova sua causa nem estabilidade absoluta do ambiente.

O smoke de instalação real começou e retornou exit2 na primeira instalação; etapas de checksum/artifact não executadas. Não se infere qual guarda falhou desse código genérico. Hipótese de flag de erro herdada de ReadRegStr foi descartada experimentalmente: função real KQ_InitializeInstallationControl, copiada para fixture com SID atual/paths temporários, passou mesmo com SetErrors prévio; falha real de FileOpen foi corretamente recusada. Não se adicionou ClearErrors como falsa correção. Esses dois cenários agora integram o probe versionado.

Acrescentados códigos de erro que preservam o aborto fechado e permitem diagnosticar a guarda no modo silencioso: 201=destino fixo divergente; 202=opção destrutiva proibida; 203=resolução ProgramData; 204/205=instalação HKCU conflitante; 206=estado/registro global conflitante; 210–217=inicialização do controle (atributos, SDDL, criação, GUID, manifesto, owner); 219=criação dos mutexes; 220=aquisição. Códigos 301–309 distinguem criação/ACL/membership/admissão da árvore administrativa. Códigos genéricos restantes continuam não zero. Não foram removidos controles, modificados privilégios, liberados locks prematuramente nem toleradas falhas. O smoke informa a imagem que falhou e existência/atributos somente das suas fixtures descartáveis, sem ler perfis operacionais.

Runner oficial focado **PASS**, `/tmp/kq-nsis-errorcodes-windows.log`, fingerprint `c447c7bbd2f25fce5b110c01a7a25b4dfeee76c384e6830a99aff715d156c302`, incluindo novo initializer, arquivo válido/inválido e coordenação completa. Depois desse snapshot foram acrescentados dois marcadores de código 219/220 e diagnóstico read-only no smoke; verificação definitiva exigida no CI seguinte. `test:release-workflow` **PASS 19** antes desses marcadores; repetido no estado final em `/tmp/kq-nsis-codes-release-final.log`. A instalação real continua FAIL e artifact indisponível até correção/comprovação da causa. Sem instalação operacional/merge/Release; S1 PARTIAL e E1–E5 sem homologação.


## 22. Abertura do manifesto inicial — 2026-11-09

Run [42617458239](https://github.com/ChrisDiniz/Karaoke-Queue/actions/runs/42617458239), HEAD `f241aa11c970b4adfed5a65585808d180551db2e`, passou Linux, build/verify Windows, provas nativas e smoke empacotado. Primeira instalação NSIS abortou com **215**, ramo IfErrors imediatamente após FileOpen do manifesto inicial. O log ainda não provou se havia erro NSIS anterior ou erro Win32 de abertura. Os Write-Output diagnósticos estavam sendo capturados pela atribuição `$install = Invoke-FixtureProcess` e não chegavam ao console; passam a usar Write-Host, preservando o retorno Process da função. Em falha, icacls faz somente readback da pasta sintética previamente ausente, criada pelo próprio smoke hosted.

FileOpen agora começa com ClearErrors e valida a flag produzida pela própria abertura. Falha real continua abortando; código `215000 + GetLastError()` diferencia o ramo de IO, sem permitir continuar com handle inválido. A origem completa da falha hosted permanece em investigação até repetição; não se declara uma correção de permissões por inferência. Não alterados SDDL, owners ou grants.

Regressão usa a função NSIS real com SetErrors injetado imediatamente antes do ClearErrors/FileOpen: criação precisa produzir manifesto válido; escrita num caminho de diretório deve continuar sendo recusada. Runner oficial focado **PASS**, `/tmp/kq-nsis-fileopen-windows.log`, fingerprint `063d5795922f2a67716a8ed0d376351ce6b055d1dcd54308814064b8948b47c6`, HEAD-base f241aa1. Depois apenas o instrumento da prova foi extraído para aceitar LF/CRLF e exigir uma única correspondência; teste dedicado cobre ambos e impede instrumentação vazia/duplicada. Workflow/proveniência **PASS, 20 testes**, `/tmp/kq-fileopen-release-final.log`. Prova descartável NSIS GetFileAttributes também confirmou `-1,missing`; essa hipótese de comparação não explica o aborto. Nenhuma instalação operacional executada.

Instalação real e artifact continuam pendentes do CI seguinte. O último smoke empacotado é PASS apenas do seu SHA; não usado como substituto do próximo. S1 PARTIAL e E1–E5 sem homologação, sem merge/Release.
