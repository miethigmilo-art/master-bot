@echo off
cd /d "C:\Users\mieth\OneDrive\Dokumente\Claude\Projects\App Übersicht\master-bot"

REM Git-Locks entfernen falls vorhanden
if exist .git\HEAD.lock del /f .git\HEAD.lock
if exist .git\index.lock del /f .git\index.lock

REM Git config setzen
git config user.email "miethigmilo@gmail.com"
git config user.name "miethigmilo-art"

REM Alle Änderungen hinzufügen und pushen
git add -A
git commit -m "feat: Backtesting Engine V2 - Metriken, Walk-Forward, EMA-Backtest, Signal-Logging"
git push https://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@github.com/miethigmilo-art/master-bot.git main

echo.
echo === Fertig! ===
pause
