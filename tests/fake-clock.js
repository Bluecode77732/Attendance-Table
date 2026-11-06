// 목적: 시험할 때 서버의 시계를 원하는 시각으로 옮깁니다.
// 사용처: tests/helpers.js가 서버를 띄울 때 `node --require tests/fake-clock.js server.ts`로 미리 부릅니다. 실제 실행에는 쓰지 않습니다.
// 근거: 출석 반복 구간과 자정 날짜 넘김은 실제 시계로는 기다려야만 시험할 수 있어서, 시각을 정해 두고 시험하려고 넣었습니다.

'use strict';

const fs = require('node:fs');

const RealDate = Date;
let offset = 0;

// 목적: 시험이 FAKE_CLOCK_FILE에 써 둔 시차(ms)를 읽습니다.
// 이유: 시험 도중 시각을 여러 번 옮겨야 해서, 서버를 다시 띄우지 않고 파일로 알려 줍니다.
// 방법: 파일이 없거나 숫자가 아니면 시차 0. 50ms마다 다시 읽습니다(시험 전용이라 동기 읽기를 씁니다).
function readOffset() {
  try {
    offset = Number(fs.readFileSync(process.env.FAKE_CLOCK_FILE, 'utf8')) || 0;
  } catch {
    offset = 0;
  }
}

readOffset();
setInterval(readOffset, 50).unref();

// 인자 없는 new Date()와 Date.now()만 옮기고, 시각을 넘겨 만드는 Date는 그대로 둡니다.
global.Date = class FakeDate extends RealDate {
  constructor(...args) {
    if (args.length === 0) super(RealDate.now() + offset);
    else super(...args);
  }

  static now() {
    return RealDate.now() + offset;
  }
};
