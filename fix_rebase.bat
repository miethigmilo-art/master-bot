@echo off
echo === Aborting broken rebase in master-bot ===
cd /d "C:\Users\mieth\OneDrive\Dokumente\Claude\Projects\App Übersicht\master-bot"
git rebase --abort
echo Rebase aborted.
git status
echo.
echo === Checking ml-service path ===
if exist "C:\Users\mieth\OneDrive\Dokumente\Claude\Projects\App Übersicht\ml-service" (
  echo ml-service path EXISTS
) else (
  echo ml-service path DOES NOT EXIST - checking alternatives...
  dir "C:\Users\mieth\OneDrive\Dokumente\Claude\Projects\App Übersicht\"
)
pause
