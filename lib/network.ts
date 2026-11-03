// 목적: 출석 기기에 보여 줄 교사 PC의 LAN 주소를 고르고, 교사가 다음 후보로 바꿀 수 있게 합니다.
// 사용처: lib/teacher.ts(현황판 상태, 주소 바꾸기)와 server.ts(시작 안내)가 불러 씁니다.
// 근거: 주소 고르기는 HTTP나 업무 규칙과 상관없는 PC 환경 문제라 server.js를 나누면서 따로 뺐습니다(DEC-14).

import os from 'node:os';

let addressIndex = 0;

// 목적: 출석 기기가 접속할 같은 네트워크(Wi-Fi/유선) 주소 후보를 모읍니다.
// 이유: PC에 가상 어댑터(WSL, VirtualBox 등)가 있으면 주소가 여러 개라 엉뚱한 주소를 가리킬 수 있습니다.
// 방법: HOST_IP 환경변수가 있으면 그것만, 없으면 내부 IPv4를 모아 192.168 → 10 → 172.16~31 순으로 정렬합니다.
export function lanAddresses(): string[] {
  if (process.env.HOST_IP) return [process.env.HOST_IP];
  const found: string[] = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const info of list ?? []) {
      if (info.family === 'IPv4' && !info.internal) found.push(info.address);
    }
  }
  const rank = (ip: string) => (ip.startsWith('192.168.') ? 0 : ip.startsWith('10.') ? 1 : /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ? 2 : 3);
  return found.sort((a, b) => rank(a) - rank(b));
}

// 목적: 지금 보여 줄 주소와 후보 수를 돌려줍니다.
// 이유: 현황판이 주소와 "다른 주소로 바꾸기" 버튼을 함께 그립니다.
// 방법: 후보 목록에서 addressIndex 번째를 고릅니다. 후보가 없으면 주소는 null입니다.
export function currentAddress(): { address: string | null; count: number } {
  const addresses = lanAddresses();
  return { address: addresses.length > 0 ? addresses[addressIndex % addresses.length] : null, count: addresses.length };
}

// 목적: 다음 주소 후보로 넘어갑니다.
// 이유: 고른 주소로 출석 기기가 열리지 않을 때 교사가 다른 후보를 시험해 볼 수 있어야 합니다.
// 방법: addressIndex를 1 올립니다(메모리에만, 재시작하면 처음으로).
export function nextAddress(): void {
  addressIndex += 1;
}
