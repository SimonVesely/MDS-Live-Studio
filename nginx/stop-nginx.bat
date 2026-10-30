@ECHO OFF
cd /d "%~dp0"
ECHO Stopping Nginx server....
nginx.exe -s stop
