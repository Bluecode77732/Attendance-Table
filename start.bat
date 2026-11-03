@echo off
rem 목적: 교사가 더블클릭만으로 출석 서버를 켜요.
rem 사용처: zip을 푼 폴더에서 실행해요. server.js가 TV 화면(브라우저)도 자동으로 열어요.
rem 근거: Node를 따로 설치하지 않도록 폴더 안의 휴대용 node.exe를 써요. 학원 PC가 32비트인지 아직 몰라서 64비트용(node\x64)과 32비트용(node\x86)을 함께 넣고 여기서 골라요. 둘 다 없을 때만 PC에 설치된 node를 써요(개발 PC용).
chcp 65001 >nul
title Attendance server - close this window to stop
cd /d "%~dp0"

rem 32비트 cmd에서 실행돼도 실제 PC 종류를 보도록 PROCESSOR_ARCHITEW6432를 먼저 본다.
set "ARCH=%PROCESSOR_ARCHITECTURE%"
if defined PROCESSOR_ARCHITEW6432 set "ARCH=%PROCESSOR_ARCHITEW6432%"

rem 64비트(AMD64)만 node\x64를 쓰고, 32비트와 ARM은 어디서나 도는 node\x86을 쓴다.
set "NODE="
if /i "%ARCH%"=="AMD64" if exist "%~dp0node\x64\node.exe" set "NODE=%~dp0node\x64\node.exe"
if not defined NODE if exist "%~dp0node\x86\node.exe" set "NODE=%~dp0node\x86\node.exe"
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

for /f "delims=" %%v in ('call "%NODE%" --version') do echo Node %%v (%ARCH%)
"%NODE%" "%~dp0server.js"

echo.
echo 출석부가 종료되었습니다. 이 창을 닫아도 됩니다.
pause
