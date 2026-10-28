@echo off
rem cctunnel for Windows: runs cctunnel-win.ps1 from this folder.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0cctunnel-win.ps1" %*
