@echo off
REM === master-bot Push ===
REM %~dp0 = directory of this bat file (master-bot folder), avoids Ü encoding issue
cd /d "%~dp0"
if exist .git\HEAD.lock del /f .git\HEAD.lock
if exist .git\index.lock del /f .git\index.lock
git config user.email "miethigmilo@gmail.com"
git config user.name "miethigmilo-art"
git add -A
git commit -m "chore: update master-bot"
git push https://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@github.com/miethigmilo-art/master-bot.git main

echo.
echo === master-bot gepusht ===

REM === ml-service Push ===
REM Use relative path from master-bot to avoid Ü encoding issue
cd "%~dp0..\ml-service"
if errorlevel 1 (
  echo ERROR: ml-service Pfad nicht gefunden!
  pause
  exit /b 1
)
if exist .git\HEAD.lock del /f .git\HEAD.lock
if exist .git\index.lock del /f .git\index.lock
git config user.email "miethigmilo@gmail.com"
git config user.name "miethigmilo-art"
git add -A
git commit -m "chore: update ml-service"
git push https://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@github.com/miethigmilo-art/ml-service.git main

echo.
echo === ml-service gepusht ===
pause
