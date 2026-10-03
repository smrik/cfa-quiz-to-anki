<#
.SYNOPSIS
    Bump the userscript version, commit, and push.

.DESCRIPTION
    Tampermonkey only updates when @version increases. Editing the script and
    pushing without a bump changes nothing on your machine and looks like the
    update mechanism is broken -- so this does both in one step.

.EXAMPLE
    ./bump.ps1                      # 1.3.0 -> 1.3.1, commit "cfa-quiz-to-anki 1.3.1"
    ./bump.ps1 -Part minor          # 1.3.1 -> 1.4.0
    ./bump.ps1 -Message "fix maths" # custom commit message
    ./bump.ps1 -File cfa-quiz-readable.user.js   # bump the other script
#>
[CmdletBinding()]
param(
    [ValidateSet('major', 'minor', 'patch')]
    [string]$Part = 'patch',
    [string]$Message,
    [string]$File = 'cfa-quiz-to-anki.user.js',
    [switch]$NoPush
)

$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

$file = Join-Path $PSScriptRoot $File
$name = (Split-Path $file -Leaf) -replace '\.user\.js$', ''
$text = Get-Content $file -Raw

if ($text -notmatch '(?m)^// @version\s+(\d+)\.(\d+)\.(\d+)\s*$') {
    throw "Could not find a semver @version line in $file"
}
$major = [int]$Matches[1]; $minor = [int]$Matches[2]; $patch = [int]$Matches[3]
$old = "$major.$minor.$patch"

switch ($Part) {
    'major' { $major++; $minor = 0; $patch = 0 }
    'minor' { $minor++; $patch = 0 }
    'patch' { $patch++ }
}
$new = "$major.$minor.$patch"

# Node is used elsewhere in this workflow; a syntax error pushed to main would
# silently break the script on next auto-update, so check before committing.
if (Get-Command node -ErrorAction SilentlyContinue) {
    node -e "new Function(require('fs').readFileSync('$($file -replace '\\','/')','utf8'))"
    if ($LASTEXITCODE -ne 0) { throw 'Syntax check failed - not bumping.' }
    Write-Host 'syntax OK' -ForegroundColor DarkGray
}

$text = $text -replace '(?m)^// @version\s+\d+\.\d+\.\d+\s*$', "// @version      $new"
Set-Content -Path $file -Value $text -NoNewline

if (-not $Message) { $Message = "$name $new" }

git add -A
git commit -m $Message | Out-Null
Write-Host "$old -> $new  ($Message)" -ForegroundColor Green

if (-not $NoPush) {
    git push
    Write-Host 'pushed. Tampermonkey picks it up on its next check (or force one from the dashboard).' -ForegroundColor Green
} else {
    Write-Host 'not pushed (-NoPush).' -ForegroundColor Yellow
}
