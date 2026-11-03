// 목적: 교사 PC에서 도는 출석 서버예요. TV 현황판, 출석 기기, 기록 화면이 같은 출석 데이터를 보게 해요.
// 사용처: `node server.js`(시작 스크립트)로 실행해요. public/ 아래 세 화면(현황판, 출석 기기, 기록)을 내줘요.
// 근거: 출석을 서버가 들고 있어야 출석 기기의 입력이 TV와 기록에 바로 반영돼요(DEC-01, DEC-10).
//       설치 부담을 줄이려 외부 패키지 없이 Node 기본 모듈만 써요(DEC-02).

'use strict';

const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const PORT = Number(process.env.PORT) || 8080;
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data.json');
const BACKUP_DIR = path.join(path.dirname(DATA_FILE), 'backup');
const PUBLIC_DIR = path.join(__dirname, 'public');

const DATA_VERSION = 2;
const REPEAT_WINDOW_MIN = 10; // 직전 입력 후 이 시간 안의 입력은 반복으로 봐요(두 번 누름 대비)
const PAIR_CODE_TTL_MS = 10 * 60_000; // 출석 기기 등록 코드가 유효한 시간
const PAIR_MAX_TRIES = 5; // 등록 코드를 이만큼 틀리면 그 코드를 버려요
const DEVICE_COOKIE_MAX_AGE_S = 34_560_000; // 400일. 브라우저가 받아 주는 최대치라 출석할 때마다 다시 발급해요
const BACKUP_KEEP = 30;
const NAME_MAX = 12;
const CLASS_NAME_MAX = 20;
const MAX_STUDENTS = 200;
const MAX_CLASSES = 50;
const MAX_DEVICES = 20;
const MAX_VISITS_PER_DAY = 10;
const BODY_MAX = 10_000;

const DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const PHONE_RE = /^\d{9,11}$/;
const HASH_RE = /^[0-9a-f]{64}$/;
const BACKUP_NAME_RE = /^data-\d{4}-\d{2}-\d{2}\.json$/;

// 화이트리스트 방식 정적 서빙 — 요청 경로를 파일 경로로 직접 쓰지 않는다(경로 탈출 방지).
const STATIC_FILES = {
  '/': { file: 'index.html', type: 'text/html; charset=utf-8', teacherOnly: true },
  '/records': { file: 'records.html', type: 'text/html; charset=utf-8', teacherOnly: true },
  '/k': { file: 'kiosk.html', type: 'text/html; charset=utf-8', teacherOnly: false },
  '/vendor/qrcode.js': { file: 'vendor/qrcode.js', type: 'text/javascript; charset=utf-8', teacherOnly: true },
};

const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const TEACHER_HOSTS = new Set([`localhost:${PORT}`, `127.0.0.1:${PORT}`, `[::1]:${PORT}`]);

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// ───────────────────────── 저장소 ─────────────────────────

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

const loaded = loadDb();
let db = loaded.data;
let rev = Date.now(); // 변경 때마다 +1. 재시작해도 줄어들지 않게 시각에서 시작한다.
let writeQueue = Promise.resolve();
let backupDay = null; // 오늘 백업을 이미 했는지. 재시작하면 파일 이름으로 다시 확인해요

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

if (loaded.upgraded) {
  console.log('예전 형식의 데이터 파일을 새 형식으로 바꿨어요. 원래 파일은 backup 폴더에 남겨요.');
  persist();
}

// ───────────────────────── 출석 기록 ─────────────────────────

// 목적: 시각을 PC 현지 날짜 문자열(YYYY-MM-DD)로 바꿔요.
// 이유: 기록은 학원의 날짜 기준으로 묶여야 해요. UTC로 묶으면 오전 9시 전 기록이 전날로 가요.
// 방법: Date의 현지 시간 getter로 조립해요.
function localDate(now) {
  const d = new Date(now);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

// 목적: 시각을 PC 현지 시:분(HH:MM)으로 바꿔요.
// 이유: 상담에 쓰는 기록은 분 단위면 충분해요.
// 방법: Date의 현지 시간 getter로 조립해요.
function localTime(now) {
  const d = new Date(now);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

// 목적: 숫자를 두 자리 문자열로 맞춰요.
// 이유: 날짜와 시각 문자열을 정렬·비교할 수 있게 해요.
// 방법: padStart.
function pad2(n) {
  return String(n).padStart(2, '0');
}

// 목적: HH:MM을 자정부터 지난 분으로 바꿔요.
// 이유: 10분 반복 구간과 등원·하원 순서를 비교해야 해요.
// 방법: 시와 분을 숫자로 나눠 계산해요.
function minutesOf(time) {
  return Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
}

// 목적: 학생의 오늘 상태(미등원·등원·하원)와 마지막 방문 시각을 알려 줘요.
// 이유: 현황판 칸의 색과 시각은 오늘 기록에서 계산해요(DEC-11).
// 방법: 오늘 방문 목록의 마지막 항목을 봐요. 없으면 미등원, 하원 시각이 없으면 등원, 있으면 하원이에요.
function todayStatus(student, now) {
  const visits = db.records[localDate(now)]?.[student.id] ?? [];
  const last = visits.at(-1);
  if (!last) return { status: 'absent', inTime: null, outTime: null };
  return { status: last.out === null ? 'in' : 'out', inTime: last.in, outTime: last.out };
}

// 목적: 학생의 오늘 기록을 한 단계 앞으로 보내요. 미등원이나 하원이면 새로 등원, 등원 중이면 하원이에요.
// 이유: 출석 기기와 현황판 칸 누르기가 같은 규칙으로 기록해야 해요. 앞으로만 가서 잘못 눌러도 시각이 지워지지 않아요.
// 방법: 출석 기기에서는 직전 입력 후 10분 안이면 반복(already)으로 보고 아무것도 바꾸지 않아요. 바뀌면 persist해요.
function advanceVisit(student, now, checkRepeat) {
  const date = localDate(now);
  const time = localTime(now);
  const day = db.records[date] ?? {};
  const visits = day[student.id] ?? [];
  const last = visits.at(-1);
  if (last && checkRepeat) {
    const lastTime = last.out ?? last.in;
    const gap = minutesOf(time) - minutesOf(lastTime);
    if (gap >= 0 && gap < REPEAT_WINDOW_MIN) {
      return { state: 'already', kind: last.out === null ? 'in' : 'out', time: lastTime };
    }
  }
  let result;
  if (last && last.out === null) {
    last.out = time;
    result = { state: 'out', time };
  } else {
    if (visits.length >= MAX_VISITS_PER_DAY) return { state: 'already', kind: 'out', time: last.out };
    visits.push({ in: time, out: null });
    result = { state: 'in', time };
  }
  day[student.id] = visits;
  db.records[date] = day;
  persist();
  return result;
}

// ───────────────────────── 네트워크 주소 ─────────────────────────

let addressIndex = 0;

// 목적: 학생 폰이 접속할 같은 네트워크(Wi-Fi/유선) 주소 후보를 모은다.
// 이유: PC에 가상 어댑터(WSL, VirtualBox 등)가 있으면 주소가 여러 개라 QR이 엉뚱한 주소를 가리킬 수 있다.
// 방법: HOST_IP 환경변수가 있으면 그것만, 없으면 내부 IPv4를 모아 192.168 → 10 → 172.16~31 순으로 정렬한다.
function lanAddresses() {
  if (process.env.HOST_IP) return [process.env.HOST_IP];
  const found = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const info of list ?? []) {
      if (info.family === 'IPv4' && !info.internal) found.push(info.address);
    }
  }
  const rank = (ip) => (ip.startsWith('192.168.') ? 0 : ip.startsWith('10.') ? 1 : /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ? 2 : 3);
  return found.sort((a, b) => rank(a) - rank(b));
}

// ───────────────────────── 출석 기기 ─────────────────────────

// 목적: 쿠키의 기기 식별자를 저장용 해시로 바꾼다.
// 이유: 저장 파일이 새어도 폰에 든 식별자를 그대로 쓸 수는 없게 한다.
// 방법: SHA-256 hex.
function hashDevice(deviceId) {
  return crypto.createHash('sha256').update(deviceId).digest('hex');
}

const pairing = { code: null, expiresAt: 0, tries: 0 }; // 지금 열려 있는 출석 기기 등록 코드(메모리에만)

// 목적: 출석 기기 등록용 6자리 일회용 코드를 새로 만들어요.
// 이유: 등록 절차가 없으면 학원 Wi-Fi의 아무 기기나 출석을 찍을 수 있어요(DEC-10).
// 방법: 암호학적 난수 6자리, 10분 유효. 새로 만들면 이전 코드는 버려요.
function startPairing(now) {
  pairing.code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  pairing.expiresAt = now + PAIR_CODE_TTL_MS;
  pairing.tries = 0;
}

// 목적: 출석 기기가 입력한 등록 코드를 확인하고, 맞으면 기기를 등록해요.
// 이유: 코드를 본 사람만 기기를 등록할 수 있어야 하고, 코드를 맞힐 때까지 계속 시도할 수는 없어야 해요.
// 방법: 만료되었거나 5번 틀리면 코드를 버려요(expired). 맞으면 새 식별자를 만들어 해시만 저장하고, 이 기기가 쓰던 등록은 지워요. 식별자는 쿠키로만 내보내요.
function pairDevice(code, previousDeviceId, now) {
  if (pairing.code === null || now > pairing.expiresAt) {
    pairing.code = null;
    return { state: 'expired' };
  }
  if (code !== pairing.code) {
    pairing.tries += 1;
    if (pairing.tries >= PAIR_MAX_TRIES) pairing.code = null;
    return { state: pairing.code === null ? 'expired' : 'wrong' };
  }
  if (previousDeviceId) {
    const previousHash = hashDevice(previousDeviceId);
    db.devices = db.devices.filter((d) => d.tokenHash !== previousHash);
  }
  if (db.devices.length >= MAX_DEVICES) return { state: 'full' };
  const deviceId = crypto.randomBytes(16).toString('hex');
  const device = { id: db.nextDeviceId, label: `기기 ${db.nextDeviceId}`, tokenHash: hashDevice(deviceId), pairedOn: localDate(now) };
  db.nextDeviceId += 1;
  db.devices.push(device);
  pairing.code = null;
  persist();
  return { state: 'paired', label: device.label, deviceId };
}

// 목적: 쿠키의 기기 식별자로 등록된 출석 기기를 찾아요.
// 이유: 등록된 기기만 출석을 찍을 수 있어요.
// 방법: 식별자를 해시해 저장된 tokenHash와 비교해요.
function findDevice(deviceId) {
  const tokenHash = hashDevice(deviceId);
  return db.devices.find((d) => d.tokenHash === tokenHash);
}

// 목적: 출석 기기에서 입력한 번호 뒷 4자리로 학생을 찾아 등원이나 하원을 기록해요.
// 이유: 학생은 학원 기기에 번호를 입력해 출석해요(DEC-10). 같은 숫자의 학생이 여럿이면 이름을 골라야 해요.
// 방법: 퇴원하지 않았고 번호가 그 4자리로 끝나는 학생을 모아요. 없으면 unknown, 여럿이고 고른 학생이 없으면 choose(이름만), 하나로 정해지면 advanceVisit으로 기록해요.
function kioskCheckin(digits, studentId, now) {
  if (typeof digits !== 'string' || !/^\d{4}$/.test(digits)) throw new HttpError(400, '번호 뒷 4자리를 입력해 주세요.');
  const matches = db.students.filter((s) => s.leftOn === null && s.phone !== null && s.phone.endsWith(digits));
  if (matches.length === 0) return { state: 'unknown' };
  let student;
  if (studentId === undefined || studentId === null) {
    if (matches.length > 1) return { state: 'choose', choices: matches.map((s) => ({ id: s.id, name: s.name })) };
    student = matches[0];
  } else {
    student = matches.find((s) => s.id === studentId);
    if (!student) return { state: 'unknown' };
  }
  return { ...advanceVisit(student, now, true), name: student.name };
}

// ───────────────────────── 교사 도메인 로직 ─────────────────────────

// 목적: 교사 화면(TV)에 보낼 전체 상태를 만들어요.
// 이유: TV가 2초마다 이 하나만 읽어 칸, 반 선택, 출석 기기 창을 모두 그려요.
// 방법: 학생마다 오늘 상태를 계산해 필드를 하나씩 담아요. 기기는 해시 없이 이름과 등록일만, 등록 코드는 열려 있을 때만 담아요.
function teacherState(now) {
  const addresses = lanAddresses();
  const address = addresses.length > 0 ? addresses[addressIndex % addresses.length] : null;
  const pairOpen = pairing.code !== null && now <= pairing.expiresAt;
  return {
    rev,
    today: localDate(now),
    students: db.students.map((s) => ({
      id: s.id,
      name: s.name,
      phone: s.phone,
      classIds: [...s.classIds],
      left: s.leftOn !== null,
      ...todayStatus(s, now),
    })),
    classes: db.classes.map((c) => ({ id: c.id, name: c.name })),
    devices: db.devices.map((d) => ({ id: d.id, label: d.label, pairedOn: d.pairedOn })),
    pairing: pairOpen ? { code: pairing.code, expiresInMs: pairing.expiresAt - now } : null,
    kioskUrl: address ? `http://${address}:${PORT}/k` : null,
    address,
    addressCount: addresses.length,
  };
}

// 목적: id로 학생을 찾고 없으면 404를 던진다.
// 이유: 교사 쪽 쓰기 API가 같은 "없는 학생" 처리를 반복하지 않게 한다.
// 방법: id가 정수인지 확인 후 find.
function mustFindStudent(id) {
  const student = Number.isInteger(id) ? db.students.find((s) => s.id === id) : undefined;
  if (!student) throw new HttpError(404, '해당 학생을 찾을 수 없습니다.');
  return student;
}

// 목적: id로 반을 찾고 없으면 404를 던져요.
// 이유: 반 이름 변경과 삭제가 같은 "없는 반" 처리를 써요.
// 방법: id가 정수인지 확인 후 find.
function mustFindClass(id) {
  const found = Number.isInteger(id) ? db.classes.find((c) => c.id === id) : undefined;
  if (!found) throw new HttpError(404, '해당 반을 찾을 수 없습니다.');
  return found;
}

// 목적: 이름 입력값을 저장 가능한 형태로 다듬어요. 학생 이름과 반 이름에 같이 써요.
// 이유: 빈 이름, 너무 긴 이름, 제어 문자가 TV 칸과 표를 망가뜨리지 않게 해요.
// 방법: 문자열이 아니면 400, 제어 문자 제거 후 trim, 비었거나 max자 초과면 400.
function cleanName(value, max = NAME_MAX) {
  if (typeof value !== 'string') throw new HttpError(400, '이름이 올바르지 않습니다.');
  const name = value.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (name.length === 0 || [...name].length > max) {
    throw new HttpError(400, `이름은 1~${max}자로 입력해 주세요.`);
  }
  return name;
}

// 목적: 휴대폰번호 입력값을 숫자만 남긴 형태로 다듬어요. 빈 값은 "번호 없음"이에요.
// 이유: 010-1234-5678처럼 하이픈이나 공백을 넣어 입력해도 같은 번호로 봐야 해요.
// 방법: 숫자 외 문자를 지운 뒤 9~11자리인지 확인해요. 원래 값이 비었으면 null.
function cleanPhone(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') throw new HttpError(400, '휴대폰번호가 올바르지 않습니다.');
  if (value.trim() === '') return null;
  const digits = value.replace(/\D/g, '');
  if (!PHONE_RE.test(digits)) throw new HttpError(400, '휴대폰번호는 숫자 9~11자리로 입력해 주세요.');
  return digits;
}

// 목적: 학생에게 넣을 반 id 목록을 확인해요.
// 이유: 없는 반이나 같은 반이 두 번 들어가면 현황판 반 선택이 어긋나요.
// 방법: 배열인지, 모두 있는 반의 id인지 확인하고 중복을 없애요.
function cleanClassIds(value) {
  if (!Array.isArray(value)) throw new HttpError(400, '반 목록이 올바르지 않습니다.');
  const ids = [...new Set(value)];
  for (const id of ids) mustFindClass(id);
  return ids;
}

// 목적: 붙여넣은 명단 행을 검사해, 추가할 학생과 건너뛸 행을 나눠요. 저장은 하지 않아요.
// 이유: 저장 전에 미리보기를 보여 주고(DEC-12), 적용할 때도 같은 계산을 다시 써서 미리보기와 결과가 어긋나지 않게 해요.
// 방법: 행은 [이름, 번호, 반] 문자열 배열이에요. 이미 있는 이름은 건너뛰고, 형식이 틀린 행은 사유와 함께 모아요. 학생 수와 반 수 한도를 넘으면 409.
function planImport(rows) {
  if (!Array.isArray(rows) || rows.length === 0) throw new HttpError(400, '붙여넣은 명단이 없습니다.');
  if (rows.length > MAX_STUDENTS) throw new HttpError(400, `한 번에 ${MAX_STUDENTS}명까지 붙여넣을 수 있습니다.`);
  const known = new Set(db.students.map((s) => s.name));
  const knownClasses = new Set(db.classes.map((c) => c.name));
  const newClasses = new Set();
  const add = [];
  const exists = [];
  const bad = [];
  rows.forEach((row, index) => {
    const line = index + 1;
    if (!Array.isArray(row) || !row.every((cell) => typeof cell === 'string')) {
      bad.push({ line, reason: '읽을 수 없는 행입니다.' });
      return;
    }
    try {
      const name = cleanName(row[0] ?? '');
      if (known.has(name)) {
        exists.push(name);
        return;
      }
      const phone = cleanPhone(row[1] ?? '');
      const classNames = [...new Set((row[2] ?? '').split(/[,/]/).map((n) => n.trim()).filter(Boolean))]
        .map((n) => cleanName(n, CLASS_NAME_MAX));
      for (const n of classNames) if (!knownClasses.has(n)) newClasses.add(n);
      known.add(name);
      add.push({ name, phone, classNames });
    } catch (e) {
      if (!(e instanceof HttpError)) throw e;
      bad.push({ line, reason: e.message });
    }
  });
  if (db.students.length + add.length > MAX_STUDENTS) {
    throw new HttpError(409, `학생은 최대 ${MAX_STUDENTS}명까지 둘 수 있습니다. 지금 ${db.students.length}명입니다.`);
  }
  if (db.classes.length + newClasses.size > MAX_CLASSES) {
    throw new HttpError(409, `반은 최대 ${MAX_CLASSES}개까지 만들 수 있습니다.`);
  }
  return { add, exists, bad };
}

// 목적: planImport가 정한 학생을 실제로 추가해요.
// 이유: 미리보기를 확인한 뒤에만 명단이 바뀌어야 해요.
// 방법: 없는 반은 이름으로 새로 만들고, 학생을 명단 끝에 붙인 뒤 한 번만 persist해요. 붙여넣기는 추가만 하고 아무도 지우지 않아요.
function applyImport(plan) {
  for (const entry of plan.add) {
    const classIds = entry.classNames.map((n) => {
      let found = db.classes.find((c) => c.name === n);
      if (!found) {
        found = { id: db.nextClassId, name: n };
        db.nextClassId += 1;
        db.classes.push(found);
      }
      return found.id;
    });
    db.students.push({ id: db.nextId, name: entry.name, phone: entry.phone, classIds, leftOn: null });
    db.nextId += 1;
  }
  if (plan.add.length > 0) persist();
}

// 목적: 한 달치 기록을 기록 화면에 보낼 모양으로 만들어요.
// 이유: 상담할 때 한 달을 한 표로 봐요. 퇴원한 학생의 기록도 함께 보여야 해요.
// 방법: 그 달 날짜의 기록만 골라 방문을 필드별로 복사하고, 학생은 번호 없이 이름·반·퇴원일만 담아요.
function monthRecords(month) {
  if (typeof month !== 'string' || !MONTH_RE.test(month)) throw new HttpError(400, '달을 YYYY-MM 형식으로 보내 주세요.');
  const days = {};
  for (const [date, day] of Object.entries(db.records)) {
    if (!date.startsWith(`${month}-`)) continue;
    days[date] = {};
    for (const [id, visits] of Object.entries(day)) {
      days[date][id] = visits.map((v) => ({ in: v.in, out: v.out }));
    }
  }
  return {
    month,
    students: db.students.map((s) => ({ id: s.id, name: s.name, classIds: [...s.classIds], leftOn: s.leftOn })),
    classes: db.classes.map((c) => ({ id: c.id, name: c.name })),
    days,
  };
}

// 목적: 기록 화면에서 고친 하루치 방문 목록을 확인해요.
// 이유: 교사가 하원을 깜빡한 날 등을 고칠 때, 순서가 뒤집히거나 형식이 틀린 기록이 저장되면 안 돼요.
// 방법: 방문마다 등원 시각은 필수, 하원 시각은 비워도 돼요(마지막 방문만). 하원은 등원보다 늦고, 다음 등원은 앞 하원보다 늦어야 해요.
function cleanVisits(value) {
  if (!Array.isArray(value) || value.length > MAX_VISITS_PER_DAY) throw new HttpError(400, '방문 기록이 올바르지 않습니다.');
  const visits = value.map((v, i) => {
    if (!isPlainObject(v) || typeof v.in !== 'string' || !TIME_RE.test(v.in)) {
      throw new HttpError(400, '등원 시각을 HH:MM 형식으로 입력해 주세요.');
    }
    const out = v.out === null || v.out === '' || v.out === undefined ? null : v.out;
    if (out !== null && (typeof out !== 'string' || !TIME_RE.test(out))) {
      throw new HttpError(400, '하원 시각을 HH:MM 형식으로 입력해 주세요.');
    }
    if (out === null && i !== value.length - 1) throw new HttpError(400, '하원 시각은 마지막 방문에서만 비울 수 있습니다.');
    if (out !== null && minutesOf(out) < minutesOf(v.in)) throw new HttpError(400, '하원 시각이 등원 시각보다 빠릅니다.');
    return { in: v.in, out };
  });
  for (let i = 1; i < visits.length; i++) {
    if (minutesOf(visits[i].in) < minutesOf(visits[i - 1].out)) throw new HttpError(400, '방문 시각이 겹칩니다. 시간 순서대로 입력해 주세요.');
  }
  return visits;
}

// 목적: 학생의 하루치 기록을 통째로 바꿔요. 빈 목록이면 그날 기록을 지워요.
// 이유: 교사는 오늘뿐 아니라 어느 날의 시각이든 고칠 수 있어야 해요.
// 방법: 날짜와 학생을 확인하고 cleanVisits를 거친 목록으로 바꿔요. 빈 날짜는 records에서 빼요.
function editRecords(date, studentId, value) {
  if (typeof date !== 'string' || !DATE_RE.test(date)) throw new HttpError(400, '날짜가 올바르지 않습니다.');
  const student = mustFindStudent(studentId);
  const visits = cleanVisits(value);
  if (visits.length > 0) {
    db.records[date] = db.records[date] ?? {};
    db.records[date][student.id] = visits;
  } else if (db.records[date]) {
    delete db.records[date][student.id];
    if (Object.keys(db.records[date]).length === 0) delete db.records[date];
  }
  persist();
}

// 목적: 학생의 기록을 모든 날짜에서 지워요.
// 이유: 학생 삭제는 잘못 등록한 학생을 지우는 용도라 기록도 함께 지워요(DEC-11). 학원을 그만둔 학생은 퇴원으로 처리해요.
// 방법: 날짜마다 그 학생 항목을 빼고, 빈 날짜는 records에서 빼요. persist는 부른 쪽에서 해요.
function removeRecordsOf(studentId) {
  for (const [date, day] of Object.entries(db.records)) {
    delete day[studentId];
    if (Object.keys(day).length === 0) delete db.records[date];
  }
}

// ───────────────────────── HTTP ─────────────────────────

// 목적: 이 요청이 교사 PC(TV를 띄운 브라우저)에서 온 것인지 확인한다.
// 이유: 출석 토글·해제·삭제는 교사만 해야 하는데 별도 로그인이 없어, "PC 본인에서만"을 로그인 대신 쓴다.
// 방법: 소켓 상대 주소가 루프백이고 Host 헤더가 localhost 계열이어야 한다(DNS 리바인딩 방어).
function isTeacherRequest(req) {
  return LOOPBACK_ADDRESSES.has(req.socket.remoteAddress ?? '') && TEACHER_HOSTS.has(req.headers.host ?? '');
}

// 목적: 요청 본문을 JSON 객체로 읽는다.
// 이유: 모든 쓰기 API가 같은 검증(크기, 타입, 형식)을 받게 한다.
// 방법: Content-Type이 application/json이어야 하고(다른 사이트의 폼 전송 차단), 10KB 초과면 413.
async function readJson(req) {
  const type = (req.headers['content-type'] ?? '').split(';')[0].trim();
  if (type !== 'application/json') throw new HttpError(415, 'JSON 요청만 받습니다.');
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > BODY_MAX) throw new HttpError(413, '요청이 너무 큽니다.');
    chunks.push(chunk);
  }
  let body;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    throw new HttpError(400, 'JSON 형식이 올바르지 않습니다.');
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new HttpError(400, '요청 본문은 객체여야 합니다.');
  }
  return body;
}

// 목적: JSON 응답을 보낸다.
// 이유: 상태 코드·헤더(캐시 금지)를 한곳에서 맞춘다.
// 방법: no-store로 캐시를 막고 본문을 JSON으로 직렬화한다.
function sendJson(res, status, body, extraHeaders = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(payload),
    ...extraHeaders,
  });
  res.end(payload);
}

// 목적: 쿠키 헤더에서 출석 기기의 식별자를 꺼내요.
// 이유: 등록된 출석 기기를 알아보는 유일한 단서예요(DEC-10).
// 방법: kid= 값이 32자리 hex일 때만 인정해요.
function readDeviceId(req) {
  const match = /(?:^|;\s*)kid=([0-9a-f]{32})(?:;|$)/.exec(req.headers.cookie ?? '');
  return match ? match[1] : null;
}

// 목적: 출석 기기 쿠키의 Set-Cookie 값을 만들어요.
// 이유: 브라우저가 쿠키 수명을 최대 400일로 자르니, 쓸 때마다 다시 발급해 기기가 계속 등록된 채로 남게 해요.
// 방법: HttpOnly(스크립트에서 못 읽게), SameSite=Lax(다른 사이트 요청에 안 실리게). HTTP라 Secure는 붙일 수 없어요(DEC-08).
function deviceCookie(deviceId) {
  return `kid=${deviceId}; Path=/; Max-Age=${DEVICE_COOKIE_MAX_AGE_S}; HttpOnly; SameSite=Lax`;
}

// 목적: 정적 파일 하나를 응답한다.
// 이유: 화면 HTML과 QR 라이브러리를 같은 서버에서 내려준다.
// 방법: 화이트리스트에 있는 경로만 읽고, 교사 전용 화면은 교사 요청일 때만 내준다.
async function serveStatic(req, res, entry) {
  if (entry.teacherOnly && !isTeacherRequest(req)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(`이 화면은 교사 PC에서 http://localhost:${PORT} 로 열어야 합니다.`);
    return;
  }
  const body = await fsp.readFile(path.join(PUBLIC_DIR, entry.file));
  res.writeHead(200, {
    'Content-Type': entry.type,
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'",
  });
  res.end(body);
}

// 목적: 교사 전용 API를 처리해요.
// 이유: 교사 쓰기 동작은 전부 "루프백 확인 → 변경 → 전체 상태 반환" 한 모양이에요.
// 방법: 교사 요청이 아니면 403. 조회는 GET(상태, 한 달 기록), 나머지는 POST로 db에 반영하고 persist한 뒤 최신 teacherState를 돌려줘요.
async function handleTeacher(req, res, url, now) {
  if (!isTeacherRequest(req)) throw new HttpError(403, '교사 PC에서만 사용할 수 있습니다.');
  const pathname = url.pathname;

  if (req.method === 'GET' && pathname === '/api/state') {
    sendJson(res, 200, teacherState(now));
    return;
  }
  if (req.method === 'GET' && pathname === '/api/records') {
    sendJson(res, 200, monthRecords(url.searchParams.get('month')));
    return;
  }
  if (req.method !== 'POST') throw new HttpError(405, '허용되지 않는 요청입니다.');

  const body = await readJson(req);
  let extra = {};

  switch (pathname) {
    case '/api/toggle': {
      const student = mustFindStudent(body.id);
      if (student.leftOn !== null) throw new HttpError(409, '퇴원한 학생입니다.');
      if (advanceVisit(student, now, false).state === 'already') {
        throw new HttpError(409, `하루 방문은 ${MAX_VISITS_PER_DAY}번까지 기록할 수 있습니다.`);
      }
      break;
    }
    case '/api/rename': {
      const student = mustFindStudent(body.id);
      student.name = cleanName(body.name);
      persist();
      break;
    }
    case '/api/add': {
      if (db.students.length >= MAX_STUDENTS) throw new HttpError(409, `학생은 최대 ${MAX_STUDENTS}명까지 추가할 수 있습니다.`);
      const classIds = body.classId === undefined || body.classId === null ? [] : cleanClassIds([body.classId]);
      const student = { id: db.nextId, name: `학생 ${db.students.length + 1}`, phone: null, classIds, leftOn: null };
      db.nextId += 1;
      db.students.push(student);
      persist();
      extra = { id: student.id };
      break;
    }
    case '/api/delete': {
      const student = mustFindStudent(body.id);
      db.students = db.students.filter((s) => s.id !== student.id);
      removeRecordsOf(student.id);
      persist();
      break;
    }
    case '/api/phone': {
      const student = mustFindStudent(body.id);
      student.phone = cleanPhone(body.phone);
      persist();
      extra = { duplicatePhone: student.phone !== null && db.students.some((s) => s.id !== student.id && s.phone === student.phone) };
      break;
    }
    case '/api/assign': {
      const student = mustFindStudent(body.id);
      student.classIds = cleanClassIds(body.classIds);
      persist();
      break;
    }
    case '/api/leave': {
      // 퇴원하면 번호는 지우고 기록은 남긴다 — 상담에 쓰는 기록이고, 번호는 더 필요 없는 개인정보다.
      const student = mustFindStudent(body.id);
      student.leftOn = localDate(now);
      student.phone = null;
      persist();
      break;
    }
    case '/api/return': {
      const student = mustFindStudent(body.id);
      student.leftOn = null;
      persist();
      break;
    }
    case '/api/classes/add': {
      if (db.classes.length >= MAX_CLASSES) throw new HttpError(409, `반은 최대 ${MAX_CLASSES}개까지 만들 수 있습니다.`);
      const name = cleanName(body.name, CLASS_NAME_MAX);
      if (db.classes.some((c) => c.name === name)) throw new HttpError(409, '같은 이름의 반이 이미 있습니다.');
      db.classes.push({ id: db.nextClassId, name });
      db.nextClassId += 1;
      persist();
      break;
    }
    case '/api/classes/rename': {
      const found = mustFindClass(body.id);
      const name = cleanName(body.name, CLASS_NAME_MAX);
      if (db.classes.some((c) => c.id !== found.id && c.name === name)) throw new HttpError(409, '같은 이름의 반이 이미 있습니다.');
      found.name = name;
      persist();
      break;
    }
    case '/api/classes/delete': {
      const found = mustFindClass(body.id);
      db.classes = db.classes.filter((c) => c.id !== found.id);
      for (const s of db.students) s.classIds = s.classIds.filter((id) => id !== found.id);
      persist();
      break;
    }
    case '/api/import/preview': {
      extra = { preview: planImport(body.rows) };
      break;
    }
    case '/api/import/apply': {
      const plan = planImport(body.rows);
      applyImport(plan);
      extra = { imported: { added: plan.add.length, exists: plan.exists.length, bad: plan.bad.length } };
      break;
    }
    case '/api/records/edit': {
      editRecords(body.date, body.id, body.visits);
      break;
    }
    case '/api/devices/pair': {
      startPairing(now);
      break;
    }
    case '/api/devices/cancel': {
      pairing.code = null;
      break;
    }
    case '/api/devices/revoke': {
      const id = body.id;
      if (!db.devices.some((d) => d.id === id)) throw new HttpError(404, '해당 출석 기기를 찾을 수 없습니다.');
      db.devices = db.devices.filter((d) => d.id !== id);
      persist();
      break;
    }
    case '/api/address/next': {
      addressIndex += 1;
      break;
    }
    default:
      throw new HttpError(404, '없는 API입니다.');
  }

  sendJson(res, 200, { ...teacherState(now), ...extra });
}

// 목적: 출석 기기용 API를 처리해요.
// 이유: 출석 기기는 로그인이 없고, 등록 때 받은 쿠키로만 구분돼요(DEC-10).
// 방법: pair는 등록 코드를 확인하고 쿠키를 발급해요. hello와 checkin은 등록된 기기여야 하고, 아니면 unpaired를 돌려줘요. 등록된 기기에는 쿠키를 매번 다시 발급해요.
async function handleKiosk(req, res, pathname, now) {
  if (req.method !== 'POST') throw new HttpError(405, '허용되지 않는 요청입니다.');
  const body = await readJson(req);
  const deviceId = readDeviceId(req);

  if (pathname === '/api/kiosk/pair') {
    const result = pairDevice(body.code, deviceId, now);
    if (result.state !== 'paired') {
      sendJson(res, 200, { state: result.state });
      return;
    }
    sendJson(res, 200, { state: 'paired', label: result.label }, { 'Set-Cookie': deviceCookie(result.deviceId) });
    return;
  }

  const device = deviceId ? findDevice(deviceId) : undefined;
  if (!device) {
    sendJson(res, 200, { state: 'unpaired' });
    return;
  }
  const headers = { 'Set-Cookie': deviceCookie(deviceId) };

  if (pathname === '/api/kiosk/hello') {
    sendJson(res, 200, { state: 'ready', label: device.label }, headers);
    return;
  }
  if (pathname === '/api/kiosk/checkin') {
    sendJson(res, 200, kioskCheckin(body.digits, body.studentId, now), headers);
    return;
  }
  throw new HttpError(404, '없는 API입니다.');
}

// 목적: 들어오는 모든 요청의 진입점이에요.
// 이유: 정적 파일, 교사 API, 출석 기기 API를 한 서버에서 나눠 주고 오류를 한 모양으로 돌려줘요.
// 방법: 경로로 갈라 처리해요. /api/kiosk/ 밖의 /api/는 전부 교사 쪽이라 기본이 거부예요. HttpError는 그 상태 코드로, 그 밖의 예외는 서버 로그에만 남기고 일반 500으로 응답해요.
async function onRequest(req, res) {
  try {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const pathname = url.pathname;
    const now = Date.now();

    if (req.method === 'GET' && Object.hasOwn(STATIC_FILES, pathname)) {
      await serveStatic(req, res, STATIC_FILES[pathname]);
    } else if (pathname.startsWith('/api/kiosk/')) {
      await handleKiosk(req, res, pathname, now);
    } else if (pathname.startsWith('/api/')) {
      await handleTeacher(req, res, url, now);
    } else {
      throw new HttpError(404, '찾을 수 없습니다.');
    }
  } catch (e) {
    if (e instanceof HttpError) {
      sendJson(res, e.status, { message: e.message });
      return;
    }
    console.error('요청 처리 중 오류', e);
    sendJson(res, 500, { message: '서버 오류가 발생했습니다.' });
  }
}

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

// 목적: 종료 신호를 받으면 쓰던 저장을 마치고 끈다.
// 이유: 마지막 출석 체크가 파일에 쓰이기 전에 프로세스가 죽으면 그 기록을 잃는다.
// 방법: 새 연결을 닫고, 진행 중인 저장 큐가 비면 종료한다.
function shutdown() {
  server.close();
  writeQueue.finally(() => process.exit(0));
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
