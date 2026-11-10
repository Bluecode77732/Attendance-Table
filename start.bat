@echo off
rem 목적: 교사가 더블클릭만으로 출석 서버를 켭니다. 처음 켤 때 바탕 화면에 '출석부' 바로 가기를 만들고, 출석부가 정상으로 꺼지면 창도 닫습니다.
rem 사용처: zip을 푼 폴더에서 실행합니다. server.ts가 TV 화면(브라우저)도 자동으로 엽니다.
rem 근거: Node를 따로 설치하지 않도록 폴더 안의 휴대용 node.exe를 씁니다. 학원 PC가 32비트인지 아직 몰라서 64비트용(node\x64)과 32비트용(node\x86)을 함께 넣고 여기서 고릅니다. 둘 다 없을 때만 PC에 설치된 node를 씁니다(개발 PC용).
chcp 65001 >nul
title Attendance server - close this window to stop
cd /d "%~dp0"

rem 32비트 cmd에서 실행돼도 실제 PC 종류를 보도록 PROCESSOR_ARCHITEW6432를 먼저 봅니다.
set "ARCH=%PROCESSOR_ARCHITECTURE%"
if defined PROCESSOR_ARCHITEW6432 set "ARCH=%PROCESSOR_ARCHITEW6432%"

rem 64비트(AMD64)만 node\x64를 쓰고, 32비트와 ARM은 어디서나 도는 node\x86을 씁니다.
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

rem 바탕 화면에 '출석부' 바로 가기를 둡니다. 없거나 다른 폴더를 가리키면 새로 만들고, zip 안에서 바로 실행해 임시 폴더에서 돌 때는 만들지 않습니다.
rem 시작 프로그램 폴더에 교사가 넣어 둔 '출석부'가 있으면, 새 폴더로 옮긴 뒤에도 이 폴더를 가리키게 맞춥니다. 없으면 만들지 않습니다(ROADMAP §1).
set "SHORTCUT_NAME=출석부"
set "SHORTCUT_TARGET=%~f0"
powershell -NoProfile -ExecutionPolicy Bypass -Command "$t = $env:SHORTCUT_TARGET; if ($t -like '*\AppData\Local\Temp\*' -or $t -like ($env:TEMP + '\*')) { exit 0 }; $w = New-Object -ComObject WScript.Shell; $a = Join-Path ([Environment]::GetFolderPath('Startup')) ($env:SHORTCUT_NAME + '.lnk'); if ((Test-Path -LiteralPath $a) -and ($w.CreateShortcut($a).TargetPath -ne $t)) { $s = $w.CreateShortcut($a); $s.TargetPath = $t; $s.WorkingDirectory = (Split-Path $t); $s.Save() }; $l = Join-Path ([Environment]::GetFolderPath('Desktop')) ($env:SHORTCUT_NAME + '.lnk'); if ((Test-Path -LiteralPath $l) -and ($w.CreateShortcut($l).TargetPath -eq $t)) { exit 0 }; $s = $w.CreateShortcut($l); $s.TargetPath = $t; $s.WorkingDirectory = (Split-Path $t); $s.Save(); exit 10" >nul 2>nul
if errorlevel 10 echo 바탕 화면에 '출석부' 바로 가기를 만들었어요. 다음부터는 그것을 더블클릭해 주세요.

for /f "delims=" %%v in ('call "%NODE%" --version') do echo Node %%v (%ARCH%)

rem 이 창에서만 빠른 편집을 끕니다. 켜져 있으면 창을 클릭했을 때 '선택' 상태가 되어 출석부가 멈춥니다(ROADMAP §3).
rem cmd는 프로그램 하나가 끝날 때마다 창 설정을 되돌리므로, 같은 창에서 따로 띄워 출석부(node)가 창에 붙은 뒤에 끕니다. 출석부가 끝나면 cmd가 다시 켭니다.
start "" /b powershell -NoProfile -ExecutionPolicy Bypass -Command "$k = Add-Type -Name QuickEdit -Namespace AttendanceTable -PassThru -MemberDefinition '[DllImport(\"kernel32.dll\")] public static extern System.IntPtr GetStdHandle(int n); [DllImport(\"kernel32.dll\")] public static extern bool GetConsoleMode(System.IntPtr h, out uint m); [DllImport(\"kernel32.dll\")] public static extern bool SetConsoleMode(System.IntPtr h, uint m); [DllImport(\"kernel32.dll\")] public static extern uint GetConsoleProcessList(uint[] l, uint n);'; $l = New-Object 'uint32[]' 16; for ($i = 0; $i -lt 60 -and $k::GetConsoleProcessList($l, 16) -lt 3; $i++) { Start-Sleep -Milliseconds 500 }; $h = $k::GetStdHandle(-10); $m = [uint32]0; if ($i -lt 60 -and $k::GetConsoleMode($h, [ref]$m)) { [void]$k::SetConsoleMode($h, ($m -band 0xFFFFFFBF) -bor 0x80) }" >nul 2>nul
"%NODE%" "%~dp0server.ts"

rem 정상 종료(교사 화면을 모두 닫음, Ctrl+C)면 창도 닫습니다. 시작하지 못했거나 오류로 멈췄으면 안내를 읽을 수 있게 창을 남깁니다(DEC-16).
if errorlevel 1 (
  echo.
  echo 출석부를 시작하지 못했거나 오류로 멈췄습니다. 위 안내를 확인한 뒤 이 창을 닫아 주세요.
  pause
  exit /b 1
)
exit /b 0
