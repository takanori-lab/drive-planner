# Drive Planner API Worker

AI候補探索を受け持つCloudflare Workerです。AI APIはOpenAI Responses APIへ接続済みで、AI実行ログはCloudflare D1へ保存します。

## APIと認証

### `GET /health`

認証なしで `200 { "status": "ok" }` を返す公開エンドポイントです。

### `POST /session`

`Content-Type: application/json` で `{ "passcode": "..." }` を送信します。共有パスコードが一致すると、HMAC-SHA256署名付きで8時間有効なstateless session tokenとISO 8601形式の `expiresAt` を返します。パスコードそのものは返しません。

### `POST /v1/ai/segment-candidates`

`Authorization: Bearer <session token>` と `Content-Type: application/json` が必須です。署名・期限を検証してからbodyを読み取り、OpenAI Responses APIで候補を生成します。モデルは `gpt-5.6-luna`、reasoning effortは `medium`、出力上限は4,000 tokensです。`strict: true` のStructured Outputs（JSON Schema）を使用し、正常時は5候補を返します。Web Searchはまだ使用せず、要求された場合も実行せず安全な400エラーで通知します。

場所を十分に特定できない場合は `needs_clarification` と確認メッセージを返します。OpenAIが生成した候補にはWorkerが `resultId` を付与し、Web Search未使用のため `sources` は常に空配列です。

寄り道候補生成ではResponses APIの `store: true` を有効にし、開発・品質改善時にOpenAI PlatformのLogsから入力・出力を確認できるようにしています。固定の識別用metadataだけを送り、API keyやsession tokenなどのSecretはmetadataに含めません。ログ保存が不要になった場合は `store: false` に戻せます。

地点にGoogle Maps共有URLがある場合、Workerは許可したGoogle Mapsホストに限ってredirectを手動で追跡し、最終URLに含まれる地点名・query・緯度経度を一時的な地点特定の補助情報として利用します。各redirect先の検証、回数上限、短いtimeoutを設け、解決失敗時は地点名・場所メモによる従来の生成へfallbackします。レスポンス本文のスクレイピングやGoogle Maps API / Places APIは行わず、OpenAI Web Searchも使用しません。

bodyは32 KiB以下、既存候補は20件以下です。型、必須項目、文字列長、実在日付、未知の項目も検証します。

## AI実行ログとJSONL export

OpenAIへ実際に送ったinput、解決したGoogle Maps文脈、instructions、生成結果、response ID、usageを、D1 `drive-planner-ai-logs` の `AI_LOGS_DB` bindingへ1実行1レコードで保存します。テーブルとindexは初回保存またはexport時に作成され、D1保存失敗はAI候補生成を失敗させません。OpenAI Platformの `store: true` も現時点では維持します。

`promptVersion` はプロンプト別の品質比較に使います。**将来instructionsを変更するときは必ずpromptVersionも更新してください。**

`/admin/ai-logs` の管理ページで `AI_LOG_EXPORT_KEY` を入力すると、AI品質分析用JSONLを時系列順でダウンロードできます。JSONLはルート情報、地点情報、Google Maps URL、freeText等を含むため厳重に扱ってください。API key、passcode、session token、Authorization header、export key、その他のSecretはD1にもJSONLにも保存しません。

## Secret

次の名前をCloudflare Worker Secretとして使用します。**値をリポジトリやログへ保存しないでください。**

- `DRIVE_PLANNER_PASSCODE`
- `SESSION_SIGNING_KEY`
- `OPENAI_API_KEY`
- `AI_LOG_EXPORT_KEY`
- `ORS_API_KEY`

## 経路計算

`POST /v1/routing/segment` は確定した2地点を解決し、openrouteservice Directions V2の
`driving-car`（`api.heigit.org`）で道路距離と所要時間を返します。「一般道中心」では
`avoid_features: ["highways"]` を指定します。値はリアルタイム交通を含まない計画用の目安です。
`ORS_API_KEY` はWorker SecretからAuthorization headerへ設定し、Frontendやログへ渡しません。
評価情報はAI生成ログとは別の `routing_evaluation_logs` テーブルへ保存します。

地点解決は、Google Maps URL内の確定座標を最優先し、座標がなければPeliasの通常検索を行います。
通常検索では最大5候補から地点名、`locationNote` の都道府県・市区町村、地点種別、`confidence` を照合します。
十分な候補がない場合だけ、`locationNote` がある地点では地点名のみの検索、最後に
`/pelias/v1/search/structured` の `venue` と地域文脈を使う検索を行います。地点ごとのGeocodingは最大3回
（`locationNote` がない場合は最大2回）で、地域と矛盾する候補や低confidence候補は採用しません。
HTTP 429 / 5xxの通信再試行はこの検索条件fallbackには含めず、従来どおりクライアント側のbounded retryで扱います。

`routing_evaluation_logs.resolution_methods_json` には `google_maps_coordinates`、
`place_geocoding` / `google_maps_query_geocoding`、`name_only_geocoding`、
`structured_geocoding`、`unresolved` のいずれかをbefore / after別に記録します。これにより、
駅名（東京駅・千葉駅・勝浦駅）、観光地（河口湖）、公園、店舗など同じ代表ケース群について、
地点名のみ / `locationNote` あり / Google Maps URLありの解決率を方式別に比較できます。
自動テストの比較は外部ORSへ接続せず、Peliasレスポンスのmockを使います。

ローカル開発では、コミット対象外の `.dev.vars` に開発専用の値を設定します。`OPENAI_API_KEY` の実値は、コード、README、テストを含むリポジトリへ絶対に置かないでください。実行時のSecret不足は設定内容やSecret名をクライアントへ公開せず `internal_error` として扱います。

## Rate Limit

Cloudflare Workers Rate Limiting bindingを4系統使用します。

- `SESSION_RATE_LIMITER`: 接続元IPごとに **60秒あたり5回**。共有パスコードの総当たりを抑制します。
- `AI_RATE_LIMITER`: 有効なsessionを持つ共有グループ全体で **60秒あたり10回**。tokenを再発行しても枠が増えない固定のgroup keyを使い、将来の外部API利用時の乱用を抑制します。
- `ROUTING_IP_RATE_LIMITER`: routing専用のIP別上限（**60秒あたり10回**）。単一クライアントによる集中利用を抑制します。
- `ROUTING_RATE_LIMITER`: routing専用の共有グループ全体で **60秒あたり30回**。IP別上限と二段でORS quotaを保護し、AI用の上限とは分離します。

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

初回deploy前、またはSecretを更新するときは、担当者が次のコマンドで5つすべてを登録します（値は対話入力し、ファイルやコマンドライン引数へ書きません）。

```bash
npx wrangler secret put DRIVE_PLANNER_PASSCODE
npx wrangler secret put SESSION_SIGNING_KEY
npx wrangler secret put OPENAI_API_KEY
npx wrangler secret put AI_LOG_EXPORT_KEY
npx wrangler secret put ORS_API_KEY
```

Cloudflare Workers Buildsのdeploy commandは **`npm run deploy`** に設定してください。npmの`predeploy`で`wrangler secret list`を照合し、上記のいずれか（`ORS_API_KEY`を含む）が未登録ならdeployを中止します。`npx wrangler deploy`を直接指定するとこの検査を迂回するため使用しません。

Worker名は `drive-planner-api` です。
