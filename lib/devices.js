// 목적: 출석 기기의 일회용 등록 코드, 기기 등록, 기기 찾기, 등록 취소를 맡아요.
// 사용처: lib/teacher.js(코드 열기, 취소, 목록)와 lib/http.js(출석 기기 요청)가 불러 써요.
// 근거: 등록된 기기만 출석할 수 있게 하는 규칙(DEC-10)을 server.js를 나누면서 한 파일로 모았어요(DEC-14).

'use strict';

const crypto = require('node:crypto');
const { PAIR_CODE_TTL_MS, PAIR_MAX_TRIES, MAX_DEVICES } = require('./config');
const { notFound } = require('./errors');
const { getDb, persist } = require('./store');
const { localDate } = require('./time');

const pairing = { code: null, expiresAt: 0, tries: 0 }; // 지금 열려 있는 출석 기기 등록 코드(메모리에만)

// 목적: 쿠키의 기기 식별자를 저장용 해시로 바꾼다.
// 이유: 저장 파일이 새어도 폰에 든 식별자를 그대로 쓸 수는 없게 한다.
// 방법: SHA-256 hex.
function hashDevice(deviceId) {
  return crypto.createHash('sha256').update(deviceId).digest('hex');
}

// 목적: 출석 기기 등록용 6자리 일회용 코드를 새로 만들어요.
// 이유: 등록 절차가 없으면 학원 Wi-Fi의 아무 기기나 출석을 찍을 수 있어요(DEC-10).
// 방법: 암호학적 난수 6자리, 10분 유효. 새로 만들면 이전 코드는 버려요.
function startPairing(now) {
  pairing.code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  pairing.expiresAt = now + PAIR_CODE_TTL_MS;
  pairing.tries = 0;
}

// 목적: 열려 있는 등록 코드를 닫아요.
// 이유: 현황판에서 창을 닫으면 TV에 보였던 코드가 10분 동안 남지 않게 해요.
// 방법: code를 비워요.
function cancelPairing() {
  pairing.code = null;
}

// 목적: 열려 있는 등록 코드를 현황판에 보여 줄 모양으로 돌려줘요.
// 이유: 교사만 코드를 보고, 지난 코드는 보이지 않아야 해요.
// 방법: 코드가 있고 마감 전이면 코드와 남은 시간을, 아니면 null을 돌려줘요.
function pairingView(now) {
  return pairing.code !== null && now <= pairing.expiresAt ? { code: pairing.code, expiresInMs: pairing.expiresAt - now } : null;
}

// 목적: 출석 기기가 입력한 등록 코드를 확인하고, 맞으면 기기를 등록해요.
// 이유: 코드를 본 사람만 기기를 등록할 수 있어야 하고, 코드를 맞힐 때까지 계속 시도할 수는 없어야 해요.
// 방법: 만료되었거나 5번 틀리면 코드를 버려요(expired). 맞으면 새 식별자를 만들어 해시만 저장하고, 이 기기가 쓰던 등록은 지워요. 식별자는 쿠키로만 내보내요.
function pairDevice(code, previousDeviceId, now) {
  const db = getDb();
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
  return getDb().devices.find((d) => d.tokenHash === tokenHash);
}

// 목적: 출석 기기의 등록을 취소해요.
// 이유: 잃어버리거나 바꾼 기기로 더 출석할 수 없어야 해요.
// 방법: id가 없으면 "없음" 업무 오류, 있으면 목록에서 빼고 persist해요.
function revokeDevice(id) {
  const db = getDb();
  if (!db.devices.some((d) => d.id === id)) throw notFound('해당 출석 기기를 찾을 수 없습니다.');
  db.devices = db.devices.filter((d) => d.id !== id);
  persist();
}

module.exports = { startPairing, cancelPairing, pairingView, pairDevice, findDevice, revokeDevice };
