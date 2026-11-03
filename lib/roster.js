// 목적: 학생과 반을 찾고, 이름·번호·반 입력을 다듬고, 붙여넣은 명단을 검사하고 추가합니다.
// 사용처: lib/teacher.js, lib/records.js가 불러 씁니다.
// 근거: 명단 규칙이 교사 API 처리와 섞여 있던 것을 server.js를 나누면서 따로 뺐습니다(DEC-12, DEC-14).

'use strict';

const { NAME_MAX, CLASS_NAME_MAX, MAX_STUDENTS, MAX_CLASSES, PHONE_RE } = require('./config');
const { DomainError, invalid, notFound, conflict } = require('./errors');
const { getDb, persist } = require('./store');

// 목적: id로 학생을 찾고 없으면 "없음" 업무 오류를 던집니다.
// 이유: 교사 쪽 쓰기 동작이 같은 "없는 학생" 처리를 반복하지 않게 합니다.
// 방법: id가 정수인지 확인 후 find.
function mustFindStudent(id) {
  const student = Number.isInteger(id) ? getDb().students.find((s) => s.id === id) : undefined;
  if (!student) throw notFound('해당 학생을 찾을 수 없습니다.');
  return student;
}

// 목적: id로 반을 찾고 없으면 "없음" 업무 오류를 던집니다.
// 이유: 반 이름 변경과 삭제가 같은 "없는 반" 처리를 씁니다.
// 방법: id가 정수인지 확인 후 find.
function mustFindClass(id) {
  const found = Number.isInteger(id) ? getDb().classes.find((c) => c.id === id) : undefined;
  if (!found) throw notFound('해당 반을 찾을 수 없습니다.');
  return found;
}

// 목적: 이름 입력값을 저장 가능한 형태로 다듬습니다. 학생 이름과 반 이름에 같이 씁니다.
// 이유: 빈 이름, 너무 긴 이름, 제어 문자가 TV 칸과 표를 망가뜨리지 않게 합니다.
// 방법: 문자열이 아니면 "잘못된 입력", 제어 문자 제거 후 trim, 비었거나 max자 초과면 "잘못된 입력".
function cleanName(value, max = NAME_MAX) {
  if (typeof value !== 'string') throw invalid('이름이 올바르지 않습니다.');
  const name = value.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (name.length === 0 || [...name].length > max) {
    throw invalid(`이름은 1~${max}자로 입력해 주세요.`);
  }
  return name;
}

// 목적: 휴대폰번호 입력값을 숫자만 남긴 형태로 다듬습니다. 빈 값은 "번호 없음"입니다.
// 이유: 010-1234-5678처럼 하이픈이나 공백을 넣어 입력해도 같은 번호로 봐야 합니다.
// 방법: 숫자 외 문자를 지운 뒤 9~11자리인지 확인합니다. 원래 값이 비었으면 null.
function cleanPhone(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') throw invalid('휴대폰번호가 올바르지 않습니다.');
  if (value.trim() === '') return null;
  const digits = value.replace(/\D/g, '');
  if (!PHONE_RE.test(digits)) throw invalid('휴대폰번호는 숫자 9~11자리로 입력해 주세요.');
  return digits;
}

// 목적: 학생에게 넣을 반 id 목록을 확인합니다.
// 이유: 없는 반이나 같은 반이 두 번 들어가면 현황판 반 선택이 어긋납니다.
// 방법: 배열인지, 모두 있는 반의 id인지 확인하고 중복을 없앱니다.
function cleanClassIds(value) {
  if (!Array.isArray(value)) throw invalid('반 목록이 올바르지 않습니다.');
  const ids = [...new Set(value)];
  for (const id of ids) mustFindClass(id);
  return ids;
}

// 목적: 붙여넣은 명단 행을 검사해, 추가할 학생과 건너뛸 행을 나눕니다. 저장은 하지 않습니다.
// 이유: 저장 전에 미리보기를 보여 주고(DEC-12), 적용할 때도 같은 계산을 다시 써서 미리보기와 결과가 어긋나지 않게 합니다.
// 방법: 행은 [이름, 번호, 반] 문자열 배열입니다. 이미 있는 이름은 건너뛰고, 형식이 틀린 행은 사유와 함께 모읍니다. 학생 수와 반 수 한도를 넘으면 "상태와 맞지 않음" 업무 오류입니다.
function planImport(rows) {
  const db = getDb();
  if (!Array.isArray(rows) || rows.length === 0) throw invalid('붙여넣은 명단이 없습니다.');
  if (rows.length > MAX_STUDENTS) throw invalid(`한 번에 ${MAX_STUDENTS}명까지 붙여넣을 수 있습니다.`);
  const known = new Set(db.students.map((s) => s.name));
  const knownClasses = new Set(db.classes.map((c) => c.name));
  const newClasses = new Set();
  const add = [];
  const exists = [];
  const bad = [];
  rows.forEach((row, index) => {
    const line = index + 1;
    if (!Array.isArray(row) || !row.every((cell) => typeof cell === 'string')) {
      bad.push({ line, reason: '읽을 수 없는 행입니다.' });
      return;
    }
    try {
      const name = cleanName(row[0] ?? '');
      if (known.has(name)) {
        exists.push(name);
        return;
      }
      const phone = cleanPhone(row[1] ?? '');
      const classNames = [...new Set((row[2] ?? '').split(/[,/]/).map((n) => n.trim()).filter(Boolean))]
        .map((n) => cleanName(n, CLASS_NAME_MAX));
      for (const n of classNames) if (!knownClasses.has(n)) newClasses.add(n);
      known.add(name);
      add.push({ name, phone, classNames });
    } catch (e) {
      if (!(e instanceof DomainError)) throw e;
      bad.push({ line, reason: e.message });
    }
  });
  if (db.students.length + add.length > MAX_STUDENTS) {
    throw conflict(`학생은 최대 ${MAX_STUDENTS}명까지 둘 수 있습니다. 지금 ${db.students.length}명입니다.`);
  }
  if (db.classes.length + newClasses.size > MAX_CLASSES) {
    throw conflict(`반은 최대 ${MAX_CLASSES}개까지 만들 수 있습니다.`);
  }
  return { add, exists, bad };
}

// 목적: planImport가 정한 학생을 실제로 추가합니다.
// 이유: 미리보기를 확인한 뒤에만 명단이 바뀌어야 합니다.
// 방법: 없는 반은 이름으로 새로 만들고, 학생을 명단 끝에 붙인 뒤 한 번만 persist합니다. 붙여넣기는 추가만 하고 아무도 지우지 않습니다.
function applyImport(plan) {
  const db = getDb();
  for (const entry of plan.add) {
    const classIds = entry.classNames.map((n) => {
      let found = db.classes.find((c) => c.name === n);
      if (!found) {
        found = { id: db.nextClassId, name: n };
        db.nextClassId += 1;
        db.classes.push(found);
      }
      return found.id;
    });
    db.students.push({ id: db.nextId, name: entry.name, phone: entry.phone, classIds, leftOn: null });
    db.nextId += 1;
  }
  if (plan.add.length > 0) persist();
}

module.exports = { mustFindStudent, mustFindClass, cleanName, cleanPhone, cleanClassIds, planImport, applyImport };
