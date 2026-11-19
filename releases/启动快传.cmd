@echo off
chcp 65001 >nul
title 快传 · 电脑控制端
cd /d "%~dp0"

if not exist "kuaichuan.exe" (
  echo [缺少文件] kuaichuan.exe 不在当前目录，请下载完整 zip 包。
  pause
  exit /b 1
)
if not exist ".cloudbase-apikey" (
  echo [缺少文件] .cloudbase-apikey 不在当前目录，请下载完整 zip 包。
  pause
  exit /b 1
)

rem 每次运行顺手创建/刷新桌面快捷方式（覆盖写，无副作用）
powershell -NoProfile -Command "$w=New-Object -ComObject WScript.Shell; $s=$w.CreateShortcut([Environment]::GetFolderPath('Desktop')+'\快传.lnk'); $s.TargetPath='%~dp0kuaichuan.exe'; $s.WorkingDirectory='%~dp0'; $s.Save()" >nul 2>&1

echo ==============================================
echo   快传已启动，三步上手：
echo   1. 程序窗口会显示 6 位配对码（首次随机生成）
echo   2. 手机打开「快传」小程序，输入配对码即可连接
echo   3. 关闭本窗口即退出
echo ==============================================
"%~dp0kuaichuan.exe"
pause
