// 목적: 날짜별 등원·하원 기록을 계산하고, 한 걸음 진행하고, 한 달치를 보여 주고, 고치고, 지워요.
// 사용처: lib/teacher.js(칸 누르기, 기록 화면)와 lib/checkin.js(출석 기기)가 불러 써요.
// 근거: 출석 기기와 현황판이 같은 기록 규칙을 써야 해서(DEC-11) server.js를 나누면서 한 파일로 모았어요(DEC-14).

'use strict';

const { REPEAT_WINDOW_MIN, MAX_VISITS_PER_DAY, DATE_RE, MONTH_RE, TIME_RE } = require('./config');
const { invalid } = require('./errors');
const { getDb, persist, isPlainObject } = require('./store');
const { localDate, localTime, minutesOf } = require('./time');
const { mustFindStudent } = require('./roster');

// 목적: 학생의 오늘 상태(미등원·등원·하원)와 마지막 방문 시각을 알려 줘요.
// 이유: 현황판 칸의 색과 시각은 오늘 기록에서 계산해요(DEC-11).
// 방법: 오늘 방문 목록의 마지막 항목을 봐요. 없으면 미등원, 하원 시각이 없으면 등원, 있으면 하원이에요.
function todayStatus(student, now) {
  const visits = getDb().records[localDate(now)]?.[student.id] ?? [];
  const last = visits.at(-1);
  if (!last) return { status: 'absent', inTime: null, outTime: null };
  return { status: last.out === null ? 'in' : 'out', inTime: last.in, outTime: last.out };
}

// 목적: 학생의 오늘 기록을 한 단계 앞으로 보내요. 미등원이나 하원이면 새로 등원, 등원 중이면 하원이에요.
// 이유: 출석 기기와 현황판 칸 누르기가 같은 규칙으로 기록해야 해요. 앞으로만 가서 잘못 눌러도 시각이 지워지지 않아요.
// 방법: 출석 기기에서는 직전 입력 후 10분 안이면 반복(already)으로 보고 아무것도 바꾸지 않아요. 바뀌면 persist해요.
function advanceVisit(student, now, checkRepeat) {
  const db = getDb();
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

// 목적: 한 달치 기록을 기록 화면에 보낼 모양으로 만들어요.
// 이유: 상담할 때 한 달을 한 표로 봐요. 퇴원한 학생의 기록도 함께 보여야 해요.
// 방법: 그 달 날짜의 기록만 골라 방문을 필드별로 복사하고, 학생은 번호 없이 이름·반·퇴원일만 담아요.
function monthRecords(month) {
  const db = getDb();
  if (typeof month !== 'string' || !MONTH_RE.test(month)) throw invalid('달을 YYYY-MM 형식으로 보내 주세요.');
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
  if (!Array.isArray(value) || value.length > MAX_VISITS_PER_DAY) throw invalid('방문 기록이 올바르지 않습니다.');
  const visits = value.map((v, i) => {
    if (!isPlainObject(v) || typeof v.in !== 'string' || !TIME_RE.test(v.in)) {
      throw invalid('등원 시각을 HH:MM 형식으로 입력해 주세요.');
    }
    const out = v.out === null || v.out === '' || v.out === undefined ? null : v.out;
    if (out !== null && (typeof out !== 'string' || !TIME_RE.test(out))) {
      throw invalid('하원 시각을 HH:MM 형식으로 입력해 주세요.');
    }
    if (out === null && i !== value.length - 1) throw invalid('하원 시각은 마지막 방문에서만 비울 수 있습니다.');
    if (out !== null && minutesOf(out) < minutesOf(v.in)) throw invalid('하원 시각이 등원 시각보다 빠릅니다.');
    return { in: v.in, out };
  });
  for (let i = 1; i < visits.length; i++) {
    if (minutesOf(visits[i].in) < minutesOf(visits[i - 1].out)) throw invalid('방문 시각이 겹칩니다. 시간 순서대로 입력해 주세요.');
  }
  return visits;
}

// 목적: 학생의 하루치 기록을 통째로 바꿔요. 빈 목록이면 그날 기록을 지워요.
// 이유: 교사는 오늘뿐 아니라 어느 날의 시각이든 고칠 수 있어야 해요.
// 방법: 날짜와 학생을 확인하고 cleanVisits를 거친 목록으로 바꿔요. 빈 날짜는 records에서 빼요.
function editRecords(date, studentId, value) {
  const db = getDb();
  if (typeof date !== 'string' || !DATE_RE.test(date)) throw invalid('날짜가 올바르지 않습니다.');
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
  const db = getDb();
  for (const [date, day] of Object.entries(db.records)) {
    delete day[studentId];
    if (Object.keys(day).length === 0) delete db.records[date];
  }
}

module.exports = { todayStatus, advanceVisit, monthRecords, editRecords, removeRecordsOf };
