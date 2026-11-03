// 목적: 교사 PC에서 도는 출석 서버를 켜고 끄는 시작 파일이에요. TV 현황판, 출석 기기, 기록 화면이 같은 출석 데이터를 보게 해요.
// 사용처: `node server.js`(시작 스크립트)로 실행해요. 실제 일은 lib/ 아래 파일들이 나눠 맡아요.
// 근거: 출석을 서버가 들고 있어야 출석 기기의 입력이 TV와 기록에 바로 반영돼요(DEC-01, DEC-10).
//       설치 부담을 줄이려 외부 패키지 없이 Node 기본 모듈만 써요(DEC-02). 기능별 나눔은 DEC-14.

'use strict';

const http = require('node:http');
const { spawn } = require('node:child_process');
const { PORT } = require('./lib/config');
const { openStore, flush } = require('./lib/store');
const { lanAddresses } = require('./lib/network');
const { onRequest } = require('./lib/http');

// 목적: TV용 화면을 기본 브라우저로 자동으로 연다.
// 이유: 교사가 주소를 직접 치지 않고 시작 파일만 더블클릭하게 한다.
// 방법: OS별 기본 열기 명령을 분리 실행한다. 실패해도 서버는 계속 돈다(NO_OPEN=1이면 건너뜀).
function openBrowser(url) {
  if (process.env.NO_OPEN === '1') return;
  const [cmd, args] =
    process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
    : process.platform === 'darwin' ? ['open', [url]]
    : ['xdg-open', [url]];
  try {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
    child.on('error', (e) => console.warn('브라우저를 자동으로 열지 못했습니다. 주소를 직접 열어 주세요.', e.message));
    child.unref();
  } catch (e) {
    console.warn('브라우저를 자동으로 열지 못했습니다. 주소를 직접 열어 주세요.', e.message);
  }
}

openStore();

const server = http.createServer(onRequest);

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`포트 ${PORT}을(를) 이미 쓰고 있습니다. 출석부가 이미 켜져 있는지 확인해 주세요.`);
  } else {
    console.error('서버를 시작하지 못했습니다.', e.message);
  }
  process.exit(1);
});

server.listen(PORT, '0.0.0.0', () => {
  const addresses = lanAddresses();
  console.log('출석부 서버가 켜졌어요.');
  console.log(`  교사 화면(TV): http://localhost:${PORT}`);
  console.log(`  출석 기기 주소: ${addresses.length > 0 ? addresses.map((a) => `http://${a}:${PORT}/k`).join(', ') : '(같은 네트워크 주소를 찾지 못했습니다)'}`);
  console.log('  끄려면 이 창을 닫거나 Ctrl+C를 누르세요.');
  openBrowser(`http://localhost:${PORT}`);
});

// 목적: 종료 신호를 받으면 쓰던 저장을 마치고 꺼요.
// 이유: 마지막 출석 체크가 파일에 쓰이기 전에 프로세스가 죽으면 그 기록을 잃어요.
// 방법: 새 연결을 닫고, 진행 중인 저장 큐가 비면 종료해요.
function shutdown() {
  server.close();
  flush().finally(() => process.exit(0));
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
