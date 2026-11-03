// 목적: 교사가 현황판과 기록 화면에서 하는 동작(출석 바꾸기, 학생·반·번호·퇴원, 붙여넣기, 기록 수정, 기기 관리)과 현황판 상태를 맡아요.
// 사용처: lib/http.js의 교사 API가 경로마다 여기 함수를 하나씩 불러요.
// 근거: 이 동작들이 HTTP 처리(switch) 안에 섞여 있던 것을 server.js를 나누면서 꺼냈어요(DEC-14). http.js는 받고 알리기만 해요.

'use strict';

const { PORT, MAX_STUDENTS, MAX_CLASSES, MAX_VISITS_PER_DAY, CLASS_NAME_MAX } = require('./config');
const { conflict } = require('./errors');
const { getDb, getRev, persist } = require('./store');
const { localDate } = require('./time');
const roster = require('./roster');
const records = require('./records');
const devices = require('./devices');
const network = require('./network');

// 목적: 교사 화면(TV)에 보낼 전체 상태를 만들어요.
// 이유: TV가 2초마다 이 하나만 읽어 칸, 반 선택, 출석 기기 창을 모두 그려요.
// 방법: 학생마다 오늘 상태를 계산해 필드를 하나씩 담아요. 기기는 해시 없이 이름과 등록일만, 등록 코드는 열려 있을 때만 담아요.
function teacherState(now) {
  const db = getDb();
  const { address, count } = network.currentAddress();
  return {
    rev: getRev(),
    today: localDate(now),
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

// 목적: 현황판 칸을 눌렀을 때 학생의 오늘 기록을 한 단계 앞으로 보내요.
// 이유: 교사가 출석 기기 없이 직접 바꿀 수 있어야 하고, 앞으로만 가서 잘못 눌러도 시각이 지워지지 않아요.
// 방법: 퇴원한 학생이면 "상태와 맞지 않음", 하루 방문 한도를 넘으면 같은 오류예요. 10분 반복 구간은 보지 않아요.
function toggle(id, now) {
  const student = roster.mustFindStudent(id);
  if (student.leftOn !== null) throw conflict('퇴원한 학생입니다.');
  if (records.advanceVisit(student, now, false).state === 'already') {
    throw conflict(`하루 방문은 ${MAX_VISITS_PER_DAY}번까지 기록할 수 있습니다.`);
  }
}

// 목적: 학생 이름을 바꿔요.
// 이유: 현황판 칸에서 이름을 바로 고쳐요.
// 방법: 이름을 다듬어 넣고 persist해요.
function rename(id, name) {
  const student = roster.mustFindStudent(id);
  student.name = roster.cleanName(name);
  persist();
}

// 목적: "학생 N" 이름으로 학생 한 명을 명단 끝에 추가하고 그 id를 돌려줘요.
// 이유: 붙여넣기 뒤에 한 명씩 추가하는 경로예요(DEC-12). 반을 고른 상태면 그 반에 넣어야 바로 보여요.
// 방법: 학생 수 한도를 먼저 보고, 반 id가 있으면 확인해 넣은 뒤 persist해요.
function addStudent(classId) {
  const db = getDb();
  if (db.students.length >= MAX_STUDENTS) throw conflict(`학생은 최대 ${MAX_STUDENTS}명까지 추가할 수 있습니다.`);
  const classIds = classId === undefined || classId === null ? [] : roster.cleanClassIds([classId]);
  const student = { id: db.nextId, name: `학생 ${db.students.length + 1}`, phone: null, classIds, leftOn: null };
  db.nextId += 1;
  db.students.push(student);
  persist();
  return student.id;
}

// 목적: 학생과 그 학생의 기록을 지워요.
// 이유: 잘못 등록한 학생을 지우는 용도예요(DEC-11). 학원을 그만둔 학생은 퇴원으로 처리해요.
// 방법: 명단에서 빼고, 모든 날짜의 기록을 지운 뒤 persist해요.
function deleteStudent(id) {
  const db = getDb();
  const student = roster.mustFindStudent(id);
  db.students = db.students.filter((s) => s.id !== student.id);
  records.removeRecordsOf(student.id);
  persist();
}

// 목적: 학생 번호를 바꾸고, 같은 번호의 다른 학생이 있는지 알려 줘요.
// 이유: 형제자매가 같은 번호를 쓸 수 있어서 막지 않고 알리기만 해요.
// 방법: 번호를 다듬어 넣고 persist한 뒤, 같은 번호의 다른 학생이 있으면 true를 돌려줘요.
function setPhone(id, phone) {
  const student = roster.mustFindStudent(id);
  student.phone = roster.cleanPhone(phone);
  persist();
  return student.phone !== null && getDb().students.some((s) => s.id !== student.id && s.phone === student.phone);
}

// 목적: 학생이 속한 반을 바꿔요.
// 이유: 현황판의 "정보" 창에서 반을 체크하면 바로 저장돼요.
// 방법: 반 id 목록을 확인해 넣고 persist해요.
function assignClasses(id, classIds) {
  const student = roster.mustFindStudent(id);
  student.classIds = roster.cleanClassIds(classIds);
  persist();
}

// 목적: 학생을 퇴원 처리해요.
// 이유: 현황판과 출석 기기에서는 빼되 상담용 기록은 남겨요. 번호는 더 필요 없는 개인정보라 지워요(DEC-11).
// 방법: 퇴원일을 오늘로 넣고 번호를 비운 뒤 persist해요.
function leaveStudent(id, now) {
  const student = roster.mustFindStudent(id);
  student.leftOn = localDate(now);
  student.phone = null;
  persist();
}

// 목적: 퇴원한 학생을 다시 재원으로 돌려요.
// 이유: 다시 다니게 된 학생을 새로 등록하지 않고 예전 기록을 이어 쓰게 해요.
// 방법: 퇴원일을 비우고 persist해요. 번호는 교사가 다시 넣어요.
function returnStudent(id) {
  const student = roster.mustFindStudent(id);
  student.leftOn = null;
  persist();
}

// 목적: 새 반을 만들어요.
// 이유: 타임(반)별로 현황판과 기록을 나눠 봐요.
// 방법: 반 수 한도, 이름 다듬기, 이름 중복 순으로 확인하고 persist해요.
function addClass(name) {
  const db = getDb();
  if (db.classes.length >= MAX_CLASSES) throw conflict(`반은 최대 ${MAX_CLASSES}개까지 만들 수 있습니다.`);
  const clean = roster.cleanName(name, CLASS_NAME_MAX);
  if (db.classes.some((c) => c.name === clean)) throw conflict('같은 이름의 반이 이미 있습니다.');
  db.classes.push({ id: db.nextClassId, name: clean });
  db.nextClassId += 1;
  persist();
}

// 목적: 반 이름을 바꿔요.
// 이유: "3시 타임"처럼 반 이름이 바뀌어도 학생 배정은 그대로여야 해요.
// 방법: 이름을 다듬고, 다른 반과 겹치면 "상태와 맞지 않음", 아니면 바꾸고 persist해요.
function renameClass(id, name) {
  const found = roster.mustFindClass(id);
  const clean = roster.cleanName(name, CLASS_NAME_MAX);
  if (getDb().classes.some((c) => c.id !== found.id && c.name === clean)) throw conflict('같은 이름의 반이 이미 있습니다.');
  found.name = clean;
  persist();
}

// 목적: 반을 지우고, 모든 학생에게서 그 반을 빼요.
// 이유: 반이 없어져도 학생과 기록은 그대로 남아야 해요.
// 방법: 반 목록과 학생들의 classIds에서 그 id를 빼고 persist해요.
function deleteClass(id) {
  const db = getDb();
  const found = roster.mustFindClass(id);
  db.classes = db.classes.filter((c) => c.id !== found.id);
  for (const s of db.students) s.classIds = s.classIds.filter((classId) => classId !== found.id);
  persist();
}

// 목적: 붙여넣은 명단을 적용하고 결과 수를 돌려줘요.
// 이유: 미리보기와 같은 계산을 다시 해서, 그 사이 바뀐 명단에도 맞게 추가해요(DEC-12).
// 방법: planImport로 다시 계산하고 applyImport로 추가한 뒤 추가·건너뜀·읽지 못함 수를 돌려줘요.
function importRows(rows) {
  const plan = roster.planImport(rows);
  roster.applyImport(plan);
  return { added: plan.add.length, exists: plan.exists.length, bad: plan.bad.length };
}

module.exports = {
  teacherState,
  toggle,
  rename,
  addStudent,
  deleteStudent,
  setPhone,
  assignClasses,
  leaveStudent,
  returnStudent,
  addClass,
  renameClass,
  deleteClass,
  previewImport: roster.planImport,
  importRows,
  monthRecords: records.monthRecords,
  editRecords: records.editRecords,
  openPairing: devices.startPairing,
  closePairing: devices.cancelPairing,
  revokeDevice: devices.revokeDevice,
  nextAddress: network.nextAddress,
};
