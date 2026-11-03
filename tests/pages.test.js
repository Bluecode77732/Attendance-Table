// 목적: 세 화면(현황판, 출석 기기, 기록)이 실제 브라우저에서 동작하는지 고정해 두는 시험이에요.
// 사용처: `node --test "tests/*.test.js"`로 실행해요. Chrome이나 Edge가 없는 PC에서는 건너뛰어요. 가짜 이름만 써요.
// 근거: 화면 스크립트를 파일로 나눌 때 붙여넣기 해석, 기기 등록, 출석 결과 화면이 그대로인지 확인해야 해요. 일회용으로 쓰던 시험을 옮겨 왔어요.

'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { startServer, clients, removeDir, makeTempDir } = require('./helpers');

const BROWSERS = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);
const BROWSER = BROWSERS.find((p) => fs.existsSync(p));

// 목적: 잠깐 기다려요.
// 이유: 화면은 요청을 보내고 결과를 그리는 데 시간이 걸려요.
// 방법: setTimeout을 Promise로 감싸요.
function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 목적: 비어 있는 포트를 하나 얻어요.
// 이유: 브라우저 원격 제어(DevTools) 포트가 다른 프로그램과 겹치면 안 돼요.
// 방법: 0번으로 잠깐 열어 받은 포트를 닫고 돌려줘요.
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

// 목적: 헤드리스 브라우저를 띄우고 DevTools 포트가 열릴 때까지 기다려요.
// 이유: npm 패키지 없이 화면을 시험하려고 브라우저를 직접 원격 제어해요(DEC-02).
// 방법: 임시 프로필로 --headless=new를 띄우고 /json/version이 답할 때까지 확인해요.
async function startBrowser(profileDir) {
  const port = await freePort();
  const child = spawn(BROWSER, [
    '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profileDir}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu', 'about:blank',
  ], { stdio: 'ignore' });
  for (let i = 0; i < 50; i++) {
    try {
      await fetch(`http://127.0.0.1:${port}/json/version`);
      return { port, child };
    } catch {
      await wait(200);
    }
  }
  child.kill();
  throw new Error('브라우저가 켜지지 않았어요');
}

// 목적: 새 탭을 열어 주소로 이동하고, 그 탭에서 스크립트를 실행하는 도구를 돌려줘요.
// 이유: 시험이 화면 안의 버튼을 누르고 글자를 읽어야 해요.
// 방법: DevTools 프로토콜로 탭을 만들고 WebSocket으로 명령을 보내요. 페이지 예외는 errors에 모으고, confirm 창은 자동으로 확인해요.
async function openTab(cdpPort, url, { width, height, mobile }, errors) {
  const target = await (await fetch(`http://127.0.0.1:${cdpPort}/json/new?about:blank`, { method: 'PUT' })).json();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve) => ws.addEventListener('open', resolve, { once: true }));
  let id = 0;
  const pending = new Map();
  const send = (method, params = {}) => new Promise((resolve) => {
    id += 1;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
    if (msg.method === 'Runtime.exceptionThrown') errors.push(`${url}: ${msg.params.exceptionDetails.exception?.description}`);
    // CSP가 막은 스크립트·스타일은 예외가 아니라 콘솔 오류로만 나온다. 네트워크 오류(favicon 404, 일부러 낸 400)는 뺀다.
    if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error' && msg.params.entry.source !== 'network') {
      errors.push(`${url}: ${msg.params.entry.text}`);
    }
    if (msg.method === 'Page.javascriptDialogOpening') send('Page.handleJavaScriptDialog', { accept: true });
  });
  await send('Runtime.enable');
  await send('Log.enable');
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile });
  if (mobile) await send('Emulation.setTouchEmulationEnabled', { enabled: true });
  const go = async (to) => {
    await send('Page.navigate', { url: to });
    await wait(1500);
  };
  await go(url);
  const evaluate = async (expression) => {
    const res = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (res.result.exceptionDetails) throw new Error(`${expression}: ${res.result.exceptionDetails.exception?.description}`);
    return res.result.result.value;
  };
  return { evaluate, go, close: () => ws.close() };
}

describe('화면', { skip: BROWSER ? false : 'Chrome이나 Edge가 없어요' }, () => {
  let server;
  let api;
  let browser;
  let profileDir;
  let board;
  let kiosk;
  const errors = [];

  before(async () => {
    server = await startServer();
    api = clients(server.port);
    profileDir = makeTempDir();
    browser = await startBrowser(profileDir);
    board = await openTab(browser.port, `http://localhost:${server.port}/`, { width: 1920, height: 1080, mobile: false }, errors);
  });

  after(async () => {
    board?.close();
    kiosk?.close();
    if (browser) {
      browser.child.kill();
      await wait(500);
    }
    await server.stop();
    removeDir(server.dir);
    try {
      removeDir(profileDir);
    } catch {
      // 브라우저가 프로필 파일을 늦게 놓을 때가 있다. 임시 폴더라 남아도 해가 없다.
    }
  });

  // 목적: 현황판의 붙여넣기 창에 글자를 넣고 미리보기 결과를 읽어요.
  // 이유: 붙여넣기 시험 여러 개가 같은 순서를 써요.
  // 방법: 창을 열고 입력칸에 값을 넣은 뒤 input 이벤트와 미리보기 버튼을 눌러요.
  const paste = async (text) => {
    await board.evaluate(`document.getElementById('open-paste').click(); document.getElementById('paste-box').value = ${JSON.stringify(text)}; document.getElementById('paste-box').dispatchEvent(new Event('input')); document.getElementById('paste-check').click()`);
    await wait(600);
    return board.evaluate(`document.getElementById('paste-preview').textContent`);
  };

  it('빈 명단에서도 학생 추가 칸을 그려요', async () => {
    assert.equal(await board.evaluate(`document.querySelectorAll('.cell.add').length`), 1);
  });

  it('엑셀 형식(CRLF, 줄 번호 칸)을 읽어 휴대폰 칸을 골라요', async () => {
    const text = await paste('번호\t이름\t학교\t학년\t휴대폰 번호\t반\r\n1\t사아자\t가학교\t3\t010-5555-6666\t3시 타임\r\n2\t차카타\t가학교\t4\t01077778888\t7시 타임\r\n');
    assert.match(text, /가져올 칸: 이름, 번호, 반/);
    assert.match(text, /추가할 학생 2명/);
    assert.doesNotMatch(text, /읽지 못한/);
    await board.evaluate(`document.getElementById('paste-apply').click()`);
    await wait(800);
    const sa = (await api.teacher('/api/state')).json.students.find((s) => s.name === '사아자');
    assert.equal(sa.phone, '01055556666');
    assert.equal(await board.evaluate(`document.getElementById('paste-dialog').open`), false);
  });

  it('구글 스프레드시트 형식(LF)과 줄바꿈이 든 따옴표 칸을 읽어요', async () => {
    assert.match(await paste('이름\t휴대폰\t타임\n파하가\t01099990000\t3시 타임\n'), /추가할 학생 1명/);
    await board.evaluate(`document.getElementById('paste-dialog').close()`);
    const quoted = await paste('이름\t타임\n"하나\n둘"\t3시 타임\n');
    assert.match(quoted, /추가할 학생 1명/);
    assert.match(quoted, /하나 둘/);
    assert.doesNotMatch(quoted, /"/);
    await board.evaluate(`document.getElementById('paste-dialog').close()`);
  });

  it('현황판이 학생 칸, 번호 없음 표시, 반 선택을 그려요', async () => {
    await board.go(`http://localhost:${server.port}/`);
    assert.equal(await board.evaluate(`document.querySelectorAll('.cell[data-id]').length`), 2);
    assert.equal(await board.evaluate(`[...document.getElementById('class-filter').options].map((o) => o.text).join('|')`), '전체|3시 타임|7시 타임');
    await board.evaluate(`document.querySelector('.cell[data-id] .toggle').click()`);
    await wait(500);
    assert.match(await board.evaluate(`document.querySelector('.cell[data-id] .status').textContent`), /^등원 \d\d:\d\d$/);
  });

  it('출석 기기 창이 등록 코드와 QR을 보여 주고, 기기 화면에서 등록돼요', async () => {
    await board.evaluate(`document.getElementById('open-devices').click(); document.getElementById('pair-start').click()`);
    await wait(500);
    const code = await board.evaluate(`document.getElementById('pair-code').textContent`);
    assert.match(code, /^\d{6}$/);
    assert.ok(await board.evaluate(`Boolean(document.querySelector('#device-qr svg'))`));

    kiosk = await openTab(browser.port, `http://127.0.0.1:${server.port}/k`, { width: 412, height: 915, mobile: true }, errors);
    assert.equal(await kiosk.evaluate(`document.getElementById('entry-title').textContent`), '출석 기기 등록');
    await kiosk.evaluate(`${JSON.stringify(code)}.split('').forEach((d) => document.querySelector('.key[data-key="' + d + '"]').click())`);
    await wait(600);
    assert.match(await kiosk.evaluate(`document.getElementById('entry-message').textContent`), /등록됐어요/);
    await kiosk.go(`http://127.0.0.1:${server.port}/k`);
    assert.equal(await kiosk.evaluate(`document.getElementById('entry-title').textContent`), '출석', '새로고침해도 등록이 남아요');
    assert.ok(await kiosk.evaluate(`document.documentElement.scrollHeight <= innerHeight`), '폰 화면에서 스크롤이 없어요');

    await wait(2500);
    assert.equal(await board.evaluate(`document.getElementById('pair-code').textContent`), '');
    assert.equal(await board.evaluate(`document.querySelectorAll('#device-list li').length`), 1);
    await board.evaluate(`document.getElementById('devices-dialog').close()`);
  });

  it('출석 기기에서 출석하면 결과를 보여 주고 현황판에 나타나요', async () => {
    // 목적: 출석 기기 화면에서 숫자 키를 차례로 눌러요.
    // 이유: 학생이 키패드를 누르는 것과 같은 경로로 시험해요.
    // 방법: 숫자마다 data-key가 같은 버튼을 클릭해요.
    const press = (digits) => kiosk.evaluate(`'${digits}'.split('').forEach((d) => document.querySelector('.key[data-key="' + d + '"]').click())`);
    // 사아자는 앞 시험에서 현황판으로 등원시켰으니 10분 반복에 걸린다. 아직 오지 않은 차카타로 시험한다.
    await press('8888');
    await wait(600);
    assert.equal(await kiosk.evaluate(`document.getElementById('result-big').textContent`), '차카타님 등원했어요');
    await kiosk.evaluate(`document.getElementById('result').click()`);
    await press('0000');
    await wait(600);
    assert.equal(await kiosk.evaluate(`document.getElementById('result-big').textContent`), '등록되지 않은 번호예요');
    await kiosk.evaluate(`document.getElementById('result').click()`);

    await wait(2500);
    const cls = await board.evaluate(`[...document.querySelectorAll('.cell[data-id]')].find((c) => c.textContent.includes('차카타')).className`);
    assert.match(cls, /\bin\b/);
  });

  it('퇴원 처리하면 현황판에서 빠지고 퇴원생 목록에 나와요', async () => {
    await board.evaluate(`[...document.querySelectorAll('.cell[data-id]')].find((c) => c.textContent.includes('사아자')).querySelector('[data-act="info"]').click()`);
    await board.evaluate(`document.getElementById('student-leave').click()`);
    await wait(600);
    assert.equal(await board.evaluate(`document.querySelectorAll('.cell[data-id]').length`), 1);
    await board.evaluate(`document.getElementById('open-left').click()`);
    assert.equal(await board.evaluate(`document.querySelectorAll('#left-list button').length`), 1);
    await board.evaluate(`document.getElementById('left-dialog').close()`);
  });

  it('기록 화면이 하루 두 번 방문을 보여 주고, 잘못된 수정은 사유를 보여 줘요', async () => {
    const sa = (await api.teacher('/api/state')).json.students.find((s) => s.name === '사아자');
    const month = (await api.teacher('/api/state')).json.today.slice(0, 7);
    const date = `${month}-02`;
    await api.teacher('/api/records/edit', { date, id: sa.id, visits: [{ in: '15:00', out: '17:00' }, { in: '19:00', out: '21:00' }] });
    const rec = await openTab(browser.port, `http://localhost:${server.port}/records`, { width: 1600, height: 900, mobile: false }, errors);
    try {
      assert.equal(await rec.evaluate(`document.querySelector('td.day[data-date="${date}"][data-id="${sa.id}"]').textContent`), '15:00–17:0019:00–21:00');
      await rec.evaluate(`document.querySelector('td.day[data-date="${date}"][data-id="${sa.id}"]').click()`);
      assert.equal(await rec.evaluate(`document.getElementById('edit-dialog').open`), true);
      await rec.evaluate(`document.querySelector('#visit-rows [data-role="in"]').value = '18:00'; document.querySelector('#visit-rows [data-role="out"]').value = '17:00'; document.getElementById('edit-save').click()`);
      await wait(500);
      assert.match(await rec.evaluate(`document.getElementById('edit-error').textContent`), /하원 시각이 등원 시각보다 빠릅니다/);
    } finally {
      rec.close();
    }
  });

  it('화면에 스크립트 오류가 없어요', () => {
    assert.deepEqual(errors, []);
  });

  it('CSP가 HTML 안에 끼워 넣은 스크립트를 실행하지 않아요', async () => {
    await board.evaluate(`const s = document.createElement('script'); s.textContent = 'window.__inlineRan = true'; document.body.append(s)`);
    await wait(200);
    assert.equal(await board.evaluate(`window.__inlineRan === true`), false);
  });
});
