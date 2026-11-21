@echo off
title HRM Database Viewer
cd /d "%~dp0"
call :findpython
if not defined PY goto nopython
%PY% app.py %*
if errorlevel 1 pause
goto :eof

:findpython
set "PY="
py -3 --version >nul 2>nul && set "PY=py -3" && goto :eof
python --version >nul 2>nul && set "PY=python" && goto :eof
goto :eof

:nopython
echo.
echo  Python isn't installed on this computer yet.
echo.
echo  1. Your browser will open the Python download page.
echo  2. Download and run the installer. On its first screen, tick
echo     "Add python.exe to PATH", then click Install Now.
echo  3. Double-click Start.bat again.
echo.
start "" https://www.python.org/downloads/windows/
pause
