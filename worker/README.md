# Drive Planner API Worker

AI候補探索を受け持つCloudflare Workerです。AI APIはOpenAI Responses APIへ接続済みですが、GitHub PagesのfrontendはまだWorkerへ接続していません。データベース、Cloudflare Access、Turnstile、KV、D1は使用しません。

## APIと認証

### `GET /health`

認証なしで `200 { "status": "ok" }` を返す公開エンドポイントです。

### `POST /session`

`Content-Type: application/json` で `{ "passcode": "..." }` を送信します。共有パスコードが一致すると、HMAC-SHA256署名付きで8時間有効なstateless session tokenとISO 8601形式の `expiresAt` を返します。パスコードそのものは返しません。

### `POST /v1/ai/segment-candidates`

`Authorization: Bearer <session token>` と `Content-Type: application/json` が必須です。署名・期限を検証してからbodyを読み取り、OpenAI Responses APIで候補を生成します。モデルは `gpt-5.6-luna`、reasoning effortは `medium`、出力上限は4,000 tokensです。`strict: true` のStructured Outputs（JSON Schema）を使用し、正常時は5候補を返します。Web Searchはまだ使用せず、要求された場合も実行せず安全な400エラーで通知します。

場所を十分に特定できない場合は `needs_clarification` と確認メッセージを返します。OpenAIが生成した候補にはWorkerが `resultId` を付与し、Web Search未使用のため `sources` は常に空配列です。

地点にGoogle Maps共有URLがある場合、Workerは許可したGoogle Mapsホストに限ってredirectを手動で追跡し、最終URLに含まれる地点名・query・緯度経度を一時的な地点特定の補助情報として利用します。各redirect先の検証、回数上限、短いtimeoutを設け、解決失敗時は地点名・場所メモによる従来の生成へfallbackします。レスポンス本文のスクレイピングやGoogle Maps API / Places APIは行わず、OpenAI Web Searchも使用しません。

bodyは32 KiB以下、既存候補は20件以下です。型、必須項目、文字列長、実在日付、未知の項目も検証します。

## Secret

次の名前をCloudflare Worker Secretとして使用します。**値をリポジトリやログへ保存しないでください。**

- `DRIVE_PLANNER_PASSCODE`
- `SESSION_SIGNING_KEY`
- `OPENAI_API_KEY`

ローカル開発では、コミット対象外の `.dev.vars` に開発専用の値を設定します。`OPENAI_API_KEY` の実値は、コード、README、テストを含むリポジトリへ絶対に置かないでください。PRを `main` へマージする前に、担当者がCloudflare Dashboardで `OPENAI_API_KEY` を含む3つのSecretを登録する必要があります。`secrets.required` によりrequired Secretが未設定の場合はdeployが失敗します。実行時のSecret不足は設定内容やSecret名をクライアントへ公開せず `internal_error` として扱います。

## Rate Limit

Cloudflare Workers Rate Limiting bindingを2系統使用します。

- `SESSION_RATE_LIMITER`: 接続元IPごとに **60秒あたり5回**。共有パスコードの総当たりを抑制します。
- `AI_RATE_LIMITER`: 有効なsessionを持つ共有グループ全体で **60秒あたり10回**。tokenを再発行しても枠が増えない固定のgroup keyを使い、将来の外部API利用時の乱用を抑制します。

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

GitHubリポジトリはCloudflare Workers Buildsと連携されており、production branchは `main` です。`main` へのpushまたはmergeによりCloudflare Workers Buildsが自動でbuild・deployします。GitHub Actions自身はWorkerをdeployしません。merge前にCloudflare Dashboardへrequired Secretを登録してください。

Worker名は `drive-planner-api` です。
