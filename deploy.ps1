# 编码切换器多目标部署脚本
# 用法：
#   .\deploy.ps1                  # 部署到所有已检测到的 IDE（trae/vscode/codebuddy）
#   .\deploy.ps1 -Targets trae    # 只部署到 Trae
#   .\deploy.ps1 -Targets vscode,codebuddy
# 前置：先执行构建（npm run build），脚本只负责拷贝与清理旧版本。
param(
    [string[]]$Targets = @("trae", "vscode", "codebuddy")
)

$ErrorActionPreference = "Stop"
$root = $PSScriptRoot

# 读取版本号，目标目录统一用 "发布者.名称-版本" 规范命名
$pkg = Get-Content (Join-Path $root "package.json") -Raw -Encoding UTF8 | ConvertFrom-Json
$ver = $pkg.version
$extId = "$($pkg.publisher).$($pkg.name)"

# 构建产物检查（缺则提示先构建）
$distJs = Join-Path $root "dist\extension.js"
if (-not (Test-Path $distJs)) {
    Write-Host "[错误] 未找到 $distJs ，请先执行: npm run build" -ForegroundColor Red
    exit 1
}

# 三个 IDE 的用户级扩展目录（目录存在 = 该 IDE 已安装过）
$ideMap = @{
    "trae"      = Join-Path $env:USERPROFILE ".trae-cn\extensions"
    "vscode"    = Join-Path $env:USERPROFILE ".vscode\extensions"
    "codebuddy" = Join-Path $env:USERPROFILE ".codebuddy\extensions"
}

# 待拷贝文件：清单 + 打包产物 + 图标资源（esbuild 已把 iconv-lite 打进单文件，无需 node_modules）
$filesToCopy = @(
    @{ Src = Join-Path $root "package.json"; DestSub = "" },
    @{ Src = $distJs;                        DestSub = "dist" },
    @{ Src = Join-Path $root "resources\icon.png";         DestSub = "resources" },
    @{ Src = Join-Path $root "resources\scope-file.svg";   DestSub = "resources" },
    @{ Src = Join-Path $root "resources\scope-folder.svg"; DestSub = "resources" }
)

foreach ($t in $Targets) {
    if (-not $ideMap.ContainsKey($t)) {
        Write-Host "[$t] 未知目标，跳过（可用: trae / vscode / codebuddy）" -ForegroundColor Yellow
        continue
    }
    $base = $ideMap[$t]
    if (-not (Test-Path $base)) {
        Write-Host "[$t] 未安装（$base 不存在），跳过" -ForegroundColor Yellow
        continue
    }

    # 清理本扩展的全部旧版本目录，避免同 id 同版本双目录冲突
    $old = Get-ChildItem $base -Directory -Filter "$extId-*" -ErrorAction SilentlyContinue
    foreach ($o in $old) {
        try {
            Remove-Item $o.FullName -Recurse -Force
            Write-Host "[$t] 已删除旧版本目录: $($o.Name)"
        } catch {
            # IDE 正在运行时个别文件可能被占用；删除失败则明确提示，避免双目录同版本冲突
            Write-Host "[$t] 警告: 旧目录 $($o.Name) 删除失败（可能被运行中的 IDE 占用），请关闭 IDE 后重跑本脚本" -ForegroundColor Yellow
        }
    }

    # 拷贝新版本
    $dest = Join-Path $base "$extId-$ver"
    foreach ($f in $filesToCopy) {
        if (-not (Test-Path $f.Src)) { continue }
        $dstDir = if ($f.DestSub) { Join-Path $dest $f.DestSub } else { $dest }
        New-Item -ItemType Directory -Force -Path $dstDir | Out-Null
        Copy-Item $f.Src $dstDir -Force
    }
    Write-Host "[$t] 已部署 v$ver -> $dest" -ForegroundColor Green
    Write-Host "[$t] 如该 IDE 当前正在运行，请重载窗口（Reload Window）后生效" -ForegroundColor Cyan
}
