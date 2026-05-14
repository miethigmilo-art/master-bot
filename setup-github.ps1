# Master-Bot GitHub Setup Script
# Fuehre dieses Skript einmal aus, um das Repo zu erstellen und zu pushen
$ErrorActionPreference = "Stop"
trap { Write-Host "`nFEHLER: $_" -ForegroundColor Red; Write-Host "Druecke Enter..."; Read-Host; exit 1 }

$TOKEN = "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"
$REPO_NAME = "master-bot"
$GITHUB_USER = "miethigmilo-art"

Write-Host "=== Master-Bot GitHub Setup ===" -ForegroundColor Cyan

# 1. GitHub Repo erstellen
Write-Host "`n[1/3] Erstelle GitHub Repo..." -ForegroundColor Yellow
$body = @{
    name        = $REPO_NAME
    description = "Master Trading Bot mit eigenem Dashboard"
    private     = $true
    auto_init   = $false
} | ConvertTo-Json

$response = Invoke-RestMethod `
    -Uri "https://api.github.com/user/repos" `
    -Method POST `
    -Headers @{ Authorization = "token $TOKEN"; "User-Agent" = "master-bot-setup" } `
    -Body $body `
    -ContentType "application/json"

Write-Host "Repo erstellt: $($response.html_url)" -ForegroundColor Green

# 2. Git initialisieren
Write-Host "`n[2/3] Initialisiere Git..." -ForegroundColor Yellow
$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $dir

git init
git config user.email "miethigmilo@gmail.com"
git config user.name "Boss"
git add .
git commit -m "feat: initial master-bot with dashboard"
git branch -M main
git remote add origin "https://$TOKEN@github.com/$GITHUB_USER/$REPO_NAME.git"

# 3. Push
Write-Host "`n[3/3] Pushe zu GitHub..." -ForegroundColor Yellow
git push -u origin main

Write-Host "`n=== FERTIG ===" -ForegroundColor Green
Write-Host "Repo: https://github.com/$GITHUB_USER/$REPO_NAME" -ForegroundColor Cyan
Write-Host "`nNaechste Schritte:" -ForegroundColor Yellow
Write-Host "1. Railway.app -> New Project -> Deploy from GitHub -> master-bot"
Write-Host "2. Alle Env-Variablen aus .env.example in Railway eintragen"
Write-Host "3. Railway deployed automatisch!"
Write-Host "`nDruecke Enter zum Schliessen..."
Read-Host
