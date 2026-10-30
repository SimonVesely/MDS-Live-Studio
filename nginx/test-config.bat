@ECHO OFF
cd /d "%~dp0"
ECHO Testing the config
nginx.exe -t
PAUSE
