// 목적: 서버 API의 동작을 고정해 두는 시험입니다. 교사 관문, 명단, 기기 등록, 출석, 퇴원, 기록 수정을 확인합니다.
// 사용처: `node --test "tests/*.test.js"`로 실행합니다. 가짜 이름만 쓰고, 임시 폴더의 데이터로 돕니다.
// 근거: 구조를 나누거나 타입을 달 때 동작이 그대로인지 확인할 기준이 필요합니다(ROADMAP §1). 일회용으로 쓰던 시험을 옮겨 왔습니다.

'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startServer, clients, setClock, removeDir, makeTempDir, lanAddress, pairDevice, request } = require('./helpers');

describe('서버 API', () => {
  let server;
  let api;
  let clockFile;
  let today;
  let dev1;
  let dev2;
  // 목적: 이름으로 학생의 지금 상태를 찾습니다.
  // 이유: id는 붙여넣기 순서로 정해져서, 시험에서는 이름으로 찾는 편이 읽기 쉽습니다.
  // 방법: /api/state를 불러 이름이 같은 첫 학생을 돌려줍니다.
  const byName = async (name) => (await api.teacher('/api/state')).json.students.find((s) => s.name === name);

  before(async () => {
    const dir = makeTempDir();
    clockFile = path.join(dir, 'clock.txt');
    fs.writeFileSync(clockFile, '0');
    server = await startServer({ dataFile: path.join(dir, 'data.json'), clockFile });
    api = clients(server.port);
    today = await setClock(clockFile, 0, 15, 0);
  });

  after(async () => {
    await server.stop();
    removeDir(server.dir);
  });

  describe('교사 관문과 정적 파일', () => {
    it('처음에는 빈 명단이에요', async () => {
      const state = (await api.teacher('/api/state')).json;
      assert.equal(state.students.length, 0);
      assert.equal(state.classes.length, 0);
      assert.equal(state.today, today);
    });

    it('localhost가 아닌 Host의 교사 요청은 막아요', async () => {
      const res = await api.raw({ pathName: '/api/state', hostHeader: `evil.example:${server.port}` });
      assert.equal(res.status, 403);
    });

    it('LAN 주소로 들어온 교사 요청과 교사 화면은 막고, 출석 화면은 내줘요', async (t) => {
      const ip = lanAddress();
      if (!ip) {
        t.skip('LAN 주소가 없어요');
        return;
      }
      const lan = (pathName) => request(server.port, { pathName, host: ip, hostHeader: `${ip}:${server.port}` });
      assert.equal((await lan('/api/state')).status, 403);
      assert.equal((await lan('/')).status, 403);
      assert.equal((await lan('/records')).status, 403);
      assert.equal((await lan('/vendor/qrcode.js')).status, 403);
      assert.equal((await lan('/js/board.js')).status, 403);
      assert.equal((await lan('/css/board.css')).status, 403);
      assert.equal((await lan('/js/records.js')).status, 403);
      assert.equal((await lan('/k')).status, 200);
      assert.equal((await lan('/js/common.js')).status, 200);
      assert.equal((await lan('/js/kiosk.js')).status, 200);
      assert.equal((await lan('/css/kiosk.css')).status, 200);
    });

    it('CSP는 HTML 안 스크립트와 스타일을 허용하지 않아요', async () => {
      const res = await new Promise((resolve, reject) => {
        require('node:http').get({ host: '127.0.0.1', port: server.port, path: '/k', headers: { Host: `localhost:${server.port}` } }, (r) => {
          r.resume();
          resolve(r);
        }).on('error', reject);
      });
      const csp = res.headers['content-security-policy'];
      assert.match(csp, /script-src 'self';/);
      assert.match(csp, /style-src 'self';/);
      assert.doesNotMatch(csp, /unsafe-inline/);
    });

    it('교사 PC에서는 기록 화면을 내주고, 없어진 QR 경로는 404예요', async () => {
      assert.equal((await api.teacher('/records')).status, 200);
      assert.equal((await api.teacher('/s')).status, 404);
      assert.equal((await api.raw({ pathName: '/api/student/enter', body: {} })).status, 404);
      assert.equal((await api.teacher('/api/reset', {})).status, 404);
      assert.equal((await api.teacher('/api/release', { id: 1 })).status, 404);
    });

    it('JSON이 아닌 요청은 415예요', async () => {
      const res = await api.raw({ pathName: '/api/kiosk/hello', body: 'a=1', contentType: 'application/x-www-form-urlencoded' });
      assert.equal(res.status, 415);
    });
  });

  describe('명단 붙여넣기', () => {
    const rows = [
      ['가나다', '01011112222', '3시 타임'],
      ['라마바', '010-3333-4444', '3시 타임, 7시 타임'],
      ['사아자', '', ''],
      ['차카타', '01055556666', '7시 타임'],
      ['파하가', '01055556666', '7시 타임'],
      ['가나다', '01099990000', ''],
      ['너무긴이름이에요열세글자다', '', ''],
      ['나다라', '12', ''],
    ];

    it('미리보기는 추가, 건너뜀, 읽지 못한 줄을 나누고 저장하지 않아요', async () => {
      const preview = (await api.teacher('/api/import/preview', { rows })).json.preview;
      assert.deepEqual(preview.add.map((a) => a.name), ['가나다', '라마바', '사아자', '차카타', '파하가']);
      assert.deepEqual(preview.exists, ['가나다']);
      assert.deepEqual(preview.bad.map((b) => b.line), [7, 8]);
      assert.equal((await api.teacher('/api/state')).json.students.length, 0);
    });

    it('적용하면 학생과 반이 생기고, 다시 붙여넣어도 늘지 않아요', async () => {
      const applied = (await api.teacher('/api/import/apply', { rows })).json;
      assert.equal(applied.imported.added, 5);
      assert.deepEqual(applied.classes.map((c) => c.name), ['3시 타임', '7시 타임']);
      const again = (await api.teacher('/api/import/apply', { rows })).json;
      assert.equal(again.imported.added, 0);
      assert.equal(again.students.length, 5);
      const ra = again.students.find((s) => s.name === '라마바');
      assert.equal(ra.phone, '01033334444');
      assert.equal(ra.classIds.length, 2);
    });
  });

  describe('번호와 반', () => {
    it('같은 번호는 막지 않고 알려 줘요', async () => {
      const sa = await byName('사아자');
      assert.equal((await api.teacher('/api/phone', { id: sa.id, phone: '010 1111 2222' })).json.duplicatePhone, true);
      assert.equal((await api.teacher('/api/phone', { id: sa.id, phone: '01077778888' })).json.duplicatePhone, false);
      assert.equal((await api.teacher('/api/phone', { id: sa.id, phone: 'abc' })).status, 400);
    });

    it('반을 만들고, 고른 반에 학생을 추가하고, 반을 지우면 학생에게서도 빠져요', async () => {
      const added = (await api.teacher('/api/classes/add', { name: '9시 타임' })).json;
      const nine = added.classes.find((c) => c.name === '9시 타임');
      assert.ok(nine);
      assert.equal((await api.teacher('/api/classes/add', { name: '9시 타임' })).status, 409);
      const withStudent = (await api.teacher('/api/add', { classId: nine.id })).json;
      assert.deepEqual(withStudent.students.find((s) => s.id === withStudent.id).classIds, [nine.id]);
      const removed = (await api.teacher('/api/classes/delete', { id: nine.id })).json;
      assert.ok(removed.students.every((s) => !s.classIds.includes(nine.id)));
      await api.teacher('/api/delete', { id: withStudent.id });
    });
  });

  describe('출석 기기 등록', () => {
    it('등록하지 않은 기기는 출석할 수 없어요', async () => {
      assert.equal((await api.kiosk('/api/kiosk/hello', {})).json.state, 'unpaired');
      assert.equal((await api.kiosk('/api/kiosk/checkin', { digits: '2222' })).json.state, 'unpaired');
      assert.equal((await api.kiosk('/api/kiosk/pair', { code: '000000' })).json.state, 'expired');
    });

    it('맞는 코드로 등록하면 쿠키를 받고, 코드는 한 번만 써요', async () => {
      const code = (await api.teacher('/api/devices/pair', {})).json.pairing.code;
      assert.match(code, /^\d{6}$/);
      const wrong = code === '000000' ? '111111' : '000000';
      assert.equal((await api.kiosk('/api/kiosk/pair', { code: wrong })).json.state, 'wrong');
      const paired = await api.kiosk('/api/kiosk/pair', { code });
      assert.equal(paired.json.state, 'paired');
      assert.match(paired.setCookie, /^kid=[0-9a-f]{32}; Path=\/; Max-Age=34560000; HttpOnly; SameSite=Lax$/);
      dev1 = paired.cookie;
      assert.equal((await api.kiosk('/api/kiosk/pair', { code })).json.state, 'expired');
      const hello = await api.kiosk('/api/kiosk/hello', {}, dev1);
      assert.equal(hello.json.state, 'ready');
      assert.ok(hello.setCookie, '쿠키를 다시 발급해요');
      assert.ok(!fs.readFileSync(server.dataFile, 'utf8').includes(dev1.slice(4)), '기기 식별자 원문은 저장하지 않아요');
    });

    it('5번 틀리면 코드를 버려요', async () => {
      const code = (await api.teacher('/api/devices/pair', {})).json.pairing.code;
      const wrong = code === '000000' ? '111111' : '000000';
      for (let i = 0; i < 4; i++) await api.kiosk('/api/kiosk/pair', { code: wrong });
      assert.equal((await api.kiosk('/api/kiosk/pair', { code: wrong })).json.state, 'expired');
      assert.equal((await api.kiosk('/api/kiosk/pair', { code })).json.state, 'expired');
    });

    it('두 번째 기기를 등록하고, 창을 닫으면 코드도 닫혀요', async () => {
      dev2 = await pairDevice(api);
      assert.equal((await api.teacher('/api/state')).json.devices.length, 2);
      await api.teacher('/api/devices/pair', {});
      assert.equal((await api.teacher('/api/devices/cancel', {})).json.pairing, null);
    });
  });

  describe('출석', () => {
    it('없는 번호는 unknown, 4자리가 아니면 400이에요', async () => {
      assert.equal((await api.kiosk('/api/kiosk/checkin', { digits: '0000' }, dev1)).json.state, 'unknown');
      assert.equal((await api.kiosk('/api/kiosk/checkin', { digits: '12' }, dev1)).status, 400);
    });

    it('같은 번호의 학생이 여럿이면 이름만 보여 주고 고르게 해요', async () => {
      const choose = (await api.kiosk('/api/kiosk/checkin', { digits: '6666' }, dev1)).json;
      assert.equal(choose.state, 'choose');
      assert.deepEqual(Object.keys(choose.choices[0]).sort(), ['id', 'name']);
      const cha = choose.choices.find((c) => c.name === '차카타');
      const picked = (await api.kiosk('/api/kiosk/checkin', { digits: '6666', studentId: cha.id }, dev1)).json;
      assert.equal(picked.state, 'in');
      assert.equal(picked.time, '15:00');
    });

    it('10분 안에 다시 누르면 반복이고, 다른 기기에서도 같아요', async () => {
      assert.equal((await api.kiosk('/api/kiosk/checkin', { digits: '2222' }, dev1)).json.state, 'in');
      await setClock(clockFile, 0, 15, 9);
      const again = (await api.kiosk('/api/kiosk/checkin', { digits: '2222' }, dev2)).json;
      assert.equal(again.state, 'already');
      assert.equal(again.kind, 'in');
      assert.equal(again.time, '15:00');
    });

    it('10분이 지나면 하원, 하원 뒤 다시 오면 두 번째 등원이에요', async () => {
      await setClock(clockFile, 0, 15, 10);
      assert.equal((await api.kiosk('/api/kiosk/checkin', { digits: '2222' }, dev1)).json.state, 'out');
      await setClock(clockFile, 0, 15, 12);
      const repeat = (await api.kiosk('/api/kiosk/checkin', { digits: '2222' }, dev1)).json;
      assert.equal(repeat.state, 'already');
      assert.equal(repeat.kind, 'out');
      await setClock(clockFile, 0, 19, 0);
      assert.equal((await api.kiosk('/api/kiosk/checkin', { digits: '2222' }, dev1)).json.state, 'in');
      const ga = await byName('가나다');
      assert.equal(ga.status, 'in');
      assert.equal(ga.inTime, '19:00');
      const rec = (await api.teacher(`/api/records?month=${today.slice(0, 7)}`)).json;
      assert.deepEqual(rec.days[today][String(ga.id)], [{ in: '15:00', out: '15:10' }, { in: '19:00', out: null }]);
    });

    it('교사가 칸을 누르면 앞으로만 넘어가요', async () => {
      const sa = await byName('사아자');
      const seen = [];
      for (let i = 0; i < 3; i++) {
        const state = (await api.teacher('/api/toggle', { id: sa.id })).json;
        seen.push(state.students.find((s) => s.id === sa.id).status);
      }
      assert.deepEqual(seen, ['in', 'out', 'in']);
    });
  });

  describe('학원 이름', () => {
    it('처음에는 비어 있고, 고치면 앞뒤 공백을 지우고 저장해요', async () => {
      assert.equal((await api.teacher('/api/state')).json.academyName, '');
      const res = await api.teacher('/api/academy/rename', { name: '  한빛\t학원 ' });
      assert.equal(res.status, 200);
      assert.equal(res.json.academyName, '한빛학원');
      assert.equal((await api.teacher('/api/records?month=2026-01')).json.academyName, '한빛학원');
    });

    it('같은 이름을 다시 보내면 저장하지 않고, 빈칸이면 이름을 지워요', async () => {
      const before = (await api.teacher('/api/state')).json.rev;
      assert.equal((await api.teacher('/api/academy/rename', { name: '한빛학원' })).json.rev, before);
      assert.equal((await api.teacher('/api/academy/rename', { name: '   ' })).json.academyName, '');
      await api.teacher('/api/academy/rename', { name: '한빛학원' });
    });

    it('15자를 넘거나 문자열이 아니면 400이고, 교사 PC 밖에서는 403이에요', async () => {
      assert.equal((await api.teacher('/api/academy/rename', { name: '가'.repeat(15) })).status, 200);
      assert.equal((await api.teacher('/api/academy/rename', { name: '가'.repeat(16) })).status, 400);
      assert.equal((await api.teacher('/api/academy/rename', { name: 3 })).status, 400);
      assert.equal((await api.kiosk('/api/academy/rename', { name: '남의학원' }, dev1)).status, 403);
      await api.teacher('/api/academy/rename', { name: '한빛학원' });
    });

    it('등록된 출석 기기에는 hello·checkin에 학원 이름을 보내고, 등록 안 된 기기에는 보내지 않아요', async () => {
      assert.equal((await api.kiosk('/api/kiosk/hello', {}, dev1)).json.academyName, '한빛학원');
      assert.equal((await api.kiosk('/api/kiosk/checkin', { digits: '0000' }, dev1)).json.academyName, '한빛학원');
      const stranger = (await api.kiosk('/api/kiosk/hello', {})).json;
      assert.equal(stranger.state, 'unpaired');
      assert.ok(!('academyName' in stranger));
      const code = (await api.teacher('/api/devices/pair', {})).json.pairing.code;
      const paired = await api.kiosk('/api/kiosk/pair', { code });
      assert.equal(paired.json.academyName, '한빛학원');
      const id = (await api.teacher('/api/state')).json.devices.at(-1).id;
      await api.teacher('/api/devices/revoke', { id });
    });
  });

  describe('기기 취소, 퇴원, 삭제, 기록 수정', () => {
    it('등록을 취소한 기기는 다시 unpaired예요', async () => {
      const first = (await api.teacher('/api/state')).json.devices[0];
      await api.teacher('/api/devices/revoke', { id: first.id });
      assert.equal((await api.kiosk('/api/kiosk/checkin', { digits: '2222' }, dev1)).json.state, 'unpaired');
    });

    it('퇴원하면 번호가 지워지고 출석 대상에서 빠지며, 복귀할 수 있어요', async () => {
      const cha = await byName('차카타');
      const left = (await api.teacher('/api/leave', { id: cha.id })).json.students.find((s) => s.id === cha.id);
      assert.equal(left.left, true);
      assert.equal(left.phone, null);
      const res = (await api.kiosk('/api/kiosk/checkin', { digits: '6666' }, dev2)).json;
      assert.equal(res.state, 'in');
      assert.equal(res.name, '파하가');
      assert.equal((await api.teacher('/api/toggle', { id: cha.id })).status, 409);
      const back = (await api.teacher('/api/return', { id: cha.id })).json.students.find((s) => s.id === cha.id);
      assert.equal(back.left, false);
    });

    it('기록 수정은 형식과 순서를 확인해요', async () => {
      const ga = await byName('가나다');
      assert.equal((await api.teacher('/api/records?month=2026-13')).status, 400);
      assert.equal((await api.teacher('/api/records/edit', { date: today, id: ga.id, visits: [{ in: '15:00', out: '14:00' }] })).status, 400);
      assert.equal((await api.teacher('/api/records/edit', { date: today, id: ga.id, visits: [{ in: '10:00', out: null }, { in: '12:00', out: '13:00' }] })).status, 400);
      assert.equal((await api.teacher('/api/records/edit', { date: '2026-10-05', id: ga.id, visits: [{ in: '15:00', out: '17:00' }] })).status, 200);
      const month = (await api.teacher('/api/records?month=2026-10')).json;
      assert.ok(month.students.every((s) => !('phone' in s)), '기록에는 번호를 보내지 않아요');
    });

    it('학생을 지우면 그 학생의 기록도 지워져요', async () => {
      const ga = await byName('가나다');
      await api.teacher('/api/delete', { id: ga.id });
      assert.deepEqual((await api.teacher('/api/records?month=2026-10')).json.days, {});
    });
  });
});
