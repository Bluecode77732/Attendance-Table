// 목적: 학원 규모(가짜 60명)에서 붙여넣기, 번호 출석, 하원, 한 달 기록, 재시작이 그대로 되는지 고정해 두는 시험입니다.
// 사용처: `node --test "tests/*.test.js"`로 실행합니다. 가짜 이름만 쓰고, 임시 폴더의 데이터로 돕니다.
// 근거: 다른 시험은 학생 몇 명으로만 확인합니다. 학원은 전체 60명이라고 답해서(ROADMAP B3), 넘기기 전에 그 규모로 한 번에 돌려 봐야 합니다.

'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startServer, clients, setClock, removeDir, makeTempDir, pairDevice, fakeRoster, groupByLast4 } = require('./helpers');

const COUNT = 60;

// 목적: 저장 큐가 파일에 쓸 시간을 잠깐 기다립니다.
// 이유: 서버는 응답을 먼저 보내고 파일은 큐에서 씁니다. 곧바로 끄면 Windows에서는 마지막 쓰기를 잃습니다(ROADMAP §3).
// 방법: 짧게 기다립니다.
function settle() {
  return new Promise((resolve) => setTimeout(resolve, 400));
}

describe(`${COUNT}명 규모`, () => {
  const rows = fakeRoster(COUNT);
  const groups = groupByLast4(rows);
  const noPhone = rows.filter(([, phone]) => phone === '').map(([name]) => name);
  let dir;
  let clockFile;
  let server;
  let api;
  let today;
  let device;

  // 목적: 학생 이름으로 id를 찾습니다.
  // 이유: 번호 없는 학생은 현황판 칸 누르기로만 출석시킬 수 있어 id가 필요합니다.
  // 방법: /api/state에서 이름이 같은 학생을 찾습니다.
  const idOf = async (name) => (await api.teacher('/api/state')).json.students.find((s) => s.name === name).id;

  // 목적: 명단의 모든 학생을 출석 기기에서 한 번씩 출석시키고 결과 상태를 모읍니다.
  // 이유: 등원과 하원이 같은 순서로 진행되어 두 시험이 함께 씁니다.
  // 방법: 뒷 4자리가 혼자인 학생은 번호만, 겹치는 학생은 choose에서 받은 id로 다시 보냅니다. 번호 없는 학생은 현황판 칸을 누릅니다.
  const checkEveryone = async () => {
    const states = new Map();
    for (const [digits, names] of groups) {
      if (names.length === 1) {
        const res = (await api.kiosk('/api/kiosk/checkin', { digits }, device)).json;
        assert.equal(res.name, names[0]);
        states.set(names[0], res.state);
        continue;
      }
      const choose = (await api.kiosk('/api/kiosk/checkin', { digits }, device)).json;
      assert.equal(choose.state, 'choose');
      assert.deepEqual(choose.choices.map((c) => c.name).sort(), [...names].sort());
      for (const choice of choose.choices) {
        const res = (await api.kiosk('/api/kiosk/checkin', { digits, studentId: choice.id }, device)).json;
        states.set(choice.name, res.state);
      }
    }
    for (const name of noPhone) {
      const id = await idOf(name);
      const state = (await api.teacher('/api/toggle', { id })).json;
      states.set(name, state.students.find((s) => s.id === id).status);
    }
    return states;
  };

  before(async () => {
    dir = makeTempDir();
    clockFile = path.join(dir, 'clock.txt');
    fs.writeFileSync(clockFile, '0');
    server = await startServer({ dataFile: path.join(dir, 'data.json'), clockFile });
    api = clients(server.port);
    today = await setClock(clockFile, 0, 15, 0);
    device = await pairDevice(api);
  });

  after(async () => {
    await server.stop();
    removeDir(dir);
  });

  it('가짜 명단에 형제 번호, 뒷 4자리만 같은 번호, 번호 없는 학생이 들어 있어요', () => {
    const shared = [...groups.values()].filter((names) => names.length > 1);
    assert.deepEqual(shared.map((names) => names.length).sort(), [2, 2, 3]);
    assert.equal(noPhone.length, 1);
  });

  it(`${COUNT}명을 한 번에 붙여넣어 미리보기와 적용이 맞아요`, async () => {
    const preview = (await api.teacher('/api/import/preview', { rows })).json.preview;
    assert.equal(preview.add.length, COUNT);
    assert.deepEqual(preview.exists, []);
    assert.deepEqual(preview.bad, []);
    const applied = (await api.teacher('/api/import/apply', { rows })).json;
    assert.equal(applied.imported.added, COUNT);
    assert.equal(applied.students.length, COUNT);
    assert.deepEqual(applied.classes.map((c) => c.name), ['3시 타임', '5시 타임', '7시 타임']);
    assert.equal(applied.students.filter((s) => s.phone).length, COUNT - noPhone.length);
    assert.equal(applied.students.filter((s) => s.classIds.length === 2).length, COUNT / 10);
  });

  it('모두 등원하면 현황판에 전원이 등원으로 나와요', async () => {
    const states = await checkEveryone();
    assert.equal(states.size, COUNT);
    assert.ok([...states.values()].every((s) => s === 'in'), [...states].filter(([, s]) => s !== 'in').join(', '));
    const students = (await api.teacher('/api/state')).json.students;
    assert.ok(students.every((s) => s.status === 'in' && s.inTime === '15:00'));
  });

  it('두 시간 뒤 모두 하원하고, 한 달 기록에 전원의 방문이 남아요', async () => {
    await setClock(clockFile, 0, 17, 0);
    const states = await checkEveryone();
    assert.ok([...states.values()].every((s) => s === 'out'), [...states].filter(([, s]) => s !== 'out').join(', '));
    const rec = (await api.teacher(`/api/records?month=${today.slice(0, 7)}`)).json;
    assert.equal(rec.students.length, COUNT);
    const day = rec.days[today];
    assert.equal(Object.keys(day).length, COUNT);
    for (const visits of Object.values(day)) assert.deepEqual(visits, [{ in: '15:00', out: '17:00' }]);
  });

  it('재시작해도 명단과 오늘 기록이 그대로예요', async () => {
    await settle();
    await server.stop();
    server = await startServer({ dataFile: path.join(dir, 'data.json'), clockFile });
    api = clients(server.port);
    const state = (await api.teacher('/api/state')).json;
    assert.equal(state.students.length, COUNT);
    assert.ok(state.students.every((s) => s.status === 'out'));
    const rec = (await api.teacher(`/api/records?month=${today.slice(0, 7)}`)).json;
    assert.equal(Object.keys(rec.days[today]).length, COUNT);
    assert.equal((await api.kiosk('/api/kiosk/hello', {}, device)).json.state, 'ready', '등록한 기기도 그대로예요');
  });
});

describe('명단 한도 500명', () => {
  const MAX = 500;
  let server;
  let api;

  before(async () => {
    server = await startServer();
    api = clients(server.port);
  });

  after(async () => {
    await server.stop();
    removeDir(server.dir);
  });

  it(`반 이름이 긴 ${MAX}명도 한 번에 붙여넣어요`, async () => {
    // 학원 반 이름이 길어도 들어가는지 보려고 일부러 긴 반 이름 둘을 붙입니다.
    const rows = fakeRoster(MAX).map(([name, phone]) => [name, phone, '월수금 4시 타임, 화목 6시 타임']);
    assert.ok(Buffer.byteLength(JSON.stringify({ rows })) > 30_000, '시험 명단이 충분히 커야 해요');
    const preview = await api.teacher('/api/import/preview', { rows });
    assert.equal(preview.status, 200);
    assert.equal(preview.json.preview.add.length, MAX);
    const applied = (await api.teacher('/api/import/apply', { rows })).json;
    assert.equal(applied.students.length, MAX);
  });

  it(`${MAX}명이 차면 학생 추가와 붙여넣기를 막아요`, async () => {
    assert.equal((await api.teacher('/api/add', {})).status, 409);
    assert.equal((await api.teacher('/api/import/preview', { rows: [['새학생', '', '']] })).status, 409);
  });

  it('요청 크기 상한(64KB)을 넘으면 교사와 출석 기기 요청 모두 413이에요', async () => {
    const big = { rows: [['가'.repeat(30_000), '', '']] };
    assert.equal((await api.teacher('/api/import/preview', big)).status, 413);
    assert.equal((await api.kiosk('/api/kiosk/checkin', big)).status, 413);
  });
});
