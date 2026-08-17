# Drive Planner API Worker

将来のAI候補探索を受け持つCloudflare Workerです。現段階では外部API、認証、rate limit、データベースを使わず、固定候補を1件返します。既存のGitHub Pagesフロントエンドからはまだ呼び出しません。

## API

### `GET /health`

`200 { "status": "ok" }` を返します。

### `POST /v1/ai/segment-candidates`

`Content-Type: application/json` で次の形を送ります。地点の `id` や他区間、localStorageの内容はcontractに含めません。`date`、地点の補足値、`freeText` は空文字を許可しますが、名前とタイトルは空白だけにできません。

```json
{
  "requestId": "5eca122f-c098-4690-9575-5e906c3f86af",
  "plan": {
    "title": "架空の星めぐりドライブ",
    "date": "2099-12-31",
    "mainPoint": { "name": "星見ヶ原", "googleMapsUrl": "", "locationNote": "", "memo": "" }
  },
  "segment": {
    "before": { "name": "月影広場", "googleMapsUrl": "", "locationNote": "", "memo": "" },
    "after": { "name": "虹空湖", "googleMapsUrl": "", "locationNote": "", "memo": "" }
  },
  "existingCandidates": [{ "name": "候補例", "locationNote": "" }],
  "preferences": { "freeText": "空想の景色を楽しめるところ", "useWebSearch": false }
}
```

正常時は入力の `requestId`、`status: "ok"`、固定の `candidates`、`meta` を返します。将来の正常系では `status: "needs_clarification"` も使用予定です。通常エラーは別に、適切なHTTP statusと `status: "error"`、`error.code`、利用者向け `message`、`retryable` を返します。内部例外の内容は公開しません。

## validationとCORS

- bodyは32 KiB以下、既存候補は20件以下です。
- 文字列は用途別に10〜2,048文字を上限とし、型、必須項目、実在日付、未知の項目も検証します。
- 本番Origin `https://takanori-lab.github.io` と、`localhost` / `127.0.0.1` のHTTP Originを許可します。
- 不許可OriginにはCORS許可ヘッダーを付けず、不許可のpreflightは拒否します。CORSはブラウザ連携を整えるものであり、認証の代わりではありません。

## ローカル確認と初回deploy

Node.js 20以降を用意します（CIと同じNode.js 22を推奨）。このディレクトリで次を実行してください。

```bash
cd worker
npm install
npm test
npm run typecheck
npm run dev
```

`wrangler dev` が表示するローカルURLで動作を確認します。レビュー後、Cloudflareへの初回deployを手動で行う担当者だけが、ブラウザが利用できる環境で次を実行します。

```bash
npx wrangler login
npm run deploy
```

設定上のWorker名は `drive-planner-api` です。初回deploy時にCloudflare側へWorkerが作成されます。現段階ではSecret登録は不要です。GitHub ActionsからWorkerをdeployする設定はありません。
