@echo off
setlocal
set "ELECTRON_RUN_AS_NODE=1"
"%~dp0..\..\Folio.exe" "%~dp0..\cli\folio.cjs" %*
exit /b %errorlevel%
