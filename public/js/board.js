// 목적: 교사용 TV 현황판의 동작입니다. 칸, 반 선택, 정보·반 관리·퇴원생·붙여넣기·출석 기기 창을 그립니다.
// 사용처: public/index.html이 common.js 다음에 부릅니다.
// 근거: HTML 안 스크립트를 막는 보안 정책(CSP)을 켜려고 index.html에서 옮겼습니다(DEC-14).

const PER_PAGE = 8;
const NAME_MAX = 12;
const POLL_MS = 2000;
const PASTE_BYTES_MAX = 63_000; // 서버의 요청 크기 한도(64KB) 안에 들어가게 미리 막습니다

const grid = document.getElementById('grid');
const summaryEl = document.getElementById('summary');
const classFilterEl = document.getElementById('class-filter');
const pageLabel = document.getElementById('page-label');
const prevBtn = document.getElementById('prev');
const nextBtn = document.getElementById('next');
const toastEl = document.getElementById('toast');

const studentDialog = document.getElementById('student-dialog');
const studentTitle = document.getElementById('student-title');
const phoneInput = document.getElementById('phone-input');
const studentClassesEl = document.getElementById('student-classes');
const studentNoClass = document.getElementById('student-no-class');
const classesDialog = document.getElementById('classes-dialog');
const classListEl = document.getElementById('class-list');
const classNewInput = document.getElementById('class-new');
const leftDialog = document.getElementById('left-dialog');
const leftListEl = document.getElementById('left-list');
const pasteDialog = document.getElementById('paste-dialog');
const pasteBox = document.getElementById('paste-box');
const pastePreview = document.getElementById('paste-preview');
const pasteApplyBtn = document.getElementById('paste-apply');
const devicesDialog = document.getElementById('devices-dialog');
const deviceQr = document.getElementById('device-qr');
const deviceUrl = document.getElementById('device-url');
const addrNextBtn = document.getElementById('addr-next');
const pairCodeEl = document.getElementById('pair-code');
const pairLeftEl = document.getElementById('pair-left');
const deviceListEl = document.getElementById('device-list');

let state = null;
let students = [];
let rev = 0;
let page = 0;
let classFilter = 'all';
let editingId = null;
let dialogStudentId = null;
let slide = '';
let drawnQrUrl;
let pastedRows = null;
let polling = false;
let toastTimer = null;
let toastKind = '';

// 목적: 교사 동작을 서버에 보내고 돌아온 최신 상태를 그립니다.
// 이유: 모든 쓰기 동작이 같은 "요청 → 상태 반영 → 실패 안내" 흐름을 씁니다.
// 방법: api 호출 후 applyState. 응답을 돌려줘서 부른 쪽이 추가 정보(중복 번호 등)를 볼 수 있게 합니다. 실패하면 토스트로 사유를 알리고 null을 돌려줍니다.
async function act(path, body) {
  try {
    const data = await api(path, body);
    applyState(data);
    return data;
  } catch (e) {
    showToast(e.message, 4000, 'error');
    return null;
  }
}

// 목적: 화면 아래에 짧은 안내 문구를 띄웁니다.
// 이유: 서버 연결 끊김이나 동작 실패를 교사가 바로 알아야 합니다.
// 방법: ms가 0이면 직접 지울 때까지 유지(연결 끊김용). 그 외에는 ms 뒤 자동으로 숨깁니다.
function showToast(text, ms, kind) {
  clearTimeout(toastTimer);
  toastEl.textContent = text;
  toastEl.hidden = false;
  toastKind = kind;
  if (ms > 0) toastTimer = setTimeout(hideToast, ms);
}

// 목적: 안내 문구를 숨깁니다.
// 이유: 연결이 돌아오면 끊김 안내가 남아 있으면 안 됩니다.
// 방법: hidden 처리하고 종류를 비웁니다.
function hideToast() {
  clearTimeout(toastTimer);
  toastEl.hidden = true;
  toastKind = '';
}

// 목적: 지금 반 선택에 맞는, 현황판에 보일 학생 목록을 만듭니다.
// 이유: 퇴원생은 현황판에서 빠지고, 반을 고르면 그 반 학생만 보여야 합니다.
// 방법: 퇴원하지 않은 학생 중 반 선택이 "전체"이거나 그 반에 속한 학생만 고릅니다.
function visibleStudents() {
  return students.filter((s) => !s.left && (classFilter === 'all' || s.classIds.includes(classFilter)));
}

// 목적: 학생 목록에서 "화면 구조가 바뀌었는지"를 판단할 키를 만듭니다.
// 이유: 이름, 반, 퇴원, 번호 유무가 바뀐 때만 칸을 다시 만들고, 출석 색과 시각만 바뀐 때는 제자리에서 칠해야 마우스를 올린 칸이 깜빡이지 않습니다.
// 방법: id, 이름, 퇴원 여부, 번호 유무, 반 목록을 이어 붙인 문자열(출석 상태는 제외).
function structureKey(list) {
  return list.map((s) => `${s.id}|${s.name}|${s.left ? 1 : 0}|${s.phone ? 1 : 0}|${s.classIds.join(',')}`).join('\n');
}

// 목적: 서버가 준 최신 상태를 화면에 반영합니다.
// 이유: 폴링 응답과 교사 동작 응답이 모두 이 한 경로로 화면을 갱신해야 서로 어긋나지 않습니다.
// 방법: 옛 응답(rev가 작음)은 버립니다. 이름 입력 중이면 입력창이 날아가지 않게 학생 목록과 칸 갱신은 건너뜁니다. 구조가 같으면 색만, 다르면 전체를 다시 그립니다. 반 선택과 열린 창은 학생 목록을 바꾼 뒤에 맞춥니다.
function applyState(next) {
  if (next.rev < rev) return;
  state = next;
  if (editingId === null) {
    rev = next.rev;
    const structural = structureKey(next.students) !== structureKey(students);
    students = next.students;
    const filterReset = updateClassFilter();
    if (structural || filterReset) {
      render();
    } else {
      paintAll();
      updateHeader();
    }
  }
  refreshDialogs();
}

// 목적: 서버 상태를 한 번 가져와 반영합니다.
// 이유: 출석 기기의 입력이 몇 초 안에 이 화면에 나타나야 합니다.
// 방법: 겹쳐 호출되지 않게 막고, 실패하면 끊김 안내를, 성공하면 그 안내를 지웁니다.
async function poll() {
  if (polling) return;
  polling = true;
  try {
    applyState(await api('/api/state'));
    if (toastKind === 'offline') hideToast();
  } catch {
    showToast('서버와 연결이 끊겼어요. 시작 창(검은 창)이 켜져 있는지 확인해 주세요.', 0, 'offline');
  } finally {
    polling = false;
  }
}

// 목적: 반 선택 목록을 서버의 반 목록에 맞춥니다.
// 이유: 반을 만들거나 지우면 선택 목록도 바로 바뀌어야 하고, 지운 반을 고른 채로 남으면 안 됩니다.
// 방법: 반 목록이 바뀐 때만 option을 다시 만듭니다. 고른 반이 사라졌으면 "전체"로 돌아가고 true를 돌려줘서 부른 쪽이 다시 그리게 합니다.
function updateClassFilter() {
  const key = state.classes.map((c) => `${c.id}:${c.name}`).join('|');
  if (classFilterEl.dataset.key === key) return false;
  classFilterEl.dataset.key = key;
  let reset = false;
  if (classFilter !== 'all' && !state.classes.some((c) => c.id === classFilter)) {
    classFilter = 'all';
    page = 0;
    reset = true;
  }
  classFilterEl.replaceChildren(new Option('전체', 'all'));
  for (const c of state.classes) classFilterEl.append(new Option(c.name, String(c.id)));
  classFilterEl.value = String(classFilter);
  return reset;
}

// 목적: 현재 페이지의 8칸과 머리글을 화면에 그립니다.
// 이유: 페이지 이동, 반 선택, 추가, 삭제, 이름 수정, 구조 변경이 모두 같은 그리기 경로를 씁니다.
// 방법: 보일 학생 중 해당 구간 칸 → 마지막 페이지면 추가 칸 → 나머지는 빈 칸, 이동이면 슬라이드 애니메이션.
function render() {
  const list = visibleStudents();
  page = Math.min(Math.max(page, 0), pageCount() - 1);
  const visible = list.slice(page * PER_PAGE, (page + 1) * PER_PAGE);

  grid.replaceChildren();
  for (let i = 0; i < PER_PAGE; i++) {
    if (i < visible.length) grid.append(buildCell(visible[i]));
    else if (i === visible.length) grid.append(buildAddCell());
    else grid.append(buildEmptyCell());
  }

  grid.classList.remove('slide-next', 'slide-prev');
  if (slide) {
    void grid.offsetWidth;
    grid.classList.add(slide);
    slide = '';
  }

  updateHeader();

  const editor = grid.querySelector('.name-input');
  if (editor) {
    editor.focus();
    editor.select();
  }
}

// 목적: 전체 페이지 수를 계산합니다.
// 이유: 마지막 페이지에는 늘 "학생 추가" 칸이 들어갈 자리가 있어야 합니다.
// 방법: 지금 보이는 학생이 8명으로 딱 차면 추가 칸만 있는 페이지가 하나 더 생기도록 floor(n/8)+1.
function pageCount() {
  return Math.floor(visibleStudents().length / PER_PAGE) + 1;
}

// 목적: 등원·하원 인원과 페이지 표시, 이전/다음 버튼 상태를 갱신합니다.
// 이유: 출석이 바뀔 때는 칸을 다시 만들지 않고 머리글만 고치면 됩니다.
// 방법: 보이는 학생의 상태별 수를 세고, 첫/마지막 페이지에서는 해당 방향 버튼을 끕니다.
function updateHeader() {
  const list = visibleStudents();
  const count = (status) => list.filter((s) => s.status === status).length;
  summaryEl.textContent = `등원 ${count('in')} · 하원 ${count('out')} · 미등원 ${count('absent')}`;
  pageLabel.textContent = `${page + 1} / ${pageCount()}`;
  prevBtn.disabled = page === 0;
  nextBtn.disabled = page === pageCount() - 1;
}

// 목적: 학생 한 명의 칸(이름, 출석 토글, 번호 없음 표시, 수정·정보·삭제 버튼)을 만듭니다.
// 이유: 이름 크게 + 등원 초록, 미등원 빨강, 하원 회색이라는 화면의 핵심 단위입니다.
// 방법: 전체를 덮는 토글 버튼과 별도의 액션 버튼을 형제로 둡니다(버튼 안에 버튼을 넣지 않음). 이름은 textContent로 넣습니다. 번호가 없는 학생에게만 "번호 없음" 표시를 붙입니다.
function buildCell(student) {
  const cell = document.createElement('div');
  cell.className = 'cell';
  cell.dataset.id = String(student.id);

  if (student.id === editingId) {
    cell.append(buildEditor(student));
    paintCell(cell, student);
    return cell;
  }

  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'toggle';
  const name = document.createElement('span');
  name.className = 'name';
  name.textContent = student.name;
  const status = document.createElement('span');
  status.className = 'status';
  toggle.append(name, status);

  const actions = document.createElement('div');
  actions.className = 'actions';
  actions.append(
    buildIconButton('edit', '✎', `${student.name} 이름 수정`),
    buildPillButton('info', '정보', `${student.name} 번호·반·퇴원`),
    buildIconButton('delete', '✕', `${student.name} 삭제`),
  );

  cell.append(toggle, actions);
  if (!student.phone) {
    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent = '번호 없음';
    cell.append(badge);
  }
  paintCell(cell, student);
  return cell;
}

// 목적: 칸 모서리에 뜨는 동그란 액션 버튼 하나를 만듭니다.
// 이유: 수정/삭제 버튼의 모양과 접근성 이름을 한 곳에서 맞춥니다.
// 방법: data-act로 동작을 구분하고 aria-label에 학생 이름을 넣습니다.
function buildIconButton(act, glyph, label) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'icon';
  button.dataset.act = act;
  button.setAttribute('aria-label', label);
  button.textContent = glyph;
  return button;
}

// 목적: 글자가 있는 알약 모양 액션 버튼을 만듭니다.
// 이유: "정보"는 아이콘만으로는 뜻이 안 통해서 글자로 보여 줍니다.
// 방법: buildIconButton과 같은 구조에 pill 클래스를 더합니다.
function buildPillButton(act, text, label) {
  const button = buildIconButton(act, text, label);
  button.classList.add('pill');
  return button;
}

// 목적: 마지막 페이지의 빈 자리에 "학생 추가" 칸을 만듭니다.
// 이유: 8칸을 넘는 학생은 새 페이지로 이어져야 해서 추가 경로가 필요합니다.
// 방법: 점선 칸 하나. 평소엔 흐리게 있다가 마우스를 올리면 서서히 또렷해집니다.
function buildAddCell() {
  const cell = document.createElement('div');
  cell.className = 'cell add';
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'toggle';
  const plus = document.createElement('span');
  plus.className = 'plus';
  plus.textContent = '+';
  const label = document.createElement('span');
  label.className = 'label';
  label.textContent = '학생 추가';
  button.append(plus, label);
  cell.append(button);
  return cell;
}

// 목적: 학생이 없는 남는 칸을 만듭니다.
// 이유: 마지막 페이지도 8칸 격자가 무너지지 않아야 접힌 종이 느낌이 유지됩니다.
// 방법: 눈에 띄지 않는 빈 div를 스크린리더에서 숨깁니다.
function buildEmptyCell() {
  const cell = document.createElement('div');
  cell.className = 'cell empty';
  cell.setAttribute('aria-hidden', 'true');
  return cell;
}

// 목적: 칸 안에서 바로 이름을 고치는 입력창을 만듭니다.
// 이유: prompt() 창은 큰 글씨 화면 흐름을 끊습니다.
// 방법: Enter 저장, Esc 취소, 포커스를 잃으면 저장. 한글 조합 중 Enter는 무시합니다. Enter와 Esc는 기본 동작을 막습니다. 막지 않으면 같은 키가 포커스를 옮겨 받은 출석 버튼까지 눌러 등원으로 기록합니다.
function buildEditor(student) {
  const input = document.createElement('input');
  input.className = 'name-input';
  input.value = student.name;
  input.maxLength = NAME_MAX;
  input.setAttribute('aria-label', '학생 이름');
  input.addEventListener('keydown', (event) => {
    if (event.isComposing) return;
    if (event.key === 'Enter') {
      event.preventDefault();
      commitEdit(student.id, input.value);
      focusToggle(student.id);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      cancelEdit(student.id);
      focusToggle(student.id);
    }
  });
  input.addEventListener('blur', () => commitEdit(student.id, input.value));
  return input;
}

// 목적: 칸의 색, 상태 글자(시각 포함), aria 설명을 학생 데이터에 맞춥니다.
// 이유: 그릴 때와 서버 상태가 바뀔 때 같은 모양이 나와야 하고, 제자리 갱신이어야 포커스가 안 날아갑니다.
// 방법: absent/in/out 클래스를 갈아 끼우고, 상태 글자를 "미등원", "등원 14:02", "하원 17:40"으로 바꿉니다.
function paintCell(cell, student) {
  for (const status of ['absent', 'in', 'out']) cell.classList.toggle(status, student.status === status);
  const toggle = cell.querySelector('.toggle');
  if (!toggle) return;
  const text = student.status === 'in' ? `등원 ${student.inTime}`
    : student.status === 'out' ? `하원 ${student.outTime}`
    : '미등원';
  toggle.querySelector('.status').textContent = text;
  toggle.setAttribute('aria-label', `${student.name} ${text}. 누르면 다음 상태로 바뀌어요.`);
}

// 목적: 지금 화면의 모든 학생 칸 색을 최신 출석 상태로 맞춥니다.
// 이유: 출석 기기에서 입력이 들어오면 칸을 다시 만들지 않고 색만 바꿔야 합니다.
// 방법: data-id로 학생을 찾아 paintCell을 부릅니다.
function paintAll() {
  for (const cell of grid.querySelectorAll('.cell[data-id]')) {
    const student = students.find((s) => s.id === Number(cell.dataset.id));
    if (student) paintCell(cell, student);
  }
}

// 목적: 격자 안의 클릭을 칸별 동작(상태 넘기기, 수정, 정보, 삭제, 추가)으로 나눠 줍니다.
// 이유: 페이지를 넘길 때마다 칸을 새로 만드니 칸마다 리스너를 달지 않습니다.
// 방법: 이벤트 위임. 눌린 버튼과 가장 가까운 .cell의 data-id로 학생을 찾습니다.
function onGridClick(event) {
  const button = event.target.closest('button');
  const cell = event.target.closest('.cell');
  if (!button || !cell) return;

  if (cell.classList.contains('add')) {
    addStudent();
    return;
  }

  const student = students.find((s) => s.id === Number(cell.dataset.id));
  if (!student) return;

  if (button.classList.contains('toggle')) act('/api/toggle', { id: student.id });
  else if (button.dataset.act === 'edit') startEdit(student);
  else if (button.dataset.act === 'info') openStudentDialog(student.id);
  else if (button.dataset.act === 'delete') removeStudent(student);
}

// 목적: 학생 이름 수정을 시작합니다.
// 이유: 칸 안에서 바로 고치게 하려는 것입니다.
// 방법: editingId를 잡고 다시 그리면 해당 칸이 입력창으로 나옵니다.
function startEdit(student) {
  editingId = student.id;
  render();
}

// 목적: 입력한 이름을 저장하고 수정 상태를 끝냅니다.
// 이유: Enter와 blur가 연달아 불려도 한 번만 처리해야 합니다(다시 그리면서 입력창이 사라질 때 blur가 또 옵니다).
// 방법: editingId가 이미 다르면 바로 반환. 바뀐 이름이면 화면에 먼저 반영하고 서버에 보냅니다(공백뿐이면 버림). 서버 응답이 실패하면 다음 폴링이 원래 이름으로 되돌립니다.
function commitEdit(id, value) {
  if (editingId !== id) return;
  editingId = null;
  const student = students.find((s) => s.id === id);
  const name = value.trim();
  if (student && name && name !== student.name) {
    student.name = name;
    act('/api/rename', { id, name });
  }
  render();
}

// 목적: 이름 수정을 저장 없이 끝냅니다.
// 이유: Esc로 실수를 되돌릴 수 있어야 합니다.
// 방법: commitEdit과 같은 중복 호출 방어 후 editingId만 풀고 다시 그립니다.
function cancelEdit(id) {
  if (editingId !== id) return;
  editingId = null;
  render();
}

// 목적: 수정을 마친 학생 칸의 토글 버튼으로 포커스를 돌려줍니다.
// 이유: 칸을 다시 만들면 포커스가 body로 빠져 키보드 사용자가 자리를 잃습니다.
// 방법: Enter/Esc로 끝낼 때만 호출합니다(blur로 끝났으면 사용자가 다른 곳을 누른 것이라 건드리지 않습니다).
function focusToggle(id) {
  const toggle = grid.querySelector(`[data-id="${id}"] .toggle`);
  if (toggle) toggle.focus();
}

// 목적: 새 학생을 명단 끝에 넣고 바로 이름을 입력하게 합니다.
// 이유: 붙여넣기 뒤에 한 명씩 추가하는 경로입니다(DEC-12). 반을 고른 상태면 그 반에 넣어야 바로 보입니다.
// 방법: 서버에 추가 요청(고른 반 포함) → 응답 상태를 반영 → 새 학생이 있는 페이지로 이동 → 수정 상태로 렌더.
async function addStudent() {
  try {
    const next = await api('/api/add', classFilter === 'all' ? {} : { classId: classFilter });
    editingId = null;
    applyState(next);
    editingId = next.id;
    page = Math.floor((visibleStudents().length - 1) / PER_PAGE);
    render();
  } catch (e) {
    showToast(e.message, 4000, 'error');
  }
}

// 목적: 잘못 등록한 학생을 명단과 기록에서 지웁니다.
// 이유: 지우면 되돌릴 수 없고 그 학생의 출석 기록도 함께 사라집니다(DEC-11). 학원을 그만둔 학생은 퇴원으로 처리합니다.
// 방법: confirm으로 한 번 확인한 뒤 서버에 삭제를 요청합니다(페이지는 render가 범위로 보정).
function removeStudent(student) {
  if (!confirm(`'${student.name}' 학생을 삭제할까요?\n출석 기록도 함께 지워지고 되돌릴 수 없습니다.\n학원을 그만둔 학생이면 '정보'에서 퇴원 처리를 해 주세요.`)) return;
  act('/api/delete', { id: student.id });
}

// 목적: 학생의 번호·반·퇴원 창을 엽니다.
// 이유: 칸에는 버튼을 많이 둘 수 없어서, 자주 쓰지 않는 설정은 창 하나에 모읍니다.
// 방법: 열 학생 id를 기억하고, 창 내용을 그린 뒤 번호 칸에 지금 번호를 넣습니다.
function openStudentDialog(id) {
  dialogStudentId = id;
  const student = students.find((s) => s.id === id);
  phoneInput.value = student && student.phone ? student.phone : '';
  drawStudentDialog();
  studentDialog.showModal();
}

// 목적: 학생 창의 제목과 반 체크 상자를 그립니다.
// 이유: 반 목록이나 학생 이름이 바뀌면 창도 맞춰야 합니다.
// 방법: 반마다 체크 상자를 만들고, 학생이 속한 반은 체크합니다. 학생이 사라졌으면 창을 닫습니다.
function drawStudentDialog() {
  const student = students.find((s) => s.id === dialogStudentId);
  if (!student) {
    studentDialog.close();
    return;
  }
  studentTitle.textContent = student.name;
  studentClassesEl.replaceChildren();
  for (const c of state.classes) {
    const label = document.createElement('label');
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.value = String(c.id);
    box.checked = student.classIds.includes(c.id);
    label.append(box, ` ${c.name}`);
    studentClassesEl.append(label);
  }
  studentNoClass.hidden = state.classes.length > 0;
}

// 목적: 학생 창의 번호를 저장합니다.
// 이유: 번호가 있어야 출석 기기로 출석할 수 있습니다. 같은 번호를 쓰는 형제자매도 있어서 막지 않고 알리기만 합니다.
// 방법: /api/phone에 보내고, 서버가 같은 번호가 있다고 하면 안내를 띄웁니다.
async function savePhone() {
  const data = await act('/api/phone', { id: dialogStudentId, phone: phoneInput.value });
  if (!data) return;
  if (data.duplicatePhone) showToast('같은 번호의 학생이 있어요. 형제자매라면 그대로 두셔도 돼요.', 6000, 'info');
  else showToast('번호를 저장했어요.', 2500, 'info');
}

// 목적: 학생 창의 반 체크 상자가 바뀌면 바로 저장합니다.
// 이유: 저장 버튼을 따로 누르지 않아도 되게 합니다.
// 방법: 체크된 반 id를 모두 모아 /api/assign으로 보냅니다.
function saveClasses() {
  const classIds = [...studentClassesEl.querySelectorAll('input:checked')].map((box) => Number(box.value));
  act('/api/assign', { id: dialogStudentId, classIds });
}

// 목적: 학원을 그만둔 학생을 퇴원 처리합니다.
// 이유: 현황판과 출석 기기에서는 빼되, 상담용 기록은 남겨야 합니다(DEC-11).
// 방법: 번호가 지워진다는 것을 confirm으로 알린 뒤 /api/leave를 보내고 창을 닫습니다.
async function leaveStudent() {
  const student = students.find((s) => s.id === dialogStudentId);
  if (!student) return;
  if (!confirm(`'${student.name}' 학생을 퇴원 처리할까요?\n현황판과 출석 기기에서 빠지고 번호는 지워져요. 기록은 남아요.`)) return;
  const data = await act('/api/leave', { id: student.id });
  if (data) studentDialog.close();
}

// 목적: 반 관리 창의 반 목록을 그립니다.
// 이유: 반 이름을 바꾸거나 지우는 곳입니다.
// 방법: 반마다 이름 입력칸, 이름 저장, 삭제 버튼을 만듭니다. 버튼에는 data-act와 data-id를 둡니다.
function drawClassList() {
  classListEl.replaceChildren();
  if (state.classes.length === 0) {
    const empty = document.createElement('li');
    empty.textContent = '아직 반이 없어요.';
    classListEl.append(empty);
    return;
  }
  for (const c of state.classes) {
    const item = document.createElement('li');
    const input = document.createElement('input');
    input.className = 'field grow';
    input.value = c.name;
    input.maxLength = 20;
    input.setAttribute('aria-label', `${c.name} 반 이름`);
    const count = students.filter((s) => !s.left && s.classIds.includes(c.id)).length;
    const meta = document.createElement('span');
    meta.textContent = `${count}명`;
    const rename = document.createElement('button');
    rename.type = 'button';
    rename.className = 'btn';
    rename.textContent = '이름 저장';
    rename.dataset.act = 'rename';
    rename.dataset.id = String(c.id);
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'btn danger';
    remove.textContent = '삭제';
    remove.dataset.act = 'delete';
    remove.dataset.id = String(c.id);
    item.append(input, meta, rename, remove);
    classListEl.append(item);
  }
}

// 목적: 반 관리 창의 버튼(이름 저장, 삭제)을 처리합니다.
// 이유: 반을 지우면 학생들의 반 표시도 함께 빠지니 확인이 필요합니다.
// 방법: 이벤트 위임. 이름 저장은 같은 줄의 입력값을 보내고, 삭제는 confirm 후 보냅니다.
function onClassListClick(event) {
  const button = event.target.closest('button[data-act]');
  if (!button) return;
  const id = Number(button.dataset.id);
  const found = state.classes.find((c) => c.id === id);
  if (!found) return;
  if (button.dataset.act === 'rename') {
    const name = button.closest('li').querySelector('input').value;
    act('/api/classes/rename', { id, name });
  } else if (confirm(`'${found.name}' 반을 삭제할까요?\n학생은 그대로 있고, 이 반 표시만 빠져요.`)) {
    act('/api/classes/delete', { id });
  }
}

// 목적: 새 반을 만듭니다.
// 이유: 타임(반)별로 현황판과 기록을 나눠 봐야 합니다.
// 방법: 입력한 이름을 보내고, 성공하면 입력칸을 비웁니다.
async function addClass() {
  const data = await act('/api/classes/add', { name: classNewInput.value });
  if (data) classNewInput.value = '';
}

// 목적: 퇴원생 창의 목록을 그립니다.
// 이유: 퇴원생은 현황판에 없어서, 다시 다니게 된 학생을 복귀시킬 곳이 필요합니다.
// 방법: 퇴원한 학생마다 이름과 복귀 버튼을 만듭니다.
function drawLeftList() {
  leftListEl.replaceChildren();
  const left = students.filter((s) => s.left);
  if (left.length === 0) {
    const empty = document.createElement('li');
    empty.textContent = '퇴원한 학생이 없어요.';
    leftListEl.append(empty);
    return;
  }
  for (const s of left) {
    const item = document.createElement('li');
    const name = document.createElement('span');
    name.className = 'grow';
    name.textContent = s.name;
    const back = document.createElement('button');
    back.type = 'button';
    back.className = 'btn';
    back.textContent = '복귀';
    back.dataset.id = String(s.id);
    item.append(name, back);
    leftListEl.append(item);
  }
}

// 목적: 복사한 표 글자를 줄과 칸으로 나눕니다.
// 이유: 엑셀과 구글 스프레드시트는 칸 안에 줄바꿈이나 따옴표가 있으면 그 칸을 따옴표로 감쌉니다. 줄바꿈으로만 나누면 한 칸이 두 학생으로 쪼개집니다.
// 방법: 글자를 차례로 읽습니다. 따옴표로 시작한 칸은 닫는 따옴표까지 한 칸이고, 안의 "" 는 " 하나입니다. 칸 안의 줄바꿈은 공백으로 바꿉니다.
function parseTsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (ch === '"') {
        quoted = false;
      } else {
        cell += ch === '\r' || ch === '\n' ? ' ' : ch;
      }
    } else if (ch === '"' && cell === '') {
      quoted = true;
    } else if (ch === '\t') {
      row.push(cell.trim());
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      row.push(cell.trim());
      rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += ch;
    }
  }
  if (cell !== '' || row.length > 0) {
    row.push(cell.trim());
    rows.push(row);
  }
  return rows;
}

// 목적: 붙여넣은 표 글자를 [이름, 번호, 반] 행으로 바꿉니다.
// 이유: 학원 명단에는 학교·학년 같은 다른 칸도 있고(DEC-12), '번호'라는 이름의 칸이 휴대폰이 아니라 줄 번호일 때도 있습니다.
// 방법: 첫 줄에서 '이름' 칸을 찾으면 제목 줄로 봅니다. 번호 칸은 휴대폰·전화·연락처가 들어간 제목을 먼저 보고, 그중 값이 휴대폰번호처럼 보이는 칸을 고릅니다. 제목 줄이 없으면 첫 칸을 이름으로 봅니다. 이름이 빈 줄은 건너뜁니다.
function parsePaste(text) {
  const lines = parseTsv(text);
  const header = lines[0] ?? [];
  const titles = header.map((cell) => cell.replace(/\s/g, ''));
  const nameCol = titles.findIndex((c) => c.includes('이름') || c.includes('성명'));
  const hasHeader = nameCol !== -1;
  const looksLikePhones = (col) => {
    const values = lines.slice(1).map((cells) => (cells[col] ?? '').replace(/\D/g, '')).filter(Boolean);
    return values.length > 0 && values.filter((v) => v.length >= 9 && v.length <= 11).length * 2 >= values.length;
  };
  const phoneCandidates = [
    ...titles.flatMap((c, i) => (/휴대폰|핸드폰|전화|연락처/.test(c) ? [i] : [])),
    ...titles.flatMap((c, i) => (/번호/.test(c) && !/휴대폰|핸드폰|전화|연락처/.test(c) ? [i] : [])),
  ];
  const phoneCol = hasHeader ? (phoneCandidates.find(looksLikePhones) ?? -1) : -1;
  const classCol = hasHeader ? titles.findIndex((c) => /타임|수업/.test(c) || /반$/.test(c)) : -1;
  const rows = [];
  const lineNumbers = [];
  lines.forEach((cells, index) => {
    if (hasHeader && index === 0) return;
    const name = cells[hasHeader ? nameCol : 0] ?? '';
    if (name === '') return;
    rows.push([name, phoneCol === -1 ? '' : cells[phoneCol] ?? '', classCol === -1 ? '' : cells[classCol] ?? '']);
    lineNumbers.push(index + 1);
  });
  return { rows, lineNumbers, hasHeader, phoneCol, classCol };
}

// 목적: 붙여넣은 명단을 서버에 보내 미리보기를 보여 줍니다. 아직 저장하지 않습니다.
// 이유: 추가될 학생과 건너뛸 행을 확인한 뒤에만 명단이 바뀌어야 합니다(DEC-12).
// 방법: parsePaste로 행을 만들고 크기를 확인한 뒤 /api/import/preview를 부릅니다. 결과를 추가·이미 있음·읽지 못함으로 나눠 그리고, 추가할 학생이 있으면 "추가하기"를 켭니다.
async function checkPaste() {
  pasteApplyBtn.disabled = true;
  pastedRows = null;
  pastePreview.replaceChildren();
  const parsed = parsePaste(pasteBox.value);
  if (parsed.rows.length === 0) {
    addPreviewLine('붙여넣은 명단에서 이름을 찾지 못했습니다.');
    return;
  }
  if (new Blob([JSON.stringify({ rows: parsed.rows })]).size > PASTE_BYTES_MAX) {
    addPreviewLine('한 번에 붙여넣기에는 너무 많습니다. 두세 번에 나눠서 붙여넣어 주세요.');
    return;
  }
  let data;
  try {
    data = await api('/api/import/preview', { rows: parsed.rows });
  } catch (e) {
    addPreviewLine(e.message);
    return;
  }
  const preview = data.preview;
  const columns = [parsed.hasHeader ? '이름' : '첫 칸(이름)'];
  if (parsed.phoneCol !== -1) columns.push('번호');
  if (parsed.classCol !== -1) columns.push('반');
  addPreviewLine(`가져올 칸: ${columns.join(', ')}`);
  addPreviewHeading(`추가할 학생 ${preview.add.length}명`);
  if (preview.add.length > 0) addPreviewLine(preview.add.map((a) => a.name).join(', '));
  if (preview.exists.length > 0) {
    addPreviewHeading(`이미 있어서 건너뛸 학생 ${preview.exists.length}명`);
    addPreviewLine(preview.exists.join(', '));
  }
  if (preview.bad.length > 0) {
    addPreviewHeading(`읽지 못한 줄 ${preview.bad.length}개`);
    for (const b of preview.bad) addPreviewLine(`${parsed.lineNumbers[b.line - 1]}번째 줄: ${b.reason}`);
  }
  if (preview.add.length > 0) {
    pastedRows = parsed.rows;
    pasteApplyBtn.disabled = false;
  }
}

// 목적: 미리보기에 소제목 한 줄을 더합니다.
// 이유: 추가, 건너뜀, 오류를 나눠 보여 줍니다.
// 방법: h3를 textContent로 만들어 붙입니다.
function addPreviewHeading(text) {
  const heading = document.createElement('h3');
  heading.textContent = text;
  pastePreview.append(heading);
}

// 목적: 미리보기에 글 한 줄을 더합니다.
// 이유: 학생 이름이 들어가는 글이라 innerHTML을 쓰지 않습니다.
// 방법: p를 textContent로 만들어 붙입니다.
function addPreviewLine(text) {
  const line = document.createElement('p');
  line.textContent = text;
  pastePreview.append(line);
}

// 목적: 미리보기에서 확인한 명단을 실제로 추가합니다.
// 이유: 서버가 같은 계산을 다시 해서, 그 사이 바뀐 명단에도 맞게 추가합니다.
// 방법: 미리보기 때 만든 행을 /api/import/apply로 보내고, 결과를 알린 뒤 창을 비우고 닫습니다.
async function applyPaste() {
  if (!pastedRows) return;
  pasteApplyBtn.disabled = true;
  const data = await act('/api/import/apply', { rows: pastedRows });
  if (!data) return;
  showToast(`${data.imported.added}명을 추가했어요.`, 4000, 'info');
  pasteBox.value = '';
  pastePreview.replaceChildren();
  pastedRows = null;
  pasteDialog.close();
}

// 목적: 출석 기기 창(주소, QR, 등록 코드, 기기 목록)을 최신 상태로 그립니다.
// 이유: 등록 코드는 10분 뒤 사라지고, 기기가 등록되면 목록에 바로 나와야 합니다.
// 방법: 주소가 바뀐 때만 QR을 다시 그립니다. 등록 코드가 열려 있으면 코드와 남은 분을, 기기마다 이름·등록일·등록 취소 버튼을 보여 줍니다.
function drawDevices() {
  if (state.kioskUrl !== drawnQrUrl) {
    drawnQrUrl = state.kioskUrl;
    drawQr(state.kioskUrl);
  }
  deviceUrl.textContent = state.kioskUrl ?? '같은 네트워크 주소를 찾지 못했어요. PC가 Wi-Fi나 유선망에 연결돼 있는지 확인해 주세요.';
  addrNextBtn.hidden = state.addressCount < 2;
  if (state.pairing) {
    pairCodeEl.textContent = state.pairing.code;
    pairLeftEl.textContent = `출석 기기에 이 코드를 입력해 주세요. ${Math.ceil(state.pairing.expiresInMs / 60000)}분 안에 입력해야 해요.`;
  } else {
    pairCodeEl.textContent = '';
    pairLeftEl.textContent = '';
  }
  deviceListEl.replaceChildren();
  for (const d of state.devices) {
    const item = document.createElement('li');
    const label = document.createElement('span');
    label.className = 'grow';
    label.textContent = `${d.label} (등록일 ${d.pairedOn})`;
    const revoke = document.createElement('button');
    revoke.type = 'button';
    revoke.className = 'btn danger';
    revoke.textContent = '등록 취소';
    revoke.dataset.id = String(d.id);
    revoke.dataset.label = d.label;
    item.append(label, revoke);
    deviceListEl.append(item);
  }
}

// 목적: 출석 기기 주소를 QR 이미지로 그립니다.
// 이유: 교사 PC 주소가 바뀌어도 출석 기기가 QR로 새 주소를 바로 열 수 있어야 합니다.
// 방법: 번들한 qrcode 라이브러리로 SVG를 만들어 넣습니다. 주소가 없으면 안내 글자를 보여 줍니다.
function drawQr(url) {
  if (!url) {
    deviceQr.textContent = '주소 없음';
    return;
  }
  const code = qrcode(0, 'L');
  code.addData(url);
  code.make();
  deviceQr.innerHTML = code.createSvgTag({ cellSize: 1, margin: 4, scalable: true });
}

// 목적: 열려 있는 창의 내용을 최신 상태에 맞춥니다.
// 이유: 폴링으로 반, 퇴원생, 기기 목록이 바뀌면 열린 창에도 보여야 합니다. 입력 중인 창을 다시 그리면 입력이 날아갑니다.
// 방법: 열린 창마다, 그 안에서 입력칸에 포커스가 없을 때만 다시 그립니다.
function refreshDialogs() {
  const typing = (dialog) => dialog.contains(document.activeElement)
    && ['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName)
    && document.activeElement.type !== 'checkbox';
  if (studentDialog.open && !typing(studentDialog)) drawStudentDialog();
  if (classesDialog.open && !typing(classesDialog)) drawClassList();
  if (leftDialog.open) drawLeftList();
  if (devicesDialog.open) drawDevices();
}

// 목적: 창을 열면서 내용을 먼저 그립니다.
// 이유: 창이 빈 채로 잠깐 보이지 않게 합니다.
// 방법: 그리기 함수를 부른 뒤 showModal.
function openDialog(dialog, draw) {
  if (state) draw();
  dialog.showModal();
}

// 목적: 페이지를 앞뒤로 넘깁니다.
// 이유: 8명을 넘는 학생을 옆 페이지로 보기 위해서입니다.
// 방법: 범위 안으로 보정하고 바뀔 때만, 방향에 맞는 슬라이드 클래스를 예약한 뒤 렌더.
function goPage(delta) {
  const target = Math.min(Math.max(page + delta, 0), pageCount() - 1);
  if (target === page) return;
  slide = delta > 0 ? 'slide-next' : 'slide-prev';
  page = target;
  render();
}

// 목적: 키보드 입력을 처리합니다. ←/→는 페이지 이동입니다.
// 이유: 교사가 마우스 없이도 TV 앞에서 넘길 수 있어야 합니다.
// 방법: 창이 열려 있거나, 입력 중이거나, 조합키가 눌려 있으면 무시합니다.
function onKeydown(event) {
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
  if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLSelectElement) return;
  if (document.querySelector('dialog[open]')) return;
  if (event.key === 'ArrowRight') goPage(1);
  else if (event.key === 'ArrowLeft') goPage(-1);
}

grid.addEventListener('click', onGridClick);
prevBtn.addEventListener('click', () => goPage(-1));
nextBtn.addEventListener('click', () => goPage(1));
classFilterEl.addEventListener('change', () => {
  classFilter = classFilterEl.value === 'all' ? 'all' : Number(classFilterEl.value);
  page = 0;
  render();
});
for (const close of document.querySelectorAll('[data-close]')) {
  close.addEventListener('click', () => close.closest('dialog').close());
}

document.getElementById('phone-save').addEventListener('click', savePhone);
phoneInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.isComposing) savePhone();
});
studentClassesEl.addEventListener('change', saveClasses);
document.getElementById('student-leave').addEventListener('click', leaveStudent);

document.getElementById('open-classes').addEventListener('click', () => openDialog(classesDialog, drawClassList));
classListEl.addEventListener('click', onClassListClick);
document.getElementById('class-add').addEventListener('click', addClass);
classNewInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.isComposing) addClass();
});

document.getElementById('open-left').addEventListener('click', () => openDialog(leftDialog, drawLeftList));
leftListEl.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-id]');
  if (button) act('/api/return', { id: Number(button.dataset.id) });
});

document.getElementById('open-paste').addEventListener('click', () => openDialog(pasteDialog, () => {}));
document.getElementById('paste-check').addEventListener('click', checkPaste);
pasteApplyBtn.addEventListener('click', applyPaste);
pasteBox.addEventListener('input', () => {
  pasteApplyBtn.disabled = true;
  pastedRows = null;
});

document.getElementById('open-devices').addEventListener('click', () => openDialog(devicesDialog, drawDevices));
document.getElementById('pair-start').addEventListener('click', () => act('/api/devices/pair', {}));
addrNextBtn.addEventListener('click', () => act('/api/address/next', {}));
deviceListEl.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-id]');
  if (!button) return;
  if (!confirm(`'${button.dataset.label}'의 등록을 취소할까요?\n그 기기에서는 다시 등록 코드를 입력해야 출석할 수 있어요.`)) return;
  act('/api/devices/revoke', { id: Number(button.dataset.id) });
});
// 창을 닫으면 쓰지 않은 등록 코드를 바로 버린다 — TV에 보인 코드가 10분 동안 남지 않게.
devicesDialog.addEventListener('close', () => {
  if (state && state.pairing) act('/api/devices/cancel', {});
});

document.addEventListener('keydown', onKeydown);

// 첫 상태가 빈 명단이면 구조가 바뀌지 않았다고 보아 그리지 않으니, 시작할 때 한 번 그립니다.
render();
poll();
setInterval(poll, POLL_MS);
