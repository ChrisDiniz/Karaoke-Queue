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
- Clone de validação em volume NTFS. Por padrão, o runner procura `source\karaoke-queue-win` sob `$env:USERPROFILE`. Para outro diretório, configure `KARAOKE_QUEUE_WIN_CHECKOUT` no ambiente do PowerShell iniciado pelo WSL.
- Sessão gráfica Windows interativa para esta suíte de múltiplas instâncias. A compilação sozinha não precisa abrir janelas.

O runner não instala ferramentas globais nem altera configurações do Windows ou do Git. `npm ci` instala dependências em `node_modules` do clone Windows e usa `.npm-cache` local.

## Comando central

Execute no terminal WSL, a partir do repositório:

    npm run test:e2e:multi-instance:windows

O fluxo único prepara o snapshot, verifica o clone, executa `npm ci`, compila com Node/npm Windows e inicia `build/tests/multi-instance-electron.js` com o Electron e Playwright locais do Windows. O Electron usa perfis e bancos SQLite temporários.

Arquivos novos não rastreados são listados com SHA-256 para revisão. Em um terminal interativo, confirme digitando `SYNC`. Para automação após revisar exatamente a lista exibida, passe a aprovação explícita:

    npm run test:e2e:multi-instance:windows -- --approve-untracked

Essa opção aprova somente a lista identificada naquela execução. Arquivos sensíveis, caminhos incompatíveis com Windows, links e arquivos especiais são recusados. Na origem WSL, caminhos ignorados pelo Git e artefatos conhecidos — como `node_modules`, `build`, `.npm-cache`, caches, saídas de build, logs e temporários — não entram no snapshot. Os perfis e bancos do E2E são criados fora do checkout. Um caminho sensível ou artefato que esteja rastreado ou não ignorado bloqueia a sincronização em vez de ser silenciosamente copiado.

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

Esta suíte não deve ser forçada para headless. Ela verifica estados reais de janela: ocultação/show, minimização/restore e ativação/foco. O teste de minimização observa o evento nativo e `isMinimized`; a restauração observa `restore`, visibilidade e estado minimizado. O foco só recebe status PASS quando o evento e `BrowserWindow.isFocused()` são observados no cenário de restauração e no de janela oculta. Se o foco não puder ser confirmado, a execução falha sem presumir que a causa foi uma política do sistema.

Os testes são automatizados e não pedem interação manual. Se não houver Explorer/sessão gráfica interativa, a compilação pode ocorrer, mas o E2E é reportado como NOT RUN e o runner retorna erro. `xvfb-run` é uma infraestrutura Linux e não valida comportamento nativo de janelas do Windows. Outros testes sem dependência de janela gráfica podem ter runners headless próprios quando preservarem as assertions reais.

Após o E2E, o worker verifica a remoção do perfil temporário e consulta processos Electron associados ao caminho exclusivo daquela execução via `Get-CimInstance Win32_Process`. Se a consulta falhar ou não puder confirmar o resultado, a verificação falha; isso não é interpretado como ausência de processos. O worker não encerra processos indiscriminadamente. Ao receber cancelamento, o runner confirma a identidade do worker pelo PID, `runId` e token do lock, encerra a árvore identificada e verifica que os processos observados terminaram. Depois recupera o build anterior, preservando o build interrompido em `.git/`, limpa apenas o perfil temporário exclusivo do run e confirma que não há pendência nem backup de sincronização. Só então remove o lock pertencente à execução. Se alguma verificação ou recuperação falhar, o relatório fica `CANCELLED_RECOVERY_REQUIRED` e o lock é mantido para revisão manual. Processos residuais ou uma consulta inconclusiva impedem o status geral PASS.

## Interpretar o resultado

- PASS: sincronização, equivalência de hashes, validação e limpeza dos backups, build Windows, E2E, foco observado, limpeza de perfil, ausência de processo residual e liberação do lock foram confirmados. A saída inclui branch, HEAD e fingerprint.
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
- Origem alterada durante o teste: o resultado é inválido mesmo que o E2E tenha terminado; repita após estabilizar o snapshot.
