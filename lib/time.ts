// 목적: PC 현지 시각을 날짜(YYYY-MM-DD)와 시:분(HH:MM) 문자열로 바꾸고 비교합니다.
// 사용처: lib/store.ts(백업 파일 이름), lib/records.ts, lib/devices.ts, lib/teacher.ts가 불러 씁니다.
// 근거: 저장, 기록, 기기 등록이 모두 같은 날짜 기준을 써야 해서 server.js를 나누면서 한 파일로 모았습니다(DEC-14).

// 목적: 시각을 PC 현지 날짜 문자열(YYYY-MM-DD)로 바꿉니다.
// 이유: 기록은 학원의 날짜 기준으로 묶여야 합니다. UTC로 묶으면 오전 9시 전 기록이 전날로 갑니다.
// 방법: Date의 현지 시간 getter로 조립합니다.
export function localDate(now: number): string {
  const d = new Date(now);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

// 목적: 시각을 PC 현지 시:분(HH:MM)으로 바꿉니다.
// 이유: 상담에 쓰는 기록은 분 단위면 충분합니다.
// 방법: Date의 현지 시간 getter로 조립합니다.
export function localTime(now: number): string {
  const d = new Date(now);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

// 목적: 숫자를 두 자리 문자열로 맞춥니다.
// 이유: 날짜와 시각 문자열을 정렬·비교할 수 있게 합니다.
// 방법: padStart.
function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

// 목적: HH:MM을 자정부터 지난 분으로 바꿉니다.
// 이유: 반복 구간(REPEAT_WINDOW_MIN)과 등원·하원 순서를 비교해야 합니다.
// 방법: 시와 분을 숫자로 나눠 계산합니다.
export function minutesOf(time: string): number {
  return Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
}
