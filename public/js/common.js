// 목적: 세 화면이 함께 쓰는 서버 요청 함수와, 교사 화면이 열고 닫힘을 알리는 함수입니다.
// 사용처: public/index.html, kiosk.html, records.html이 각 화면 스크립트보다 먼저 부릅니다.
// 근거: 같은 요청·오류 처리 코드가 세 화면에 따로 있던 것을 스크립트를 파일로 옮기면서 하나로 모았습니다(DEC-14).

// 목적: 서버 API를 부르고 JSON 응답을 돌려받습니다.
// 이유: 조회(GET)와 변경(POST)이 세 화면에서 같은 헤더와 오류 처리를 씁니다.
// 방법: body가 있으면 JSON POST, 없으면 캐시 없는 GET. 응답이 실패면 서버가 준 message로 예외를 던지고, 연결 실패는 그대로 던집니다.
async function api(path, body) {
  const options = body === undefined
    ? { cache: 'no-store' }
    : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
  const res = await fetch(path, options);
  let data = null;
  try {
    data = await res.json();
  } catch {
    // 본문이 JSON이 아니면 상태 코드로 설명합니다
  }
  if (!res.ok) throw new Error((data && data.message) || `서버 오류 (${res.status})`);
  return data;
}

// 목적: 교사 화면(현황판, 기록)이 열리고 닫히는 것을 서버에 알립니다.
// 이유: 브라우저를 닫으면 출석부와 검은 창까지 꺼지게 하려면, 서버가 열린 교사 화면이 남았는지 알아야 합니다(DEC-16). 출석 기기 화면은 부르지 않습니다.
// 방법: 화면마다 무작위 id를 만들어 열릴 때 /api/page/open을, 닫힐 때(pagehide) 화면이 사라져도 끝까지 가는 keepalive 요청으로 /api/page/close를 보냅니다. 뒤로 가기로 되살아나면(pageshow) 다시 열림을 보냅니다. 새로고침은 서버가 잠시 기다리는 동안 다시 열려 꺼지지 않습니다.
function announcePage() {
  const pageId = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('');
  const open = () => api('/api/page/open', { pageId }).catch((e) => console.warn('화면 열림을 알리지 못했습니다.', e.message));
  open();
  addEventListener('pagehide', () => {
    fetch('/api/page/close', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pageId }), keepalive: true })
      .catch((e) => console.warn('화면 닫힘을 알리지 못했습니다.', e.message));
  });
  addEventListener('pageshow', (event) => {
    if (event.persisted) open();
  });
}
