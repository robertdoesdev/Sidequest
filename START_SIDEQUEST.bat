@echo off
setlocal
cd /d "%~dp0"
echo.
echo  SIDEQUEST
 echo Starting the real local app + backend...
echo.
if not exist node_modules call npm install
node server.mjs
pause
