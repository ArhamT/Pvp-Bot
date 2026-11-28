@echo off
setlocal
title Mineflayer PvP Bot Launcher
cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Node.js was not found in PATH. Please install Node.js first.
    pause
    exit /b 1
)

if not exist "node_modules" (
    echo [INFO] Installing dependencies...
    call npm.cmd install
    if errorlevel 1 (
        echo [ERROR] npm install failed.
        pause
        exit /b 1
    )
)

set "PVPBOT_USERNAME="
set "PVPBOT_HOST="
set "PVPBOT_PORT="
set "PVPBOT_VERSION="
set "PVPBOT_PASSWORD="
set "PVPBOT_AUTH=offline"

echo ============================================================
echo              Mineflayer PvP Bot - Cracked Launcher
echo ============================================================
echo.
set /p "PVPBOT_USERNAME=Bot Name (Enter for config default): "
set /p "PVPBOT_HOST=Cracked Server IP (host or host:port, Enter for default): "
set /p "PVPBOT_VERSION=MC Version (e.g. 1.21.11 for Paper 26.x+ViaBackwards, 1.20.4, or auto) [auto]: "
set /p "PVPBOT_PASSWORD=Bot Login Password (for /login, Enter to skip): "

if "%PVPBOT_VERSION%"=="" set "PVPBOT_VERSION=auto"

echo.
echo ============================================================
echo  Launching bot (offline/cracked mode)...
if not "%PVPBOT_USERNAME%"=="" echo  Bot Name : %PVPBOT_USERNAME%
if not "%PVPBOT_HOST%"=="" echo  Server   : %PVPBOT_HOST%
echo  Version  : %PVPBOT_VERSION%
if not "%PVPBOT_PASSWORD%"=="" (
    echo  Password : [configured - will auto /login]
) else (
    echo  Password : [skipped - send /login manually if needed]
)
echo ------------------------------------------------------------
echo  Manual Console Commands:
echo    /server ^<name^>    Join a backend server (e.g. /server pvp)
echo    /^<anything^>       Send any Minecraft server command or chat
echo    !duel [player]    Start dueling a player (or nearest)
echo    !auto             Toggle auto-engage nearest player in arena
echo    !kit [name]       Claim kit, equip armor, sort hotbar
echo    !sort             Equip armor and sort hotbar (in arena)
echo    !stop             Stop combat and return to IDLE
echo    !players          List nearby visible players
echo    !status / !debug  Show bot status, controls, and Pkt/s
echo    !login            Manually re-send /login with password
echo    !quit             Disconnect and exit
echo ============================================================
echo.

node index.js

echo.
echo Bot process exited (code %ERRORLEVEL%).
pause
endlocal
