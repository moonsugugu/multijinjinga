# 🎭 멀티진진가 (진짜 진짜 가짜) · made by 문수네집

학생들이 **진짜 사실 5가지**를 적으면 그중 하나를 **그럴듯한 가짜**로 바꿔, 반 전체가 "어느 것이 가짜일까?"를 맞히는 실시간 교실 게임입니다.
QR코드로 접속하고 Firebase Realtime Database로 실시간 동기화되며, `index.html` 파일 하나로 동작합니다.

> **made by 문수네집** — [🏠 문수네집](https://moonsunezipbrand.vercel.app) · [📷 인스타그램](https://www.instagram.com/moonsune.zip/) · [✨ moonsune.zip](https://moonsune-zip.vercel.app/)

> ✅ **배포 완료 — 바로 사용 가능**
>
> **👉 https://jinjinga-class.web.app**
>
> - Firebase 프로젝트: `gen-lang-client-0204797514` (qr-bingo와 공용)
> - Realtime Database: 싱가포르 리전, `rooms/JJG_<코드>` 경로만 사용 (qr-bingo와 분리)
> - 수정 후 재배포: `cd C:\Users\admin\jinjinga` → `firebase deploy --only hosting:jinjinga`

## 게임 흐름

1. **선생님**: 접속 → `문제 방 만들기` → 주제 입력 + 가짜 방식 선택(AI / 직접 작성) → 방 생성
2. QR코드·방 코드가 표시됨. **학생**은 QR을 찍거나 코드 입력 → 이름 입력 → 입장
3. **학생**: 진짜 사실 5개 작성 → 그중 1개를 골라 **비슷한 가짜로 직접** 변경(예시·팁 자동 안내) → 제출
4. **선생님 화면**: 누가 제출했는지 실시간 표시 (`○/○ 완료`)
5. **선생님**: `발표 시작하기` → 학생 한 명씩 문제 슬라이드 표시
6. **학생**: 각자 폰에서 가짜라고 생각하는 보기에 투표 (실시간 집계)
7. **선생님**: `정답 공개` → 가짜 강조 + 진짜값 + 정답률 → `다음` → 반복
8. 마지막에 문제별 정답률 요약

## 가짜 만드는 방식

학생이 진짜 5개 중 하나를 골라 **직접** 비슷한 가짜로 바꿉니다. 작성 화면에 예시·팁이 자동으로 표시돼요:

- 🔢 숫자·개수: "강아지를 ~~3마리~~ → **2마리** 키운다"
- 📍 장소: "~~제주도~~ → **부산**에서 태어났다"
- 📅 연도·이름: "~~2015년~~ → **2016년**에 이사했다"

> **AI·외부 API를 전혀 쓰지 않습니다.** API 키·요금·네트워크 호출이 필요 없어 100% 무료로 동작합니다.

## 데이터 구조 (Realtime Database)

```
rooms/JJG_<코드>
  ├─ topic, state(writing|presenting|done)
  ├─ players/<pid>   : name, submitted
  ├─ problems/<pid>  : items[5], fakeIndex, realValue, submittedAt
  ├─ present         : order[], idx, revealed
  └─ votes/<주인pid>/<투표자pid> : 선택한 보기 index
```

기존 qr-bingo 보안 규칙(`rooms/$room` 읽기·쓰기 허용)을 그대로 사용하므로 규칙 수정이 필요 없습니다.

## 파일

- `index.html` — 앱 전체 (HTML/CSS/JS + Firebase + QR, 빌드 불필요)
- `firebase.json`, `.firebaserc` — 배포 설정 (hosting target: `jinjinga` → 사이트 `jinjinga-class`)
