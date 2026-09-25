@echo off
setlocal
set "RESOURCE_DIR=%~dp0.."
"%RESOURCE_DIR%\runtime\node.exe" "%RESOURCE_DIR%\app\dist\cli.js" %*
exit /b %errorlevel%
