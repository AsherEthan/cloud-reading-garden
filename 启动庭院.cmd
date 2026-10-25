@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
title 云间共读 - 本地庭院
where node >nul 2>&1
if errorlevel 1 (
  echo 请先安装 Node.js 24 或更新版本，然后重新双击本文件。
  pause
  exit /b 1
)
if not exist "node_modules\express" (
  echo 正在安装项目依赖……
  call npm install
  if errorlevel 1 goto failed
)
echo 正在检查并构建网页……
call npm run build
if errorlevel 1 goto failed
echo.
echo 请用浏览器打开 http://127.0.0.1:4317
echo 第一次使用时，下面会显示建站码。请在网页自行设置管理员。
echo 此窗口保持打开即提供服务；按 Ctrl+C 可以停止。不会发布到公网。
echo.
node server/index.mjs
if errorlevel 1 goto failed
exit /b 0
:failed
echo.
echo 启动未完成。请保留上面的错误信息，检查 README.md 或联系维护者。
pause
exit /b 1
