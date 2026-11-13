@echo off
rem Run the server in the background every time you log in to Windows,
rem so cloud images and weather data keep being collected.
rem   autostart.cmd on      add a shortcut to your Startup folder
rem   autostart.cmd off     remove it
rem   autostart.cmd         show whether it is on
rem The computer must stay awake: nothing is collected while it sleeps.
setlocal
set "LNK=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\SatelliteTracker.lnk"
set "DIR=%~dp0"
if "%DIR:~-1%"=="\" set "DIR=%DIR:~0,-1%"

if /i "%~1"=="on" goto on
if /i "%~1"=="off" goto off
if exist "%LNK%" (echo Autostart is ON: %LNK%) else (echo Autostart is OFF. Run "autostart.cmd on" to turn it on.)
goto end

:on
powershell -NoProfile -Command "$s = (New-Object -ComObject WScript.Shell).CreateShortcut($env:LNK); $s.TargetPath = \"$env:SystemRoot\System32\wscript.exe\"; $s.Arguments = '\"' + $env:DIR + '\start.vbs\" /background'; $s.WorkingDirectory = $env:DIR; $s.Description = 'Satellite tracker server (collects cloud and weather data)'; $s.Save()"
if exist "%LNK%" (echo Autostart is ON. The server will start in the background when you log in.) else (echo Failed to create %LNK%)
goto end

:off
if exist "%LNK%" del "%LNK%"
echo Autostart is OFF.

:end
endlocal
