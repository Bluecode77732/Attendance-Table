// 목적: 교사 PC에서 도는 출석 서버. TV 화면과 학생 폰이 같은 출석 데이터를 보게 한다.
// 사용처: `node server.js`(시작 스크립트)로 실행한다. public/ 아래 두 화면(TV, 학생)을 서빙한다.
// 근거: 출석 상태가 브라우저 localStorage에 있으면 학생 폰에서 체크해도 TV에 반영되지 않아 서버가 필요했다.
//       설치 부담을 줄이려 외부 패키지 없이 Node 기본 모듈만 쓴다.

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
const PUBLIC_DIR = path.join(__dirname, 'public');

const CODE_TTL_MS = 30_000; // QR 코드 한 개가 TV에 떠 있는 시간
const CODE_GRACE_MS = 10_000; // 갱신 직후, 직전 코드를 아직 받아 주는 여유(스캔 도중 갱신 대비)
const PENDING_TTL_MS = 120_000; // 이름을 고르는 동안 유지되는 등록 권한
const NAME_MAX = 12;
const MAX_STUDENTS = 200;
const BODY_MAX = 10_000;

// 화이트리스트 방식 정적 서빙 — 요청 경로를 파일 경로로 직접 쓰지 않는다(경로 탈출 방지).
const STATIC_FILES = {
  '/': { file: 'index.html', type: 'text/html; charset=utf-8', teacherOnly: true },
  '/s': { file: 'student.html', type: 'text/html; charset=utf-8', teacherOnly: false },
  '/vendor/qrcode.js': { file: 'vendor/qrcode.js', type: 'text/javascript; charset=utf-8', teacherOnly: false },
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

// 목적: 저장된 명단을 읽어 온다. 없으면 기본 명단, 깨졌으면 파일을 보존하고 기본 명단으로 시작한다.
// 이유: 첫 실행이나 파일 손상에도 서버는 떠야 하고, 손상된 기록을 조용히 덮어써서 잃으면 안 된다.
// 방법: JSON 파싱 후 모양을 검사한다. 모양이 틀리면 data.broken-<시각>.json으로 옮겨 두고 경고한다.
function loadDb() {
  let raw;
  try {
    raw = fs.readFileSync(DATA_FILE, 'utf8');
  } catch (e) {
    if (e.code !== 'ENOENT') console.warn('데이터 파일을 읽지 못해 새로 시작합니다.', e.message);
    return defaultDb();
  }
  try {
    const data = JSON.parse(raw);
    if (isValidDb(data)) return data;
    throw new Error('형식이 올바르지 않습니다');
  } catch (e) {
    const backup = `${DATA_FILE}.broken-${Date.now()}`;
    try {
      fs.renameSync(DATA_FILE, backup);
      console.warn(`데이터 파일이 손상되어 ${path.basename(backup)}로 옮기고 새로 시작합니다. (${e.message})`);
    } catch (renameError) {
      console.warn('손상된 데이터 파일을 옮기지 못했습니다.', renameError.message);
    }
    return defaultDb();
  }
}

// 목적: 처음 실행할 때 쓸 한 페이지 분량(8명)의 명단을 만든다.
// 이유: 빈 화면 대신 바로 써 볼 칸이 있어야 한다.
// 방법: "학생 1"~"학생 8", 전원 미출석·미등록.
function defaultDb() {
  const students = Array.from({ length: 8 }, (_, i) => ({
    id: i + 1,
    name: `학생 ${i + 1}`,
    present: false,
    deviceHash: null,
  }));
  return { students, nextId: 9 };
}

// 목적: 읽어 온 데이터가 기대한 모양인지 확인한다.
// 이유: 손으로 고친 파일이나 옛 버전 파일이 들어와도 서버가 중간에 죽지 않게 한다.
// 방법: students 배열의 각 항목 타입과 nextId, id 중복 여부만 검사한다.
function isValidDb(data) {
  if (typeof data !== 'object' || data === null) return false;
  if (!Array.isArray(data.students) || !Number.isInteger(data.nextId)) return false;
  const ids = new Set();
  for (const s of data.students) {
    if (typeof s !== 'object' || s === null) return false;
    if (!Number.isInteger(s.id) || ids.has(s.id)) return false;
    if (typeof s.name !== 'string' || typeof s.present !== 'boolean') return false;
    if (s.deviceHash !== null && typeof s.deviceHash !== 'string') return false;
    ids.add(s.id);
  }
  return true;
}

let db = loadDb();
let rev = Date.now(); // 변경 때마다 +1. 재시작해도 줄어들지 않게 시각에서 시작한다.
let writeQueue = Promise.resolve();

// 목적: 현재 명단을 디스크에 저장한다.
// 이유: 서버를 껐다 켜도 출석·등록 상태가 남아야 하고, 쓰는 도중 꺼져도 파일이 깨지면 안 된다.
// 방법: 지금 시점의 스냅샷을 만들어 순서대로 임시 파일에 쓴 뒤 rename으로 교체한다(비동기 큐).
function persist() {
  rev += 1;
  const snapshot = JSON.stringify(db);
  const tmp = `${DATA_FILE}.tmp`;
  writeQueue = writeQueue
    .then(async () => {
      await fsp.writeFile(tmp, snapshot, 'utf8');
      await fsp.rename(tmp, DATA_FILE);
    })
    .catch((e) => console.error('데이터를 저장하지 못했습니다.', e.message));
}

// ───────────────────────── QR 코드 ─────────────────────────

const qr = { current: newCode(), previous: null, rotatedAt: Date.now() };

// 목적: 예측할 수 없는 일회용 코드를 만든다.
// 이유: 코드가 짐작 가능하면 TV를 보지 않고도 출석 주소를 만들 수 있다.
// 방법: 암호학적 난수 8바이트를 URL-safe 문자열로 바꾼다.
function newCode() {
  return crypto.randomBytes(8).toString('base64url');
}

// 목적: 코드가 갱신 시점을 지났으면 새 코드로 바꾼다.
// 이유: 타이머 없이 요청이 올 때 갱신해, TV가 꺼진 동안에는 아무 일도 하지 않게 한다.
// 방법: TTL이 지났으면 current를 previous로 밀고 새로 만든다. 오래 쉬었다 온 경우 previous는 버린다.
function rotateIfDue(now) {
  if (now - qr.rotatedAt < CODE_TTL_MS) return;
  const contiguous = now - qr.rotatedAt < CODE_TTL_MS + CODE_GRACE_MS;
  qr.previous = contiguous ? qr.current : null;
  qr.current = newCode();
  qr.rotatedAt = now;
}

// 목적: 학생이 가져온 코드가 지금 유효한지 판단한다.
// 이유: "TV를 봤다"는 증거가 이 코드뿐이라, 만료된 코드를 받아 주면 사진 전달로 우회된다.
// 방법: 현재 코드이거나, 갱신 직후 여유 시간 안의 직전 코드면 유효.
function isValidCode(code, now) {
  rotateIfDue(now);
  if (typeof code !== 'string' || code.length === 0) return false;
  if (code === qr.current) return true;
  return qr.previous !== null && code === qr.previous && now - qr.rotatedAt < CODE_GRACE_MS;
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

// ───────────────────────── 학생 도메인 로직 ─────────────────────────

// 목적: 쿠키의 기기 식별자를 저장용 해시로 바꾼다.
// 이유: 저장 파일이 새어도 폰에 든 식별자를 그대로 쓸 수는 없게 한다.
// 방법: SHA-256 hex.
function hashDevice(deviceId) {
  return crypto.createHash('sha256').update(deviceId).digest('hex');
}

const pending = new Map(); // deviceHash → 이름 고르기 권한 만료 시각

// 목적: 만료된 "이름 고르기 권한"을 치운다.
// 이유: 기기가 계속 늘어나도 메모리가 쌓이지 않게 한다.
// 방법: enter/claim 호출 때마다 만료된 항목을 순회 삭제한다.
function purgePending(now) {
  for (const [key, expiresAt] of pending) {
    if (expiresAt < now) pending.delete(key);
  }
}

// 목적: 학생 목록을 학생 폰에 보여 줄 모양으로 줄인다.
// 이유: 기기 해시 같은 내부 값이 폰으로 나가면 안 된다.
// 방법: id/name/taken(이미 등록됨)만 남긴다.
function studentChoices() {
  return db.students.map((s) => ({ id: s.id, name: s.name, taken: s.deviceHash !== null }));
}

// 목적: QR을 찍고 들어온 학생 폰을 처리한다 — 등록된 폰이면 출석, 아니면 이름 고르기로 안내.
// 이유: "QR만 찍으면 출석"과 "처음 한 번만 이름 선택"을 한 진입점에서 가른다.
// 방법: 유효한 코드가 아니면 invalid. 이 기기가 이미 묶여 있으면 출석 처리(멱등). 아니면 이름 고르기 권한을 잠시 부여.
function studentEnter(deviceHash, code, now) {
  purgePending(now);
  if (!isValidCode(code, now)) return { state: 'invalid' };

  const bound = db.students.find((s) => s.deviceHash === deviceHash);
  if (bound) {
    if (!bound.present) {
      bound.present = true;
      persist();
    }
    return { state: 'done', name: bound.name };
  }

  pending.set(deviceHash, now + PENDING_TTL_MS);
  return { state: 'choose', students: studentChoices() };
}

// 목적: 학생이 고른 이름에 이 기기를 묶고 출석 처리한다.
// 이유: 이름 선점 구조의 핵심 — 먼저 고른 폰이 그 이름을 차지하고, 같은 이름·같은 폰은 한 번뿐이다.
// 방법: 권한이 없으면 invalid, 이미 묶인 기기는 그 이름으로 done, 남이 차지한 이름은 taken(+최신 목록). Node는 단일 스레드라 확인과 대입 사이에 다른 요청이 끼지 않는다.
function studentClaim(deviceHash, studentId, now) {
  purgePending(now);
  const alreadyBound = db.students.find((s) => s.deviceHash === deviceHash);
  if (alreadyBound) return { state: 'done', name: alreadyBound.name };

  const expiresAt = pending.get(deviceHash);
  if (expiresAt === undefined || expiresAt < now) return { state: 'invalid' };

  const student = db.students.find((s) => s.id === studentId);
  if (!student) return { state: 'gone', students: studentChoices() };
  if (student.deviceHash !== null) return { state: 'taken', students: studentChoices() };

  student.deviceHash = deviceHash;
  student.present = true;
  pending.delete(deviceHash);
  persist();
  return { state: 'done', name: student.name };
}

// ───────────────────────── 교사 도메인 로직 ─────────────────────────

// 목적: 교사 화면(TV)에 보낼 전체 상태를 만든다.
// 이유: TV가 2초마다 이 하나만 읽어 칸·QR·카운트다운을 모두 그린다.
// 방법: 명단(기기 해시는 bound 여부로만), 현재 QR 주소, 갱신까지 남은 시간, 주소 후보를 담는다.
function teacherState(now) {
  rotateIfDue(now);
  const addresses = lanAddresses();
  const address = addresses.length > 0 ? addresses[addressIndex % addresses.length] : null;
  return {
    rev,
    students: db.students.map((s) => ({ id: s.id, name: s.name, present: s.present, bound: s.deviceHash !== null })),
    joinUrl: address ? `http://${address}:${PORT}/s?c=${qr.current}` : null,
    address,
    addressCount: addresses.length,
    codeExpiresInMs: Math.max(0, qr.rotatedAt + CODE_TTL_MS - now),
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

// 목적: 이름 입력값을 저장 가능한 형태로 다듬는다.
// 이유: 빈 이름·너무 긴 이름·제어 문자가 TV 화면 칸을 망가뜨리지 않게 한다.
// 방법: 문자열이 아니면 400, 제어 문자 제거 후 trim, 비었거나 12자 초과면 400.
function cleanName(value) {
  if (typeof value !== 'string') throw new HttpError(400, '이름이 올바르지 않습니다.');
  const name = value.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (name.length === 0 || [...name].length > NAME_MAX) {
    throw new HttpError(400, `이름은 1~${NAME_MAX}자로 입력해 주세요.`);
  }
  return name;
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

// 목적: 쿠키 헤더에서 이 기기의 식별자를 꺼낸다.
// 이유: 학생 폰을 "이름에 묶인 기기"로 알아보는 유일한 단서다.
// 방법: did= 값이 32자리 hex일 때만 인정한다.
function readDeviceId(req) {
  const match = /(?:^|;\s*)did=([0-9a-f]{32})(?:;|$)/.exec(req.headers.cookie ?? '');
  return match ? match[1] : null;
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

// 목적: 교사 전용 API를 처리한다.
// 이유: 교사 쓰기 동작은 전부 "루프백 확인 → 변경 → 전체 상태 반환" 한 모양이다.
// 방법: 교사 요청이 아니면 403. 동작을 db에 반영하고 persist한 뒤 최신 teacherState를 돌려준다.
async function handleTeacher(req, res, pathname, now) {
  if (!isTeacherRequest(req)) throw new HttpError(403, '교사 PC에서만 사용할 수 있습니다.');

  if (req.method === 'GET' && pathname === '/api/state') {
    sendJson(res, 200, teacherState(now));
    return;
  }
  if (req.method !== 'POST') throw new HttpError(405, '허용되지 않는 요청입니다.');

  const body = await readJson(req);
  let extra = {};

  switch (pathname) {
    case '/api/toggle': {
      const student = mustFindStudent(body.id);
      student.present = !student.present;
      persist();
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
      const student = { id: db.nextId, name: `학생 ${db.students.length + 1}`, present: false, deviceHash: null };
      db.nextId += 1;
      db.students.push(student);
      persist();
      extra = { id: student.id };
      break;
    }
    case '/api/delete': {
      const student = mustFindStudent(body.id);
      db.students = db.students.filter((s) => s.id !== student.id);
      persist();
      break;
    }
    case '/api/release': {
      // 잘못 묶인 기기를 풀 때 그 기기가 남긴 출석도 함께 지운다 — 남이 대신 찍은 출석일 수 있다.
      const student = mustFindStudent(body.id);
      student.deviceHash = null;
      student.present = false;
      persist();
      break;
    }
    case '/api/reset': {
      for (const student of db.students) student.present = false;
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

// 목적: 학생 폰용 API를 처리한다.
// 이유: 학생은 로그인이 없고 쿠키의 기기 식별자와 QR 코드만으로 구분된다.
// 방법: enter는 쿠키가 없으면 새 식별자를 발급해 Set-Cookie로 내려준다. claim은 이미 식별자가 있어야 한다.
async function handleStudent(req, res, pathname, now) {
  if (req.method !== 'POST') throw new HttpError(405, '허용되지 않는 요청입니다.');
  const body = await readJson(req);

  if (pathname === '/api/student/enter') {
    let deviceId = readDeviceId(req);
    const headers = {};
    if (!deviceId) {
      deviceId = crypto.randomBytes(16).toString('hex');
      headers['Set-Cookie'] = `did=${deviceId}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax`;
    }
    sendJson(res, 200, studentEnter(hashDevice(deviceId), body.code, now), headers);
    return;
  }

  if (pathname === '/api/student/claim') {
    const deviceId = readDeviceId(req);
    if (!deviceId) {
      sendJson(res, 200, { state: 'invalid' });
      return;
    }
    sendJson(res, 200, studentClaim(hashDevice(deviceId), body.studentId, now));
    return;
  }

  throw new HttpError(404, '없는 API입니다.');
}

// 목적: 들어오는 모든 요청의 진입점.
// 이유: 정적 파일, 교사 API, 학생 API를 한 서버에서 나눠 주고 오류를 한 모양으로 돌려준다.
// 방법: 경로로 갈라서 처리하고, HttpError는 그 상태 코드로, 그 밖의 예외는 서버 로그에만 남기고 일반 500으로 응답한다.
async function onRequest(req, res) {
  try {
    const { pathname } = new URL(req.url ?? '/', 'http://localhost');
    const now = Date.now();

    if (req.method === 'GET' && Object.hasOwn(STATIC_FILES, pathname)) {
      await serveStatic(req, res, STATIC_FILES[pathname]);
    } else if (pathname.startsWith('/api/student/')) {
      await handleStudent(req, res, pathname, now);
    } else if (pathname.startsWith('/api/')) {
      await handleTeacher(req, res, pathname, now);
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
  console.log('출석부 서버가 켜졌습니다.');
  console.log(`  교사 화면(TV): http://localhost:${PORT}`);
  console.log(`  학생 접속 주소: ${addresses.length > 0 ? addresses.map((a) => `http://${a}:${PORT}`).join(', ') : '(같은 네트워크 주소를 찾지 못했습니다)'}`);
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
