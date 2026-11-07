# Testes nativos do Windows a partir do WSL2

## Objetivo e arquitetura

O WSL2 é o ambiente principal de desenvolvimento e a fonte autoritativa do código. O clone em NTFS é usado somente para validação nativa do Windows. O runner parte do WSL, sincroniza um snapshot controlado e inicia PowerShell e Node.js do Windows:

    Checkout WSL2 (origem)
      └─ inventário + hashes + bundle Git
           └─ PowerShell do Windows
                └─ clone NTFS isolado
                     └─ npm ci → compile → Electron/Playwright E2E

O checkout Windows não é uma segunda origem. Alterações feitas nele não são copiadas de volta ao WSL.

## Requisitos

- WSL2 com Node.js, npm, Git e `wslpath`.
- Interoperabilidade WSL/Windows habilitada para executar `powershell.exe`.
- Windows com Git for Windows, Node.js compatível com `engines` em `package.json` e npm.
- Clone de validação em volume NTFS. Por padrão, o runner procura `source\karaoke-queue-win` sob `$env:USERPROFILE`. Para outro diretório, configure `KARAOKE_QUEUE_WIN_CHECKOUT` no ambiente do PowerShell iniciado pelo WSL; ao iniciar o runner no WSL, encaminhe essa variável ao Windows com `WSLENV` (`/w`), conforme o exemplo abaixo.
- Sessão gráfica Windows interativa para esta suíte de múltiplas instâncias. A compilação sozinha não precisa abrir janelas.

O runner não instala ferramentas globais nem altera configurações do Windows ou do Git. `npm ci` instala dependências em `node_modules` do clone Windows e usa `.npm-cache` local.

## Comando central

Execute no terminal WSL, a partir do repositório:

    npm run test:e2e:multi-instance:windows

O fluxo único prepara o snapshot, verifica o clone, executa `npm ci`, compila com Node/npm Windows e inicia `build/tests/multi-instance-electron.js` com o Electron e Playwright locais do Windows. O Electron usa perfis e bancos SQLite temporários.

Arquivos novos não rastreados são listados com SHA-256 para revisão. Em um terminal interativo, confirme digitando `SYNC`. Para automação após revisar exatamente a lista exibida, passe a aprovação explícita:

    npm run test:e2e:multi-instance:windows -- --approve-untracked

Essa opção aprova somente a lista identificada naquela execução. Arquivos sensíveis, caminhos incompatíveis com Windows, links e arquivos especiais são recusados. Na origem WSL, caminhos ignorados pelo Git e artefatos conhecidos — como `node_modules`, `build`, `.npm-cache`, caches, saídas de build, logs e temporários — não entram no snapshot. Os perfis e bancos do E2E são criados fora do checkout. Um caminho sensível ou artefato que esteja rastreado ou não ignorado bloqueia a sincronização em vez de ser silenciosamente copiado.

### Selecionar outro checkout NTFS pelo WSL

O runner lê `KARAOKE_QUEUE_WIN_CHECKOUT` dentro do processo Windows. Uma variável definida apenas no shell WSL não é encaminhada automaticamente. Para selecionar um clone diferente do padrão, converta o caminho WSL com `wslpath -w` e encaminhe a variável somente aos processos Windows desta sessão:

    checkout_wsl_path='<caminho WSL do clone NTFS isolado já verificado>'
    export KARAOKE_QUEUE_WIN_CHECKOUT="$(wslpath -w "$checkout_wsl_path")"
    case ":${WSLENV-}:" in
      *:KARAOKE_QUEUE_WIN_CHECKOUT/w:*) ;;
      *) export WSLENV="${WSLENV:+${WSLENV}:}KARAOKE_QUEUE_WIN_CHECKOUT/w" ;;
    esac
    npm run test:e2e:multi-instance:windows

Esse procedimento preserva as demais entradas existentes em `WSLENV` e não altera configurações globais. Se `KARAOKE_QUEUE_WIN_CHECKOUT` já estiver em `WSLENV` com outro modo, corrija somente essa entrada no ambiente do processo para usar `/w`; não mantenha entradas duplicadas. O runner continua validando branch, HEAD, NTFS, manifesto e hashes antes de sincronizar.

## Snapshot e proteção contra divergência

O runner descobre os caminhos pelo índice e pelo estado do Git, sem uma lista fixa de arquivos:

- arquivos rastreados presentes, incluindo conteúdo modificado no índice ou na working tree;
- arquivos novos não ignorados, depois de revisão;
- exclusões de arquivos rastreados.

O inventário registra branch, HEAD, caminhos rastreados e hash SHA-256 de cada arquivo incluído. O fingerprint representa os bytes atuais da working tree, inclusive mudanças não commitadas; o índice WSL determina o conjunto de caminhos rastreados, mas não substitui o conteúdo da working tree. O runner também registra os arquivos tracked modificados e removidos. No clone Windows, o índice precisa estar igual ao HEAD antes da sincronização; alterações staged locais são rejeitadas para evitar que um reset sobrescreva trabalho do destino.

Antes de copiar, o destino precisa corresponder ao último manifesto em `.git`. No primeiro uso, a adoção só é aceita quando o conteúdo do clone pode ser comprovado contra o snapshot da origem ou contra o HEAD informado. Para comparar arquivos com blobs do HEAD, o runner usa `git hash-object --path=<caminho>`; o Git aplica os filtros do caminho, incluindo conversão de finais de linha configurada por `.gitattributes` ou `core.autocrlf`, sem alterar configurações. Arquivos Windows extras, conteúdo alterado, branch incompatível ou checkout divergente interrompem o fluxo e retornam código diferente de zero. No destino, um arquivo extra é divergência mesmo que uma regra local do Git o ignore; só diretórios e artefatos explicitamente reconhecidos pelo runner são excluídos da comparação. O runner não apaga arquivos desconhecidos. Exclusões se limitam a caminhos do manifesto anterior ou a arquivos rastreados cujo conteúdo base foi verificado.

Para um clone com o manifesto do runner anterior em `.git/karaoke-queue-wsl-sync.json`, o PowerShell transfere ao worker somente o JSON de baseline (metadados e hashes), não os arquivos de origem descritos nele. Como o algoritmo antigo de fingerprint difere do atual, o worker só exige que o campo legado tenha o formato de SHA-256; não compara seu valor com o fingerprint recalculado. Ele valida branch e HEAD contra o clone, recalcula o fingerprint no formato atual e compara cada hash e caminho do inventário completo, incluindo a ausência de arquivos extras, antes de adotar o baseline. Só depois grava o marcador atual `.git/karaoke-queue-wsl-snapshot.json`; o manifesto antigo não é usado como autorização para sobrescrever divergências. Se qualquer verificação falhar, a sincronização é bloqueada.

O runner consulta no Windows apenas branch e HEAD do marcador de snapshot anterior. No bootstrap sem marcador, ou quando WSL e marcador já têm o mesmo HEAD, não cria nem transfere bundle Git. Quando o HEAD avançar, valida que o marcador é ancestral e cria um bundle incremental com `HEAD ^<HEAD-do-marker>`, contendo somente os commits posteriores ao marcador; não envia todo o histórico alcançável. O worker lê novamente branch/HEAD do marcador e verifica inventário e hashes do checkout Windows antes de sincronizar. Aceita somente avanço fast-forward e não usa `git pull`. Um histórico divergente ou outra branch exige reconstruir o clone de validação.

Durante a sincronização, o worker cria `.git/karaoke-queue-sync-backup-<runId>`. Antes de substituir ou excluir um arquivo gerenciado, confere seu hash contra o snapshot anterior ou o blob Git aplicável, move o arquivo para o backup e cria o novo destino com operação exclusiva, sem sobrescrever um arquivo inesperado. Em avanço de HEAD, também copia para o backup o snapshot gerenciado anterior e confere os hashes das cópias. Após verificar o inventário completo do destino, valida novamente todos os caminhos e hashes no backup; só então remove o backup, grava o marcador novo e limpa a pendência. Se a sincronização for interrompida ou a recuperação ficar incerta, a pendência permanece; qualquer backup ainda existente é mantido para revisão, e uma nova execução fica bloqueada.

Depois da sincronização, o runner verifica inventário e hashes. O worker faz um handshake com o WSL imediatamente antes do build e novamente antes do E2E; em cada etapa, o WSL recalcula o fingerprint e libera a execução somente se a origem continuar idêntica. Ao final, o WSL calcula novamente. Se o código mudar durante build/teste, o resultado é marcado como obsoleto e o comando termina com erro. O relatório registra branch, HEAD e fingerprint efetivamente testados.

Um lock exclusivo em `.git` serializa runners que compartilham o mesmo clone. Um lock existente ou o marcador de sincronização pendente bloqueia nova execução. Não remova esses arquivos manualmente nem automaticamente; a única exceção é o runner liberar seu próprio lock após o fluxo de cancelamento confirmar a identidade e parada dos processos, recuperar o build, limpar o perfil temporário e verificar ausência de pendências. Em qualquer outra situação, primeiro confirme que não há runner ativo e que o clone não ficou parcialmente sincronizado. Se houver dúvida, prepare um novo clone em um caminho NTFS ainda não utilizado e aponte `KARAOKE_QUEUE_WIN_CHECKOUT` para ele.

Enquanto o runner estiver ativo, trate o checkout Windows como exclusivamente pertencente a essa execução: não edite arquivos nele, não altere seu estado Git e não inicie outra ferramenta que escreva no diretório. O lock serializa os próprios runners, mas não impede um editor ou processo externo de alterar o clone. O runner verifica o destino antes de sincronizar e preserva os arquivos gerenciados em backup, porém o Git não oferece uma operação que torne a verificação e `reset` atômicos contra escritores que não respeitam esse lock. Uma escrita externa nessa janela pode ser sobrescrita sem detecção; portanto, nunca edite o checkout enquanto o runner estiver ativo. Se souber que ocorreu uma escrita concorrente, não confie no resultado: inspecione ou reconstrua o checkout antes de novo uso.

O teste sintético do bloqueio por divergência pode ser executado sem tocar no clone Windows:

    node scripts/run-windows-native-tests.cjs --verify-divergence

Ele cria uma pasta temporária com hash divergente e confirma que a validação rejeita o snapshot antes de acionar o sentinel de build/teste. Esse comando valida somente a barreira de divergência; não compila nem substitui o E2E nativo.

## Build, E2E e política de interface

O worker confirma que está em Node.js `win32`, que npm é nativo, e que Electron e Playwright resolvem dentro do `node_modules` do clone Windows. Antes de compilar, move a árvore `build/` existente intacta para um backup exclusivo deste `runId` dentro de `.git/`; não apaga conteúdo preexistente por extensão. Em seguida executa `npm.cmd run compile` em uma pasta `build/` nova e compara os arquivos gerados com o inventário de outputs derivados dos fontes TypeScript e assets. Arquivos ausentes, inesperados, links ou reparse points fazem a validação falhar. Depois do E2E, se o inventário gerado continuar válido e havia build anterior, o build temporário é removido e o build anterior é restaurado; se não havia build anterior, o build novo permanece. Se a validação falhar, o runner preserva o backup e mantém o lock para inspeção. O E2E é iniciado com esse Node.js e usa o Electron Windows, Playwright e SQLite reais.

### Prioridade de automação antes da revisão manual

Antes de solicitar validação manual ao proprietário, execute os testes automatizados relevantes que forem tecnicamente viáveis: compile, unitários/integração afetados, E2E com Electron real e runner Windows quando houver dependência de plataforma. Corrija defeitos confirmados dentro do escopo e reexecute as suítes afetadas. Para alterações visuais, inspecione a renderização do Electron e compare screenshots com o Doop aprovado; assertions de DOM não aprovam fidelidade visual.

Depois, entregue ao proprietário uma lista manual focada no que não foi coberto automaticamente: percepção humana de áudio/vídeo, aprovação visual/de produto, diálogo nativo não dirigido pelo harness, hardware ou operação real no estabelecimento. A aprovação explícita do proprietário permanece obrigatória quando exigida pela etapa. Se Windows não puder executar, investigue o preflight/problema, use testes alternativos relevantes e marque Windows como `NOT RUN`; um E2E Linux não é evidência de PASS nativo Windows.

### Suítes Standalone Windows disponíveis

Os comandos abaixo existem em `package.json`, partem do WSL e encaminham para `scripts/run-windows-native-tests.cjs`:

| Comando | Cobertura focada | Dados Windows necessários |
|---|---|---|
| `npm run test:e2e:standalone-playback:windows` | Contratos/runtime/sequência/interação/adapter e regressões de playback/recovery; E2E Electron com MP4 real. | `KQ_PLAYER_TEST_MEDIA_DIR` contendo `01001.mp4`. |
| `npm run test:e2e:standalone-integration:windows` | Integração B2/Preload/IPC/Main/Chromium e recovery com Electron real; não inicia `main.ts` nem altera modos. | `KQ_PLAYER_TEST_MEDIA_DIR` contendo `01001.mp4`; CSV opcional. |
| `npm run test:e2e:standalone-options:windows` | Testes focados de Opções/IPC/metadados/catálogo e E2E C8 com Electron, Playwright, IPC, serviço, SQLite isolado, MP4 e capturas. | `KQ_PLAYER_TEST_MEDIA_DIR`, `KQ_STANDALONE_C8_REPRO_ORIGINAL_CSV` e `KQ_STANDALONE_C8_REPRO_REPLACEMENT_CSV` como arquivos Windows absolutos existentes. |

Os aliases Linux/Xvfb correspondentes incluem `npm run test:e2e:standalone-playback:headless`, `npm run test:e2e:standalone-ipc:headless`, `npm run test:e2e:standalone-integration:headless`, `npm run test:e2e:standalone-ui:headless` e `npm run test:e2e:standalone-options:headless`. Eles executam Electron no ambiente Linux e não comprovam comportamento específico do Windows.

Exemplo de preparação para C8 com arquivos já disponíveis no volume Windows. Encaminhe as variáveis usando `WSLENV` com `/w`, preservando entradas existentes e corrigindo entradas duplicadas como explicado acima:

    media_wsl_path='/mnt/c/Users/Chris/Documents/Video musicas e catalogo'
    original_csv_wsl_path='/mnt/c/Users/Chris/Documents/LISTA-06-12-24-41A-15H-LD52769-BASE-1.csv'
    replacement_csv_wsl_path='/mnt/c/Users/Chris/Documents/musicas_corrigido.csv'
    export KQ_PLAYER_TEST_MEDIA_DIR="$(wslpath -w "$media_wsl_path")"
    export KQ_STANDALONE_C8_REPRO_ORIGINAL_CSV="$(wslpath -w "$original_csv_wsl_path")"
    export KQ_STANDALONE_C8_REPRO_REPLACEMENT_CSV="$(wslpath -w "$replacement_csv_wsl_path")"
    export WSLENV="${WSLENV:+${WSLENV}:}KQ_PLAYER_TEST_MEDIA_DIR/w:KQ_STANDALONE_C8_REPRO_ORIGINAL_CSV/w:KQ_STANDALONE_C8_REPRO_REPLACEMENT_CSV/w"
    npm run test:e2e:standalone-options:windows

O runner valida que os caminhos CSV sejam absolutos e arquivos regulares no Windows; esse modo também exige MP4 real na biblioteca. Revise os arquivos não rastreados listados pelo runner e confirme interativamente com `SYNC`. Em execução não interativa, use `--approve-untracked` apenas após revisar cada arquivo, por exemplo:

    npm run test:e2e:standalone-options:windows -- --approve-untracked

O cenário C8 usa fixtures temporárias para verificar importação/substituição durante playback, continuidade do MP4 e do snapshot, falha e persistência. Quando os dois caminhos reais são fornecidos, carrega o CSV original por um helper Main-side exclusivo de teste, aciona “Alterar CSV” pela UI e verifica a tentativa de substituição, o toast, a preservação do catálogo SQLite e a persistência após reiniciar. Essa tentativa com o par real acontece em estado idle após reiniciar; a continuidade do MP4 durante importação é verificada no cenário com fixture. Os arquivos reais são lidos diretamente dos caminhos Windows, não copiados para o snapshot.

**Limite do diálogo nativo:** Playwright não controla a janela “Abrir arquivo” do Windows nesse harness. Uma porta de diálogo exclusiva de teste fornece o caminho; o clique na UI, Preload, IPC de produção, validação Main-side, serviço/parser, banco, snapshot e toast são reais. Isso valida o fluxo após o diálogo retornar um caminho, mas não a janela nativa nem a escolha física do arquivo. Não reporte o seletor como testado. Não adicione APIs privilegiadas, bypasses ou remoções de guards; preserve o passo manual quando a interação do diálogo precisar de validação.

O E2E C8 imprime o diretório de screenshots no campo `screenshots` do resultado. Preserve as imagens relevantes e compare sua renderização com o Doop quando aplicável. Uma captura não equivale a aprovação visual humana; E2E não comprova áudio audível nem aprovação do proprietário.

### Runner automatizado versus launcher manual

`scripts/run-windows-native-tests.cjs`, chamado pelo comando central e pelos aliases Windows acima, é o runner automatizado: verifica snapshot/fingerprint, executa build e Playwright/Electron com assertions, usa perfil temporário e confirma cleanup/processos residuais. Não o substitua por execução direta de testes em um checkout Windows.

`scripts/standalone-c1-windows-native.ps1` abre uma sessão interativa para observar o **harness visual C1**, não o startup de produção. Ele exporta o snapshot verificado pelo WSL, copia o código para staging NTFS em `%TEMP%`, compila no Windows, importa o CSV configurado e inicia `build/tests/standalone-player-ui-electron.js` com `KQ_STANDALONE_C1_UI_MAIN=1` e `KQ_STANDALONE_C1_MANUAL=1`. Esse entrypoint compõe serviços e a ponte IPC para testar a UI, mas não carrega `build/main.js`: não instala os handlers de `BrowserWindow.close`, `app.before-quit`, `will-quit` nem o coordenador real de encerramento. No harness, `onExitAuthorized` apenas conta a notificação; por isso Sair confirmado pode deixar a janela aberta, e Alt+F4 pode fechá-la diretamente. Esses resultados descrevem o harness C1 e não demonstram comportamento da aplicação de produção. O helper `scripts/standalone-c1-windows-manual.cjs` exporta/verifica o snapshot e o build, importa catálogo e localiza o Electron; não é runner Playwright. A sessão não executa assertions E2E.

Para validar o lifecycle C9 em automação, use `npm run test:e2e:standalone-production:windows -- --approve-untracked`, com `KQ_PLAYER_TEST_MEDIA_DIR` encaminhado ao Windows via `WSLENV`; o modo `standalone-production` inicia o aplicativo pelo diretório do projeto, isto é, pelo `main` de produção definido em `package.json` (`build/main.js`), e valida Main/Preload/IPC, MP4, SQLite, recovery e cleanup.

Para um reteste manual do app real, use o checkout NTFS cujo snapshot/fingerprint foi validado pelo runner, abra PowerShell nesse diretório e execute o comando abaixo. Ele compila e inicia `electron .` (Main real) com um perfil descartável novo e biblioteca configurada; não usa o harness C1 nem o perfil habitual do aplicativo:

```powershell
$media = 'C:\Users\Chris\Documents\Video musicas e catalogo'
$testUserDataPath = Join-Path $env:TEMP ('karaoke-queue-c9-production-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $testUserDataPath | Out-Null
$utf8 = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText((Join-Path $testUserDataPath 'operating-mode.json'), '{"version":1,"mode":"player"}', $utf8)
$library = [ordered]@{ version = 1; roots = @($media) } | ConvertTo-Json -Compress
[System.IO.File]::WriteAllText((Join-Path $testUserDataPath 'video-library.json'), $library, $utf8)
npm.cmd run compile
if ($LASTEXITCODE -ne 0) { throw 'A compilação Windows falhou.' }
& (Join-Path $PWD 'node_modules\.bin\electron.cmd') . ("--user-data-dir=" + $testUserDataPath)
```

Use um checkout NTFS sincronizado para o código atual; não execute Node/Electron Windows a partir de `\\wsl.localhost\...`. Um launcher aberto não é E2E automatizado, e um E2E aprovado não é validação manual nem aprovação do proprietário.

**Roteiro manual específico para Alt+F4:** no app iniciado pelo comando Main de produção acima, deixe a janela principal focada e pressione fisicamente `Alt+F4`. Confirme que o modal único aparece e que o app permanece aberto; pressione `Esc` e verifique que playback/fila continuam. Repita `Alt+F4`, confirme com `Enter` e verifique o encerramento normal. Faça também uma rodada com reprodução ativa e uma entrada pendente. Esse teste físico continua necessário quando o helper automatizado `SendInput` não produz o evento `BrowserWindow.close`; um resultado automatizado `SC_CLOSE` não substitui Alt+F4 físico.

### Harness isolado de Chromium

O runner oferece modos focados de avaliação Chromium e um teste da implementação Player 5C. Todos usam a mesma sincronização, verificação de branch/HEAD/hashes, handshake de fingerprint, build nativo e cleanup. Para caminhos escolhidos no WSL, converta o valor com `wslpath -w` antes de encaminhá-lo ao Windows com `WSLENV` e `/w`; o processo PowerShell precisa receber o formato Windows (`C:\...`), não o literal `/mnt/c/...`. Revise a lista de arquivos não rastreados antes de aprovar `--approve-untracked`.

- `--playback-chromium-final`: roda somente os testes do harness e a automação Electron/Chromium. Usa uma amostra a 1× e espera `HTMLMediaElement.ended` até a duração conhecida mais a tolerância especificada; também automatiza a seleção de amostra e os botões Play selected, Pause, Resume, Restart, Stop e Fullscreen em uma janela temporária. Não executa mpv nem as regressões alheias a playback.
- `--playback-chromium-interactive`: após os mesmos gates, abre uma janela temporária com seleção de amostras e controles manuais de playback/fullscreen. A execução aguarda o operador fechar essa janela. O relatório automático do runner não valida audibilidade física nem sincronização percebida.
- `--player-playback`: compila e executa somente `tests/player-playback-electron.js` no Electron Windows real. Exercita o serviço/adapter de produção em host temporário, incluindo load, controles, substituição, mídia inválida/ausente, EOF normal e término do Renderer. Não executa o conjunto padrão de regressões Windows. Requer `KQ_PLAYER_TEST_MEDIA_DIR` apontando para amostras locais read-only no Windows.
- `--standalone-playback`: executa os testes focados de contratos/runtime/sequência/interação/adapter e playback/recovery compartilhados, depois `tests/standalone-player-playback-electron.js` em processo Electron isolado. O harness não inicia `main.ts`, não ativa o modo Standalone no produto e não instancia `ManualPlaybackService`; usa o host Chromium e protocolo de mídia existentes, biblioteca real e perfil temporário. Exercita MP4 local, pause/resume, restart, Next, EOF natural, corrida controlada entre Next reservado e EOF HTML5 real, EOF final, recovery bloqueado/inválido, crash real do Renderer com estado `uncertain` e cleanup. O runner não avalia áudio audível nem fidelidade visual. Requer `KQ_PLAYER_TEST_MEDIA_DIR` apontando para as amostras locais read-only no Windows.
- `--standalone-integration`: executa contratos/runtime/sequência/interação e transport B2, IPC B4.1, adapter e regressões de playback/recovery, depois `tests/standalone-player-integration-electron.js` em Electron nativo isolado. O harness usa uma janela de controle com `standalone-player-preload` e o IPC real, mais uma janela técnica com `player-preload`/`ChromiumPlaybackHost`; ambas apontam para a mesma sequência, biblioteca, protocolo e serviço técnico. Verifica comandos B2 por IPC, snapshots/revisões, retry e perda de ACK ao destruir o controle, URL estática autorizada, playback/EOF HTML5 real, corrida Next/EOF, crash do host, relançamento com o registro incerto criado pelo cenário de crash, bloqueio sem autoplay, recuperação inválida preservada e shutdown. Não inicia `main.ts`, não instancia `ManualPlaybackService`, não altera modos nem cria UI de produto. Exige `KQ_PLAYER_TEST_MEDIA_DIR` com as amostras MP4 locais read-only; o CSV é opcional e não é aberto pelo harness.
- `--player-recovery`: compila e executa primeiro `tests/player-playback-recovery.test.js`, depois `tests/player-playback-recovery-electron.js` em processos Electron nativos separados e perfil temporário persistente entre reinícios. Exercita recuperação de filesystem, incluindo journal/quarentena, crash após o `idle` durável, encerramento abrupto, recovery pendente sem autoplay, replay explícito com nova tentativa, Stop confirmado, EOF natural e preservação da base operacional Combined após crash do Renderer. Requer `KQ_PLAYER_RECOVERY_TEST_MEDIA_DIR` apontando para uma pasta local read-only com `01001.mp4`. O modo não mede foco de janela; o relatório esperado é `WINDOW_FOCUS NOT APPLICABLE`.

### Sessão visual manual C1–C5 no PowerShell nativo

Para abrir a C1 sem E2E e sem tocar no clone `source\karaoke-queue-win`, execute **no PowerShell do Windows**:

    powershell.exe -NoProfile -ExecutionPolicy Bypass -File '\\wsl.localhost\Ubuntu\home\chris\projetos\karaoke-queue\scripts\standalone-c1-windows-native.ps1'

O script usa `wsl.exe` somente para gerar o snapshot verificado em `/tmp` com `readSourceSnapshot()`/`stageSnapshot()` e SHA-256 do runner. PowerShell copia esse snapshot via `\\wsl.localhost` para um novo diretório NTFS em `%TEMP%`, verifica os hashes e pede `SYNC` para os arquivos novos. A partir daí, PowerShell, `node.exe`, `npm.cmd`, `npm ci`, compilação e `electron.exe` executam no Windows. O `node_modules` Linux e o `build/` da origem não são copiados. A branch e o estado do clone Windows existente não são consultados nem alterados.

O exportador é invocado com o Node Linux do WSL em `/home/chris/.nvm/versions/node/v24.15.0/bin/node`, validando `platform=linux`; isso serve apenas para ler e empacotar o working tree de origem. O snapshot é verificado no staging pelo Node Windows nativo (`platform=win32`). O helper `scripts/standalone-c1-windows-manual.cjs` oferece comandos CLI nomeados para essas verificações, importação do catálogo e localização do Electron. Essa chamada evita passar código JavaScript inline por `node -e`, cujo quoting pelo Windows PowerShell pode remover aspas necessárias e invalidar o comando.

Os padrões usam `C:\Users\Chris\Documents\Video musicas e catalogo`, o MP4 `01001.mp4` e o CSV `LISTA-06-12-24-41A-15H-LD52769-BASE-1.csv`. O catálogo é importado para o perfil exclusivo no staging. A janela de controle não é iniciada por Playwright nem fecha por um teste: fica aberta até o operador fechá-la com `Alt+F4`. A reprodução manual começa pelo fluxo normal: digitar um código e confirmar com `Enter` ou `P`. `F10` imprime no terminal PowerShell o snapshot autoritativo atual, incluindo fase, estado, faixa alvo/atual e ordem FIFO/LIFO, sem adicionar uma fila visual à UI. `F11` aproxima um MP4 já reproduzindo do EOF para que o Chromium gere o evento `ended` natural. `npm ci`, a compilação e o Electron executam como o usuário atual do Windows, com o ambiente dessa sessão PowerShell. Ao fechar a janela, o script limpa o perfil, as dependências Windows e o staging temporário.

Para validar C3 manualmente durante a janela, faça duas execuções do mesmo comando, começando cada uma com um perfil temporário novo:

- Na primeira execução, em idle, digite `1001` e pressione `Enter`. Confira preview `Always` / `Bon Jovi`, countdown de 5 até 1 e ausência de playback durante a contagem.
- Durante o countdown, pressione `Espaço`; confirme que o número congela e aguarde alguns segundos. Pressione `Espaço` novamente e confira que a contagem retoma do restante sem voltar a 5.
- Aguarde o loading técnico se ocorrer e confirme que o MP4 real começa somente depois do countdown, com áudio/vídeo. A tela de reprodução deve começar limpa, sem o painel numérico.
- Feche essa janela. Na segunda execução, repita `1001`, mas confirme com `P`. Verifique novamente countdown, pausa/retomada e início real após a contagem.
- `F10` imprime o snapshot Main autoritativo; durante a transição, procure fase `countdown`/`loading`, alvo `01001` e contador/pausa quando aplicável. Após a confirmação técnica, o estado deve ser `playing` para `01001`.
- C2 continua testável depois de playback: Enter/P com MP4 disponível, `F10` para conferir FIFO/LIFO e código indisponível para conferir que a faixa atual não muda. Feedbacks duram 3,5s; o painel numérico usa 5s.
- Para testar C4 com EOF natural de um MP4 real, comece playback pelo fluxo normal (digite `1001` e pressione `Enter`, aguarde o countdown e o início confirmado). Pressione `F11`: o harness posiciona o vídeo real nos últimos cinco segundos, sem emitir EOF sintético. Chromium continua reproduzindo e deve emitir `HTMLMediaElement.ended` naturalmente. `F11` só existe no harness de teste.
- Com fila pendente, durante playback adicione `1001` com Enter e/ou P, então use `F11`. Confirme a celebração por cinco segundos e a mensagem sorteada; `Espaço` deve congelar e retomar somente o timer. `F10` mostra o snapshot Main-side (`phase: celebration`, `remainingMs`, `paused`, `message` e ordem FIFO/LIFO). Adições Enter/P durante a celebração aguardam o fim do timer; a prioridade mais recente inicia diretamente, sem outro countdown, e a faixa anterior permanece encerrada. `Ctrl + →` fica bloqueado durante a celebração.
- Para fila vazia, use um perfil novo e não adicione outras faixas: inicie `1001` por Enter, aguarde playback e use `F11`. A celebração não deve anunciar próxima faixa e, após cinco segundos, a interface volta ao idle. Este segundo cenário também pode ser feito após consumir a fila num perfil temporário.
- A janela permite apenas observação manual; o teste automatizado Linux/Electron cobre EOF natural, a pausa/retomada, seleção da mensagem, transição direta e capturas. A validação audiovisual C4 foi concluída e aprovada pelo proprietário; F11 não representa um comando de produto.

Para validar a C5, reutilize a mesma janela temporária e confira pelo `F10` o snapshot autoritativo antes/depois das operações:

- Inicie `1001` por `Enter` e aguarde o playback. Pressione `Espaço`: vídeo/áudio devem pausar e o snapshot deve ficar `paused`. Pressione novamente: devem retomar da mesma posição, sem reinício. Observe o feedback transitório “RETOMANDO”.
- Com a faixa atual tocando, adicione `1002` por `Enter` e `1003` por `P`. Confira a fila Main-side e a barra `PRÓXIMAS`: a prioridade mais recente vem primeiro. Pressione `R`; a mesma ocorrência reinicia desde o início e a fila mantém a mesma ordem. `F10` mostra `attemptId` novo para o restart e as mesmas entradas pendentes. Repita `Espaço` para pausar e `R`: o restart deve começar do início sem mostrar o feedback `RETOMANDO`, e a fila deve continuar visível e inalterada.
- Pressione `Ctrl + →` enquanto reproduz: a próxima faixa começa diretamente, sem celebração. A fila visual e o snapshot devem avançar uma vez. Em pausa/countdown/celebração/loading, Next deve ficar bloqueado; `F11` pode posicionar a mídia perto do fim para testar o bloqueio durante a celebração natural.
- Abra uma fila com pendentes e pressione `Ctrl + Espaço`. O modal deve aparecer enquanto áudio/vídeo continuam. `Esc` cancela; confira que faixa, posição de reprodução e fila permanecem. Abra novamente e confirme com `Enter`: playback e pendências são encerrados, a tela volta ao idle, a janela continua aberta e nenhum EOF/celebração/autoplay ocorre. Use `F10` depois para confirmar estado idle e fila vazia.
- `F10` e `F11` são recursos exclusivos do harness. Não use esses atalhos de teste como comandos de produto; eles não substituem as teclas reais da C5.

#### Reteste manual da correção C5 — painel “Próximas”

Em 2026-11-05, o proprietário concluiu e aprovou este reteste no Electron nativo Windows, incluindo atualização FIFO/LIFO, visibilidade após Esc/timeout, limite e layout da fila, interface e áudio/vídeo. Os passos abaixo permanecem como procedimento reproduzível para futuras verificações.

Depois de atualizar o snapshot de origem pelo launcher, execute novamente o comando PowerShell acima. Na janela temporária, use `1001` + `Enter` para iniciar playback e então valide:

- Com fila vazia durante playback, digite `1002` + `Enter`. O painel numérico tem precedência visual; use `F10` para conferir a pendência Main-side. Após cinco segundos sem digitação, o painel fecha e “Próximas” deve aparecer imediatamente com `1002`, sem Pause/Resume/Next/EOF.
- Digite `1003` + `Enter`; confirme que o painel fica temporariamente oculto e, ao pressionar `Esc`, “Próximas” reaparece com `1002 1003`. Repita com `1004` + `P`; ao fechar por `Esc`, confira a ordem `1004 1002 1003`.
- Adicione entradas até haver seis pendentes. A barra apresenta somente as primeiras cinco; `F10` deve continuar mostrando a sexta na sequência autoritativa. Adicione outra com `P`: ela vira a primeira e a antiga sexta permanece pendente. Use `Ctrl + →` para avançar e confira que a próxima pendência aparece na janela de cinco itens.
- Não use Pause/Resume, Next ou EOF para “atualizar” a fila antes de verificar o comportamento: a mudança deve aparecer ao fechar a entrada numérica. O vídeo e o áudio atuais devem continuar sem interrupção durante as adições.

O painel também foi conferido automaticamente em 1280×800 e 960×600, a largura mínima da janela de produção. A aprovação manual registrada acima é do proprietário; não atribui execução do runner Windows ao agente.

O script informa `Enter`, `P`, `Espaço`, `R`, `Ctrl + →`, `Ctrl + Espaço`, `F10` e `F11` ao iniciar. O comando e o staging continuam os mesmos; basta atualizar o snapshot de origem local pelo próprio launcher. Não abra nem sincronize o checkout auxiliar `source\karaoke-queue-win`.

Durante a sessão, o script imprime `Node` com `platform=win32`, o caminho do `electron.exe` dentro de `node_modules\electron\dist` e o PID/caminho confirmado via `Get-CimInstance Win32_Process`. Para conferir em outra janela PowerShell, substitua `PID` pelo valor impresso:

    Get-CimInstance Win32_Process -Filter "ProcessId = PID" | Select-Object ProcessId,ExecutablePath,CommandLine

Esse caminho de executável em `C:\...\Temp\...\node_modules\electron\dist\electron.exe`, junto de `platform=win32`, confirma o Electron Windows nativo. A execução automática não comprova audibilidade física nem fidelidade visual; essas validações continuam manuais.

**Registro de execução manual C1:** em 2026-11-04, o proprietário confirmou a interface ociosa/reproduzindo, teclado/numpad, preview, Backspace/Esc, timeout e reprodução de MP4 com áudio e vídeo reais no Electron Windows nativo. A diferença do aviso de código inexistente foi reservada à C2.

**Validação manual C1–C5:** concluída e aprovada pelo proprietário no Electron nativo Windows, incluindo áudio/vídeo real e a correção final de “Próximas”. Resultados Linux/Xvfb permanecem registrados separadamente e não são apresentados como validação audiovisual manual.

Exemplo com diretórios previamente preparados; use caminhos reais do seu ambiente, sem incluir a coleção no repositório:

    sample_wsl_path='<caminho WSL do diretório de amostras no volume NTFS>'
    checkout_wsl_path='<caminho WSL do clone NTFS isolado>'
    export KQ_PLAYER_TEST_MEDIA_DIR="$(wslpath -w "$sample_wsl_path")"
    export KQ_PLAYER_RECOVERY_TEST_MEDIA_DIR="$(wslpath -w "$sample_wsl_path")"
    export KARAOKE_QUEUE_WIN_CHECKOUT="$(wslpath -w "$checkout_wsl_path")"
    case ":${WSLENV-}:" in
      *:KQ_PLAYER_TEST_MEDIA_DIR/w:*) ;;
      *) export WSLENV="${WSLENV:+${WSLENV}:}KQ_PLAYER_TEST_MEDIA_DIR/w" ;;
    esac
    case ":${WSLENV-}:" in
      *:KQ_PLAYER_RECOVERY_TEST_MEDIA_DIR/w:*) ;;
      *) export WSLENV="${WSLENV:+${WSLENV}:}KQ_PLAYER_RECOVERY_TEST_MEDIA_DIR/w" ;;
    esac
    case ":${WSLENV-}:" in
      *:KARAOKE_QUEUE_WIN_CHECKOUT/w:*) ;;
      *) export WSLENV="${WSLENV:+${WSLENV}:}KARAOKE_QUEUE_WIN_CHECKOUT/w" ;;
    esac
    npm run test:e2e:multi-instance:windows -- --approve-untracked --standalone-integration

Se uma variável já existir em `WSLENV` com sufixo diferente, corrija somente aquela entrada para `/w` em vez de adicioná-la novamente. O clone usado precisa estar em NTFS, branch compatível e livre de escritores concorrentes.

Os modos Chromium focados e as E2Es `--player-playback`, `--standalone-playback` e `--player-recovery` exigem uma sessão gráfica Windows interativa para inicializar Electron com janela nativa. Os modos Player focados não fazem assertion de foco; `WINDOW_FOCUS NOT APPLICABLE` é esperado. O runner preserva o teste de foco para a suíte multi-instância padrão. Execute pelo entry point WSL oficial `npm run test:e2e:multi-instance:windows`; não invoque o harness diretamente no checkout Windows para validar o snapshot WSL. Em todos os modos, PASS continua exigindo build, E2E, processo/limpeza e handshake de snapshot bem-sucedidos.

Esta suíte não deve ser forçada para headless. Ela verifica estados reais de janela: ocultação/show, minimização/restore e ativação/foco. O teste de minimização observa o evento nativo e `isMinimized`; a restauração observa `restore`, visibilidade e estado minimizado. O foco só recebe status PASS quando o evento e `BrowserWindow.isFocused()` são observados no cenário de restauração e no de janela oculta. Se o foco não puder ser confirmado, a execução falha sem presumir que a causa foi uma política do sistema.

Os testes são automatizados e não pedem interação manual. Se não houver Explorer/sessão gráfica interativa, a compilação pode ocorrer, mas o E2E é reportado como NOT RUN e o runner retorna erro. `xvfb-run` é uma infraestrutura Linux e não valida comportamento nativo de janelas do Windows. Outros testes sem dependência de janela gráfica podem ter runners headless próprios quando preservarem as assertions reais.

Após o E2E, o worker verifica a remoção do perfil temporário e consulta processos Electron associados ao caminho exclusivo daquela execução via `Get-CimInstance Win32_Process`. Se a consulta falhar ou não puder confirmar o resultado, a verificação falha; isso não é interpretado como ausência de processos. O worker não encerra processos indiscriminadamente. Ao receber cancelamento, o runner confirma a identidade do worker pelo PID, `runId` e token do lock, encerra a árvore identificada e verifica que os processos observados terminaram. Depois recupera o build anterior, preservando o build interrompido em `.git/`, limpa apenas o perfil temporário exclusivo do run e confirma que não há pendência nem backup de sincronização. Só então remove o lock pertencente à execução. Se alguma verificação ou recuperação falhar, o relatório fica `CANCELLED_RECOVERY_REQUIRED` e o lock é mantido para revisão manual. Processos residuais ou uma consulta inconclusiva impedem o status geral PASS.

Se o processo WSL que controlava o runner terminou, mas o worker Windows ainda está ativo, use o cancelamento oficial por `runId` correspondente:

    npm run test:e2e:multi-instance:windows -- --cancel-windows-run <runId>

Esse comando segue as mesmas verificações de PID, `runId`, token, árvore de processos, perfil e build do cancelamento por Ctrl+C; ele não remove lock manualmente. O runner executa o script de cancelamento por arquivo PowerShell temporário em `/tmp`, encaminhado com `wslpath -w`, e remove esse arquivo ao concluir. Isso evita exceder limites da linha de comando WSL/Windows com scripts `-EncodedCommand` longos. Use `--recover-windows-cancel` apenas quando o worker já estiver parado e a primeira tentativa tiver deixado `CANCELLED_RECOVERY_REQUIRED`.

Se o processo worker já tiver terminado e a primeira recuperação tiver parado em `CANCELLED_RECOVERY_REQUIRED`, o runner permite retomar somente pelo `runId` correspondente e após confirmar que o worker não está ativo. Use o entry point central, preservando `KARAOKE_QUEUE_WIN_CHECKOUT` via `WSLENV`:

    npm run test:e2e:multi-instance:windows -- --recover-windows-cancel <runId>

Essa retomada valida novamente o proprietário e a identidade do relatório/lock, recusa perfis sem identidade segura, encerra apenas processos Electron que apontem para o perfil exclusivo do run (e verifica descendants pelo PID e horário de criação), valida a limpeza do perfil e do build e só então libera o lock. Se não puder confirmar algum desses itens, mantém o lock e os dados para inspeção; não remova-os manualmente.

## Interpretar o resultado

- PASS: sincronização, equivalência de hashes, validação e limpeza dos backups, build Windows, E2E, limpeza de perfil, ausência de processo residual e liberação do lock foram confirmados. Nos testes que verificam foco, ele também precisa estar observado; em modos focados de playback, `WINDOW_FOCUS NOT APPLICABLE` é esperado. A saída inclui branch, HEAD e fingerprint.
- FAIL: divergência, falha de dependência/build/teste, foco não confirmado, processo residual ou consulta inconclusiva, origem alterada ou falha de recuperação. O código de saída é diferente de zero; pendências de sync, backup ou lock exigem inspeção antes de nova tentativa.
- CANCELLED: cancelamento confirmado após validar PID/runId/token, encerrar a árvore, recuperar o build, limpar o perfil temporário e confirmar ausência de pendências; o runner removeu o lock pertencente à execução.
- CANCELLED_RECOVERY_REQUIRED: o worker parou, mas uma verificação ou recuperação ficou incerta; o lock permanece e o checkout exige revisão manual.
- NOT RUN: o pré-flight não encontra PowerShell/interoperabilidade WSL-Windows, Node.js ou npm nativos; o clone está ausente ou não está em NTFS; ou a sessão gráfica necessária não existe. Se o pré-flight de ferramentas ou checkout falhar, a sincronização, o build e o E2E não são iniciados. Não reporte validação Windows como PASS.

Um PASS do teste sintético `--verify-divergence` não é um PASS do pipeline Windows.

## Recriar o clone de validação

O runner não apaga nem substitui um clone existente. Se o clone estiver ausente, a execução retorna NOT RUN; crie o clone em um caminho NTFS novo e sem conteúdo antes de tentar novamente. Se estiver divergente ou com sincronização interrompida, mantenha-o para inspeção até confirmar que não contém alterações necessárias e reconstrua em um destino NTFS novo quando não for possível provar seu estado.

No WSL, gere um bundle da branch atual:

    branch="$(git branch --show-current)"
    git bundle create /tmp/karaoke-queue-windows.bundle "refs/heads/$branch"
    wslpath -w /tmp/karaoke-queue-windows.bundle

Use o caminho retornado por wslpath -w no PowerShell. Defina a branch impressa acima e um destino NTFS ainda inexistente:

    $branch = '<branch impressa no WSL>'
    $bundle = '<caminho do bundle retornado por wslpath>'
    $env:KARAOKE_QUEUE_WIN_CHECKOUT = Join-Path $env:USERPROFILE 'source\karaoke-queue-win-rebuilt'
    if (Test-Path -LiteralPath $env:KARAOKE_QUEUE_WIN_CHECKOUT) {
      throw 'Escolha um destino novo; nenhum diretório será sobrescrito.'
    }
    git clone --branch $branch $bundle $env:KARAOKE_QUEUE_WIN_CHECKOUT

Depois, execute o comando central no WSL. Não compartilhe node_modules, build, perfis Electron ou bancos SQLite entre WSL e Windows.

## Problemas comuns

- Checkout ausente ou fora de NTFS: configure `KARAOKE_QUEUE_WIN_CHECKOUT` para um clone NTFS isolado.
- Branch incompatível ou histórico divergente: não force/reset o clone. Recrie outro destino a partir de bundle da branch WSL atual.
- Arquivo extra ou hash diferente no Windows: inspecione o caminho indicado. Preserve o conteúdo necessário e use um novo clone para validar; a origem WSL continua autoritativa.
- Arquivo não rastreado listado: revise o conteúdo e execute com confirmação interativa ou `--approve-untracked`. Dados sensíveis não devem ser incluídos.
- Lock existente: confirme se há runner ativo. Um lock abandonado exige revisão explícita; o runner não decide automaticamente que é seguro removê-lo.
- Sincronização pendente: uma interrupção durante cópia impede builds subsequentes. Inspecione o clone; reconstrua em novo caminho se não puder provar que ele corresponde a um manifesto completo.
- Sessão gráfica indisponível: o E2E de minimize/restore/focus fica NOT RUN. Reconecte uma sessão desktop Windows interativa e execute novamente.
- `UtilBindVsockAnyPort:307` ao iniciar executáveis Windows dentro do sandbox Codex: faça primeiro apenas os testes mínimos `powershell.exe -NoProfile -Command "Write-Output WSL_WINDOWS_OK"` e `cmd.exe /c echo WSL_CMD_OK`. Se falharem no sandbox, repita a chamada mínima pelo mecanismo de execução aprovado fora do sandbox. Nesta investigação, essa chamada aprovada funcionou e o runner oficial passou depois que o checkout alternativo foi encaminhado via `WSLENV`; a falha isolada dentro do sandbox não indicava que o WSL ou o host Windows estivessem permanentemente indisponíveis. Não desative o sandbox nem altere configurações globais como workaround.
- Se o WSL reportar `...//powershell.exe: Invalid argument`, inspecione se uma entrada de `PATH` termina em `/`. Normalize as barras finais somente no ambiente daquela invocação do runner; não edite `PATH` global. Foi necessário neste ambiente para a invocação aprovada do runner.
- Se `--player-recovery` terminar após a E2E por “foco da janela” em `CLEANUP`, confira a versão do runner: esse modo não mede focus e deve reportar `WINDOW_FOCUS NOT APPLICABLE`; a suíte multi-instância padrão continua exigindo a evidência de foco.
- Origem alterada durante o teste: o resultado é inválido mesmo que o E2E tenha terminado; repita após estabilizar o snapshot.
