@echo off & setlocal & (if not exist "%~dp0update.journal.json" if exist "%~dp0runtime.next\node.exe" if not exist "%~dp0runtime\" move "%~dp0runtime.next" "%~dp0runtime" >nul 2>nul)
if exist "%~dp0update.journal.json" (echo(& echo  An update is running or was interrupted: wait for Update Voidswarm.cmd to finish, or run Update Voidswarm.cmd again to finish it.& echo(& pause & exit /b 1) else if not exist "%~dp0app\launch.mjs" (echo(& echo  Unzip the WHOLE folder first: this file must stay in the "Voidswarm LAN" folder, next to app\ and runtime\. Right-click the zip, choose Extract All, then start Voidswarm from the extracted folder.& echo(& pause & exit /b 1)
if not exist "%~dp0runtime\node.exe" (echo(& echo  Your antivirus may have removed runtime\node.exe. Check Bitdefender ^> Protection ^> Quarantine, then add an exception ^(START HERE.html^). Or unzip the folder again.& echo(& pause & exit /b 1)
if "%~1"=="--child" ("%~dp0runtime\node.exe" "%~dp0app\launch.mjs" %* & exit /b)
if not defined VOIDSWARM_STUB_MIN if exist "%~dp0data\voidswarm.config.json" (set VOIDSWARM_STUB_MIN=1& start "Voidswarm LAN Host" /min "%ComSpec%" /d /c call "%~f0" %* & exit /b 0)
call <nul "%~f0" --child %*
set VS_RC=%errorlevel%
(if not "%VS_RC%"=="0" ((if %VS_RC% GEQ 1260 (echo(& echo  Windows blocked the Voidswarm engine ^(school policy^). Give FOR SCHOOL IT.txt to IT.) else (echo(& echo  Voidswarm stopped with an error ^(code %VS_RC%^). The details are above and in data\logs.))& echo(& pause))& if defined VOIDSWARM_STUB_MIN (exit %VS_RC%) else exit /b %VS_RC%
