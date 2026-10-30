@ECHO OFF
REM Spusti nginx s konfiguraci projektu (Windows).
REM Backend (npm start) musi bezet DRIV nez OBS zacne vysilat.
cd /d "%~dp0"
if not exist logs mkdir logs
if not exist temp\hls mkdir temp\hls
nginx.exe -t || (PAUSE & EXIT /B 1)
start "nginx" nginx.exe
ECHO nginx bezi: https://localhost  (zastaveni: stop-nginx.bat)
