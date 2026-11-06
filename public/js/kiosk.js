// 목적: 출석 기기 화면의 동작입니다. 등록 코드, 키패드, 이름 고르기, 결과 화면을 맡습니다.
// 사용처: public/kiosk.html이 common.js 다음에 부릅니다.
// 근거: HTML 안 스크립트를 막는 보안 정책(CSP)을 켜려고 kiosk.html에서 옮겼습니다(DEC-14).

const CODE_LENGTH = { pair: 6, digits: 4 };
const RESULT_MS = 3500;

const screens = ['loading', 'entry', 'choose', 'result', 'offline'].map((id) => document.getElementById(id));
const entryTitle = document.getElementById('entry-title');
const entryText = document.getElementById('entry-text');
const dotsEl = document.getElementById('dots');
const entryMessage = document.getElementById('entry-message');
const keypadEl = document.getElementById('keypad');
const choicesEl = document.getElementById('choices');
const resultEl = document.getElementById('result');
const resultBig = document.getElementById('result-big');
const resultTime = document.getElementById('result-time');
const resultSub = document.getElementById('result-sub');
const brandEl = document.getElementById('brand');

let mode = 'digits';
let typed = '';
let busy = false;
let pendingDigits = '';
let resultTimer = null;
let lastRequest = null;

// 목적: 화면 하나만 보이게 합니다.
// 이유: 입력, 이름 고르기, 결과, 연결 끊김이 한 페이지 안의 다른 화면입니다.
// 방법: 대상 화면만 hidden을 풉니다.
function show(id) {
  for (const screen of screens) screen.hidden = screen.id !== id;
}

// 목적: 숫자 키패드를 만듭니다.
// 이유: 등록 코드 입력과 번호 입력이 같은 키패드를 씁니다.
// 방법: 1~9, 지우기, 0, 처음부터 순서로 버튼을 만들고 data-key로 동작을 구분합니다.
function buildKeypad() {
  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'back', '0', 'clear'];
  for (const key of keys) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'key';
    button.dataset.key = key;
    if (key === 'back') {
      button.textContent = '지우기';
      button.classList.add('small');
    } else if (key === 'clear') {
      button.textContent = '처음부터';
      button.classList.add('small');
    } else {
      button.textContent = key;
    }
    keypadEl.append(button);
  }
}

// 목적: 입력 화면을 등록 코드용이나 번호용으로 엽니다.
// 이유: 등록되지 않은 기기는 먼저 코드를 입력해야 하고, 등록된 기기는 번호를 받습니다.
// 방법: mode에 맞는 제목과 안내, 칸 수를 그리고 입력값을 비웁니다. 안내 문구는 실패면 경고색, ok가 true(등록 성공)면 초록색으로 보여 줍니다.
function openEntry(nextMode, message, ok = false) {
  mode = nextMode;
  typed = '';
  if (mode === 'pair') {
    entryTitle.textContent = '출석 기기 등록';
    entryText.textContent = "현황판의 '출석 기기' 창에 나온 6자리 코드를 입력해 주세요.";
  } else {
    entryTitle.textContent = '출석';
    entryText.textContent = '휴대폰번호 뒷 4자리 입력';
  }
  entryMessage.textContent = message ?? '';
  entryMessage.classList.toggle('ok', ok);
  drawDots();
  show('entry');
}

// 목적: 입력한 자리 수만큼 칸을 채워 보여 줍니다.
// 이유: 몇 자리를 눌렀는지 바로 보여야 합니다. 번호는 옆 사람이 보지 않게 가립니다.
// 방법: 칸 수만큼 만들고, 번호는 ●, 등록 코드는 숫자 그대로 보여 줍니다.
function drawDots() {
  dotsEl.replaceChildren();
  for (let i = 0; i < CODE_LENGTH[mode]; i++) {
    const dot = document.createElement('span');
    dot.className = 'dot';
    if (i < typed.length) {
      dot.classList.add('filled');
      dot.textContent = mode === 'pair' ? typed[i] : '●';
    }
    dotsEl.append(dot);
  }
}

// 목적: 키패드 누름을 처리하고, 자리 수가 다 차면 바로 보냅니다.
// 이유: 학생이 확인 버튼을 따로 누르지 않아도 되게 합니다.
// 방법: 보내는 중이면 무시합니다. 숫자는 추가, 지우기는 한 자리 삭제, 처음부터는 전부 삭제합니다.
function onKey(event) {
  const button = event.target.closest('.key');
  if (!button || busy) return;
  const key = button.dataset.key;
  entryMessage.textContent = '';
  if (key === 'back') typed = typed.slice(0, -1);
  else if (key === 'clear') typed = '';
  else if (typed.length < CODE_LENGTH[mode]) typed += key;
  drawDots();
  if (typed.length === CODE_LENGTH[mode]) {
    if (mode === 'pair') pair(typed);
    else checkin(typed, null);
  }
}

// 목적: 서버 요청 하나를 보내고, 연결이 끊기면 연결 끊김 화면을 보여 줍니다.
// 이유: 교사 PC가 꺼지거나 Wi-Fi가 끊겨도 학생이 다음에 뭘 할지 알아야 합니다.
// 방법: busy로 겹쳐 보내기를 막습니다. 실패하면 같은 요청을 "다시 시도"에서 그대로 보낼 수 있게 기억합니다.
async function send(request) {
  busy = true;
  lastRequest = request;
  try {
    await request();
  } catch {
    show('offline');
  } finally {
    busy = false;
  }
}

// 목적: 위쪽 띠에 학원 이름을 그립니다.
// 이유: 학생이 이 기기가 어느 학원 출석부인지 바로 알 수 있게 합니다.
// 방법: 서버가 이름을 보낸 응답(hello, pair, checkin)마다 맞춥니다. 이름이 없으면 띠를 숨기고, 이름이 없는 옛 서버의 응답이면 그대로 둡니다.
function drawBrand(data) {
  if (typeof data.academyName !== 'string') return;
  brandEl.textContent = data.academyName ? `${data.academyName} 출석` : '';
  brandEl.hidden = !data.academyName;
}

// 목적: 처음 열 때 이 기기가 등록돼 있는지 확인합니다.
// 이유: 등록된 기기면 바로 번호를 받고, 아니면 등록 코드부터 받아야 합니다.
// 방법: hello를 보내 ready면 번호 입력, unpaired면 등록 코드 입력을 엽니다. 받은 학원 이름으로 위쪽 띠도 맞춥니다.
function hello() {
  send(async () => {
    const data = await api('/api/kiosk/hello', {});
    drawBrand(data);
    if (data.state === 'ready') openEntry('digits');
    else openEntry('pair');
  });
}

// 목적: 등록 코드를 보내 이 기기를 출석 기기로 등록합니다.
// 이유: 코드를 본 사람만 출석 기기를 등록할 수 있습니다.
// 방법: 결과마다 안내를 바꿉니다. paired면 성공 안내를 초록색으로 보여 주며 번호 입력으로 넘어가고, 학원 이름 띠도 맞춥니다.
function pair(code) {
  send(async () => {
    const data = await api('/api/kiosk/pair', { code });
    drawBrand(data);
    if (data.state === 'paired') openEntry('digits', `${data.label}로 등록됐어요.`, true);
    else if (data.state === 'wrong') openEntry('pair', '코드가 맞지 않습니다. 다시 입력해 주세요.');
    else if (data.state === 'full') openEntry('pair', "출석 기기를 더 등록할 수 없습니다. 현황판의 '출석 기기' 창에서 안 쓰는 기기를 '등록 취소'해 주세요.");
    else openEntry('pair', '코드가 만료됐습니다. 현황판에서 새 코드를 받아 주세요.');
  });
}

// 목적: 번호 뒷 4자리(와 고른 학생)를 보내 출석을 기록합니다.
// 이유: 서버가 등원·하원·반복을 정하고, 화면은 그 결과만 보여 줍니다.
// 방법: 상태마다 결과 화면이나 이름 고르기를 보여 줍니다. 기기 등록이 취소됐으면 등록 코드 입력으로 돌아갑니다. 응답마다 학원 이름 띠를 맞춰, 현황판에서 고친 이름이 다음 출석부터 보입니다.
function checkin(digits, studentId) {
  send(async () => {
    const data = await api('/api/kiosk/checkin', studentId === null ? { digits } : { digits, studentId });
    drawBrand(data);
    if (data.state === 'unpaired') {
      openEntry('pair', '이 기기의 등록이 취소됐습니다. 새 코드로 다시 등록해 주세요.');
    } else if (data.state === 'choose') {
      showChoices(digits, data.choices);
    } else {
      showResult(data);
    }
  });
}

// 목적: 같은 번호를 쓰는 학생 중 본인 이름을 고르게 합니다.
// 이유: 형제자매가 학부모 번호를 함께 쓰거나 뒷 4자리가 겹칠 수 있습니다.
// 방법: 이름 버튼을 textContent로 만들고, 누르면 그 학생 id로 다시 출석을 보냅니다.
function showChoices(digits, choices) {
  pendingDigits = digits;
  choicesEl.replaceChildren();
  for (const choice of choices) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'choice';
    button.dataset.id = String(choice.id);
    button.textContent = choice.name;
    choicesEl.append(button);
  }
  show('choose');
}

// 목적: 출석 결과를 크게 보여 주고 잠시 뒤 키패드로 돌아갑니다.
// 이유: 다음 학생이 바로 입력할 수 있어야 하고, 학생은 자기 이름과 시각을 확인해야 합니다.
// 방법: 상태마다 색과 문구를 정합니다. 모르는 상태는 번호 확인 안내로 처리합니다. 화면을 누르면 바로 돌아갑니다.
function showResult(data) {
  resultEl.className = 'screen';
  resultTime.textContent = '';
  resultSub.textContent = '';
  if (data.state === 'in') {
    resultEl.classList.add('in');
    resultBig.textContent = `${data.name} 등원했어요`;
    resultTime.textContent = data.time;
  } else if (data.state === 'out') {
    resultEl.classList.add('out');
    resultBig.textContent = `${data.name} 하원했어요`;
    resultTime.textContent = data.time;
  } else if (data.state === 'already') {
    resultEl.classList.add(data.kind === 'out' ? 'out' : 'in');
    resultBig.textContent = data.kind === 'out' ? `${data.name} 이미 하원했어요` : `${data.name} 이미 등원했어요`;
    resultTime.textContent = data.time;
    resultSub.textContent = '3분 뒤에 다시 눌러 주세요.';
  } else {
    resultEl.classList.add('warn');
    resultBig.textContent = '등록되지 않은 번호예요';
    resultSub.textContent = '번호를 다시 확인하고, 그래도 안 되면 선생님께 말씀해 주세요.';
  }
  show('result');
  clearTimeout(resultTimer);
  resultTimer = setTimeout(backToPad, RESULT_MS);
}

// 목적: 결과 화면이나 이름 고르기에서 번호 입력으로 돌아갑니다.
// 이유: 다음 학생이 기다리지 않고 입력할 수 있어야 합니다.
// 방법: 타이머를 지우고 번호 입력 화면을 새로 엽니다.
function backToPad() {
  clearTimeout(resultTimer);
  openEntry('digits');
}

buildKeypad();
keypadEl.addEventListener('click', onKey);
choicesEl.addEventListener('click', (event) => {
  const button = event.target.closest('.choice');
  if (!button || busy) return;
  checkin(pendingDigits, Number(button.dataset.id));
});
document.getElementById('choose-cancel').addEventListener('click', backToPad);
resultEl.addEventListener('click', backToPad);
document.getElementById('retry').addEventListener('click', () => {
  if (lastRequest) send(lastRequest);
  else hello();
});

hello();
