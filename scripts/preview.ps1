# dsh-repowiki 真机预览：隔离 profile（复制默认 web profile 的登录/模型/工作区），
# npm pack 后解包进 profile node_modules，file: 依赖注册 bundle。
# 机制对齐根 scripts/preview-packages.ps1（单插件版）。用法：
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/preview.ps1 [-Port 5494]
param(
  [string]$DshExecutable = 'E:\Dev\Toolchains\DeepSeek\DeepSeek Harness.exe',
  [int]$Port = 5494
)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$previewHome = Join-Path $projectRoot '.cache/preview-dsh'
$profileDir = Join-Path $previewHome 'profiles/repowiki-test'
$runtime = Join-Path (Split-Path -Parent $DshExecutable) 'resources/app.asar/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js'
if (!(Test-Path -LiteralPath $DshExecutable)) { throw "DSH executable not found: $DshExecutable" }
if (!(Test-Path -LiteralPath (Join-Path $projectRoot 'lib/client.js'))) { throw 'Run npm run build first.' }
$previousHome = $env:DSH_HOME
$previousElectron = $env:ELECTRON_RUN_AS_NODE
$previousTelemetry = $env:DSH_TELEMETRY_DISABLED
try {
  New-Item -ItemType Directory -Force -Path $previewHome | Out-Null
  $env:DSH_HOME = $previewHome
  $env:ELECTRON_RUN_AS_NODE = '1'
  $env:DSH_TELEMETRY_DISABLED = '1'
  $hostArguments = @('--expose-internals', $runtime)
  if (!(Test-Path -LiteralPath (Join-Path $profileDir 'package.json'))) {
    & $DshExecutable $hostArguments @('--profile', 'repowiki-test', '--from-default-profile', 'web', '--dump-config') | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Cannot initialize isolated DSH profile.' }
  }
  # 拷贝构建产物（= npm pack 内容，白名单已由 check:package 验证），解包进 profile node_modules。
  $target = Join-Path $profileDir 'node_modules/dsh-repowiki'
  New-Item -ItemType Directory -Force -Path $target | Out-Null
  foreach ($entry in @('lib', 'cordis.patch.yml', 'docs', 'README.md', 'LICENSE', 'package.json')) {
    Copy-Item -LiteralPath (Join-Path $projectRoot $entry) -Destination $target -Recurse -Force
  }
  $manifestPath = Join-Path $profileDir 'package.json'
  $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
  if ($manifest.dsh.profile.bundles -notcontains 'dsh-repowiki') {
    $manifest.dsh.profile.bundles += 'dsh-repowiki'
  }
  $manifest.dependencies | Add-Member -NotePropertyName 'dsh-repowiki' -NotePropertyValue "file:$target" -Force
  # Windows PowerShell 5 的 -Encoding utf8 会写 BOM，宿主 JSON.parse 不接受；显式无 BOM。
  [IO.File]::WriteAllText($manifestPath, ($manifest | ConvertTo-Json -Depth 20), [Text.UTF8Encoding]::new($false))
  $overlay = Join-Path $previewHome 'preview-no-hmr.yml'
  "- id: hmr`n  disabled: true`n" | Set-Content -LiteralPath $overlay -Encoding utf8
  Write-Host "Isolated DSH home: $previewHome"
  Write-Host "Panel URL: http://127.0.0.1:$Port"
  & $DshExecutable $hostArguments @('--profile', 'repowiki-test', '--patch', $overlay, '--host', '127.0.0.1', '--port', [string]$Port, '--no-open') | Out-Host
} finally {
  $env:DSH_HOME = $previousHome
  $env:ELECTRON_RUN_AS_NODE = $previousElectron
  $env:DSH_TELEMETRY_DISABLED = $previousTelemetry
}
