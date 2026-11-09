// 목적: 업무 코드가 "무슨 일이 생겼는지"만 담아 던지는 오류입니다.
// 사용처: lib/ 아래 업무 파일이 던지고, lib/http.ts만 받아서 응답 번호(400, 404, 409)로 바꿉니다.
// 근거: 업무 코드가 HTTP 번호를 직접 정하던 구조를 나눴습니다(DEC-14). 판단은 업무 파일, 알리기는 http.ts가 맡습니다.

export type DomainErrorKind = 'invalid' | 'notFound' | 'conflict';

export class DomainError extends Error {
  kind: DomainErrorKind;

  constructor(kind: DomainErrorKind, message: string) {
    super(message);
    this.kind = kind;
  }
}

// 목적: 입력이 잘못됐다는 업무 오류를 만듭니다.
// 이유: 형식, 길이, 범위가 틀린 입력을 같은 종류로 알립니다.
// 방법: kind 'invalid'와 사용자에게 보일 한국어 문구를 담습니다.
export function invalid(message: string): DomainError {
  return new DomainError('invalid', message);
}

// 목적: 찾는 대상이 없다는 업무 오류를 만듭니다.
// 이유: 지워진 학생이나 반을 가리키는 요청을 같은 종류로 알립니다.
// 방법: kind 'notFound'와 문구를 담습니다.
export function notFound(message: string): DomainError {
  return new DomainError('notFound', message);
}

// 목적: 지금 상태와 맞지 않는 요청이라는 업무 오류를 만듭니다.
// 이유: 한도 초과, 이름 중복, 퇴원한 학생 조작처럼 입력은 맞지만 받아들일 수 없는 경우입니다.
// 방법: kind 'conflict'와 문구를 담습니다.
export function conflict(message: string): DomainError {
  return new DomainError('conflict', message);
}
