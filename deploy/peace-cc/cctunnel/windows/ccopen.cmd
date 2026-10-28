@echo off
rem ccopen for Windows: cctunnel open.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0cctunnel-win.ps1" open %*
