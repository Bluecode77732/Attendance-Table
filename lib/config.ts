// 목적: 환경 변수, 경로, 시간·크기 상수, 형식 검사용 정규식을 한곳에 모읍니다.
// 사용처: lib/ 아래 모든 파일과 server.ts가 불러 씁니다.
// 근거: server.js를 기능별 파일로 나누면서(DEC-14) 여러 파일이 같은 값을 써서, 값마다 정의가 하나만 있게 따로 뺐습니다.

import path from 'node:path';

const ROOT = path.join(import.meta.dirname, '..');

export const PORT = Number(process.env.PORT) || 8080;
export const DATA_FILE = process.env.DATA_FILE || path.join(ROOT, 'data.json');
export const BACKUP_DIR = path.join(path.dirname(DATA_FILE), 'backup');
export const PUBLIC_DIR = path.join(ROOT, 'public');

export const DATA_VERSION = 2;
export const REPEAT_WINDOW_MIN = 10; // 직전 입력 후 이 시간 안의 입력은 반복으로 봅니다(두 번 누름 대비)
export const PAIR_CODE_TTL_MS = 10 * 60_000; // 출석 기기 등록 코드가 유효한 시간
export const PAIR_MAX_TRIES = 5; // 등록 코드를 이만큼 틀리면 그 코드를 버립니다
export const DEVICE_COOKIE_MAX_AGE_S = 34_560_000; // 400일. 브라우저가 받아 주는 최대치라 출석할 때마다 다시 발급합니다
export const BACKUP_KEEP = 30;
export const NAME_MAX = 12;
export const CLASS_NAME_MAX = 20;
export const MAX_STUDENTS = 500;
export const MAX_CLASSES = 50;
export const MAX_DEVICES = 20;
export const MAX_VISITS_PER_DAY = 10;
export const BODY_MAX = 64_000; // 500명 한 번 붙여넣기(반 이름이 길면 약 40KB)가 들어가는 크기. 끝없는 요청에 메모리가 바닥나지 않게 상한은 둡니다

export const DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
export const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
export const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
export const PHONE_RE = /^\d{9,11}$/;
export const HASH_RE = /^[0-9a-f]{64}$/;
export const BACKUP_NAME_RE = /^data-\d{4}-\d{2}-\d{2}\.json$/;
