# Fase E — Ajustes de instalação e onboarding


## Ajustes de instalação e onboarding autorizados — 2026-11-09

O proprietário autorizou explicitamente corrigir o diretório selecionável, as telas nativas de manutenção/desinstalação, a indexação/importação do Welcome e a nova escolha de função depois de uninstall/reinstall. Também autorizou commit/push e acompanhamento do PR existente até CI/artifact; sem merge ou publicação. Não há frames Doop para NSIS: o proprietário autorizou o desenho nativo. Welcome e mídia reutilizam as referências aprovadas e o diálogo de problemas já existente em Configurações. Nenhum frame foi alterado.

- **Local escolhido:** NSIS mostra o seletor. Mantém uma instalação por máquina, identidade HKLM/appId e dados por conta. O alvo novo deve estar vazio e numa unidade local com ACL segura; pastas pessoais, reparse points, compartilhamentos e ancestrais substituíveis por usuário comum são recusados. Diretórios novos recebem owner Administrators, SYSTEM/Administrators full e Authenticated Users RX. Não se reescrevem ACLs de pastas existentes. Reparar usa o local registrado; mudar o local exige uninstall/reinstall. O binding permite o caminho customizado somente com HKLM InstallLocation correspondente e owner/DACL/cadeia de ancestrais protegidos. A compatibilidade Program Files permanece.
- **Manutenção:** executar novamente o instalador identifica a instalação, explica preservação dos dados e oferece reparar mantendo função ou trocar para Reprodutor/Tudo em um. Sem função confirmada, só reparar; escolha inicial continua no app. Painel de Controle abre opções reparar/trocar ou desinstalar; reparar é o padrão e abre cópia do mesmo instalador em ProgramData protegido. A cópia permanece com o controle recuperável; não é outro executável de produto/serviço. Cancelar antes do commit preserva função/generation. Silencioso mantém intenção explícita /S de uninstall; nenhuma finalização forçada.
- **Reinstall:** somente após bootstrap/atalhos verificados, consome o tombstone com fences e avança generation para unconfigured/role:null. A função antiga não é retomada automaticamente. Retry do mesmo operationId é idempotente; falha mantém intenção recuperável. Todos os bancos, históricos, bibliotecas, catálogos e configurações por conta permanecem. Nova escolha explícita repõe o marcador de setup pendente sem apagar dados.
- **Welcome:** indexação real pelo VideoLibraryService publica scanning e contagens finais; CSV usa MusicCatalogService, confirmação da substituição e lista paginada dos números inválidos recuperáveis. Cancelamento/CSV estruturalmente inválido preservam catálogo anterior. Renderer usa texto, IPC restrito ao Welcome e nenhum acesso genérico a arquivos. Player mantém relatório no seu SQLite; Combined mantém o relatório desta composição de onboarding em memória, sem migração do banco operacional. A confirmação Combined faz CAS de revisão dentro da transação. Fechamento drena o serviço antes de encerrar; Continuar/Configurar depois não reenviam CSV já importado/rejeitado.

Testes novos cobrem ambas as funções, SQLite real isolado, cancelamento, paginação, restart, catálogo alterado entre preview/commit e reinstalação com falha/retry. O PR passa a executar o E2E real de modos/onboarding. Smoke hosted instala em caminho customizado, verifica N-API/manifesto/atalhos, exerce a página GUI de manutenção/cancelamento, uninstall/reinstall e preservação dos hashes de userData. Execuções/resultados desta alteração serão registrados abaixo; o CI anterior não é evidência deste snapshot.

**Gates:** E0 aprovada; S1 PARTIAL; E1–E5 sem homologação. UAC interativo/cancelamento real, ACL entre contas/sessões, legado/N-1, falhas instaladas com reboot e aceite visual/manual permanecem pendentes quando não executados. Não houve instalação no host operacional.

### Validação antes do primeiro push

- `npm run test:unit`: PASS; SQLite sintético, domínios e regressões existentes. `test:unit:installation-control`: PASS, incluindo reset das duas funções, falha de bootstrap, restart/retry e proteção CAS. `test:release-workflow`: PASS 20/20 fora da restrição EPERM de subprocessos do sandbox. Parser PowerShell dos dois smokes: PASS, sem executá-los no host.
- Runner oficial Windows real: PASS no snapshot `a85d0ddbf169d150f60a7f0b4c374e03a83656b465eb855d7e8ca6efd765a4ea`, HEAD base `b734b9a542de518b2584d7441424110d6039f4a5`; migração, single-instance/foco, Controller legado/Combined/Player, Welcome das duas funções, scanning→ready, CSV parcial 61 problemas/50+11, cancelamento, confirmação SQLite e Configure depois. Cleanup/processos residuais: PASS. Log local `/tmp/kq-onboarding-windows-e2e2.log`; imagens em `E:\KaraokeQueue\e-onboarding-evidence-20261109`. Comparação com Doop mantém estrutura/cartões/cores; status e relatório reutilizados de Configurações. Capturas posteriores normalizam conteúdo para 1280×800, além de escala CSS. Não constitui aceite visual humano.
- Build oficial NSIS x64 + binding real + verificador: PASS no snapshot `51905237c8681865cb6f23f8fc4e21b1cc94c5cfd13cfb73ca3e1af3a79bf799`; inputs selados `e128adc02f615c388eee569f0b4f27cd6de64a755b6ea04ddb74af7ec8de61a7`; SHA-256 `1adb23ab6ed626d71ba7e91dfb5b87cb2a923ec6911a02a209e095523e9e1a2d`. Log `/tmp/kq-location-build4.log`. Mudanças posteriores em testes invalidam o selo anterior: CI deve gerar novo candidato; não atribuir esse binário ao novo snapshot.
- Falhas encontradas/corrigidas: inventário do novo CSS, verificador ainda exigindo alvo fixo e expansão precoce `${isUpdated}` antes do registro de plugins. Macro atual usa flag calculada no customUnInit. O E2E aguarda entrega real dos eventos antes da asserção, pois resposta invoke e eventos são assíncronos; nenhuma asserção removida. Um build interrompido pelo inventário foi preservado com seu lock/backup; restauração só ocorreu após confirmar worker morto, checkout sem processos e ausência de sync pendente.
- **Pendente neste ponto:** smoke de instalação/GUI no runner hosted e artifact do código novo. Não executar esses smokes no host operacional. Resultados do CI serão registrados após execução.

### Provas complementares do commit enviado

Runner oficial `--installation-coordination`: PASS no commit `3cf3e312516c042c70ee9979958f0af6d7c67889`, fingerprint `104e263f32ea3b56c17768eca2b9b79fc93406646eedb1f67b13e87defccae10`; N-API real, mutex/thread ownership/contenção/abandono/ACL readback, árvore administrativa e fences NSIS. Log `/tmp/kq-location-native-proof.log`.

Smoke hosted acrescenta provas negativas da fronteira nova: pelo Electron empacotado em Run-As-Node, o binding aceita o caminho customizado protegido, recusa escrita AU na própria raiz (sem mudar ACL do exe) e recusa InstallLocation HKLM divergente. Cada alteração é restrita à fixture identificada e revertida em finally antes de iniciar Main/helper. O script recusa execução fora de runner hospedado; execução ainda pendente de CI. Não é prova entre contas ou UAC.

### Primeira execução CI deste ajuste

Run [42695735985](https://github.com/ChrisDiniz/Karaoke-Queue/actions/runs/42695735985): Linux completo PASS; Windows build, pacote e provas N-API/NSIS PASS. Novo E2E encontrou fixture sob alias 8.3 `RUNNER~1`, recusada corretamente pelo guard de caminhos do CSV. A fixture passa a usar `fs.realpathSync.native(os.tmpdir())`; nenhuma proteção de produção foi relaxada. Instalação/artifact desta run NOT RUN devido à falha anterior.

O smoke também exercita confirmação pelo helper real em runner já administrativo (sem fingir prova do UAC): confirma Combined, verifica as duas opções de troca na manutenção, cancela sem alteração e faz uninstall/reinstall de uma função efetivamente confirmada. Exige retorno a unconfigured e Welcome mesmo com o modo legado/SQLite preservados, além dos hashes de todos os arquivos antes/depois. Provas negativas de caminho e os novos passos ainda aguardam a próxima run.


Runner completo repetido no commit `9799dfcd07b233eceb50c6d07b639116eeac1542`: PASS, fingerprint `99dc74e52be887bf7d813aaa9bb77a62cdb5dcaf79b3e524f7bb5e266fb75f2d`. Log `/tmp/kq-onboarding-final-windows.log`. Capturas de ambas as funções em conteúdo 1280×800, escala CSS, comparadas visualmente ao frame `gFR_COs4VP`; mantidos estrutura/cartões, referências e diálogo compartilhado, com estados funcionais acrescentados. Sem aceite humano implícito. O smoke hosted inclui também repair/update efetivo após confirmação Combined, exigindo mesma identidade/função, avanço de geração e hashes do userData preservados. Restauração da prova negativa limita-se à DACL que o teste alterou, preservando owner/group/SACL.


Run [42697261744](https://github.com/ChrisDiniz/Karaoke-Queue/actions/runs/42697261744): Linux, build/verificador Windows, N-API/NSIS, onboarding real e smoke empacotado PASS. Instalação silenciosa inicial `/S /D` recusada com 230: o template Builder faz SetOutPath antes de customInit e cria o destino com ACL herdada, fora da criação protegida do guard. Recusa preservada, sem relaxar ACL. O smoke inicial agora usa o seletor MUI gráfico real, seleciona o caminho antes da seção protegida e exige manifesto confirmado/arquivo/Finish/término. Isso testa diretamente o requisito solicitado. Repair/reinstall silenciosos usam o ancestral protegido criado nessa primeira instalação. Instalação silenciosa em local novo exige ancestral previamente protegido; não se alteram permissões de pastas de terceiros.

### Checklist manual do proprietário (após artifact CI)

- Em ambiente de teste, abrir o instalador sem /S, escolher outra pasta local protegida e conferir os atalhos/primeira abertura.
- Escolher cada função em instalações separadas; autorizar/cancelar UAC interativo e verificar retomada sem função selecionada automaticamente.
- No Welcome, selecionar acervo, observar indexação/conferir contagens e importar CSV parcial; conferir confirmação, registros ignorados, paginação e Configurar depois.
- Executar novamente o instalador: conferir mensagem de instalação existente, reparar mantendo função e trocar função preservando bancos/históricos/acervo.
- Painel de Controle: conferir as duas opções; cancelar sem efeitos, reparar e desinstalar explicitamente.
- Após uninstall/reinstall, escolher novamente a função; confirmar dados anteriores preservados nas respectivas contas e ausência de fusão dos bancos.
- Homologação entre contas/sessões, UAC real, legado/N-1, interrupções/reboot e julgamento visual/áudio continuam separados do CI. Não usar a aprovação automatizada como homologação E1–E5.


Na revisão própria foi corrigida a precedência do CSS compartilhado: a folha comum é carregada antes dos ajustes responsivos/TV do Standalone, e a cópia dos estilos-base dos botões ficou somente no Welcome. O E2E real passa a exigir fonte/padding/altura originais do diálogo em 1920px (escala 1,5), evitando regressão da tela de Configurações ao reutilizar o diálogo. Nenhuma decisão visual nova.


Regressão de escala revalidada no runner oficial: PASS, snapshot `0c988a30e2a301a9f061a9bd9b6e1262118e29647cf89f558a429fa7d698e19b`, HEAD base `a6f4a2c7e82c1876dfc040d013d15bca549db5ab`; inclui fonte 30px, padding 36px e paginação 51px em viewport 1920. Log `/tmp/kq-css-windows-scale.log`. Botões-base do Welcome têm a mesma especificidade de Configurações, para a paginação manter largura mínima 90px e não herdar a largura dos botões de confirmação; asserção correspondente no E2E.


Run [42698984814](https://github.com/ChrisDiniz/Karaoke-Queue/actions/runs/42698984814): Linux, build/verificador e provas nativas PASS; controller do E2E encerrou com código 1 após o primeiro cenário, sem stack. Causa exata não comprovada por aquele log. Teardown usa agora o handle ChildProcess criado pelo teste, sem reconstrução `taskkill /T` por PIDs; aguarda os processos do runtime de teste antes de limpar perfis. Acrescentado diagnóstico síncrono de cenário/recursos e FAIL explícito se a campanha encerrar incompleta. Não remove asserções nem transforma a falha em PASS; nova execução necessária. O observador do manifesto no smoke GUI também usa FILE_SHARE_DELETE, evitando que o próprio teste bloqueie o replace atômico.


O ensaio local identificou que Playwright Windows lança via `shell:true`: o ChildProcess retornado é cmd.exe, não o Main Electron. A primeira tentativa por handle do wrapper foi **CANCELLED**, não PASS; o procedimento oficial confirmou PID/runId, encerrou somente a árvore/perfil da fixture e recuperou build/lock. O helper de testes agora captura o PID real no Main, compara argv Windows exato (`CommandLineToArgvW`), caminho canônico e creation time, retém handles antes do primeiro stop e confirma ausência de descendentes daquele perfil. Não usa árvore reconstruída por PID nem confunde perfis com prefixos semelhantes/espaços. Prova de regressão mantém outro Electron vivo, recusa executável divergente e confirma término do Main/filhos reais. Falhas preservam perfis; nenhuma autoridade de produto foi adicionada.

### Resultado do cleanup e layout corrigidos

Runner oficial completo **PASS**, snapshot `ac304997ce2985aad11635f6d371f9ebc3bfe6ba0cb9df72bbc83c04eadbc7df`, HEAD base `a6f4a2c7e82c1876dfc040d013d15bca549db5ab`. Log `/tmp/kq-owned-main-windows.log`: prova do Main real versus cmd, recusa de imagem divergente, isolamento de perfil com prefixo/espaços, outro Electron mantido vivo, N-API/NSIS, modos, CSV, biblioteca, SQLite, escala/paginação e cleanup/processos residuais PASS. A hipótese genérica anterior sobre taskkill não é confirmação da causa exata da run sem stack; a identidade incorreta do wrapper foi comprovada e corrigida no harness. Instalação/GUI/artifact do novo snapshot seguem dependentes do próximo CI.


Run [42731041731](https://github.com/ChrisDiniz/Karaoke-Queue/actions/runs/42731041731), commit `594351e`: Linux completo, build/verificador, provas N-API/NSIS/cleanup, onboarding e smoke empacotado **PASS**. O smoke GUI procurava o controle de diretório antes de avançar a MUI_PAGE_WELCOME que o customWelcomePage inclui; falhou explicitamente, sem artifact. Automação agora avança essa página uma única vez, tanto no instalador inicial quanto no cache de manutenção, e só aciona Finish após manifesto/arquivos confirmados e botão de conclusão identificado. Sem relaxar permissões ou asserções. Acrescentado dump de controles em caso de falha. Nova instalação GUI permanece aguardando CI.


A automação entre processos usa WM_SETTEXT/WM_GETTEXT com SendMessageTimeout e readback do Edit, conforme [SetWindowTextW](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setwindowtextw) e [WM_GETTEXT](https://learn.microsoft.com/en-us/windows/win32/winmsg/wm-gettext); não confunde o texto real do controle com caption em cache. Mantidos os deadlines e as asserções de caminho/manifesto/término.


Antes de executar o cache na manutenção, NSIS verifica que é arquivo comum sem reparse e reutiliza o leitor de owner/DACL para recusar owner não privilegiado ou escrita por contas comuns. O smoke verifica também a segurança do arquivo em si, além do diretório/manifesto protegido. Não relaxa ACL para obter execução; qualquer cache não confiável bloqueia o ramo de reparo com a orientação de executar o instalador original.


## Resultado consolidado — CI integral PASS

Execução [42733046324](https://github.com/ChrisDiniz/Karaoke-Queue/actions/runs/42733046324), HEAD `896df226ccce5ed421b86ec464fb33bbe896cee0`; merge testado `b70ff716b2397b3f495d4a30f4182b6d0a050bb6`. Jobs **Linux compile, unit and Electron E2E: PASS** e **Windows x64 package and smoke test: PASS**. Nenhuma asserção removida, nenhum merge, tag, Release ou instalação no Windows operacional.

| Solicitação / contrato | Evidência executada | Resultado |
|---|---|---|
| Selecionar local | Wizard MUI real, campo de diretório com readback, instalação concluída em caminho customizado fora de Program Files | PASS |
| Welcome: acervo/CSV como Configurações | Electron/IPC/SQLite reais nas duas funções; scanning→ready, CSV parcial, cancelamento/confirmar, 61 problemas paginados 50+11, adiamento, restart; escala de Configurações preservada | PASS |
| Painel de Controle informativo | Página nativa com reparar/trocar e desinstalar; reparar padrão; cache protegido lançado; cancelar sem mudar manifesto/arquivos | PASS |
| Reexecutar instalador | Página informa instalação existente, reparar e as duas funções; teste em unconfigured e Combined; repair/update efetivo mantém função/identidade e avança geração | PASS |
| Uninstall/reinstall pede função novamente | Helper real confirma Combined em runner já administrativo; uninstall guarda tombstone; reinstall publica unconfigured/null; Main real volta ao Welcome apesar de SQLite/modo legado existentes | PASS |
| Preservação e isolamento | Todos os hashes de arquivos do userData antes/depois de confirmação, cancelamento, repair, uninstall/reinstall; atalhos próprios e Registro conferidos | PASS |
| Confiança do caminho/cache | N-API empacotado aceita caminho protegido e recusa raiz gravável AU/HKLM divergente; restaura a fixture; owner/DACL do cache verificados antes de execução | PASS |
| Coordenação/empacotamento | Mutex/thread-owner/contenção/abandono/ACL, Job Object/fences NSIS, cleanup com Main real e outro perfil vivo; build NSIS x64, verify e smoke empacotado | PASS |

Artifact [Karaoke-Queue-PR-4-Windows-x64](https://github.com/ChrisDiniz/Karaoke-Queue/actions/runs/42733046324/artifacts/13724859407), ID `13724859407`, 124.947.787 bytes. Instalador `Karaoke-Queue-Setup-0.5.0-x64.exe`; SHA-256 **`9f7bf54581c3f9e4be66da08632ef2b4fb5284ce2f6c28054b2cb9055cbfa62e`**. Manifesto e SHA256SUMS conferidos depois do download para `%TEMP%\kq-ci-42733046324-artifact`; checksum do arquivo baixado coincide com ambos. Digest do ZIP do Actions: `sha256:9a3f7c0fbde0daff7d4eea042d8be5b2c3e976ff2b8c4a5e5975ebbcd9d1bb21` (distinto do SHA do exe).

Fingerprint de inputs selado/verificado: `4a248b6a547f1a7cac90f767955d9bd380196f63d97c4487ef370c2a27159e64`. Logs locais `/tmp/kq-ci-windows-success5.log`, `/tmp/kq-ci-onboarding-watch5.log`; logs persistentes vinculados na run. Os commits seguintes exclusivamente documentais não mudam esses inputs; novo artifact deve sempre identificar seu próprio sourceSha/hash.

**NOT RUN / homologação restante:** UAC interativo com conta padrão, cancelamento e credenciais; ACL/mutex entre contas e sessões; legado/N-1 e interrupção/reboot reais; troca efetiva de função por clique até o fim do wizard; seleção física do diálogo de mídia (E2E fornece caminhos ao diálogo Main); julgamento visual/áudio e validação do proprietário. Os probes/crash de fixtures não substituem esses cenários. S1 PARTIAL, E1–E5 não homologadas/aprovadas. **GO para artifact de validação e checklist manual; sem autorização automática de distribuição/merge.**


## Continuidade — licença Player e fullscreen

O proprietário acrescentou ativação no topo ocioso do Reprodutor, compartilhada com Tudo em um, e abertura Player sempre em fullscreen. [Contratos e evidências desta adição](fase-e-player-licenca-fullscreen.md). A run documental 42734516214 revelou uma corrida no harness de fechamento Linux; corrigida com observação externa, exit normal obrigatório e verificação integral do SQLite após restart, preservando a evidência anterior como histórica. O novo candidato exige seu próprio CI/artifact.
