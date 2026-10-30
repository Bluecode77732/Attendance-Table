@echo off
rem 목적: 교사가 더블클릭만으로 출석 서버를 켠다.
rem 사용처: zip을 푼 폴더에서 실행한다. server.js가 TV 화면(브라우저)도 자동으로 연다.
rem 근거: Node를 따로 설치하지 않아도 되도록 폴더 안의 node\node.exe를 우선 쓰고, 없을 때만 PC에 설치된 node를 쓴다.
chcp 65001 >nul
title Attendance server - close this window to stop
cd /d "%~dp0"

set "NODE="
if exist "%~dp0node\node.exe" set "NODE=%~dp0node\node.exe"
if not defined NODE (
  where node >nul 2>nul
  if not errorlevel 1 set "NODE=node"
)
if not defined NODE (
  echo.
  echo [오류] node 실행 파일을 찾지 못했습니다.
  echo zip 안의 'node' 폴더가 함께 풀렸는지 확인해 주세요.
  echo.
  pause
  exit /b 1
)

"%NODE%" "%~dp0server.js"

echo.
echo 출석부가 종료되었습니다. 이 창을 닫아도 됩니다.
pause
