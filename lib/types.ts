// 목적: 저장 형식(data.json)과 화면에 보내는 응답의 모양을 타입으로 적어 둡니다.
// 사용처: lib/ 아래 모든 파일과 server.ts가 타입으로만 불러 씁니다. 실행할 때는 지워져서 아무 일도 하지 않습니다.
// 근거: 서버를 TS로 옮기면서(DEC-15) 실수하면 피해가 큰 저장 형식과 응답 모양을 한곳에서 검사받게 했습니다.

export interface Visit {
  in: string;
  out: string | null;
}

export interface Student {
  id: number;
  name: string;
  phone: string | null;
  classIds: number[];
  leftOn: string | null;
}

export interface ClassInfo {
  id: number;
  name: string;
}

export interface Device {
  id: number;
  label: string;
  tokenHash: string;
  pairedOn: string;
}

// records[날짜][학생 id] = 그날의 방문 목록
export type Records = Record<string, Record<string, Visit[]>>;

export interface Db {
  version: 3;
  academyName: string; // 비어 있으면 화면에 '출석부'만 보입니다
  classes: ClassInfo[];
  nextClassId: number;
  students: Student[];
  nextId: number;
  devices: Device[];
  nextDeviceId: number;
  records: Records;
}

// 학원 이름이 없던 버전 2의 data.json
export type V2Db = Omit<Db, 'version' | 'academyName'> & { version: 2 };

// QR 출석 시절(버전 1)의 data.json
export interface V1Db {
  students: { id: number; name: string; present: boolean; deviceHash: string | null }[];
  nextId: number;
}

export type VisitStatus = 'absent' | 'in' | 'out';

export interface TodayStatus {
  status: VisitStatus;
  inTime: string | null;
  outTime: string | null;
}

export type AdvanceResult =
  | { state: 'in' | 'out'; time: string }
  | { state: 'already'; kind: 'in' | 'out'; time: string | null };

export type CheckinResult =
  | { state: 'unknown' }
  | { state: 'choose'; choices: { id: number; name: string }[] }
  | (AdvanceResult & { name: string });

export type PairResult =
  | { state: 'expired' | 'wrong' | 'full' }
  | { state: 'paired'; label: string; deviceId: string };

export interface ImportPlan {
  add: { name: string; phone: string | null; classNames: string[] }[];
  exists: string[];
  bad: { line: number; reason: string }[];
}

export interface TeacherState {
  rev: number;
  today: string;
  academyName: string;
  students: ({ id: number; name: string; phone: string | null; classIds: number[]; left: boolean } & TodayStatus)[];
  classes: ClassInfo[];
  devices: { id: number; label: string; pairedOn: string }[];
  pairing: { code: string; expiresInMs: number } | null;
  kioskUrl: string | null;
  address: string | null;
  addressCount: number;
  saveError: { time: string } | null; // 저장이 실패한 채이면 처음 실패한 시각. 교사 PC에만 갑니다
}

export interface MonthRecords {
  month: string;
  academyName: string;
  students: { id: number; name: string; classIds: number[]; leftOn: string | null }[];
  classes: ClassInfo[];
  days: Records;
}
