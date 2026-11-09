// 목적: 출석 기기에서 누른 번호 뒷 4자리로 학생을 찾아 등원이나 하원을 기록합니다.
// 사용처: lib/http.ts의 출석 기기 요청(/api/kiosk/checkin)이 부릅니다.
// 근거: 학생 쪽에서 들어오는 유일한 쓰기라, 교사 동작과 섞이지 않게 server.js를 나누면서 따로 뺐습니다(DEC-10, DEC-14).

import { invalid } from './errors.ts';
import { getDb } from './store.ts';
import { advanceVisit } from './records.ts';
import type { CheckinResult, Student } from './types.ts';

// 목적: 출석 기기에서 입력한 번호 뒷 4자리로 학생을 찾아 등원이나 하원을 기록합니다.
// 이유: 학생은 학원 기기에 번호를 입력해 출석합니다(DEC-10). 같은 숫자의 학생이 여럿이면 이름을 골라야 합니다.
// 방법: 퇴원하지 않았고 번호가 그 4자리로 끝나는 학생을 모읍니다. 없으면 unknown, 여럿이고 고른 학생이 없으면 choose(이름만), 하나로 정해지면 advanceVisit으로 기록합니다.
export function kioskCheckin(digits: unknown, studentId: unknown, now: number): CheckinResult {
  if (typeof digits !== 'string' || !/^\d{4}$/.test(digits)) throw invalid('번호 뒷 4자리를 입력해 주세요.');
  const matches = getDb().students.filter((s) => s.leftOn === null && s.phone !== null && s.phone.endsWith(digits));
  if (matches.length === 0) return { state: 'unknown' };
  let student: Student | undefined;
  if (studentId === undefined || studentId === null) {
    if (matches.length > 1) return { state: 'choose', choices: matches.map((s) => ({ id: s.id, name: s.name })) };
    student = matches[0];
  } else {
    student = matches.find((s) => s.id === studentId);
    if (!student) return { state: 'unknown' };
  }
  return { ...advanceVisit(student, now, true), name: student.name };
}
