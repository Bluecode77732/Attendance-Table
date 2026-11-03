// 목적: 시험마다 격리된 출석 서버를 띄우고, 교사·출석 기기 요청을 보내는 공통 도구입니다.
// 사용처: tests/*.test.js가 불러 씁니다. `node --test "tests/*.test.js"`로 실행합니다.
// 근거: 실제 data.json을 건드리지 않도록 임시 폴더와 빈 포트로 서버를 띄워야 하고, 이 준비가 모든 시험에서 같아서 한곳에 모았습니다.

'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

// 목적: 비어 있는 TCP 포트 번호를 하나 얻습니다.
// 이유: 8080은 실제 출석부가 쓰고 있을 수 있고, 시험 파일끼리 포트가 겹치면 안 됩니다.
// 방법: 0번으로 잠깐 열어 운영체제가 준 포트를 읽고 바로 닫습니다.
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

// 목적: 시험용 임시 폴더를 만듭니다.
// 이유: 시험 데이터와 백업이 저장소 폴더에 생기면 안 됩니다.
// 방법: 운영체제 임시 폴더 아래에 attendance-test- 로 시작하는 새 폴더를 만듭니다.
function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'attendance-test-'));
}

// 목적: 임시 폴더를 지웁니다.
// 이유: 시험이 끝나면 가짜 이름이 든 데이터도 남기지 않습니다.
// 방법: 폴더째 지우고, 이미 없으면 넘어갑니다.
function removeDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

// 목적: 시험용 시계를 "오늘부터 dayOffset일 뒤 hh:mm"으로 옮깁니다.
// 이유: 10분 반복 구간과 자정 넘김을 기다리지 않고 시험합니다.
// 방법: 목표 시각과 지금의 차이를 clockFile에 쓰고, fake-clock.js가 다시 읽을 때까지 잠깐 기다립니다. 그날 날짜(YYYY-MM-DD)를 돌려줍니다.
async function setClock(clockFile, dayOffset, hh, mm) {
  const target = new Date();
  target.setDate(target.getDate() + dayOffset);
  target.setHours(hh, mm, 0, 0);
  fs.writeFileSync(clockFile, String(target.getTime() - Date.now()));
  await new Promise((resolve) => setTimeout(resolve, 150));
  return `${target.getFullYear()}-${String(target.getMonth() + 1).padStart(2, '0')}-${String(target.getDate()).padStart(2, '0')}`;
}

// 목적: 격리된 출석 서버를 띄우고, 켜질 때까지 기다립니다.
// 이유: 모든 시험이 같은 방식으로 서버를 띄워야 실제 데이터와 포트를 건드리지 않습니다.
// 방법: 빈 포트, 임시 data.json, NO_OPEN=1로 server.js를 띄웁니다. clockFile을 주면 fake-clock.js를 먼저 부릅니다. "켜졌어요"가 출력되면 준비된 것입니다.
async function startServer({ dataFile, clockFile } = {}) {
  const dir = dataFile ? path.dirname(dataFile) : makeTempDir();
  const file = dataFile ?? path.join(dir, 'data.json');
  const port = await freePort();
  const args = clockFile ? ['--require', path.join(__dirname, 'fake-clock.js')] : [];
  args.push(path.join(ROOT, 'server.js'));
  const child = spawn(process.execPath, args, {
    env: { ...process.env, PORT: String(port), NO_OPEN: '1', DATA_FILE: file, HOST_IP: '', FAKE_CLOCK_FILE: clockFile ?? '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`서버가 켜지지 않았어요: ${log}`)), 10_000);
    const onData = (chunk) => {
      log += chunk;
      if (log.includes('켜졌어요')) {
        clearTimeout(timer);
        resolve();
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`서버가 종료됐어요(${code}): ${log}`));
    });
  });
  child.removeAllListeners('exit');
  return { port, dir, dataFile: file, log: () => log, stop: () => stopProcess(child) };
}

// 목적: 띄운 서버를 끄고 완전히 내려갈 때까지 기다립니다.
// 이유: 다음 시험이 같은 데이터 파일로 서버를 다시 띄울 때 앞 서버가 남아 있으면 안 됩니다.
// 방법: 이미 끝났으면 바로 돌려주고, 아니면 kill 후 exit를 기다립니다.
function stopProcess(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    child.once('exit', () => resolve());
    child.kill();
  });
}

// 목적: 서버에 HTTP 요청 하나를 보내고 상태, JSON, Set-Cookie를 돌려받습니다.
// 이유: Host 헤더나 접속 주소를 바꿔 교사 관문을 시험해야 해서 fetch 대신 http를 씁니다.
// 방법: body가 있으면 POST(기본 JSON), 없으면 GET. host는 접속할 주소, hostHeader는 보낼 Host 값입니다.
function request(port, { method, pathName, body, cookie, host = '127.0.0.1', hostHeader, contentType = 'application/json' }) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : typeof body === 'string' ? body : JSON.stringify(body);
    const headers = { Host: hostHeader ?? `localhost:${port}` };
    if (payload !== null) {
      headers['Content-Type'] = contentType;
      headers['Content-Length'] = Buffer.byteLength(payload);
    }
    if (cookie) headers.Cookie = cookie;
    const req = http.request({ host, port, method: method ?? (payload === null ? 'GET' : 'POST'), path: pathName, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try {
          json = JSON.parse(text);
        } catch {
          // HTML이나 일반 글자 응답입니다
        }
        const set = res.headers['set-cookie'];
        resolve({ status: res.statusCode, json, text, cookie: set ? set[0].split(';')[0] : null, setCookie: set ? set[0] : null });
      });
    });
    req.on('error', reject);
    if (payload !== null) req.write(payload);
    req.end();
  });
}

// 목적: 교사 PC와 출석 기기 역할의 요청 함수를 묶어 돌려줍니다.
// 이유: 시험 코드가 매번 포트와 Host를 넘기지 않게 합니다.
// 방법: teacher는 localhost Host로, kiosk는 LAN 주소처럼 보이는 Host와 기기 쿠키로 보냅니다.
function clients(port) {
  return {
    teacher: (pathName, body) => request(port, { pathName, body }),
    kiosk: (pathName, body, cookie) => request(port, { pathName, body, cookie, hostHeader: `192.168.0.10:${port}` }),
    raw: (options) => request(port, options),
  };
}

// 목적: 이 PC의 LAN IPv4 주소 하나를 찾습니다.
// 이유: 교사 관문이 LAN에서 온 요청을 막는지 시험하려면 루프백이 아닌 주소로 접속해야 합니다.
// 방법: 내부용이 아닌 첫 IPv4 주소. 없으면 null이라 그 시험은 건너뜁니다.
function lanAddress() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const info of list ?? []) {
      if (info.family === 'IPv4' && !info.internal) return info.address;
    }
  }
  return null;
}

// 목적: 출석 기기 하나를 등록하고 그 쿠키를 돌려줍니다.
// 이유: 출석 시험마다 등록 절차가 먼저 필요합니다.
// 방법: 교사로 등록 코드를 열고, 출석 기기로 그 코드를 보내 받은 kid 쿠키를 돌려줍니다.
async function pairDevice(api) {
  const code = (await api.teacher('/api/devices/pair', {})).json.pairing.code;
  return (await api.kiosk('/api/kiosk/pair', { code })).cookie;
}

module.exports = { ROOT, makeTempDir, removeDir, setClock, startServer, request, clients, lanAddress, pairDevice };
