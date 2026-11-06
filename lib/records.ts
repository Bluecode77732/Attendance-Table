// 목적: 날짜별 등원·하원 기록을 계산하고, 한 걸음 진행하고, 한 달치를 보여 주고, 고치고, 지웁니다.
// 사용처: lib/teacher.ts(칸 누르기, 기록 화면)와 lib/checkin.ts(출석 기기)가 불러 씁니다.
// 근거: 출석 기기와 현황판이 같은 기록 규칙을 써야 해서(DEC-11) server.js를 나누면서 한 파일로 모았습니다(DEC-14).

import { REPEAT_WINDOW_MIN, MAX_VISITS_PER_DAY, DATE_RE, MONTH_RE, TIME_RE } from './config.ts';
import { invalid } from './errors.ts';
import { getDb, persist, isPlainObject } from './store.ts';
import { localDate, localTime, minutesOf } from './time.ts';
import { mustFindStudent } from './roster.ts';
import type { AdvanceResult, MonthRecords, Records, Student, TodayStatus, Visit } from './types.ts';

// 목적: 학생의 오늘 상태(미등원·등원·하원)와 마지막 방문 시각을 알려 줍니다.
// 이유: 현황판 칸의 색과 시각은 오늘 기록에서 계산합니다(DEC-11).
// 방법: 오늘 방문 목록의 마지막 항목을 봅니다. 없으면 미등원, 하원 시각이 없으면 등원, 있으면 하원입니다.
export function todayStatus(student: Student, now: number): TodayStatus {
  const visits = getDb().records[localDate(now)]?.[student.id] ?? [];
  const last = visits.at(-1);
  if (!last) return { status: 'absent', inTime: null, outTime: null };
  return { status: last.out === null ? 'in' : 'out', inTime: last.in, outTime: last.out };
}

// 목적: 학생의 오늘 기록을 한 단계 앞으로 보냅니다. 미등원이나 하원이면 새로 등원, 등원 중이면 하원입니다.
// 이유: 출석 기기와 현황판 칸 누르기가 같은 규칙으로 기록해야 합니다. 앞으로만 가서 잘못 눌러도 시각이 지워지지 않습니다.
// 방법: 출석 기기에서는 직전 입력 후 REPEAT_WINDOW_MIN(3분) 안이면 반복(already)으로 보고 아무것도 바꾸지 않습니다. 바뀌면 persist합니다.
export function advanceVisit(student: Student, now: number, checkRepeat: boolean): AdvanceResult {
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
  let result: AdvanceResult;
  if (last && last.out === null) {
    last.out = time;
    result = { state: 'out', time };
  } else {
    if (last && visits.length >= MAX_VISITS_PER_DAY) return { state: 'already', kind: 'out', time: last.out };
    visits.push({ in: time, out: null });
    result = { state: 'in', time };
  }
  day[student.id] = visits;
  db.records[date] = day;
  persist();
  return result;
}

// 목적: 한 달치 기록을 기록 화면에 보낼 모양으로 만듭니다.
// 이유: 상담할 때 한 달을 한 표로 봅니다. 퇴원한 학생의 기록도 함께 보여야 합니다.
// 방법: 그 달 날짜의 기록만 골라 방문을 필드별로 복사하고, 학생은 번호 없이 이름·반·퇴원일만 담습니다.
export function monthRecords(month: unknown): MonthRecords {
  const db = getDb();
  if (typeof month !== 'string' || !MONTH_RE.test(month)) throw invalid('달을 YYYY-MM 형식으로 보내 주세요.');
  const days: Records = {};
  for (const [date, day] of Object.entries(db.records)) {
    if (!date.startsWith(`${month}-`)) continue;
    const copy: Record<string, Visit[]> = {};
    for (const [id, visits] of Object.entries(day)) {
      copy[id] = visits.map((v) => ({ in: v.in, out: v.out }));
    }
    days[date] = copy;
  }
  return {
    month,
    academyName: db.academyName,
    students: db.students.map((s) => ({ id: s.id, name: s.name, classIds: [...s.classIds], leftOn: s.leftOn })),
    classes: db.classes.map((c) => ({ id: c.id, name: c.name })),
    days,
  };
}

// 목적: 기록 화면에서 고친 하루치 방문 목록을 확인합니다.
// 이유: 교사가 하원을 깜빡한 날 등을 고칠 때, 순서가 뒤집히거나 형식이 틀린 기록이 저장되면 안 됩니다.
// 방법: 방문마다 등원 시각은 필수, 하원 시각은 비워도 됩니다(마지막 방문만). 하원은 등원보다 늦고, 다음 등원은 앞 하원보다 늦어야 합니다.
function cleanVisits(value: unknown): Visit[] {
  if (!Array.isArray(value) || value.length > MAX_VISITS_PER_DAY) throw invalid('방문 기록이 올바르지 않습니다.');
  const visits = (value as unknown[]).map((v, i): Visit => {
    if (!isPlainObject(v) || typeof v.in !== 'string' || !TIME_RE.test(v.in)) {
      throw invalid('등원 시각을 HH:MM 형식으로 입력해 주세요.');
    }
    let out: string | null = null;
    if (!(v.out === null || v.out === '' || v.out === undefined)) {
      if (typeof v.out !== 'string' || !TIME_RE.test(v.out)) throw invalid('하원 시각을 HH:MM 형식으로 입력해 주세요.');
      out = v.out;
    }
    if (out === null && i !== value.length - 1) throw invalid('하원 시각은 마지막 방문에서만 비울 수 있습니다.');
    if (out !== null && minutesOf(out) < minutesOf(v.in)) throw invalid('하원 시각이 등원 시각보다 빠릅니다.');
    return { in: v.in, out };
  });
  for (let i = 1; i < visits.length; i++) {
    // 마지막이 아닌 방문은 위에서 하원 시각이 있다고 확인했습니다.
    if (minutesOf(visits[i].in) < minutesOf(visits[i - 1].out as string)) throw invalid('방문 시각이 겹칩니다. 시간 순서대로 입력해 주세요.');
  }
  return visits;
}

// 목적: 학생의 하루치 기록을 통째로 바꿉니다. 빈 목록이면 그날 기록을 지웁니다.
// 이유: 교사는 오늘뿐 아니라 어느 날의 시각이든 고칠 수 있어야 합니다.
// 방법: 날짜와 학생을 확인하고 cleanVisits를 거친 목록으로 바꿉니다. 빈 날짜는 records에서 뺍니다.
export function editRecords(date: unknown, studentId: unknown, value: unknown): void {
  const db = getDb();
  if (typeof date !== 'string' || !DATE_RE.test(date)) throw invalid('날짜가 올바르지 않습니다.');
  const student = mustFindStudent(studentId);
  const visits = cleanVisits(value);
  const day = db.records[date];
  if (visits.length > 0) {
    db.records[date] = { ...day, [student.id]: visits };
  } else if (day) {
    delete day[student.id];
    if (Object.keys(day).length === 0) delete db.records[date];
  }
  persist();
}

// 목적: 학생의 기록을 모든 날짜에서 지웁니다.
// 이유: 학생 삭제는 잘못 등록한 학생을 지우는 용도라 기록도 함께 지웁니다(DEC-11). 학원을 그만둔 학생은 퇴원으로 처리합니다.
// 방법: 날짜마다 그 학생 항목을 빼고, 빈 날짜는 records에서 뺍니다. persist는 부른 쪽에서 합니다.
export function removeRecordsOf(studentId: number): void {
  const db = getDb();
  for (const [date, day] of Object.entries(db.records)) {
    delete day[studentId];
    if (Object.keys(day).length === 0) delete db.records[date];
  }
}
