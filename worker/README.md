# Drive Planner API Worker

将来のAI候補探索を受け持つCloudflare Workerです。GitHub Pages側との接続とOpenAI APIへの接続はまだ行わず、AI APIは認証後に固定候補を1件返します。データベース、Cloudflare Access、Turnstile、KV、D1は使用しません。

## APIと認証

### `GET /health`

認証なしで `200 { "status": "ok" }` を返す公開エンドポイントです。

### `POST /session`

`Content-Type: application/json` で `{ "passcode": "..." }` を送信します。共有パスコードが一致すると、HMAC-SHA256署名付きで8時間有効なstateless session tokenとISO 8601形式の `expiresAt` を返します。パスコードそのものは返しません。

### `POST /v1/ai/segment-candidates`

`Authorization: Bearer <session token>` と `Content-Type: application/json` が必須です。署名・期限を検証してからbodyを読み取ります。現在はOpenAIに未接続で、正常時は入力の `requestId` と従来どおりの固定候補を返します。

bodyは32 KiB以下、既存候補は20件以下です。型、必須項目、文字列長、実在日付、未知の項目も検証します。

## Secret

次の名前をCloudflare Worker Secretとして使用します。**値をリポジトリやログへ保存しないでください。**

- `DRIVE_PLANNER_PASSCODE`
- `SESSION_SIGNING_KEY`

ローカル開発では、コミット対象外の `.dev.vars` に開発専用の値を設定します。本番deployの前に、担当者がCloudflare Dashboardで両方のSecretを設定してください。Secret不足時は設定内容をクライアントへ公開せず `internal_error` として扱います。

## Rate Limit

Cloudflare Workers Rate Limiting bindingを2系統使用します。

- `SESSION_RATE_LIMITER`: 接続元IPごとに **60秒あたり5回**。共有パスコードの総当たりを抑制します。
- `AI_RATE_LIMITER`: 検証済みsession tokenのランダムなsession IDごとに **60秒あたり10回**。将来の外部API利用時の乱用を抑制します。

上限到達時は統一形式の `rate_limited` エラーを429で返します。Rate Limitingは乱用を抑える補助策であり、将来OpenAIへ接続する際の最終的な課金上限の代替にはなりません。

## CORS

本番Origin `https://takanori-lab.github.io` と、`localhost` / `127.0.0.1` のHTTP Originを許可します。preflightでは `Authorization` と `Content-Type` を許可します。不許可OriginにはCORS許可ヘッダーを付けませんが、CORSを認証の代わりにはせず、AI APIはBearer tokenを常に検証します。

## ローカル確認とdeploy

Node.js 20以降（CIと同じNode.js 22を推奨）で実行します。

```bash
cd worker
npm install
npm test
npm run typecheck
npm run dev
```

レビュー後、Cloudflare DashboardでSecretを設定した担当者がproductionへ手動deployします。PRをマージしただけではdeployされません。

```bash
npx wrangler login
npm run deploy
```

Worker名は `drive-planner-api` です。GitHub ActionsからWorkerをdeployする設定はありません。
