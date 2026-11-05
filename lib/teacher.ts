// 목적: 교사가 현황판과 기록 화면에서 하는 동작(출석 바꾸기, 학생·반·번호·퇴원, 붙여넣기, 기록 수정, 기기 관리)과 현황판 상태를 맡습니다.
// 사용처: lib/http.ts의 교사 API가 경로마다 여기 함수를 하나씩 부릅니다.
// 근거: 이 동작들이 HTTP 처리(switch) 안에 섞여 있던 것을 server.js를 나누면서 꺼냈습니다(DEC-14). http.ts는 받고 알리기만 합니다.

import { PORT, MAX_STUDENTS, MAX_CLASSES, MAX_VISITS_PER_DAY, CLASS_NAME_MAX, ACADEMY_NAME_MAX, PAGE_CLOSE_GRACE_MS, MAX_OPEN_PAGES, PAGE_ID_RE } from './config.ts';
import { conflict, invalid } from './errors.ts';
import { getDb, getRev, persist } from './store.ts';
import { localDate } from './time.ts';
import * as roster from './roster.ts';
import * as records from './records.ts';
import * as devices from './devices.ts';
import * as network from './network.ts';
import type { Student, TeacherState } from './types.ts';

export { planImport as previewImport } from './roster.ts';
export { monthRecords, editRecords } from './records.ts';
export { startPairing as openPairing, cancelPairing as closePairing, revokeDevice } from './devices.ts';
export { nextAddress } from './network.ts';

// 목적: 교사 화면(TV)에 보낼 전체 상태를 만듭니다.
// 이유: TV가 2초마다 이 하나만 읽어 칸, 반 선택, 출석 기기 창을 모두 그립니다.
// 방법: 학생마다 오늘 상태를 계산해 필드를 하나씩 담습니다. 기기는 해시 없이 이름과 등록일만, 등록 코드는 열려 있을 때만 담습니다.
export function teacherState(now: number): TeacherState {
  const db = getDb();
  const { address, count } = network.currentAddress();
  return {
    rev: getRev(),
    today: localDate(now),
    academyName: db.academyName,
    students: db.students.map((s) => ({
      id: s.id,
      name: s.name,
      phone: s.phone,
      classIds: [...s.classIds],
      left: s.leftOn !== null,
      ...records.todayStatus(s, now),
    })),
    classes: db.classes.map((c) => ({ id: c.id, name: c.name })),
    devices: db.devices.map((d) => ({ id: d.id, label: d.label, pairedOn: d.pairedOn })),
    pairing: devices.pairingView(now),
    kioskUrl: address ? `http://${address}:${PORT}/k` : null,
    address,
    addressCount: count,
  };
}

// 목적: 현황판 칸을 눌렀을 때 학생의 오늘 기록을 한 단계 앞으로 보냅니다.
// 이유: 교사가 출석 기기 없이 직접 바꿀 수 있어야 하고, 앞으로만 가서 잘못 눌러도 시각이 지워지지 않습니다.
// 방법: 퇴원한 학생이면 "상태와 맞지 않음", 하루 방문 한도를 넘으면 같은 오류입니다. 10분 반복 구간은 보지 않습니다.
export function toggle(id: unknown, now: number): void {
  const student = roster.mustFindStudent(id);
  if (student.leftOn !== null) throw conflict('퇴원한 학생입니다.');
  if (records.advanceVisit(student, now, false).state === 'already') {
    throw conflict(`하루 방문은 ${MAX_VISITS_PER_DAY}번까지 기록할 수 있습니다.`);
  }
}

// 목적: 학생 이름을 바꿉니다.
// 이유: 현황판 칸에서 이름을 바로 고칩니다.
// 방법: 이름을 다듬어 넣고 persist합니다.
export function rename(id: unknown, name: unknown): void {
  const student = roster.mustFindStudent(id);
  student.name = roster.cleanName(name);
  persist();
}

// 목적: "학생 N" 이름으로 학생 한 명을 명단 끝에 추가하고 그 id를 돌려줍니다.
// 이유: 붙여넣기 뒤에 한 명씩 추가하는 경로입니다(DEC-12). 반을 고른 상태면 그 반에 넣어야 바로 보입니다.
// 방법: 학생 수 한도를 먼저 보고, 반 id가 있으면 확인해 넣은 뒤 persist합니다.
export function addStudent(classId: unknown): number {
  const db = getDb();
  if (db.students.length >= MAX_STUDENTS) throw conflict(`학생은 최대 ${MAX_STUDENTS}명까지 추가할 수 있습니다.`);
  const classIds = classId === undefined || classId === null ? [] : roster.cleanClassIds([classId]);
  const student: Student = { id: db.nextId, name: `학생 ${db.students.length + 1}`, phone: null, classIds, leftOn: null };
  db.nextId += 1;
  db.students.push(student);
  persist();
  return student.id;
}

// 목적: 학생과 그 학생의 기록을 지웁니다.
// 이유: 잘못 등록한 학생을 지우는 용도입니다(DEC-11). 학원을 그만둔 학생은 퇴원으로 처리합니다.
// 방법: 명단에서 빼고, 모든 날짜의 기록을 지운 뒤 persist합니다.
export function deleteStudent(id: unknown): void {
  const db = getDb();
  const student = roster.mustFindStudent(id);
  db.students = db.students.filter((s) => s.id !== student.id);
  records.removeRecordsOf(student.id);
  persist();
}

// 목적: 학생 번호를 바꾸고, 같은 번호의 다른 학생이 있는지 알려 줍니다.
// 이유: 형제자매가 같은 번호를 쓸 수 있어서 막지 않고 알리기만 합니다.
// 방법: 번호를 다듬어 넣고 persist한 뒤, 같은 번호의 다른 학생이 있으면 true를 돌려줍니다.
export function setPhone(id: unknown, phone: unknown): boolean {
  const student = roster.mustFindStudent(id);
  student.phone = roster.cleanPhone(phone);
  persist();
  return student.phone !== null && getDb().students.some((s) => s.id !== student.id && s.phone === student.phone);
}

// 목적: 학생이 속한 반을 바꿉니다.
// 이유: 현황판의 "정보" 창에서 반을 체크하면 바로 저장됩니다.
// 방법: 반 id 목록을 확인해 넣고 persist합니다.
export function assignClasses(id: unknown, classIds: unknown): void {
  const student = roster.mustFindStudent(id);
  student.classIds = roster.cleanClassIds(classIds);
  persist();
}

// 목적: 학생을 퇴원 처리합니다.
// 이유: 현황판과 출석 기기에서는 빼되 상담용 기록은 남깁니다. 번호는 더 필요 없는 개인정보라 지웁니다(DEC-11).
// 방법: 퇴원일을 오늘로 넣고 번호를 비운 뒤 persist합니다.
export function leaveStudent(id: unknown, now: number): void {
  const student = roster.mustFindStudent(id);
  student.leftOn = localDate(now);
  student.phone = null;
  persist();
}

// 목적: 퇴원한 학생을 다시 재원으로 돌립니다.
// 이유: 다시 다니게 된 학생을 새로 등록하지 않고 예전 기록을 이어 쓰게 합니다.
// 방법: 퇴원일을 비우고 persist합니다. 번호는 교사가 다시 넣습니다.
export function returnStudent(id: unknown): void {
  const student = roster.mustFindStudent(id);
  student.leftOn = null;
  persist();
}

// 목적: 새 반을 만듭니다.
// 이유: 타임(반)별로 현황판과 기록을 나눠 봅니다.
// 방법: 반 수 한도, 이름 다듬기, 이름 중복 순으로 확인하고 persist합니다.
export function addClass(name: unknown): void {
  const db = getDb();
  if (db.classes.length >= MAX_CLASSES) throw conflict(`반은 최대 ${MAX_CLASSES}개까지 만들 수 있습니다.`);
  const clean = roster.cleanName(name, CLASS_NAME_MAX);
  if (db.classes.some((c) => c.name === clean)) throw conflict('같은 이름의 반이 이미 있습니다.');
  db.classes.push({ id: db.nextClassId, name: clean });
  db.nextClassId += 1;
  persist();
}

// 목적: 반 이름을 바꿉니다.
// 이유: "3시 타임"처럼 반 이름이 바뀌어도 학생 배정은 그대로여야 합니다.
// 방법: 이름을 다듬고, 다른 반과 겹치면 "상태와 맞지 않음", 아니면 바꾸고 persist합니다.
export function renameClass(id: unknown, name: unknown): void {
  const found = roster.mustFindClass(id);
  const clean = roster.cleanName(name, CLASS_NAME_MAX);
  if (getDb().classes.some((c) => c.id !== found.id && c.name === clean)) throw conflict('같은 이름의 반이 이미 있습니다.');
  found.name = clean;
  persist();
}

// 목적: 현황판 머리줄에서 고친 학원 이름을 저장합니다. 빈칸이면 이름을 지웁니다.
// 이유: 원장이 학원 이름을 직접 넣고 바꿀 수 있어야 합니다(DEC-17).
// 방법: 제어 문자를 빼고 앞뒤 공백을 지운 뒤 ACADEMY_NAME_MAX자 이내인지 봅니다. 이름이 그대로면 저장하지 않아 같은 요청이 두 번 와도 결과가 같습니다.
export function renameAcademy(name: unknown): void {
  if (typeof name !== 'string') throw invalid('학원 이름이 올바르지 않습니다.');
  const clean = name.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if ([...clean].length > ACADEMY_NAME_MAX) throw invalid(`학원 이름은 ${ACADEMY_NAME_MAX}자까지 입력해 주세요.`);
  const db = getDb();
  if (db.academyName === clean) return;
  db.academyName = clean;
  persist();
}

// 목적: 저장된 학원 이름을 돌려줍니다.
// 이유: 출석 기기 위쪽 띠에도 학원 이름을 보여 줍니다. 학원 이름은 숨길 정보가 아니라 등록된 기기에 보내도 됩니다.
// 방법: 메모리의 db에서 읽기만 합니다.
export function academyName(): string {
  return getDb().academyName;
}

// 목적: 반을 지우고, 모든 학생에게서 그 반을 뺍니다.
// 이유: 반이 없어져도 학생과 기록은 그대로 남아야 합니다.
// 방법: 반 목록과 학생들의 classIds에서 그 id를 빼고 persist합니다.
export function deleteClass(id: unknown): void {
  const db = getDb();
  const found = roster.mustFindClass(id);
  db.classes = db.classes.filter((c) => c.id !== found.id);
  for (const s of db.students) s.classIds = s.classIds.filter((classId) => classId !== found.id);
  persist();
}

// 목적: 붙여넣은 명단을 적용하고 결과 수를 돌려줍니다.
// 이유: 미리보기와 같은 계산을 다시 해서, 그 사이 바뀐 명단에도 맞게 추가합니다(DEC-12).
// 방법: planImport로 다시 계산하고 applyImport로 추가한 뒤 추가·건너뜀·읽지 못함 수를 돌려줍니다.
export function importRows(rows: unknown): { added: number; exists: number; bad: number } {
  const plan = roster.planImport(rows);
  roster.applyImport(plan);
  return { added: plan.add.length, exists: plan.exists.length, bad: plan.bad.length };
}

// 열려 있는 교사 화면(현황판, 기록)은 메모리에만 둡니다. 다시 켜면 비어 있고, 화면이 열리면서 다시 알립니다.
const openPages = new Set<string>();
let closeTimer: ReturnType<typeof setTimeout> | null = null;
let onAllClosed: (() => void) | null = null;

// 목적: 교사 화면이 모두 닫혔을 때 부를 함수를 정합니다.
// 이유: 서버를 끄는 일(연결 닫기, 저장 마치기)은 server.ts가 맡고, 여기서는 언제 끌지만 정합니다(DEC-16).
// 방법: 함수 하나를 기억해 둡니다.
export function onAllPagesClosed(handler: () => void): void {
  onAllClosed = handler;
}

// 목적: 화면이 보낸 id를 확인합니다.
// 이유: 아무 값이나 모음에 넣으면 메모리를 차지하고 다른 화면과 섞입니다.
// 방법: 32자리 16진수가 아니면 "잘못된 입력"입니다.
function cleanPageId(value: unknown): string {
  if (typeof value !== 'string' || !PAGE_ID_RE.test(value)) throw invalid('화면 id가 올바르지 않습니다.');
  return value;
}

// 목적: 교사 화면 하나가 열렸다고 기록합니다.
// 이유: 새로고침은 닫힘 바로 뒤에 열림이 오므로, 그사이 예약된 종료를 취소해야 합니다.
// 방법: id를 모음에 넣고 예약된 종료를 지웁니다. 같은 id가 두 번 와도 한 번으로 셉니다. 모음은 MAX_OPEN_PAGES까지만 받습니다.
export function pageOpen(pageId: unknown): void {
  const id = cleanPageId(pageId);
  if (!openPages.has(id) && openPages.size >= MAX_OPEN_PAGES) throw conflict('열린 교사 화면이 너무 많습니다. 안 쓰는 창을 닫아 주세요.');
  openPages.add(id);
  if (closeTimer) {
    clearTimeout(closeTimer);
    closeTimer = null;
  }
}

// 목적: 교사 화면 하나가 닫혔다고 기록하고, 모두 닫혔으면 잠시 뒤 종료를 예약합니다.
// 이유: 브라우저를 닫으면 출석부와 검은 창까지 꺼져야 합니다. 새로고침으로 꺼지지 않게 PAGE_CLOSE_GRACE_MS만큼 기다립니다(DEC-16).
// 방법: 모음에서 빼고, 비었으면 타이머를 겁니다. 시간이 지나도 비어 있으면 onAllPagesClosed로 정한 함수를 부릅니다. 같은 닫힘이 두 번 와도 타이머는 하나입니다.
export function pageClose(pageId: unknown): void {
  openPages.delete(cleanPageId(pageId));
  if (openPages.size > 0 || closeTimer) return;
  closeTimer = setTimeout(() => {
    closeTimer = null;
    if (openPages.size === 0 && onAllClosed) onAllClosed();
  }, PAGE_CLOSE_GRACE_MS);
}
