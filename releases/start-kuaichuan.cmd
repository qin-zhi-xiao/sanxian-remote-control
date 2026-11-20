@echo off
setlocal
set PORT=8765
set CODE=886613
set GW=https://eval-lifecycle-d7gf433u22f6c2405.api.tcloudbasegateway.com/v1/functions/kuaichuan-relay
set EXE=%~dp0kuaichuan-v1.5.0.exe
if not exist "%EXE%" set EXE=%~dp0kuaichuan.exe
if not exist "%EXE%" goto noexe
if not exist "%~dp0.cloudbase-apikey" goto nokey
start "" "%EXE%" --gw %GW% --port %PORT% --code %CODE%
set /a N=0
:wait
ping -n 2 127.0.0.1 >nul
set /a N+=1
powershell -NoProfile -Command "if((Test-NetConnection -ComputerName 127.0.0.1 -Port %PORT% -WarningAction SilentlyContinue).TcpTestSucceeded){exit 0}else{exit 1}" >nul 2>&1
if not errorlevel 1 goto ready
if %N% lss 12 goto wait
goto timeout
:ready
start "" "http://127.0.0.1:%PORT%/?t=%CODE%"
exit /b 0
:timeout
echo Timeout. Open http://127.0.0.1:%PORT%/?t=%CODE%
pause
exit /b 1
:noexe
echo kuaichuan-app.exe not found.
pause
exit /b 1
:nokey
echo .cloudbase-apikey not found. Cloud mode needs it.
pause
exit /b 1
