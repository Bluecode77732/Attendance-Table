// 목적: 요청을 받아 교사 API, 출석 기기 API, 정적 파일로 나누고, 결과와 오류를 응답으로 알리는 창구입니다.
// 사용처: server.ts가 onRequest를 http 서버에 넘깁니다.
// 근거: 업무 판단은 lib/의 업무 파일이 하고, 이 파일은 교사 확인·요청 읽기·응답 번호만 맡도록 server.js를 나눴습니다(DEC-14).

import fsp from 'node:fs/promises';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { PORT, PUBLIC_DIR, BODY_MAX, DEVICE_COOKIE_MAX_AGE_S } from './config.ts';
import { DomainError, type DomainErrorKind } from './errors.ts';
import * as teacher from './teacher.ts';
import * as devices from './devices.ts';
import { kioskCheckin } from './checkin.ts';

// 업무 오류 종류를 응답 번호로 바꾸는 표. 업무 파일은 이 번호를 모릅니다.
const DOMAIN_STATUS: Record<DomainErrorKind, number> = { invalid: 400, notFound: 404, conflict: 409 };

interface StaticEntry {
  file: string;
  type: string;
  teacherOnly: boolean;
}

// 화이트리스트 방식 정적 서빙. 요청 경로를 파일 경로로 직접 쓰지 않습니다(경로 탈출 방지).
const STATIC_FILES: Record<string, StaticEntry> = {
  '/': { file: 'index.html', type: 'text/html; charset=utf-8', teacherOnly: true },
  '/records': { file: 'records.html', type: 'text/html; charset=utf-8', teacherOnly: true },
  '/k': { file: 'kiosk.html', type: 'text/html; charset=utf-8', teacherOnly: false },
  '/js/common.js': { file: 'js/common.js', type: 'text/javascript; charset=utf-8', teacherOnly: false },
  '/js/board.js': { file: 'js/board.js', type: 'text/javascript; charset=utf-8', teacherOnly: true },
  '/js/records.js': { file: 'js/records.js', type: 'text/javascript; charset=utf-8', teacherOnly: true },
  '/js/kiosk.js': { file: 'js/kiosk.js', type: 'text/javascript; charset=utf-8', teacherOnly: false },
  '/css/board.css': { file: 'css/board.css', type: 'text/css; charset=utf-8', teacherOnly: true },
  '/css/records.css': { file: 'css/records.css', type: 'text/css; charset=utf-8', teacherOnly: true },
  '/css/kiosk.css': { file: 'css/kiosk.css', type: 'text/css; charset=utf-8', teacherOnly: false },
  '/vendor/qrcode.js': { file: 'vendor/qrcode.js', type: 'text/javascript; charset=utf-8', teacherOnly: true },
};

const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const TEACHER_HOSTS = new Set([`localhost:${PORT}`, `127.0.0.1:${PORT}`, `[::1]:${PORT}`]);

class HttpError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

type Body = Record<string, unknown>;

// 목적: 이 요청이 교사 PC(TV를 띄운 브라우저)에서 온 것인지 확인합니다.
// 이유: 출석 토글·해제·삭제는 교사만 해야 하는데 별도 로그인이 없어, "PC 본인에서만"을 로그인 대신 씁니다.
// 방법: 소켓 상대 주소가 루프백이고 Host 헤더가 localhost 계열이어야 합니다(DNS 리바인딩 방어).
function isTeacherRequest(req: IncomingMessage): boolean {
  return LOOPBACK_ADDRESSES.has(req.socket.remoteAddress ?? '') && TEACHER_HOSTS.has(req.headers.host ?? '');
}

// 목적: 요청 본문을 JSON 객체로 읽습니다.
// 이유: 모든 쓰기 API가 같은 검증(크기, 타입, 형식)을 받게 합니다.
// 방법: Content-Type이 application/json이어야 하고(다른 사이트의 폼 전송 차단), BODY_MAX(64KB) 초과면 413.
async function readJson(req: IncomingMessage): Promise<Body> {
  const type = (req.headers['content-type'] ?? '').split(';')[0].trim();
  if (type !== 'application/json') throw new HttpError(415, 'JSON 요청만 받습니다.');
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > BODY_MAX) throw new HttpError(413, '요청이 너무 큽니다.');
    chunks.push(chunk);
  }
  let body: unknown;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    throw new HttpError(400, 'JSON 형식이 올바르지 않습니다.');
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new HttpError(400, '요청 본문은 객체여야 합니다.');
  }
  return body as Body;
}

// 목적: JSON 응답을 보냅니다.
// 이유: 상태 코드·헤더(캐시 금지)를 한곳에서 맞춥니다.
// 방법: no-store로 캐시를 막고 본문을 JSON으로 직렬화합니다.
function sendJson(res: ServerResponse, status: number, body: unknown, extraHeaders: Record<string, string> = {}): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(payload),
    ...extraHeaders,
  });
  res.end(payload);
}

// 목적: 쿠키 헤더에서 출석 기기의 식별자를 꺼냅니다.
// 이유: 등록된 출석 기기를 알아보는 유일한 단서입니다(DEC-10).
// 방법: kid= 값이 32자리 hex일 때만 인정합니다.
function readDeviceId(req: IncomingMessage): string | null {
  const match = /(?:^|;\s*)kid=([0-9a-f]{32})(?:;|$)/.exec(req.headers.cookie ?? '');
  return match ? match[1] : null;
}

// 목적: 출석 기기 쿠키의 Set-Cookie 값을 만듭니다.
// 이유: 브라우저가 쿠키 수명을 최대 400일로 자르니, 쓸 때마다 다시 발급해 기기가 계속 등록된 채로 남게 합니다.
// 방법: HttpOnly(스크립트에서 못 읽게), SameSite=Lax(다른 사이트 요청에 안 실리게). HTTP라 Secure는 붙일 수 없습니다(DEC-08).
function deviceCookie(deviceId: string): string {
  return `kid=${deviceId}; Path=/; Max-Age=${DEVICE_COOKIE_MAX_AGE_S}; HttpOnly; SameSite=Lax`;
}

// 목적: 정적 파일 하나를 응답합니다.
// 이유: 화면 HTML, 화면 스크립트·CSS, QR 라이브러리를 같은 서버에서 내려줍니다.
// 방법: 화이트리스트에 있는 경로만 읽고, 교사 전용 파일은 교사 요청일 때만 내줍니다. CSP는 서버가 내준 파일의 스크립트·스타일만 허용합니다(DEC-14).
async function serveStatic(req: IncomingMessage, res: ServerResponse, entry: StaticEntry): Promise<void> {
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
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; frame-ancestors 'none'",
  });
  res.end(body);
}

// 목적: 교사 전용 API를 처리합니다.
// 이유: 교사 쓰기 동작은 전부 "교사 확인 → 동작 → 전체 상태 반환" 한 모양입니다. 동작 자체는 lib/teacher.ts가 맡습니다.
// 방법: 교사 요청이 아니면 403. 조회는 GET(상태, 한 달 기록, 한 달 기록 파일), 나머지는 POST로 경로에 맞는 teacher 함수를 부른 뒤 최신 teacherState를 돌려줍니다. 기록 파일은 JSON이 아니라 내려받기(attachment)로 보내고, 한글 파일 이름은 filename*에 담습니다.
async function handleTeacher(req: IncomingMessage, res: ServerResponse, url: URL, now: number): Promise<void> {
  if (!isTeacherRequest(req)) throw new HttpError(403, '교사 PC에서만 사용할 수 있습니다.');
  const pathname = url.pathname;

  if (req.method === 'GET' && pathname === '/api/state') {
    sendJson(res, 200, teacher.teacherState(now));
    return;
  }
  if (req.method === 'GET' && pathname === '/api/records') {
    sendJson(res, 200, teacher.monthRecords(url.searchParams.get('month')));
    return;
  }
  if (req.method === 'GET' && pathname === '/api/records/csv') {
    const month = url.searchParams.get('month');
    const body = Buffer.from(teacher.monthCsv(month), 'utf8');
    res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="records-${month}.csv"; filename*=UTF-8''${encodeURIComponent(`출석기록-${month}.csv`)}`,
      'Content-Length': body.length,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(body);
    return;
  }
  if (req.method !== 'POST') throw new HttpError(405, '허용되지 않는 요청입니다.');

  const body = await readJson(req);
  let extra: Record<string, unknown> = {};

  switch (pathname) {
    case '/api/toggle': teacher.toggle(body.id, now); break;
    case '/api/rename': teacher.rename(body.id, body.name); break;
    case '/api/add': extra = { id: teacher.addStudent(body.classId) }; break;
    case '/api/delete': teacher.deleteStudent(body.id); break;
    case '/api/phone': extra = { duplicatePhone: teacher.setPhone(body.id, body.phone) }; break;
    case '/api/assign': teacher.assignClasses(body.id, body.classIds); break;
    case '/api/leave': teacher.leaveStudent(body.id, now); break;
    case '/api/return': teacher.returnStudent(body.id); break;
    case '/api/classes/add': teacher.addClass(body.name); break;
    case '/api/classes/rename': teacher.renameClass(body.id, body.name); break;
    case '/api/classes/delete': teacher.deleteClass(body.id); break;
    case '/api/academy/rename': teacher.renameAcademy(body.name); break;
    case '/api/import/preview': extra = { preview: teacher.previewImport(body.rows) }; break;
    case '/api/import/apply': extra = { imported: teacher.importRows(body.rows) }; break;
    case '/api/records/edit': teacher.editRecords(body.date, body.id, body.visits); break;
    case '/api/devices/pair': teacher.openPairing(now); break;
    case '/api/devices/cancel': teacher.closePairing(); break;
    case '/api/devices/revoke': teacher.revokeDevice(body.id); break;
    case '/api/address/next': teacher.nextAddress(); break;
    case '/api/page/open': teacher.pageOpen(body.pageId); break;
    case '/api/page/close': teacher.pageClose(body.pageId); break;
    default:
      throw new HttpError(404, '없는 API입니다.');
  }

  sendJson(res, 200, { ...teacher.teacherState(now), ...extra });
}

// 목적: 출석 기기용 API를 처리합니다.
// 이유: 출석 기기는 로그인이 없고, 등록 때 받은 쿠키로만 구분됩니다(DEC-10).
// 방법: pair는 등록 코드를 확인하고 쿠키를 발급합니다. hello와 checkin은 등록된 기기여야 하고, 아니면 unpaired를 돌려줍니다. 등록된 기기에는 쿠키를 매번 다시 발급하고, 위쪽 띠에 쓸 학원 이름을 함께 보냅니다(등록되지 않은 기기에는 보내지 않습니다).
async function handleKiosk(req: IncomingMessage, res: ServerResponse, pathname: string, now: number): Promise<void> {
  if (req.method !== 'POST') throw new HttpError(405, '허용되지 않는 요청입니다.');
  const body = await readJson(req);
  const deviceId = readDeviceId(req);

  if (pathname === '/api/kiosk/pair') {
    const result = devices.pairDevice(body.code, deviceId, now);
    if (result.state !== 'paired') {
      sendJson(res, 200, { state: result.state });
      return;
    }
    sendJson(res, 200, { state: 'paired', label: result.label, academyName: teacher.academyName() }, { 'Set-Cookie': deviceCookie(result.deviceId) });
    return;
  }

  const device = deviceId ? devices.findDevice(deviceId) : undefined;
  if (!deviceId || !device) {
    sendJson(res, 200, { state: 'unpaired' });
    return;
  }
  const headers = { 'Set-Cookie': deviceCookie(deviceId) };

  if (pathname === '/api/kiosk/hello') {
    sendJson(res, 200, { state: 'ready', label: device.label, academyName: teacher.academyName() }, headers);
    return;
  }
  if (pathname === '/api/kiosk/checkin') {
    sendJson(res, 200, { ...kioskCheckin(body.digits, body.studentId, now), academyName: teacher.academyName() }, headers);
    return;
  }
  throw new HttpError(404, '없는 API입니다.');
}

// 목적: 들어오는 모든 요청의 진입점입니다.
// 이유: 정적 파일, 교사 API, 출석 기기 API를 한 서버에서 나눠 주고 오류를 한 모양으로 돌려줍니다.
// 방법: 경로로 갈라 처리합니다. /api/kiosk/ 밖의 /api/는 전부 교사 쪽이라 기본이 거부입니다. 업무 오류는 종류에 맞는 번호로, HttpError는 그 번호로, 그 밖의 예외는 서버 로그에만 남기고 일반 500으로 응답합니다.
export async function onRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
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
    if (e instanceof DomainError) {
      sendJson(res, DOMAIN_STATUS[e.kind], { message: e.message });
      return;
    }
    if (e instanceof HttpError) {
      sendJson(res, e.status, { message: e.message });
      return;
    }
    console.error('요청 처리 중 오류', e);
    sendJson(res, 500, { message: '서버 오류가 발생했습니다.' });
  }
}
