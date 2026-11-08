# Testes nativos do Windows a partir do WSL2

## Objetivo e arquitetura

O WSL2 é o ambiente principal de desenvolvimento e a fonte autoritativa do código. Os checkouts NTFS são usados somente para validação nativa do Windows. O runner parte do WSL, sincroniza um snapshot controlado e inicia PowerShell e Node.js do Windows. Há dois fluxos distintos:

    Checkout WSL2 (origem)
      └─ inventário + hashes + bundle Git
           └─ PowerShell do Windows
           ├─ checkout NTFS de testes
           │    └─ npm ci → compile → Electron/Playwright automatizado
           └─ E:\KaraokeQueue\manual-windows\checkout
                └─ dependências Windows → compile → Electron de produção interativo

Nenhum checkout Windows é uma segunda origem. Alterações feitas nele não são copiadas de volta ao WSL.

## Requisitos

- WSL2 com Node.js, npm, Git e `wslpath`.
- Interoperabilidade WSL/Windows habilitada para executar `powershell.exe`.
- Windows com Git for Windows, Node.js compatível com `engines` em `package.json` e npm.
- Clone de validação em volume NTFS. Por padrão, o runner procura `source\karaoke-queue-win` sob `$env:USERPROFILE`. Para outro diretório, configure `KARAOKE_QUEUE_WIN_CHECKOUT` no ambiente do PowerShell iniciado pelo WSL; ao iniciar o runner no WSL, encaminhe essa variável ao Windows com `WSLENV` (`/w`), conforme o exemplo abaixo.
- Sessão gráfica Windows interativa para esta suíte de múltiplas instâncias. A compilação sozinha não precisa abrir janelas.
- Para o launcher manual oficial, unidade `E:` disponível em NTFS, WSL/Windows interop e sessão gráfica interativa.

O runner não instala ferramentas globais nem altera configurações do Windows ou do Git. `npm ci` instala dependências em `node_modules` do clone Windows e usa `.npm-cache` local.

## Comando central

Execute no terminal WSL, a partir do repositório:

    npm run test:e2e:multi-instance:windows

O fluxo único prepara o snapshot, verifica o clone, executa `npm ci`, compila com Node/npm Windows e inicia `build/tests/multi-instance-electron.js` com o Electron e Playwright locais do Windows. O Electron usa perfis e bancos SQLite temporários.

Arquivos novos não rastreados são listados com SHA-256 para revisão. Em um terminal interativo, confirme digitando `SYNC`. Para automação após revisar exatamente a lista exibida, passe a aprovação explícita:

    npm run test:e2e:multi-instance:windows -- --approve-untracked

Essa opção aprova somente a lista identificada naquela execução. Arquivos sensíveis, caminhos incompatíveis com Windows, links e arquivos especiais são recusados. Na origem WSL, caminhos ignorados pelo Git e artefatos conhecidos — como `node_modules`, `build`, `.npm-cache`, caches, saídas de build, logs e temporários — não entram no snapshot. Os perfis e bancos do E2E são criados fora do checkout. Um caminho sensível ou artefato que esteja rastreado ou não ignorado bloqueia a sincronização em vez de ser silenciosamente copiado.

## Launcher manual oficial do produto

Para validação manual, abra uma janela PowerShell interativa e execute este único comando:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File '\\wsl.localhost\Ubuntu\home\chris\projetos\karaoke-queue\scripts\standalone-manual-windows.ps1'
```

O caminho UNC acima corresponde ao checkout WSL atual (`/home/chris/projetos/karaoke-queue`). Se o repositório estiver em outro caminho ou distribuição, derive o comando a partir do UNC real do arquivo `scripts/standalone-manual-windows.ps1`.

O launcher requer `E:` e interrompe com erro claro se a unidade não estiver disponível em NTFS. Não há fallback para `C:`. Ele mantém o ambiente em `E:\KaraokeQueue\manual-windows\`:

- `checkout\`: clone Git NTFS persistente, sincronizado em cada execução.
- `profiles\`: perfis persistentes escolhidos no menu.
- `cache\`: cache npm Windows, staging temporário da sincronização e backups de build.
- `logs\`: transcript de cada execução; o log do aplicativo fica em `profiles\<perfil>\logs\app.log`.

Na primeira execução, se `checkout\` ainda não existir, o runner cria o clone de bootstrap usando um bundle Git local gerado do HEAD WSL atual. Depois disso, aplica o snapshot integral do working tree pelo mesmo `readSourceSnapshot`, `stageSnapshot`, manifesto, fingerprint, lock, `syncSnapshot` e verificação de hashes do runner oficial. Não usa clone remoto e não implementa um segundo mecanismo de sincronização. O fluxo inclui alterações staged, unstaged e arquivos não rastreados não ignorados; lista os não rastreados com hash e exige confirmação `SYNC`. Arquivos sensíveis, ignorados, `node_modules` Linux, `build/` Linux, caches e temporários continuam excluídos pelas proteções compartilhadas do runner.

Antes de sincronizar, o worker consulta processos Windows e bloqueia qualquer `electron.exe` cujo executável ou linha de comando indique uso do checkout. O lock `.git/karaoke-queue-windows-test.lock` também serializa o launcher com o runner automatizado. Feche a aplicação antes de iniciar outra sincronização.

O menu oferece uma instalação nova ou um perfil existente. A instalação nova só ganha uma pasta vazia em `profiles\` imediatamente antes da abertura; o launcher não grava `operating-mode.json`, bancos, catálogo, biblioteca, preferências nem escolhe Controller/Player/Combined. A tela Welcome/onboarding original do produto é responsável pela escolha. Reabrir um perfil seleciona sua pasta preservada sem apagar nem recriar os dados. Nenhum perfil é removido automaticamente.

O worker usa `node.exe`, `npm.cmd`, `git.exe` e o `electron.exe` instalados no Windows. Ele reutiliza `node_modules` somente quando o hash de `package-lock.json`, as versões do Node/npm e os artefatos Electron/TypeScript coincidem; caso contrário executa `npm.cmd ci` com cache em `E:\KaraokeQueue\manual-windows\cache\npm`. Em seguida executa `npm.cmd run compile` e verifica o inventário compilado. O build antigo, quando existente, é preservado no cache.

A inicialização usa o campo real `package.json.main` (atualmente `build/main.js`) através do Electron local, com o diretório do projeto e `--user-data-dir` do perfil selecionado. Não define modos, não injeta configuração de biblioteca e não define variáveis de harness. O launcher não executa testes, E2E, Playwright nem o runner automatizado. Ele confirma no terminal o branch, HEAD, fingerprint, caminho do Electron e PID nativo. Em perfil novo, `APP_READY` é esperado somente depois que o proprietário escolhe um modo no onboarding, pois o Main retorna após abrir a janela Welcome. O launcher deixa o aplicativo aberto para interação manual.

O worker verifica os hashes do checkout sincronizado antes e depois da compilação. O orquestrador compara novamente o fingerprint da origem WSL ao encerrar. Se a origem mudar durante a execução, o resultado será inválido (`SYNC STALE`); o aplicativo que já tiver sido iniciado ainda usará o snapshot capturado, então feche-o e execute novamente para abrir o estado WSL mais recente.

Para confirmar a versão iniciada, compare o fingerprint e o destino informados pelo runner. O terminal também mostra `ExecutablePath` dentro de `E:\KaraokeQueue\manual-windows\checkout\node_modules\electron\dist\electron.exe`; para consultar o PID exibido:

```powershell
Get-CimInstance Win32_Process -Filter "ProcessId = PID" | Select-Object ProcessId,ExecutablePath,CommandLine
```

### Classificação da infraestrutura Windows

| Arquivo | Categoria | Consumidores/finalidade |
| --- | --- | --- |
| `scripts/standalone-manual-windows.ps1` | Launcher manual de produção | Único launcher manual oficial; usa snapshot sincronizado e o modo manual do runner compartilhado. |
| `scripts/run-windows-native-tests.cjs` | Runner automatizado e helper de sincronização | Executa as suítes aprovadas em Electron/Playwright Windows e também fornece o mecanismo comum de snapshot/fingerprint ao launcher manual. |
| `scripts/windows-native-runner.test.cjs` | Teste unitário do runner | Protege o snapshot, o build e o encaminhamento seguro dos modos automatizados e manuais; é chamado por `test:unit`. |
| `scripts/verify-windows-build.cjs` | Helper de release | Verifica artefatos do build Windows; não inicia o aplicativo nem roda E2E. |
| `tests/standalone-player-ui-electron.ts` | Harness E2E | Cria uma composição Standalone de teste; usado pelas suítes de UI/opções, mas não inicia `package.json.main`. |

Os antigos `scripts/standalone-c1-windows-native.ps1` e `scripts/standalone-c1-windows-manual.cjs`, junto do alias `prepare:standalone-c1:windows`, foram removidos nesta auditoria. O helper também era importado somente pelos testes que verificavam esse fluxo manual C1; esses testes específicos foram substituídos por verificações do launcher oficial. O harness E2E Standalone permaneceu porque ainda é usado por suítes automatizadas.

O comando manual anterior que criava `operating-mode.json` e `video-library.json` em `%TEMP%` foi retirado como procedimento recomendado: ele forçava Player e não exercitava o onboarding original.

**Registro inicial do launcher (2026-11-07):** o snapshot foi sincronizado e verificado no branch `feature/remote-player-lan-integration`, HEAD `5cd541f7a7aa232d73b346e09720c1a5716b4dc7`, fingerprint `9d47d15f7e36218a80e1160533ee6eb1f75ad23fae7d96a0203f6280e096487c`. No Windows nativo foram confirmados Node `v24.11.0` e npm `11.6.1`; `npm ci` preparou as dependências e a execução final reutilizou-as. `npm run compile` passou. O worker iniciou `build/main.js` pelo Electron do checkout (PID `13840`) com perfil novo `fresh-20261107-150235-5ea7e867`; `operating-mode.json`, bancos, `ui-preferences.json` e configuração da biblioteca não existiam. A captura renderizada `E:\KaraokeQueue\manual-windows\logs\launcher-onboarding.png` mostra a janela original “Configuração inicial” e as três opções, sem modo selecionado. O worker imprimiu `MANUAL LAUNCH PASS`; o processo de orquestração não retornou ao terminal e foi interrompido depois, portanto o status final combinado `WINDOWS MANUAL LAUNCH PASS` não foi registrado. Nenhuma suíte automatizada foi executada.

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

No runner automatizado, o bootstrap sem marcador ou um snapshot com HEAD inalterado não precisa de bundle Git; quando o HEAD avança, o runner cria um bundle incremental com `HEAD ^<HEAD-do-marker>`. O launcher manual também usa esse caminho incremental para um checkout existente. Somente no primeiro bootstrap manual, sem checkout anterior, cria um bundle local da branch atual para inicializar o clone NTFS sem acesso remoto. Em todos os casos, o worker verifica branch/HEAD, inventário e hashes e aceita apenas avanço fast-forward; não usa `git pull`.

Durante a sincronização, o worker cria `.git/karaoke-queue-sync-backup-<runId>`. Antes de substituir ou excluir um arquivo gerenciado, confere seu hash contra o snapshot anterior ou o blob Git aplicável, move o arquivo para o backup e cria o novo destino com operação exclusiva, sem sobrescrever um arquivo inesperado. Em avanço de HEAD, também copia para o backup o snapshot gerenciado anterior e confere os hashes das cópias. Após verificar o inventário completo do destino, valida novamente todos os caminhos e hashes no backup; só então remove o backup, grava o marcador novo e limpa a pendência. Se a sincronização for interrompida ou a recuperação ficar incerta, a pendência permanece; qualquer backup ainda existente é mantido para revisão, e uma nova execução fica bloqueada.

Depois da sincronização, o runner verifica inventário e hashes. O worker faz um handshake com o WSL imediatamente antes do build e novamente antes do E2E; em cada etapa, o WSL recalcula o fingerprint e libera a execução somente se a origem continuar idêntica. Ao final, o WSL calcula novamente. Se o código mudar durante build/teste, o resultado é marcado como obsoleto e o comando termina com erro. O relatório registra branch, HEAD e fingerprint efetivamente testados.

Um lock exclusivo em `.git` serializa runners que compartilham o mesmo clone. Um lock existente ou o marcador de sincronização pendente bloqueia nova execução. Não remova esses arquivos manualmente nem automaticamente; a única exceção é o runner liberar seu próprio lock após o fluxo de cancelamento confirmar a identidade e parada dos processos, recuperar o build, limpar o perfil temporário e verificar ausência de pendências. Em qualquer outra situação, primeiro confirme que não há runner ativo e que o clone não ficou parcialmente sincronizado. Se houver dúvida, prepare um novo clone em um caminho NTFS ainda não utilizado e aponte `KARAOKE_QUEUE_WIN_CHECKOUT` para ele.

Enquanto o runner estiver ativo, trate o checkout Windows como exclusivamente pertencente a essa execução: não edite arquivos nele, não altere seu estado Git e não inicie outra ferramenta que escreva no diretório. O lock serializa os próprios runners, mas não impede um editor ou processo externo de alterar o clone. O runner verifica o destino antes de sincronizar e preserva os arquivos gerenciados em backup, porém o Git não oferece uma operação que torne a verificação e `reset` atômicos contra escritores que não respeitam esse lock. Uma escrita externa nessa janela pode ser sobrescrita sem detecção; portanto, nunca edite o checkout enquanto o runner estiver ativo. Se souber que ocorreu uma escrita concorrente, não confie no resultado: inspecione ou reconstrua o checkout antes de novo uso.

O teste sintético do bloqueio por divergência pode ser executado sem tocar no clone Windows:

    node scripts/run-windows-native-tests.cjs --verify-divergence

Ele cria uma pasta temporária com hash divergente e confirma que a validação rejeita o snapshot antes de acionar o sentinel de build/teste. Esse comando valida somente a barreira de divergência; não compila nem substitui o E2E nativo.

## Build, E2E e política de interface

No modo automatizado, o worker confirma Node.js `win32`, npm nativo, Electron e Playwright Windows no checkout. Move `build/` existente para backup, compila em build novo, confere o inventário de outputs e, após o E2E, restaura o build anterior. O E2E usa Electron, Playwright e SQLite reais. No modo manual, o mesmo worker confirma Node Windows e Electron no checkout, reutiliza dependências somente com lockfile/versões compatíveis (senão executa `npm ci`), compila com o mesmo inventário e inicia o `package.json.main` de produção. Se havia build antigo, preserva seu backup em `cache\build-backups`; o build atual compilado permanece no checkout. Esse modo não carrega Playwright e não executa testes.

### Prioridade de automação antes da revisão manual

Antes de solicitar validação manual ao proprietário, execute os testes automatizados relevantes que forem tecnicamente viáveis: compile, unitários/integração afetados, E2E com Electron real e runner Windows quando houver dependência de plataforma. Corrija defeitos confirmados dentro do escopo e reexecute as suítes afetadas. Para alterações visuais, inspecione a renderização do Electron e compare screenshots com o Doop aprovado; assertions de DOM não aprovam fidelidade visual.

Depois, entregue ao proprietário uma lista manual focada no que não foi coberto automaticamente: percepção humana de áudio/vídeo, aprovação visual/de produto, diálogo nativo não dirigido pelo harness, hardware ou operação real no estabelecimento. A aprovação explícita do proprietário permanece obrigatória quando exigida pela etapa. Se Windows não puder executar, investigue o preflight/problema, use testes alternativos relevantes e marque Windows como `NOT RUN`; um E2E Linux não é evidência de PASS nativo Windows.

### Comandos Windows e entry points efetivamente iniciados

Todos os comandos passam pelo runner oficial, que usa Node, npm, Electron e Playwright nativos do Windows. A classificação abaixo distingue produto real de Electron usado por um harness.

| Comando | Classe | Entry point iniciado | O que comprova e limites |
|---|---|---|---|
| `npm run test:e2e:multi-instance:windows` | A — produção real | Playwright inicia Electron com `args: [projectRoot, --user-data-dir=...]`; `projectRoot` resolve o `package.json.main` (`build/main.js`). | Main, Preload, janela e serviços de produção; perfis e SQLite separados. Cobre single-instance, modos, recuperação básica de fila/sessão após restart, biblioteca e catálogo. As mutações operacionais seguem a UI da Gestão; o `window.__kqueue` exposto pelo Renderer é usado como apoio de observação/flush. Não usa MP4 para comprovar playback nem cobre todas as suítes de Round Robin/sessões. |
| `npm run test:e2e:standalone-production:windows` | A — produção real | O driver Playwright inicia Electron com `args: [projectRoot, --user-data-dir=...]`; usa `build/main.js`, Preload Standalone e IPC de produção. | Main/Preload/IPC, serviços, MP4 real, SQLite de catálogo/perfil isolado, reprodução observável, recovery e shutdown. Exercita painéis, progresso do vídeo, foco/atalhos por Playwright, ciclos F11, Próximas, Pausado/Retomando, limite/toast C11 e lifecycle C9. `SendInput` físico de teclado é reportado separadamente e pode ser `NOT RUN`; Playwright não é prova de teclado físico. |
| `npm run test:e2e:standalone-playback:windows` ou runner `--standalone-playback` | B — harness de serviços | `tests/standalone-player-playback-electron.ts` inicia um Main de teste que monta serviços/host; não inicia `build/main.js`. | Exercita sequência, adapter, host Chromium, MP4 e recovery com perfil temporário. Não prova startup do produto, wiring Main de produção, IPC de produto ou UI de produção. |
| `npm run test:e2e:standalone-integration:windows` ou runner `--standalone-integration` | B — harness de integração | `tests/standalone-player-integration-electron.ts` cria Main/janelas de teste e instala os módulos de Preload/IPC diretamente; não inicia `main.ts`. | Prova a integração isolada entre contrato, Preload/IPC Standalone, sequência, serviço, Chromium, MP4 e recovery. Não prova composição/startup completo do produto nem sua UI de produção. |
| `npm run test:e2e:standalone-options:windows` ou runner `--standalone-options` | B — harness de UI | `tests/standalone-player-ui-electron.ts` cria sua própria janela, serviços, bridge e perfil; não inicia `build/main.js`. | Playwright/Electron, catálogo SQLite, serviço, MP4 e assertions de UI. Usa porta de diálogo exclusiva do teste: não comprova o seletor nativo do Windows, nem o Main/Preload/lifecycle do produto. |
| Runner `--player-playback` | B — harness de serviços | `tests/player-playback-electron.ts` é executado como entry point filho Electron; cria serviço e host isolados. | MP4 real e serviço de playback com IPC/preload de teste; não inicia `package.json.main`. Não há alias npm Windows dedicado. |
| Runner `--player-recovery` | B — harness de recovery | `tests/player-playback-recovery-electron.ts` cria seu próprio Main de teste e serviços. | Recovery/journal, SQLite Combined preservado, MP4 e reinícios isolados. Não inicia Main/Preload de produção nem a UI do produto. Não há alias npm Windows dedicado. |
| Runner `--playback-chromium-final` / `--playback-chromium-interactive` | B — harness técnico | `scripts/playback-engine-evaluation.cjs` e seu harness Electron/Chromium. | Avaliação de engine/mídia e controles do harness; não valida o produto. O modo interativo exige operador e não comprova audibilidade física. |

Não existe mais modo `--player-control`, alias Windows/Headless `test:e2e:player-control:*` ou launcher manual C1. Esses nomes descrevem o shell antigo e não são comandos ativos.

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

**Limite do diálogo nativo e do entry point:** Playwright não controla a janela “Abrir arquivo” do Windows neste harness. Uma porta de diálogo exclusiva de teste fornece o caminho. A UI, o preload de teste, os módulos reais de validação/parser/catálogo e o SQLite são exercitados, mas a janela, a instalação IPC e a composição são montadas pelo entry point de teste; o teste não inicia o Main de produção. Isso valida a lógica após o diálogo retornar um caminho, mas não a janela nativa nem o fluxo integrado do produto. Não reporte o seletor nem a aplicação completa como testados.

O E2E C8 imprime o diretório de screenshots no campo `screenshots` do resultado. Preserve as imagens relevantes e compare sua renderização com o Doop quando aplicável. Uma captura não equivale a aprovação visual humana; E2E não comprova áudio audível nem aprovação do proprietário.

### Runner automatizado versus launcher manual

`scripts/run-windows-native-tests.cjs`, chamado pelo comando central e pelos aliases Windows acima, é o runner automatizado: verifica snapshot/fingerprint, executa build e Playwright/Electron com assertions, usa perfil temporário e confirma cleanup/processos residuais. Não o substitua por execução direta de testes em um checkout Windows.

O launcher manual antigo do harness C1 e seu helper foram removidos; não há procedimento atual para iniciar manualmente esse harness. `tests/standalone-player-ui-electron.ts` continua como harness automatizado e não carrega `build/main.js` nem instala o lifecycle completo de produção. Seu PASS é válido para os módulos e cenários isolados que a suíte declara, não para startup/shutdown da aplicação real.

Para validar o lifecycle C9 em automação, use `npm run test:e2e:standalone-production:windows -- --approve-untracked`, com `KQ_PLAYER_TEST_MEDIA_DIR` encaminhado ao Windows via `WSLENV`; o modo `standalone-production` inicia o aplicativo pelo diretório do projeto, isto é, pelo `main` de produção definido em `package.json` (`build/main.js`), e valida Main/Preload/IPC, MP4, SQLite, recovery e cleanup.

Para reteste manual do Main de produção, use o launcher oficial acima. Ele conserva o perfil escolhido entre execuções e deixa a seleção de modo para o onboarding real. Não execute Node/Electron Windows a partir de `\\wsl.localhost\...`. Um launcher aberto não é E2E automatizado, e um E2E aprovado não é validação manual nem aprovação do proprietário.

**Roteiro manual específico para Alt+F4:** no app de produção iniciado pelo launcher oficial, deixe a janela principal focada e pressione fisicamente `Alt+F4`. Confirme que o modal único aparece e que o app permanece aberto; pressione `Esc` e verifique que playback/fila continuam. Repita `Alt+F4`, confirme com `Enter` e verifique o encerramento normal. Faça também uma rodada com reprodução ativa e uma entrada pendente. Esse teste físico continua necessário quando o helper automatizado `SendInput` não produz o evento `BrowserWindow.close`; um resultado automatizado `SC_CLOSE` não substitui Alt+F4 físico.

### Harness isolado de Chromium

O runner oferece modos focados de avaliação Chromium e um teste da implementação Player 5C. Todos usam a mesma sincronização, verificação de branch/HEAD/hashes, handshake de fingerprint, build nativo e cleanup. Para caminhos escolhidos no WSL, converta o valor com `wslpath -w` antes de encaminhá-lo ao Windows com `WSLENV` e `/w`; o processo PowerShell precisa receber o formato Windows (`C:\...`), não o literal `/mnt/c/...`. Revise a lista de arquivos não rastreados antes de aprovar `--approve-untracked`.

- `--playback-chromium-final`: roda somente os testes do harness e a automação Electron/Chromium. Usa uma amostra a 1× e espera `HTMLMediaElement.ended` até a duração conhecida mais a tolerância especificada; também automatiza a seleção de amostra e os botões Play selected, Pause, Resume, Restart, Stop e Fullscreen em uma janela temporária. Não executa mpv nem as regressões alheias a playback.
- `--playback-chromium-interactive`: após os mesmos gates, abre uma janela temporária com seleção de amostras e controles manuais de playback/fullscreen. A execução aguarda o operador fechar essa janela. O relatório automático do runner não valida audibilidade física nem sincronização percebida.
- `--player-playback`: compila e executa somente `tests/player-playback-electron.js` no Electron Windows real. O entry point de teste cria um host e handlers isolados usando as implementações de serviço/adapter/preload de playback; não inicia o Main de produção. Exercita load, controles, substituição, mídia inválida/ausente, EOF normal e término do Renderer. Não executa o conjunto padrão de regressões Windows. Requer `KQ_PLAYER_TEST_MEDIA_DIR` apontando para amostras locais read-only no Windows.
- `--standalone-playback`: executa os testes focados de contratos/runtime/sequência/interação/adapter e playback/recovery compartilhados, depois `tests/standalone-player-playback-electron.js` em processo Electron isolado. O harness não inicia `main.ts`, não ativa o modo Standalone no produto e não instancia `ManualPlaybackService`; usa o host Chromium e protocolo de mídia existentes, biblioteca real e perfil temporário. Exercita MP4 local, pause/resume, restart, Next, EOF natural, corrida controlada entre Next reservado e EOF HTML5 real, EOF final, recovery bloqueado/inválido, crash real do Renderer com estado `uncertain` e cleanup. O runner não avalia áudio audível nem fidelidade visual. Requer `KQ_PLAYER_TEST_MEDIA_DIR` apontando para as amostras locais read-only no Windows.
- `--standalone-integration`: executa contratos/runtime/sequência/interação e transport B2, IPC B4.1, adapter e regressões de playback/recovery, depois `tests/standalone-player-integration-electron.js` em Electron nativo isolado. O harness usa uma janela de controle com `standalone-player-preload` e o IPC real, mais uma janela técnica com `player-preload`/`ChromiumPlaybackHost`; ambas apontam para a mesma sequência, biblioteca, protocolo e serviço técnico. Verifica comandos B2 por IPC, snapshots/revisões, retry e perda de ACK ao destruir o controle, URL estática autorizada, playback/EOF HTML5 real, corrida Next/EOF, crash do host, relançamento com o registro incerto criado pelo cenário de crash, bloqueio sem autoplay, recuperação inválida preservada e shutdown. Não inicia `main.ts`, não instancia `ManualPlaybackService`, não altera modos nem cria UI de produto. Exige `KQ_PLAYER_TEST_MEDIA_DIR` com as amostras MP4 locais read-only; o CSV é opcional e não é aberto pelo harness.
- `--player-recovery`: compila e executa primeiro `tests/player-playback-recovery.test.js`, depois `tests/player-playback-recovery-electron.js` em processos Electron nativos separados e perfil temporário persistente entre reinícios. O entry point cria um Main de teste com serviços reais de recovery/playback e SQLite; não inicia Main nem Preload de produção. Exercita recuperação de filesystem, incluindo journal/quarentena, crash após o `idle` durável, encerramento abrupto, recovery pendente sem autoplay, replay explícito com nova tentativa, Stop confirmado, EOF natural e preservação da base operacional Combined após crash do Renderer. Requer `KQ_PLAYER_RECOVERY_TEST_MEDIA_DIR` apontando para uma pasta local read-only com `01001.mp4`. O modo não mede foco de janela; o relatório esperado é `WINDOW_FOCUS NOT APPLICABLE`.

### Registro histórico do harness manual C1–C5

O antigo launcher manual C1 foi retirado. Ele iniciava uma composição de teste baseada em `tests/standalone-player-ui-electron.ts`, não o Main de produção. Essa composição ainda existe como harness automatizado usado pelas suítes de UI/opções; ela não instala o lifecycle completo de `main.ts` e não serve para afirmar que o produto foi iniciado.

As validações manuais C1–C5 e aprovações do proprietário registradas no histórico foram realizadas nesse harness. Elas continuam como histórico da interface e da reprodução observadas naquele contexto, mas não são evidência de startup, Preload/IPC completo, shutdown ou aparência integrada do Main de produção. Os atalhos F10/F11 descritos nos antigos roteiros eram hooks do harness, não comandos do produto.

Para abrir e validar manualmente o produto, use exclusivamente o [launcher manual oficial](#launcher-manual-oficial-do-produto). Para validar automaticamente Main, Preload, IPC, MP4 e shutdown em Windows, use o comando `test:e2e:standalone-production:windows` da matriz acima.

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
- `UtilBindVsockAnyPort:307` ao iniciar executáveis Windows dentro do sandbox Codex: faça primeiro apenas os testes mínimos `powershell.exe -NoProfile -Command "Write-Output WSL_WINDOWS_OK"` e `cmd.exe /c echo WSL_CMD_OK`. Se falharem no sandbox, repita a chamada mínima pelo mecanismo de execução aprovado fora do sandbox. Em uma execução anterior deste ambiente, registrada no histórico do launcher acima, a chamada aprovada funcionou e o runner oficial passou depois que o checkout alternativo foi encaminhado via `WSLENV`; isso não garante disponibilidade da interop em execuções futuras. Não desative o sandbox nem altere configurações globais como workaround.
- Se o WSL reportar `...//powershell.exe: Invalid argument`, inspecione se uma entrada de `PATH` termina em `/`. Normalize as barras finais somente no ambiente daquela invocação do runner; não edite `PATH` global. Foi necessário neste ambiente para a invocação aprovada do runner.
- Se `--player-recovery` terminar após a E2E por “foco da janela” em `CLEANUP`, confira a versão do runner: esse modo não mede focus e deve reportar `WINDOW_FOCUS NOT APPLICABLE`; a suíte multi-instância padrão continua exigindo a evidência de foco.
- Origem alterada durante o teste: o resultado é inválido mesmo que o E2E tenha terminado; repita após estabilizar o snapshot.

## Auditoria de launchers e testes Windows — 2026-11-07

O launcher manual C1 (`standalone-c1-windows-native.ps1`/`standalone-c1-windows-manual.cjs`) e o alias `prepare:standalone-c1:windows` foram removidos após confirmar que iniciavam o harness de UI e não tinham consumidores ativos além das verificações específicas do próprio launcher. O teste do runner agora verifica o launcher manual oficial, que chama o runner compartilhado em modo `--manual-launch` e valida `package.json.main` (`build/main.js`). O harness `standalone-player-ui-electron.ts` permanece porque atende às suítes automatizadas de UI/opções; sua classificação continua sendo harness, não produto.

Resultados desta auditoria:

- `node scripts/windows-native-runner.test.cjs` — **PASS**, 29/29 testes.
- `node --check scripts/run-windows-native-tests.cjs` e `node --check scripts/windows-native-runner.test.cjs` — **PASS**. O `package.json` foi interpretado pelo Node; `main` é `build/main.js` e não há alias `prepare:standalone-c1:windows` nem scripts `player-control` ativos.
- `npm run test:e2e:standalone-production:windows -- --approve-untracked` e `npm run test:e2e:multi-instance:windows -- --approve-untracked` — **NOT RUN**. Ambos os runners pararam antes de consultar/sincronizar o checkout NTFS ou validar fingerprint e ferramentas nativas: PowerShell/interop WSL falhou com `UtilBindVsockAnyPort:307: socket failed 1`. Portanto, esta execução não produziu resultado Windows e não confirma estado de processo no checkout.
- `npm run test:e2e:standalone-production:headless` — a compilação TypeScript/cópia de assets passou. A primeira chamada não tinha `KQ_PLAYER_TEST_MEDIA_DIR` e encerrou antes do Electron. Repetida com o MP4 local `01001.mp4` da biblioteca configurada, a suíte ainda não conseguiu iniciar Electron: Chromium terminou com `sandbox_host_linux.cc:41` / `Operation not permitted`. O mesmo bloqueio foi reproduzido executando o Electron sob Xvfb com `--no-sandbox`. Resultado da validação comportamental Linux: **NOT RUN por restrição do ambiente**, não PASS.

Assim, há evidência local de integridade do runner e da configuração, mas esta tarefa não conseguiu executar uma nova campanha do produto real em Electron Windows ou Linux. Os PASS históricos mantidos acima pertencem a execuções anteriores e não são atribuídos a esta auditoria. Para um resultado Windows desta revisão, repetir o comando oficial em uma sessão WSL com interop funcional; só então o runner poderá registrar snapshot, fingerprint, checkout NTFS, Node/Electron nativos, execução e cleanup.
