@echo off
setlocal
cd /d "%~dp0"
echo.
echo  SIDEQUEST
 echo Starting the real local app + backend...
echo.
node server.mjs
pause
