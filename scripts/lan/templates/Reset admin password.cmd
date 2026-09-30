@echo off & setlocal & (if not exist "%~dp0update.journal.json" if exist "%~dp0runtime.next\node.exe" if not exist "%~dp0runtime\" move "%~dp0runtime.next" "%~dp0runtime" >nul 2>nul)
if exist "%~dp0update.journal.json" (echo(& echo  An update is running or was interrupted: wait for Update Voidswarm.cmd to finish, or run Update Voidswarm.cmd again to finish it.& echo(& pause & exit /b 1) else if not exist "%~dp0app\tool.mjs" (echo(& echo  Unzip the WHOLE folder first: this file must stay in the "Voidswarm LAN" folder, next to app\ and runtime\.& echo(& pause & exit /b 1)
if not exist "%~dp0runtime\node.exe" (echo(& echo  Your antivirus may have removed runtime\node.exe. Check Bitdefender ^> Protection ^> Quarantine, then add an exception ^(START HERE.html^). Or unzip the folder again.& echo(& pause & exit /b 1)
"%~dp0runtime\node.exe" "%~dp0app\tool.mjs" admin-reset %*
set VS_RC=%errorlevel%
if %VS_RC% GEQ 1260 (echo(& echo  Windows blocked the Voidswarm engine ^(school policy^). Give FOR SCHOOL IT.txt to IT.)
echo(& pause & exit /b %VS_RC%
