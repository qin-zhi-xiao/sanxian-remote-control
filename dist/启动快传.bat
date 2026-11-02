@echo off
chcp 65001 >nul
title 快传 - 电脑控制端
echo 正在启动快传控制端（局域网模式）...
"%~dp0kuaichuan.exe" --lan %*
pause
