// 목적: 교사 PC에서 도는 출석 서버를 켜고 끄는 시작 파일입니다. TV 현황판, 출석 기기, 기록 화면이 같은 출석 데이터를 보게 합니다.
// 사용처: `node server.ts`(시작 스크립트)로 실행합니다. 실제 일은 lib/ 아래 파일들이 나눠 맡습니다.
// 근거: 출석을 서버가 들고 있어야 출석 기기의 입력이 TV와 기록에 바로 반영됩니다(DEC-01, DEC-10).
//       외부 패키지 없이 Node 기본 모듈만 쓰고(DEC-02), Node가 TS를 빌드 없이 바로 실행합니다(DEC-15). 기능별 나눔은 DEC-14.

import http from 'node:http';
import { spawn } from 'node:child_process';
import { PORT } from './lib/config.ts';
import { openStore, flush } from './lib/store.ts';
import { lanAddresses, isLocalAddress } from './lib/network.ts';
import { onRequest } from './lib/http.ts';
import { onAllPagesClosed } from './lib/teacher.ts';

// 목적: TV용 화면을 기본 브라우저로 자동으로 엽니다.
// 이유: 교사가 주소를 직접 치지 않고 시작 파일만 더블클릭하게 합니다.
// 방법: OS별 기본 열기 명령을 분리 실행합니다. 실패해도 서버는 계속 돕니다(NO_OPEN=1이면 건너뜀).
function openBrowser(url: string): void {
  if (process.env.NO_OPEN === '1') return;
  const [cmd, args] =
    process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] as const
    : process.platform === 'darwin' ? ['open', [url]] as const
    : ['xdg-open', [url]] as const;
  try {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
    child.on('error', (e) => console.warn('브라우저를 자동으로 열지 못했습니다. 주소를 직접 열어 주세요.', e.message));
    child.unref();
  } catch (e) {
    console.warn('브라우저를 자동으로 열지 못했습니다. 주소를 직접 열어 주세요.', (e as Error).message);
  }
}

openStore();

const server = http.createServer(onRequest);

// 목적: 학원 밖(사설 대역이 아닌 주소)에서 온 연결을 요청을 읽기 전에 끊습니다.
// 이유: 0.0.0.0에서 기다리므로, 공인 IP가 있는 PC라면 인터넷에서 출석 기기 입구에 닿습니다(DEC-20). 출석 기기가 연결되지 않을 때 원인을 알 수 있게 처음 한 번은 알립니다.
// 방법: connection 이벤트에서 isLocalAddress가 거짓이면 소켓을 닫습니다. 안내는 처음 끊을 때만 남깁니다.
let reportedOutside = false;
server.on('connection', (socket) => {
  if (isLocalAddress(socket.remoteAddress ?? '')) return;
  if (!reportedOutside) {
    reportedOutside = true;
    console.warn(`학원 네트워크 밖에서 온 연결을 끊었습니다(주소 ${socket.remoteAddress ?? '알 수 없음'}). 이후로는 알리지 않습니다.`);
  }
  socket.destroy();
});

server.on('error', (e: NodeJS.ErrnoException) => {
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

// 목적: 종료 신호(Ctrl+C, 검은 창 닫기)를 받거나 교사 화면이 모두 닫히면(DEC-16) 쓰던 저장을 마치고 끕니다.
// 이유: 마지막 출석 체크가 파일에 쓰이기 전에 프로세스가 죽으면 그 기록을 잃습니다. Windows에서 검은 창을 닫으면 SIGHUP이 오고, 받는 곳이 없으면 저장 큐를 기다리지 않고 바로 끝납니다(2026-11-09 재현).
// 방법: 새 연결을 닫고, 진행 중인 저장 큐가 비면 종료합니다. 창을 닫은 경우 Windows는 10초쯤 뒤 프로세스를 강제로 끝내므로 그 안에 마칩니다.
function shutdown(): void {
  server.close();
  flush().finally(() => process.exit(0));
}
process.on('SIGINT', shutdown);
onAllPagesClosed(() => {
  console.log('교사 화면이 모두 닫혀 출석부를 끕니다.');
  shutdown();
});
process.on('SIGTERM', shutdown);
process.on('SIGHUP', shutdown);
