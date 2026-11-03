// 목적: 세 화면이 함께 쓰는 서버 요청 함수예요.
// 사용처: public/index.html, kiosk.html, records.html이 각 화면 스크립트보다 먼저 불러요.
// 근거: 같은 요청·오류 처리 코드가 세 화면에 따로 있던 것을 스크립트를 파일로 옮기면서 하나로 모았어요(DEC-14).

// 목적: 서버 API를 부르고 JSON 응답을 돌려받아요.
// 이유: 조회(GET)와 변경(POST)이 세 화면에서 같은 헤더와 오류 처리를 써요.
// 방법: body가 있으면 JSON POST, 없으면 캐시 없는 GET. 응답이 실패면 서버가 준 message로 예외를 던지고, 연결 실패는 그대로 던져요.
async function api(path, body) {
  const options = body === undefined
    ? { cache: 'no-store' }
    : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
  const res = await fetch(path, options);
  let data = null;
  try {
    data = await res.json();
  } catch {
    // 본문이 JSON이 아니면 상태 코드로 설명한다
  }
  if (!res.ok) throw new Error((data && data.message) || `서버 오류 (${res.status})`);
  return data;
}
