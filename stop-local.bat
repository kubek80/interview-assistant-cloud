@echo off
cd /d "%~dp0"
echo  Stopping Interview Assistant (your data is kept)...
docker compose down
echo.
echo  Stopped. To delete the local data as well, run:  docker compose down -v
echo.
pause
