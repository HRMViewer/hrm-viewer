@echo off
title HRM Database Viewer - loading database
cd /d "%~dp0"
if "%~1"=="" (
  echo.
  echo  Drag your database.db file onto this file to load it into the viewer.
  echo  You can also click "Load new database" inside the viewer.
  echo.
  pause
  goto :eof
)
call Start.bat --import "%~1"
