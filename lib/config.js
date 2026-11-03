// 목적: 환경 변수, 경로, 시간·크기 상수, 형식 검사용 정규식을 한곳에 모읍니다.
// 사용처: lib/ 아래 모든 파일과 server.js가 불러 씁니다.
// 근거: server.js를 기능별 파일로 나누면서(DEC-14) 여러 파일이 같은 값을 써서, 값마다 정의가 하나만 있게 따로 뺐습니다.

'use strict';

const path = require('node:path');

const ROOT = path.join(__dirname, '..');

const PORT = Number(process.env.PORT) || 8080;
const DATA_FILE = process.env.DATA_FILE || path.join(ROOT, 'data.json');
const BACKUP_DIR = path.join(path.dirname(DATA_FILE), 'backup');
const PUBLIC_DIR = path.join(ROOT, 'public');

const DATA_VERSION = 2;
const REPEAT_WINDOW_MIN = 10; // 직전 입력 후 이 시간 안의 입력은 반복으로 봅니다(두 번 누름 대비)
const PAIR_CODE_TTL_MS = 10 * 60_000; // 출석 기기 등록 코드가 유효한 시간
const PAIR_MAX_TRIES = 5; // 등록 코드를 이만큼 틀리면 그 코드를 버립니다
const DEVICE_COOKIE_MAX_AGE_S = 34_560_000; // 400일. 브라우저가 받아 주는 최대치라 출석할 때마다 다시 발급합니다
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

module.exports = {
  PORT,
  DATA_FILE,
  BACKUP_DIR,
  PUBLIC_DIR,
  DATA_VERSION,
  REPEAT_WINDOW_MIN,
  PAIR_CODE_TTL_MS,
  PAIR_MAX_TRIES,
  DEVICE_COOKIE_MAX_AGE_S,
  BACKUP_KEEP,
  NAME_MAX,
  CLASS_NAME_MAX,
  MAX_STUDENTS,
  MAX_CLASSES,
  MAX_DEVICES,
  MAX_VISITS_PER_DAY,
  BODY_MAX,
  DATE_RE,
  MONTH_RE,
  TIME_RE,
  PHONE_RE,
  HASH_RE,
  BACKUP_NAME_RE,
};
