$ErrorActionPreference = 'Stop'

$manualRoot = 'E:\KaraokeQueue\manual-windows'
$profilesRoot = Join-Path $manualRoot 'profiles'
$cacheRoot = Join-Path $manualRoot 'cache'
$logsRoot = Join-Path $manualRoot 'logs'
$karaokeRoot = 'E:\KaraokeQueue'

if (-not (Test-Path -LiteralPath 'E:\' -PathType Container)) {
  throw 'Unidade E: indisponível. O launcher manual exige E: e não usa fallback para C:.'
}
$drive = New-Object IO.DriveInfo 'E:\'
if (-not $drive.IsReady -or $drive.DriveFormat -ne 'NTFS') {
  throw "E: precisa estar disponível em NTFS; encontrado $($drive.DriveFormat)."
}

function Assert-PlainDirectory([string]$Path, [string]$Label) {
  if (-not (Test-Path -LiteralPath $Path -PathType Container)) { throw "$Label não existe: $Path" }
  $item = Get-Item -LiteralPath $Path -Force
  if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "$Label é reparse point: $Path" }
}

foreach ($directory in @($karaokeRoot, $manualRoot, $profilesRoot, $cacheRoot, $logsRoot)) {
  if (-not (Test-Path -LiteralPath $directory)) { New-Item -ItemType Directory -Path $directory -Force:$false | Out-Null }
  Assert-PlainDirectory $directory 'Diretório manual'
}

$availableProfiles = @(Get-ChildItem -LiteralPath $profilesRoot -Directory -Force | Sort-Object Name)
Write-Host 'Karaoke Queue — launcher manual do Main de produção'
Write-Host "Ambiente persistente: $manualRoot ($($drive.DriveFormat))"
Write-Host '1. Nova instalação (perfil vazio; o onboarding escolherá o modo)'
for ($index = 0; $index -lt $availableProfiles.Count; $index++) {
  Write-Host ("{0}. Reabrir perfil existente: {1}" -f ($index + 2), $availableProfiles[$index].Name)
}

$selection = (Read-Host 'Escolha uma opção').Trim()
$profileKind = $null
$profileName = $null
if ($selection -ceq '1') {
  $profileKind = 'new'
  $profileName = 'fresh-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + ([guid]::NewGuid().ToString('N').Substring(0, 8))
} else {
  $profileIndex = 0
  if (-not [int]::TryParse($selection, [ref]$profileIndex) -or
      $profileIndex -lt 2 -or $profileIndex -gt ($availableProfiles.Count + 1)) {
    throw 'Opção inválida; nenhum perfil foi criado ou alterado.'
  }
  $profileKind = 'existing'
  $profileName = $availableProfiles[$profileIndex - 2].Name
  Assert-PlainDirectory (Join-Path $profilesRoot $profileName) 'Perfil selecionado'
}

$scriptPath = [IO.Path]::GetFullPath([string]$MyInvocation.MyCommand.Path)
$uncMatch = [regex]::Match($scriptPath, '(?i)^\\\\wsl(?:\.localhost|\$)\\([^\\]+)\\')
if (-not $uncMatch.Success) {
  throw 'Execute este arquivo pelo caminho UNC do WSL, por exemplo: \\wsl.localhost\Ubuntu\home\chris\projetos\karaoke-queue\scripts\standalone-manual-windows.ps1'
}
$distro = $uncMatch.Groups[1].Value
$linuxScript = & wsl.exe --distribution $distro --exec wslpath -u $scriptPath
if ($LASTEXITCODE -ne 0 -or -not $linuxScript) { throw 'Não foi possível converter o caminho UNC atual para o caminho WSL.' }
$linuxScript = ([string]$linuxScript).Trim()
$suffix = '/scripts/standalone-manual-windows.ps1'
if (-not $linuxScript.EndsWith($suffix, [StringComparison]::Ordinal)) { throw "O caminho convertido não corresponde ao launcher oficial: $linuxScript" }
$repoRoot = $linuxScript.Substring(0, $linuxScript.Length - $suffix.Length)
$runner = $repoRoot.TrimEnd('/') + '/scripts/run-windows-native-tests.cjs'
if (-not (Test-Path -LiteralPath $scriptPath -PathType Leaf)) { throw "Launcher WSL não encontrado: $scriptPath" }
$nodeDiscovery = 'if [ -s "$HOME/.nvm/nvm.sh" ]; then . "$HOME/.nvm/nvm.sh" >/dev/null 2>&1; fi; command -v node'
$wslNode = & wsl.exe --distribution $distro --exec bash -lc $nodeDiscovery
if ($LASTEXITCODE -ne 0 -or -not $wslNode) { throw 'Node.js não foi encontrado no ambiente WSL do repositório.' }
$wslNode = [string](@($wslNode) | ForEach-Object { ([string]$_).Trim() } | Where-Object { $_ } | Select-Object -Last 1)
if ($wslNode -notmatch '^/(?!mnt/)[A-Za-z0-9_./+-]+/node$' -or $wslNode -match '\.exe$') {
  throw "O executável Node do orquestrador WSL não parece Linux nativo: $wslNode"
}

Write-Host "Perfil escolhido: $profileKind / $profileName"
Write-Host "Sincronização oficial do snapshot WSL: $repoRoot"
Write-Host 'Nenhum teste automatizado será executado.'

$runnerArguments = @(
  '--distribution', $distro,
  '--cd', $repoRoot,
  '--exec', $wslNode, $runner,
  '--manual-launch',
  '--manual-profile-kind', $profileKind,
  '--manual-profile-name', $profileName
)
& wsl.exe @runnerArguments
if ($LASTEXITCODE -ne 0) { throw "O launcher terminou com código $LASTEXITCODE." }
