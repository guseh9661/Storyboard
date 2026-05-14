# Han Storyboard

Vercel 배포용 줄콘티 웹페이지입니다.

## 데이터 원본

- 화면 데이터는 `db/storyboard.json`에 저장됩니다.
- AI 코딩으로 내용을 수정할 때는 이 JSON을 수정하면 됩니다.
- 웹페이지에서 컷을 수정하고 저장하면 `/api/storyboard`가 같은 JSON을 갱신합니다.

## 로컬 사용

```bash
npm install
npm run dev
```

Vercel CLI가 없다면 `npm i -g vercel` 후 실행합니다.

## Vercel 저장 설정

Vercel의 배포 파일시스템은 영구 저장소가 아니기 때문에, 배포 환경에서 저장하려면 GitHub 저장소에 JSON을 커밋하도록 환경 변수를 설정해야 합니다.

필수:

- `GITHUB_TOKEN`: `contents:write` 권한이 있는 GitHub fine-grained token
- `GITHUB_OWNER`: GitHub 사용자 또는 조직명
- `GITHUB_REPO`: 저장소 이름
- `GEMINI_API_KEY`: AI 수정에 사용할 Gemini API 키

선택:

- `GITHUB_BRANCH`: 기본값 `main`
- `STORYBOARD_WRITE_TOKEN`: 웹 저장 보호용 비밀번호. 설정하면 저장 시 한 번 입력합니다.
- `GEMINI_MODEL`: 기본값 `gemini-2.5-flash`

## DB 다시 추출

HTML에서 현재 내용을 다시 JSON으로 추출하려면:

```bash
npm run extract:db
```
