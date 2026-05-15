@echo off
cd /d "C:\Users\mieth\OneDrive\Dokumente\Claude\Projects\App Übersicht\master-bot"
if exist .git\HEAD.lock del /f .git\HEAD.lock
if exist .git\index.lock del /f .git\index.lock
git config user.email "miethigmilo@gmail.com"
git config user.name "miethigmilo-art"
git add -A
git commit -m "chore: update master-bot"
git push https://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@github.com/miethigmilo-art/master-bot.git main

echo.
echo === master-bot gepusht ===

cd /d "C:\Users\mieth\OneDrive\Dokumente\Claude\Projects\App Übersicht\ml-service"
if exist .git\HEAD.lock del /f .git\HEAD.lock
if exist .git\index.lock del /f .git\index.lock
git config user.email "miethigmilo@gmail.com"
git config user.name "miethigmilo-art"
git pull --rebase https://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@github.com/miethigmilo-art/ml-service.git main
git add -A
git commit -m "chore: update ml-service"
git push https://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@github.com/miethigmilo-art/ml-service.git main

echo.
echo === ml-service gepusht ===
pause
