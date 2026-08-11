@echo off
title Tramarsa LMS - Servidor Local

cd /d "%~dp0"

echo ==========================================
echo    Iniciando Tramarsa LMS en localhost...
echo ==========================================
echo.

start "" http://localhost:8000/index.html

python -m http.server 8000

pause