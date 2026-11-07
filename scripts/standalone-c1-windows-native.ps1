[CmdletBinding()]
param(
  [string]$MediaRoot = 'C:\Users\Chris\Documents\Video musicas e catalogo',
  [string]$CatalogCsv = 'C:\Users\Chris\Documents\Video musicas e catalogo\LISTA-06-12-24-41A-15H-LD52769-BASE-1.csv',
  [string]$WslNodePath = '/home/chris/.nvm/versions/node/v24.15.0/bin/node'
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$windowsTemp = [IO.Path]::GetFullPath($env:TEMP)
$stageRoot = $null
$wslSnapshotPath = $null
$wslNodePath = $WslNodePath
$snapshot = $null
$projectRoot = $null
$electronProcess = $null

function Assert-RegularDirectory([string]$Path, [string]$Label) {
  if (-not (Test-Path -LiteralPath $Path -PathType Container)) { throw "$Label não existe: $Path" }
  $item = Get-Item -LiteralPath $Path -Force
  if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "$Label é um reparse point: $Path" }
}

try {
  Assert-RegularDirectory $windowsTemp '%TEMP%'
  $tempDrive = New-Object IO.DriveInfo ([IO.Path]::GetPathRoot($windowsTemp))
  if ($tempDrive.DriveFormat -ne 'NTFS') { throw "%TEMP% precisa estar em NTFS; encontrado $($tempDrive.DriveFormat)." }
  Write-Host "Windows TEMP: $windowsTemp ($($tempDrive.DriveFormat))"
  Write-Host "Pasta de vídeos: $([IO.Path]::GetFullPath($MediaRoot))"
  Write-Host "CSV: $([IO.Path]::GetFullPath($CatalogCsv))"
  if (-not (Test-Path -LiteralPath $MediaRoot -PathType Container)) { throw "Pasta de vídeos não encontrada: $MediaRoot" }
  if (-not (Test-Path -LiteralPath (Join-Path $MediaRoot '01001.mp4') -PathType Leaf)) { throw "01001.mp4 não encontrado em: $MediaRoot" }
  if (-not (Test-Path -LiteralPath $CatalogCsv -PathType Leaf)) { throw "CSV não encontrado: $CatalogCsv" }

  if (-not $wslNodePath -or $wslNodePath -notmatch '^/(?!mnt/)[A-Za-z0-9_./+-]+$' -or $wslNodePath -match '\.exe$') {
    throw "Caminho de Node Linux inválido ou Windows: $wslNodePath"
  }
  $platformLines = @(& wsl.exe --distribution Ubuntu --cd /home/chris/projetos/karaoke-queue --exec $wslNodePath /home/chris/projetos/karaoke-queue/scripts/standalone-c1-windows-manual.cjs --node-info)
  if ($LASTEXITCODE -ne 0 -or $platformLines.Count -eq 0) {
    throw "O Node WSL configurado não existe ou não está executando como Linux nativo: $wslNodePath"
  }
  $wslRuntime = ([string]($platformLines | Select-Object -Last 1)).Trim() | ConvertFrom-Json
  if ($wslRuntime.platform -ne 'linux') { throw "O Node WSL configurado não é Linux nativo: $wslNodePath ($($wslRuntime.platform))" }
  Write-Host "Node WSL confirmado: $wslNodePath ($($wslRuntime.platform), $($wslRuntime.version))"
  Write-Host 'Exportando snapshot verificado do WSL; depois ele será copiado para um staging NTFS temporário.'
  $exportLines = @(& wsl.exe --distribution Ubuntu --cd /home/chris/projetos/karaoke-queue --exec $wslNodePath /home/chris/projetos/karaoke-queue/scripts/standalone-c1-windows-manual.cjs --export-snapshot --approve-untracked)
  if ($LASTEXITCODE -ne 0) { throw 'A exportação do snapshot WSL falhou.' }
  foreach ($line in $exportLines) { Write-Host $line }
  $jsonLine = $exportLines | Where-Object { $_ -like 'KQ_C1_EXPORT_JSON=*' } | Select-Object -Last 1
  if (-not $jsonLine) { throw 'O exportador não retornou os dados do snapshot.' }
  $snapshot = $jsonLine.Substring('KQ_C1_EXPORT_JSON='.Length) | ConvertFrom-Json
  $wslSnapshotPath = [string]$snapshot.stagePathWindows
  if ($snapshot.stagePathLinux -notmatch '^/tmp/karaoke-queue-windows-stage-[A-Za-z0-9]+$' -or
      $snapshot.fingerprint -notmatch '^[a-f0-9]{64}$' -or
      $wslSnapshotPath -notmatch '^\\\\wsl\.localhost\\Ubuntu\\tmp\\karaoke-queue-windows-stage-[A-Za-z0-9]+$') {
    throw 'O caminho ou fingerprint do snapshot temporário WSL é inválido.'
  }
  $runToken = [guid]::NewGuid().ToString('N')
  $stageRoot = Join-Path $windowsTemp ('karaoke-queue-c1-manual-' + $runToken)
  if (Test-Path -LiteralPath $stageRoot) { throw 'O staging NTFS temporário já existe; nenhum arquivo será sobrescrito.' }
  New-Item -ItemType Directory -Path $stageRoot -Force:$false | Out-Null
  $projectRoot = Join-Path $stageRoot 'project'
  New-Item -ItemType Directory -Path $projectRoot -Force:$false | Out-Null
  $sourceStage = $wslSnapshotPath.TrimEnd('\')
  Copy-Item -Path ($sourceStage + '\tree\*') -Destination $projectRoot -Recurse -Force
  Copy-Item -LiteralPath ($sourceStage + '\metadata\snapshot.json') -Destination (Join-Path $stageRoot 'snapshot.json')
  Assert-RegularDirectory $stageRoot 'Staging C1'
  Assert-RegularDirectory $projectRoot 'Cópia NTFS do snapshot'
  $manifestPath = Join-Path $stageRoot 'snapshot.json'
  Assert-RegularDirectory $projectRoot 'Snapshot de código'
  if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) { throw 'Manifesto SHA-256 do snapshot ausente.' }
  $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
  if ($manifest.fingerprint -ne $snapshot.fingerprint -or $manifest.branch -ne $snapshot.branch -or $manifest.head -ne $snapshot.head) {
    throw 'Fingerprint, branch ou HEAD do snapshot divergem do resultado independente do exportador.'
  }
  if ($manifest.files.Count -ne $snapshot.fileCount) { throw 'A contagem de arquivos do snapshot diverge do manifesto.' }
  $scriptSource = [string]$MyInvocation.MyCommand.Path
  $scriptRecord = $manifest.files | Where-Object { $_.path -eq 'scripts/standalone-c1-windows-native.ps1' } | Select-Object -First 1
  if (-not $scriptRecord) { throw 'O script PowerShell não consta no manifesto da origem.' }
  $scriptHash = (Get-FileHash -LiteralPath $scriptSource -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($scriptHash -ne $scriptRecord.sha256) { throw 'O script PowerShell em execução difere do snapshot C1.' }
  if ($snapshot.untrackedCount -gt 0) {
    $approval = Read-Host 'Revise os hashes/nomes não rastreados acima. Digite SYNC para incluir exatamente esta lista'
    if ($approval -cne 'SYNC') { throw 'Snapshot cancelado pelo operador.' }
  }

  $nodeCommand = Get-Command node.exe -ErrorAction Stop
  $npmCommand = Get-Command npm.cmd -ErrorAction Stop
  $nodeExe = $nodeCommand.Source
  $npmExe = $npmCommand.Source
  $manualHelper = Join-Path $projectRoot 'scripts\standalone-c1-windows-manual.cjs'
  $nodeInfoLines = @(& $nodeExe $manualHelper --node-info)
  if ($LASTEXITCODE -ne 0 -or $nodeInfoLines.Count -eq 0) { throw 'Não foi possível consultar o runtime Node do Windows.' }
  $nodeRuntime = ([string]$nodeInfoLines[-1]).Trim() | ConvertFrom-Json
  if ($LASTEXITCODE -ne 0 -or $nodeRuntime.platform -ne 'win32') { throw 'node.exe não está executando como runtime Windows nativo.' }
  $nodeVersion = [version]($nodeRuntime.version -replace '^v', '')
  if ($nodeVersion -lt [version]'22.12') { throw "Node.js 22.12+ é necessário; encontrado $($nodeRuntime.version)." }
  Write-Host "Node nativo: $nodeExe ($($nodeRuntime.platform), $($nodeRuntime.version)); npm: $npmExe"

  Push-Location $projectRoot
  try {
    $env:KQ_C1_MANIFEST = $manifestPath
    $env:KQ_C1_EXPECTED_FINGERPRINT = [string]$snapshot.fingerprint
    & $nodeExe $manualHelper --verify-snapshot
    if ($LASTEXITCODE -ne 0) { throw 'Os hashes dos arquivos em NTFS não correspondem ao snapshot WSL.' }

    & $npmExe ci --cache (Join-Path $stageRoot 'npm-cache')
    if ($LASTEXITCODE -ne 0) { throw 'npm ci falhou usando dependências nativas do Windows.' }
    & $npmExe run compile
    if ($LASTEXITCODE -ne 0) { throw 'A compilação nativa Windows falhou.' }

    & $nodeExe $manualHelper --verify-build
    if ($LASTEXITCODE -ne 0) { throw 'Inventário de build Windows falhou ou faltam artefatos C1 do harness.' }

    $profileRoot = Join-Path $stageRoot 'profile'
    Write-Host "Staging isolado C1: $stageRoot"
    Write-Host "Perfil temporário SQLite: $profileRoot"
    New-Item -ItemType Directory -Path $profileRoot -Force:$false | Out-Null
    $env:KQ_STANDALONE_C1_UI_MAIN = '1'
    $env:KQ_STANDALONE_C1_MANUAL = '1'
    $env:KQ_PROJECT_ROOT = $projectRoot
    $env:KQ_PLAYER_TEST_MEDIA_DIR = [IO.Path]::GetFullPath($MediaRoot)
    $env:KQ_PLAYER_TEST_CATALOG_CSV = [IO.Path]::GetFullPath($CatalogCsv)
    $env:KQ_STANDALONE_C1_PROFILE = $profileRoot
    $env:KQ_STANDALONE_C1_DOCUMENT = Join-Path $projectRoot 'build\src\standalone-player.html'

    & $nodeExe $manualHelper --import-catalog
    if ($LASTEXITCODE -ne 0) { throw 'A importação do CSV no perfil temporário falhou.' }

    $electronOutput = @(& $nodeExe $manualHelper --electron-path)
    if ($LASTEXITCODE -ne 0 -or $electronOutput.Count -eq 0) { throw 'O pacote Electron nativo não foi localizado.' }
    $electronExe = [IO.Path]::GetFullPath(([string]$electronOutput[-1]).Trim())
    $electronDirectory = [IO.Path]::GetFullPath((Join-Path $projectRoot 'node_modules\electron\dist')).TrimEnd('\') + '\'
    if (-not $electronExe.StartsWith($electronDirectory, [StringComparison]::OrdinalIgnoreCase) -or
        [IO.Path]::GetFileName($electronExe) -ine 'electron.exe') {
      throw "Electron não resolveu para o binário Windows instalado neste staging: $electronExe"
    }
    Write-Host "Electron nativo confirmado: $electronExe"
    Write-Host "Código WSL: branch=$($snapshot.branch) HEAD=$($snapshot.head) fingerprint=$($snapshot.fingerprint)"
    Write-Host 'AVISO: este launcher abre o harness visual C1 (standalone-player-ui-electron.js), nao o Main de producao build/main.js. Sair, X e Alt+F4 aqui nao validam o lifecycle C9.'
    Write-Host 'A janela fica aberta ate Alt+F4. C5: Space pausa/retoma; R reinicia; Ctrl+Right faz Next; Ctrl+Space abre confirmacao Stop All. F10 imprime snapshot autoritativo; F11 aproxima EOF natural.'

    $entryPoint = Join-Path $projectRoot 'build\tests\standalone-player-ui-electron.js'
    $electronProcess = Start-Process -FilePath $electronExe -ArgumentList ('"' + $entryPoint + '"') -WorkingDirectory $projectRoot -PassThru
    $nativeProcess = $null
    for ($attempt = 0; $attempt -lt 100 -and -not $nativeProcess; $attempt++) {
      $nativeProcess = Get-CimInstance -ClassName Win32_Process -Filter "ProcessId = $($electronProcess.Id)" -ErrorAction Stop
      if (-not $nativeProcess -and -not $electronProcess.HasExited) { Start-Sleep -Milliseconds 100 }
    }
    if (-not $nativeProcess) { throw 'Não foi possível consultar o processo Electron recém-iniciado.' }
    $actualElectronPath = [IO.Path]::GetFullPath([string]$nativeProcess.ExecutablePath)
    if (-not [string]::Equals($actualElectronPath, $electronExe, [StringComparison]::OrdinalIgnoreCase)) {
      throw "O processo iniciado não corresponde ao electron.exe nativo esperado: $actualElectronPath"
    }
    Write-Host "PROCESSO WINDOWS NATIVO: PID=$($nativeProcess.ProcessId) ExecutablePath=$actualElectronPath"
    Write-Host 'Para conferir em outro PowerShell: Get-CimInstance Win32_Process -Filter "ProcessId = PID" | Select ProcessId,ExecutablePath,CommandLine'
    Wait-Process -Id $electronProcess.Id
    $electronProcess.Refresh()
    if ($electronProcess.ExitCode -ne 0) { throw "Electron encerrou com código $($electronProcess.ExitCode)." }
  } finally {
    Pop-Location
  }
} finally {
  if ($electronProcess -and -not $electronProcess.HasExited) {
    Write-Host 'Aguardando o encerramento manual da janela antes de limpar o staging.'
    Wait-Process -Id $electronProcess.Id
  }
  if ($stageRoot -and (Test-Path -LiteralPath $stageRoot)) {
    $cleanup = Get-Item -LiteralPath $stageRoot -Force
    if (($cleanup.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw "Staging virou reparse point; preservado para inspeção: $stageRoot"
    }
    Remove-Item -LiteralPath $stageRoot -Recurse -Force
    Write-Host 'Perfil, node_modules e snapshot temporário foram removidos.'
  }
  if ($snapshot -and $snapshot.stagePathLinux -match '^/tmp/karaoke-queue-windows-stage-[A-Za-z0-9]+$' -and
      $snapshot.fingerprint -match '^[a-f0-9]{64}$') {
    & wsl.exe --distribution Ubuntu --cd /home/chris/projetos/karaoke-queue --exec $wslNodePath /home/chris/projetos/karaoke-queue/scripts/standalone-c1-windows-manual.cjs --cleanup-snapshot $snapshot.stagePathLinux $snapshot.fingerprint
    if ($LASTEXITCODE -ne 0) { Write-Warning 'Snapshot intermediário WSL não foi removido; ele permanece em /tmp para inspeção.' }
  }
}
