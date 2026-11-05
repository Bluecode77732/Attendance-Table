// 목적: 저장 동작을 고정해 두는 시험입니다. 재시작, 예전 파일 업그레이드, 손상 파일 격리, 매일 백업, 자정 넘김을 확인합니다.
// 사용처: `node --test "tests/*.test.js"`로 실행합니다. 가짜 이름만 쓰고, 임시 폴더의 데이터로 돕니다.
// 근거: data.json은 학원의 실제 기록이 담기는 곳이라, 구조를 나눌 때 가장 먼저 지켜야 합니다(DEC-06, DEC-11).

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startServer, clients, setClock, removeDir, makeTempDir, pairDevice } = require('./helpers');

const BACKUP_RE = /^data-\d{4}-\d{2}-\d{2}\.json$/;

// 목적: 저장 큐가 파일에 쓸 시간을 잠깐 기다립니다.
// 이유: 서버는 응답을 먼저 보내고 파일은 큐에서 씁니다. 곧바로 끄면 Windows에서는 마지막 쓰기를 잃습니다(ROADMAP §3).
// 방법: 짧게 기다립니다.
function settle() {
  return new Promise((resolve) => setTimeout(resolve, 400));
}

// 목적: 임시 폴더를 만들어 시험 하나를 돌리고, 성공하든 실패하든 서버와 폴더를 정리합니다.
// 이유: 단언이 실패해도 서버가 남으면 시험 전체가 끝나지 않습니다.
// 방법: body에 폴더와 "서버 띄우기" 함수를 넘깁니다. 띄운 서버는 기억해 두었다가 finally에서 모두 끕니다.
async function withSandbox(body) {
  const dir = makeTempDir();
  const running = [];
  const start = async (options) => {
    const server = await startServer(options);
    running.push(server);
    return server;
  };
  try {
    await body(dir, start);
  } finally {
    for (const server of running) await server.stop();
    removeDir(dir);
  }
}

describe('저장', () => {
  it('재시작해도 학생, 기기, 오늘 기록이 남아요', () => withSandbox(async (dir, start) => {
    const dataFile = path.join(dir, 'data.json');
    let server = await start({ dataFile });
    let api = clients(server.port);
    await api.teacher('/api/import/apply', { rows: [['가나다', '01011112222', '']] });
    const dev = await pairDevice(api);
    assert.equal((await api.kiosk('/api/kiosk/checkin', { digits: '2222' }, dev)).json.state, 'in');
    await settle();
    await server.stop();

    server = await start({ dataFile });
    api = clients(server.port);
    const state = (await api.teacher('/api/state')).json;
    assert.equal(state.students.length, 1);
    assert.equal(state.devices.length, 1);
    assert.equal(state.students[0].status, 'in');
    assert.equal((await api.kiosk('/api/kiosk/hello', {}, dev)).json.state, 'ready');
  }));

  it('그날 첫 저장 전에 백업하고, 30개만 남겨요', () => withSandbox(async (dir, start) => {
    const dataFile = path.join(dir, 'data.json');
    const backupDir = path.join(dir, 'backup');
    let server = await start({ dataFile });
    await clients(server.port).teacher('/api/add', {});
    await settle();
    await server.stop();
    assert.ok(!fs.existsSync(backupDir) || fs.readdirSync(backupDir).length === 0, '파일이 없던 첫 저장에는 백업이 없어요');

    fs.mkdirSync(backupDir, { recursive: true });
    for (let i = 1; i <= 35; i++) fs.writeFileSync(path.join(backupDir, `data-2025-01-${String(i).padStart(2, '0')}.json`), '{}');
    server = await start({ dataFile });
    await clients(server.port).teacher('/api/add', {});
    await settle();

    const now = new Date();
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const backups = fs.readdirSync(backupDir).filter((n) => BACKUP_RE.test(n)).sort();
    assert.ok(backups.includes(`data-${today}.json`));
    assert.equal(backups.length, 30);
    assert.ok(!backups.includes('data-2025-01-01.json'), '가장 오래된 백업부터 지워요');
  }));

  it('예전(QR) 형식 파일은 새 형식으로 바꾸고, 원본은 백업에 남겨요', () => withSandbox(async (dir, start) => {
    const dataFile = path.join(dir, 'data.json');
    fs.writeFileSync(dataFile, JSON.stringify({
      students: [{ id: 3, name: '옛학생', present: true, deviceHash: 'abc' }, { id: 7, name: '옛학생2', present: false, deviceHash: null }],
      nextId: 8,
    }));
    const server = await start({ dataFile });
    assert.match(server.log(), /새 형식으로 바꿨어요/);
    const api = clients(server.port);
    assert.deepEqual((await api.teacher('/api/state')).json.students.map((s) => `${s.id}:${s.name}`), ['3:옛학생', '7:옛학생2']);
    assert.equal((await api.teacher('/api/add', {})).json.id, 8);
    await settle();

    const saved = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
    assert.equal(saved.version, 3);
    assert.equal(saved.academyName, '');
    assert.equal(saved.students[0].phone, null);
    assert.ok(!('present' in saved.students[0]));
    const backup = fs.readdirSync(path.join(dir, 'backup')).find((n) => BACKUP_RE.test(n));
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'backup', backup), 'utf8')).version, undefined);
  }));

  it('버전 2 파일은 학원 이름 빈칸을 더해 버전 3으로 바꾸고, 명단·반·기록은 그대로이며 원본은 백업에 남겨요', () => withSandbox(async (dir, start) => {
    const dataFile = path.join(dir, 'data.json');
    fs.writeFileSync(dataFile, JSON.stringify({
      version: 2,
      classes: [{ id: 1, name: '3시 타임' }],
      nextClassId: 2,
      students: [{ id: 4, name: '가나다', phone: '01011112222', classIds: [1], leftOn: null }],
      nextId: 5,
      devices: [],
      nextDeviceId: 1,
      records: { '2026-10-01': { 4: [{ in: '15:00', out: '17:00' }] } },
    }));
    let server = await start({ dataFile });
    assert.match(server.log(), /새 형식으로 바꿨어요/);
    let api = clients(server.port);
    const state = (await api.teacher('/api/state')).json;
    assert.equal(state.academyName, '');
    assert.deepEqual(state.students.map((s) => `${s.id}:${s.name}:${s.phone}:${s.classIds}`), ['4:가나다:01011112222:1']);
    assert.deepEqual(state.classes, [{ id: 1, name: '3시 타임' }]);
    assert.deepEqual((await api.teacher('/api/records?month=2026-10')).json.days, { '2026-10-01': { 4: [{ in: '15:00', out: '17:00' }] } });
    assert.equal((await api.teacher('/api/add', {})).json.id, 5, '다음 id도 이어져요');
    assert.equal((await api.teacher('/api/academy/rename', { name: '한빛학원' })).json.academyName, '한빛학원');
    await settle();

    const saved = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
    assert.equal(saved.version, 3);
    assert.equal(saved.academyName, '한빛학원');
    const backup = fs.readdirSync(path.join(dir, 'backup')).find((n) => BACKUP_RE.test(n));
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'backup', backup), 'utf8')).version, 2);

    await server.stop();
    server = await start({ dataFile });
    api = clients(server.port);
    assert.equal((await api.teacher('/api/state')).json.academyName, '한빛학원', '다시 켜도 학원 이름이 남아요');
  }));

  it('버전 3인데 학원 이름이 문자열이 아니면 broken으로 옮겨요', () => withSandbox(async (dir, start) => {
    const dataFile = path.join(dir, 'data.json');
    fs.writeFileSync(dataFile, JSON.stringify({ version: 3, academyName: 7, classes: [], nextClassId: 1, students: [], nextId: 1, devices: [], nextDeviceId: 1, records: {} }));
    const server = await start({ dataFile });
    assert.ok(fs.readdirSync(dir).some((n) => n.startsWith('data.json.broken-')));
    assert.equal((await clients(server.port).teacher('/api/state')).json.academyName, '');
  }));

  it('모양이 틀린 파일은 broken으로 옮기고 빈 명단으로 시작해요', () => withSandbox(async (dir, start) => {
    const dataFile = path.join(dir, 'data.json');
    fs.writeFileSync(dataFile, '{"version":2,"students":"nope"}');
    const server = await start({ dataFile });
    assert.ok(fs.readdirSync(dir).some((n) => n.startsWith('data.json.broken-')));
    assert.equal((await clients(server.port).teacher('/api/state')).json.students.length, 0);
  }));

  it('자정이 지나면 모두 미등원이 되고, 새날 첫 입력은 등원이며 백업이 생겨요', () => withSandbox(async (dir, start) => {
    const dataFile = path.join(dir, 'data.json');
    const clockFile = path.join(dir, 'clock.txt');
    fs.writeFileSync(clockFile, '0');
    const server = await start({ dataFile, clockFile });
    const api = clients(server.port);
    await api.teacher('/api/import/apply', { rows: [['가나다', '01011112222', '']] });
    const dev = await pairDevice(api);

    const day1 = await setClock(clockFile, 0, 23, 50);
    assert.equal((await api.kiosk('/api/kiosk/checkin', { digits: '2222' }, dev)).json.time, '23:50');
    await setClock(clockFile, 0, 23, 59);
    assert.equal((await api.kiosk('/api/kiosk/checkin', { digits: '2222' }, dev)).json.state, 'already');

    const day2 = await setClock(clockFile, 1, 0, 3);
    const state = (await api.teacher('/api/state')).json;
    assert.equal(state.today, day2);
    assert.ok(state.students.every((s) => s.status === 'absent'));
    const next = (await api.kiosk('/api/kiosk/checkin', { digits: '2222' }, dev)).json;
    assert.equal(next.state, 'in', '자정을 넘긴 간격은 반복으로 보지 않아요');
    assert.equal(next.time, '00:03');

    const rec = (await api.teacher(`/api/records?month=${day1.slice(0, 7)}`)).json;
    assert.equal(rec.days[day1]['1'][0].out, null, '전날 방문은 하원 없이 남아요');
    await settle();
    assert.ok(fs.existsSync(path.join(dir, 'backup', `data-${day2}.json`)));
  }));
});


describe('교사 화면을 모두 닫으면', () => {
  // 목적: 시험용 화면 id를 만듭니다. 이유: 서버는 32자리 16진수만 받습니다. 방법: 한 글자를 32번 되풀이합니다.
  const pageId = (c) => c.repeat(32);
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  it('5초 뒤 저장을 마치고 꺼지고, 다시 켜면 그대로예요', () => withSandbox(async (dir, start) => {
    const dataFile = path.join(dir, 'data.json');
    const server = await start({ dataFile });
    const api = clients(server.port);
    await api.teacher('/api/import/apply', { rows: [['가나다', '01011112222', '']] });
    await api.teacher('/api/page/open', { pageId: pageId('a') });
    await api.teacher('/api/page/close', { pageId: pageId('a') });
    await wait(3000);
    assert.equal((await api.teacher('/api/state')).status, 200, '5초가 지나기 전에는 켜져 있어요');
    await wait(3500);
    await assert.rejects(api.teacher('/api/state'), '5초 뒤에는 꺼져 있어야 해요');
    assert.match(server.log(), /교사 화면이 모두 닫혀 출석부를 끕니다/);
    const again = await start({ dataFile });
    assert.equal((await clients(again.port).teacher('/api/state')).json.students.length, 1);
  }));

  it('닫힌 뒤 5초 안에 다시 열리면(새로고침) 꺼지지 않고, 다른 화면이 남아 있어도 꺼지지 않아요', () => withSandbox(async (dir, start) => {
    const server = await start({ dataFile: path.join(dir, 'data.json') });
    const api = clients(server.port);
    await api.teacher('/api/page/open', { pageId: pageId('a') });
    await api.teacher('/api/page/close', { pageId: pageId('a') });
    await wait(500);
    await api.teacher('/api/page/open', { pageId: pageId('b') });
    await api.teacher('/api/page/open', { pageId: pageId('c') });
    await api.teacher('/api/page/close', { pageId: pageId('b') });
    await wait(6500);
    assert.equal((await api.teacher('/api/state')).status, 200);
  }));

  it('화면 id가 틀리면 400이고, 출석 기기 쪽에서는 쓸 수 없어요(403)', () => withSandbox(async (dir, start) => {
    const server = await start({ dataFile: path.join(dir, 'data.json') });
    const api = clients(server.port);
    assert.equal((await api.teacher('/api/page/open', { pageId: 'abc' })).status, 400);
    assert.equal((await api.kiosk('/api/page/close', { pageId: pageId('a') })).status, 403);
  }));
});
