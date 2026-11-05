// 목적: 한 달 기록 화면의 동작입니다. 표 그리기, 칸 수정, 인쇄를 맡습니다.
// 사용처: public/records.html이 common.js 다음에 부릅니다.
// 근거: HTML 안 스크립트를 막는 보안 정책(CSP)을 켜려고 records.html에서 옮겼습니다(DEC-14).

const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];
const MAX_VISITS = 10;

const wrap = document.getElementById('wrap');
const monthLabel = document.getElementById('month-label');
const classFilterEl = document.getElementById('class-filter');
const printTitle = document.getElementById('print-title');
const editDialog = document.getElementById('edit-dialog');
const editTitle = document.getElementById('edit-title');
const visitRows = document.getElementById('visit-rows');
const editError = document.getElementById('edit-error');
const toastEl = document.getElementById('toast');

let month = currentMonth();
let data = null;
let classFilter = 'all';
let editing = null;
let toastTimer = null;

// 목적: 화면 아래에 짧은 안내를 띄웁니다.
// 이유: 불러오기 실패나 저장 결과를 바로 알아야 합니다.
// 방법: 4초 뒤 자동으로 숨깁니다.
function showToast(text) {
  clearTimeout(toastTimer);
  toastEl.textContent = text;
  toastEl.hidden = false;
  toastTimer = setTimeout(() => { toastEl.hidden = true; }, 4000);
}

// 목적: 이번 달을 YYYY-MM으로 만듭니다.
// 이유: 처음 열면 이번 달 기록을 보여 줍니다.
// 방법: PC 현지 날짜로 조립합니다.
function currentMonth() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

// 목적: 보고 있는 달을 앞뒤로 옮깁니다.
// 이유: 지난달 기록으로 상담하는 일이 많습니다.
// 방법: 연·월을 계산해 month를 바꾸고 다시 불러옵니다.
function shiftMonth(delta) {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  month = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  load();
}

// 목적: 한 달치 기록을 서버에서 받아 표를 그립니다.
// 이유: 다른 달로 옮기거나 시각을 고친 뒤 최신 기록을 보여 줘야 합니다.
// 방법: /api/records?month= 를 불러 data에 두고 반 선택과 표를 다시 그립니다. 불러왔는지를 true/false로 돌려줍니다.
async function load() {
  const [y, m] = month.split('-').map(Number);
  monthLabel.textContent = `${y}년 ${m}월`;
  try {
    data = await api(`/api/records?month=${month}`);
  } catch (e) {
    showToast(e.message);
    return false;
  }
  updateClassFilter();
  render();
  return true;
}

// 목적: 기록 화면을 서버의 최신 상태로 다시 불러옵니다.
// 이유: 기록 화면은 열 때만 불러와서, 그 뒤에 현황판에서 추가한 학생이나 새 출석이 보이지 않습니다. 원격 데스크톱으로 보는 휴대폰에서는 브라우저 새로고침을 누르기 어렵습니다.
// 방법: 보고 있는 달과 반은 그대로 두고 load를 다시 부릅니다. 불러오면 안내를 띄우고, 실패 안내는 load가 띄웁니다.
async function refresh() {
  if (await load()) showToast('최신 기록을 불러왔어요.');
}

// 목적: 반 선택 목록을 서버의 반 목록에 맞춥니다.
// 이유: 상담할 때 반별로 걸러 보기도 합니다.
// 방법: option을 다시 만들고, 고른 반이 사라졌으면 "전체"로 돌아갑니다.
function updateClassFilter() {
  if (classFilter !== 'all' && !data.classes.some((c) => c.id === classFilter)) classFilter = 'all';
  classFilterEl.replaceChildren(new Option('전체', 'all'));
  for (const c of data.classes) classFilterEl.append(new Option(c.name, String(c.id)));
  classFilterEl.value = String(classFilter);
}

// 목적: 표에 넣을 학생을 고릅니다.
// 이유: 재원생은 기록이 없어도 보여야 결석이 보이고, 퇴원생은 그 달 기록이 있을 때만 보입니다.
// 방법: 반 선택에 맞는 학생 중 퇴원하지 않았거나 그 달 기록이 있는 학생만 남깁니다.
function rowsToShow() {
  const hasRecord = (id) => Object.values(data.days).some((day) => day[id]);
  return data.students.filter((s) => (classFilter === 'all' || s.classIds.includes(classFilter))
    && (s.leftOn === null || hasRecord(s.id)));
}

// 목적: 학생 × 날짜 표를 그립니다.
// 이유: 한 달 출석을 한눈에 보고 인쇄해야 합니다.
// 방법: 날짜 칸마다 방문을 "등원–하원" 줄로 넣고, 주말과 오늘은 색을 달리합니다. 끝에 출석 일수를 붙입니다. 이름은 textContent로 넣습니다.
function render() {
  const [y, m] = month.split('-').map(Number);
  const lastDay = new Date(y, m, 0).getDate();
  const today = new Date();
  const todayKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  const className = classFilter === 'all' ? '전체' : data.classes.find((c) => c.id === classFilter).name;
  printTitle.textContent = `${y}년 ${m}월 출석 기록 · ${className}`;

  const rows = rowsToShow();
  if (rows.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'empty-msg';
    empty.textContent = '이 달에 보여 줄 학생이 없어요.';
    wrap.replaceChildren(empty);
    return;
  }

  const table = document.createElement('table');
  const head = table.createTHead().insertRow();
  const nameHead = document.createElement('th');
  nameHead.className = 'name';
  nameHead.textContent = '이름';
  head.append(nameHead);
  for (let d = 1; d <= lastDay; d++) {
    const th = document.createElement('th');
    const weekday = new Date(y, m - 1, d).getDay();
    th.textContent = `${d} ${WEEKDAYS[weekday]}`;
    if (weekday === 0 || weekday === 6) th.classList.add('weekend');
    head.append(th);
  }
  const countHead = document.createElement('th');
  countHead.textContent = '출석일';
  head.append(countHead);

  const body = table.createTBody();
  for (const student of rows) {
    const tr = body.insertRow();
    const nameCell = document.createElement('td');
    nameCell.className = 'name';
    nameCell.textContent = student.name;
    if (student.leftOn !== null) {
      const mark = document.createElement('span');
      mark.className = 'left-mark';
      mark.textContent = ' (퇴원)';
      nameCell.append(mark);
    }
    tr.append(nameCell);
    let attended = 0;
    for (let d = 1; d <= lastDay; d++) {
      const date = `${month}-${String(d).padStart(2, '0')}`;
      const visits = data.days[date]?.[student.id] ?? [];
      if (visits.length > 0) attended += 1;
      const td = document.createElement('td');
      td.className = 'day';
      td.tabIndex = 0;
      td.dataset.date = date;
      td.dataset.id = String(student.id);
      const weekday = new Date(y, m - 1, d).getDay();
      if (weekday === 0 || weekday === 6) td.classList.add('weekend');
      if (date === todayKey) td.classList.add('today');
      for (const v of visits) {
        // 인쇄할 때 31일이 A4 가로에 들어가도록 하원 시각은 줄을 바꿀 수 있게 둡니다.
        const line = document.createElement('span');
        line.className = 'visit';
        line.append(`${v.in}–`, document.createElement('wbr'), v.out ?? '');
        td.append(line);
      }
      tr.append(td);
    }
    const countCell = document.createElement('td');
    countCell.className = 'count';
    countCell.textContent = String(attended);
    tr.append(countCell);
  }
  wrap.replaceChildren(table);
}

// 목적: 날짜 칸을 누르면 그날 기록을 고치는 창을 엽니다.
// 이유: 하원을 깜빡한 날 같은 실수를 교사가 고쳐야 상담 기록이 맞습니다.
// 방법: 그 학생·날짜의 방문을 복사해 시각 입력 줄로 만듭니다. 기록이 없으면 빈 줄 하나로 시작합니다.
function openEdit(date, id) {
  const student = data.students.find((s) => s.id === id);
  if (!student) return;
  editing = { date, id };
  const [, m, d] = date.split('-').map(Number);
  editTitle.textContent = `${student.name} · ${m}월 ${d}일`;
  editError.textContent = '';
  visitRows.replaceChildren();
  const visits = data.days[date]?.[id] ?? [];
  for (const v of visits) addVisitRow(v.in, v.out ?? '');
  if (visits.length === 0) addVisitRow('', '');
  editDialog.showModal();
}

// 목적: 고치는 창에 방문 한 줄(등원, 하원, 삭제)을 더합니다.
// 이유: 하루에 두 번 온 학생도 있습니다.
// 방법: time 입력 두 개와 삭제 버튼을 만듭니다. 10줄을 넘기지 않습니다.
function addVisitRow(inTime, outTime) {
  if (visitRows.children.length >= MAX_VISITS) return;
  const row = document.createElement('div');
  row.className = 'visit-row';
  const inLabel = document.createElement('label');
  const inInput = document.createElement('input');
  inInput.type = 'time';
  inInput.className = 'field';
  inInput.value = inTime;
  inInput.dataset.role = 'in';
  inLabel.append('등원 ', inInput);
  const outLabel = document.createElement('label');
  const outInput = document.createElement('input');
  outInput.type = 'time';
  outInput.className = 'field';
  outInput.value = outTime;
  outInput.dataset.role = 'out';
  outLabel.append('하원 ', outInput);
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'btn danger';
  remove.textContent = '삭제';
  remove.addEventListener('click', () => row.remove());
  row.append(inLabel, outLabel, remove);
  visitRows.append(row);
}

// 목적: 고친 하루치 기록을 저장합니다.
// 이유: 저장하면 바로 표에 반영돼야 합니다. 모든 줄을 지우고 저장하면 그날 기록이 지워집니다.
// 방법: 등원 시각이 빈 줄은 빼고 /api/records/edit으로 보냅니다. 서버가 순서와 형식을 확인하고, 틀리면 그 사유를 창에 보여 줍니다.
async function saveEdit() {
  const visits = [...visitRows.children]
    .map((row) => ({ in: row.querySelector('[data-role="in"]').value, out: row.querySelector('[data-role="out"]').value || null }))
    .filter((v) => v.in !== '');
  if (visits.length === 0 && !confirm('이날 기록을 모두 지울까요?')) return;
  try {
    await api('/api/records/edit', { date: editing.date, id: editing.id, visits });
  } catch (e) {
    editError.textContent = e.message;
    return;
  }
  editDialog.close();
  showToast('저장했어요.');
  load();
}

document.getElementById('prev').addEventListener('click', () => shiftMonth(-1));
document.getElementById('next').addEventListener('click', () => shiftMonth(1));
classFilterEl.addEventListener('change', () => {
  classFilter = classFilterEl.value === 'all' ? 'all' : Number(classFilterEl.value);
  render();
});
document.getElementById('refresh').addEventListener('click', refresh);
document.getElementById('print').addEventListener('click', () => window.print());
wrap.addEventListener('click', (event) => {
  const cell = event.target.closest('td.day');
  if (cell) openEdit(cell.dataset.date, Number(cell.dataset.id));
});
wrap.addEventListener('keydown', (event) => {
  const cell = event.target.closest('td.day');
  if (cell && (event.key === 'Enter' || event.key === ' ')) {
    event.preventDefault();
    openEdit(cell.dataset.date, Number(cell.dataset.id));
  }
});
document.getElementById('visit-add').addEventListener('click', () => addVisitRow('', ''));
document.getElementById('edit-save').addEventListener('click', saveEdit);
document.getElementById('edit-cancel').addEventListener('click', () => editDialog.close());

load();
