// 목적: data.json을 읽고, 검사하고, 업그레이드하고, 원자적으로 저장하고, 매일 백업해요.
// 사용처: server.js가 시작할 때 openStore()를 부르고, 업무 파일은 getDb()로 데이터를 읽고 바꾼 뒤 persist()를 불러요.
// 근거: 학원 기록을 지키는 코드라 다른 기능과 섞이지 않게 server.js에서 따로 뺐어요(DEC-06, DEC-11, DEC-14).

'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { DATA_FILE, BACKUP_DIR, DATA_VERSION, BACKUP_KEEP, DATE_RE, TIME_RE, PHONE_RE, HASH_RE, BACKUP_NAME_RE } = require('./config');
const { localDate } = require('./time');

let db = null;
let rev = Date.now(); // 변경 때마다 +1. 재시작해도 줄어들지 않게 시각에서 시작한다.
let writeQueue = Promise.resolve();
let backupDay = null; // 오늘 백업을 이미 했는지. 재시작하면 파일 이름으로 다시 확인해요

// 목적: 저장된 데이터를 읽어 와요. 없으면 빈 명단, 예전 형식이면 새 형식으로 바꾸고, 깨졌으면 파일을 보존한 채 빈 명단으로 시작해요.
// 이유: 첫 실행이나 파일 손상에도 서버는 떠야 하고, 손상된 기록을 조용히 덮어써서 잃으면 안 돼요(DEC-06, DEC-11).
// 방법: JSON 파싱 후 새 형식 검사 → 예전 형식 검사(맞으면 upgradeV1) 순서로 봐요. 둘 다 아니면 data.json.broken-<시각>으로 옮기고 경고해요.
function loadDb() {
  let raw;
  try {
    raw = fs.readFileSync(DATA_FILE, 'utf8');
  } catch (e) {
    if (e.code !== 'ENOENT') console.warn('데이터 파일을 읽지 못해 새로 시작합니다.', e.message);
    return { data: defaultDb(), upgraded: false };
  }
  try {
    const data = JSON.parse(raw);
    if (isValidDb(data)) return { data, upgraded: false };
    if (isValidV1(data)) return { data: upgradeV1(data), upgraded: true };
    throw new Error('형식이 올바르지 않습니다');
  } catch (e) {
    const broken = `${DATA_FILE}.broken-${Date.now()}`;
    try {
      fs.renameSync(DATA_FILE, broken);
      console.warn(`데이터 파일이 손상되어 ${path.basename(broken)}로 옮기고 새로 시작합니다. (${e.message})`);
    } catch (renameError) {
      console.warn('손상된 데이터 파일을 옮기지 못했습니다.', renameError.message);
    }
    return { data: defaultDb(), upgraded: false };
  }
}

// 목적: 처음 실행할 때 쓸 빈 데이터를 만들어요.
// 이유: 첫 명단은 스프레드시트에서 붙여넣으니(DEC-12), 지워야 할 예시 학생을 미리 넣어 두지 않아요.
// 방법: 새 형식의 빈 목록과 1부터 시작하는 다음 id들.
function defaultDb() {
  return { version: DATA_VERSION, classes: [], nextClassId: 1, students: [], nextId: 1, devices: [], nextDeviceId: 1, records: {} };
}

// 목적: 예전(QR 출석) 형식의 데이터인지 확인해요.
// 이유: QR 버전에서 쓰던 data.json을 새 형식으로 옮겨야 명단이 사라지지 않아요.
// 방법: students 배열의 각 항목 타입과 nextId, id 중복 여부를 예전 규칙 그대로 검사해요.
function isValidV1(data) {
  if (!isPlainObject(data) || data.version !== undefined) return false;
  if (!Array.isArray(data.students) || !Number.isInteger(data.nextId)) return false;
  const ids = new Set();
  for (const s of data.students) {
    if (!isPlainObject(s)) return false;
    if (!Number.isInteger(s.id) || ids.has(s.id)) return false;
    if (typeof s.name !== 'string' || typeof s.present !== 'boolean') return false;
    if (s.deviceHash !== null && typeof s.deviceHash !== 'string') return false;
    ids.add(s.id);
  }
  return true;
}

// 목적: 예전 형식의 데이터를 새 형식으로 바꿔요.
// 이유: 이름과 id는 살리고, QR 출석에만 쓰던 값(present, deviceHash)은 버려요.
// 방법: 학생마다 번호·반·퇴원 없이 옮기고, 반·기기·기록은 비워 둬요. 저장은 부른 쪽에서 한 번 해요.
function upgradeV1(old) {
  return {
    ...defaultDb(),
    students: old.students.map((s) => ({ id: s.id, name: s.name, phone: null, classIds: [], leftOn: null })),
    nextId: old.nextId,
  };
}

// 목적: 읽어 온 데이터가 새 형식에 맞는지 확인해요.
// 이유: 손으로 고친 파일이 들어와도 서버가 요청 도중에 죽지 않아야 해요.
// 방법: 목록마다 id가 겹치지 않고 다음 id보다 작은지, 각 필드의 타입과 날짜·시각 형식이 맞는지 검사해요.
function isValidDb(data) {
  if (!isPlainObject(data) || data.version !== DATA_VERSION) return false;
  if (!Array.isArray(data.classes) || !Array.isArray(data.students) || !Array.isArray(data.devices)) return false;
  if (!hasUniqueIds(data.classes, data.nextClassId, (c) => typeof c.name === 'string')) return false;
  const studentOk = (s) => typeof s.name === 'string'
    && (s.phone === null || (typeof s.phone === 'string' && PHONE_RE.test(s.phone)))
    && Array.isArray(s.classIds) && s.classIds.every(Number.isInteger)
    && (s.leftOn === null || (typeof s.leftOn === 'string' && DATE_RE.test(s.leftOn)));
  if (!hasUniqueIds(data.students, data.nextId, studentOk)) return false;
  const deviceOk = (d) => typeof d.label === 'string' && typeof d.tokenHash === 'string' && HASH_RE.test(d.tokenHash)
    && typeof d.pairedOn === 'string' && DATE_RE.test(d.pairedOn);
  if (!hasUniqueIds(data.devices, data.nextDeviceId, deviceOk)) return false;
  if (!isPlainObject(data.records)) return false;
  for (const [date, day] of Object.entries(data.records)) {
    if (!DATE_RE.test(date) || !isPlainObject(day)) return false;
    for (const visits of Object.values(day)) {
      if (!Array.isArray(visits)) return false;
      for (const v of visits) {
        if (!isPlainObject(v) || typeof v.in !== 'string' || !TIME_RE.test(v.in)) return false;
        if (v.out !== null && (typeof v.out !== 'string' || !TIME_RE.test(v.out))) return false;
      }
    }
  }
  return true;
}

// 목적: 배열이 아닌 일반 객체인지 확인해요.
// 이유: JSON의 null과 배열도 typeof가 object라 따로 걸러야 해요.
// 방법: typeof, null, Array.isArray를 함께 봐요.
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// 목적: 목록의 각 항목이 객체이고, id가 정수로 겹치지 않으며 다음 id보다 작은지 확인해요.
// 이유: 다음 id가 이미 쓴 id보다 작으면 새 항목이 옛 항목의 id를 다시 쓰게 돼요.
// 방법: id를 Set에 모으며 검사하고, 항목별 나머지 검사는 check 함수에 맡겨요.
function hasUniqueIds(list, nextId, check) {
  if (!Number.isInteger(nextId)) return false;
  const ids = new Set();
  for (const item of list) {
    if (!isPlainObject(item) || !Number.isInteger(item.id) || ids.has(item.id) || item.id >= nextId) return false;
    if (!check(item)) return false;
    ids.add(item.id);
  }
  return true;
}

// 목적: 서버를 시작할 때 data.json을 한 번 읽어 메모리에 올려요. 예전 형식이면 바꿔서 한 번 저장해요.
// 이유: 데이터는 시작할 때 한 번만 읽고, 실행 중에는 메모리의 데이터가 기준이에요(DEC-06). 파일을 불러오기만 해서는 읽지 않아야 시험에서 따로 쓸 수 있어요.
// 방법: loadDb 결과를 db에 두고, 업그레이드했으면 안내를 남기고 persist해요.
function openStore() {
  const loaded = loadDb();
  db = loaded.data;
  if (loaded.upgraded) {
    console.log('예전 형식의 데이터 파일을 새 형식으로 바꿨어요. 원래 파일은 backup 폴더에 남겨요.');
    persist();
  }
}

// 목적: 지금 메모리에 있는 데이터를 돌려줘요.
// 이유: 업무 파일이 같은 데이터 하나를 읽고 바꿔야 해요.
// 방법: openStore가 올린 db를 그대로 돌려줘요.
function getDb() {
  return db;
}

// 목적: 지금 변경 번호를 돌려줘요.
// 이유: TV가 늦게 도착한 옛 응답을 버릴 때 이 번호를 비교해요.
// 방법: persist마다 1씩 오르는 rev를 돌려줘요.
function getRev() {
  return rev;
}

// 목적: 현재 데이터를 디스크에 저장해요. 그날 첫 저장이면 저장 전에 백업부터 해요.
// 이유: 서버를 껐다 켜도 출석이 남아야 하고, 쓰는 도중 꺼져도 파일이 깨지면 안 돼요. 하루가 시작될 때의 파일을 남겨 두면 그날 실수를 되돌릴 수 있어요(DEC-11).
// 방법: 지금 시점의 스냅샷을 만들어 순서대로 임시 파일에 쓴 뒤 rename으로 교체해요(비동기 큐). 백업은 같은 큐 안에서 쓰기 직전에 해요.
function persist() {
  rev += 1;
  const snapshot = JSON.stringify(db);
  const tmp = `${DATA_FILE}.tmp`;
  const today = localDate(Date.now());
  writeQueue = writeQueue
    .then(async () => {
      if (backupDay !== today) {
        await backupDaily(today);
        backupDay = today;
      }
      await fsp.writeFile(tmp, snapshot, 'utf8');
      await fsp.rename(tmp, DATA_FILE);
    })
    .catch((e) => console.error('데이터를 저장하지 못했습니다.', e.message));
}

// 목적: 오늘 날짜로 data.json을 backup 폴더에 복사하고, 30개를 넘는 오래된 백업을 지워요.
// 이유: 파일 손상이나 잘못된 수정이 있어도 전날 상태로 돌아갈 수 있어야 해요(DEC-11).
// 방법: 이미 오늘 백업이 있으면 덮어쓰지 않아요(COPYFILE_EXCL). 원본이 아직 없으면 건너뛰어요. 실패해도 저장은 계속해요.
async function backupDaily(today) {
  try {
    await fsp.mkdir(BACKUP_DIR, { recursive: true });
    await fsp.copyFile(DATA_FILE, path.join(BACKUP_DIR, `data-${today}.json`), fs.constants.COPYFILE_EXCL);
  } catch (e) {
    if (e.code !== 'ENOENT' && e.code !== 'EEXIST') {
      console.warn('백업을 만들지 못했습니다.', e.message);
      return;
    }
  }
  try {
    const names = (await fsp.readdir(BACKUP_DIR)).filter((n) => BACKUP_NAME_RE.test(n)).sort();
    for (const name of names.slice(0, Math.max(0, names.length - BACKUP_KEEP))) {
      await fsp.unlink(path.join(BACKUP_DIR, name));
    }
  } catch (e) {
    console.warn('오래된 백업을 지우지 못했습니다.', e.message);
  }
}

// 목적: 진행 중인 저장이 모두 끝날 때를 알려 줘요.
// 이유: 종료 신호를 받았을 때 마지막 출석이 파일에 쓰인 뒤 꺼야 해요.
// 방법: 저장 큐의 마지막 Promise를 돌려줘요.
function flush() {
  return writeQueue;
}

module.exports = { openStore, getDb, getRev, persist, flush, isPlainObject };
