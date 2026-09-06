# Issue #64: Geoapify 日本語地点検索 PoC

## 目的とスコープ

GeoapifyをDrive PlannerのPlace Search Provider候補として採用できるか、日本語の駅、曖昧地点、観光地、ドライブ施設、店舗、住所、入力途中の文字列で実測するための独立PoCです。本番UI、`src/`の地点モデル、localStorage、Cloudflare Worker、ORS Routing、既存ORS/Pelias Geocodingには接続しません。

## 実行方法

Node.js 22を推奨します（追加パッケージはなく、標準`fetch`を使用します）。シェルの履歴やリポジトリ内のファイルへキーを残しにくい方法で、現在のシェルだけに設定してください。

```bash
read -rsp 'Geoapify API key: ' GEOAPIFY_API_KEY && echo
export GEOAPIFY_API_KEY
npm run poc:geoapify
unset GEOAPIFY_API_KEY
```

未設定時は通信せず安全に終了します。キーをコマンドライン引数、`.env`、README、Issue、ログへ貼らないでください（`.env*`も`.gitignore`済みです）。進捗ログとレポートにはAPIキーもrequest URLも出力しません。

結果は`artifacts/geoapify-poc/report.md`へ生成され、このディレクトリはGit管理外です。実測結果を共有するときも、コミット前に内容へキーがないことを確認してください。

## APIとrequest条件

- 完成した検索語はGeocoding Search `GET /v1/geocode/search`、入力途中の2ケースはAddress Autocomplete `GET /v1/geocode/autocomplete`を使います。
- 共通条件は`text=<query>`、`lang=ja`、`filter=countrycode:jp`、`limit=5`です。日本語表示、国内限定、上位5候補の比較というIssue #64の目的に直接対応します。
- `format`は指定せず、GeoJSONの`features[].properties`とgeometryを評価します。`bias`は実利用時の現在地等が未定で順位へ影響するため、この基準測定では指定しません。
- Places APIや独自fallbackは使いません。SearchとAutocompleteそのものの適性を分離して判断するためです。
- Free plan等の5 requests/sec制限を安全に下回るため、すべてのrequest開始を250ms以上空けます。HTTP 429では`Retry-After`（秒数またはHTTP-date）を尊重し、最大2回だけ再試行します。最後の429でも次ケースの前に必ずcooldownし、`Retry-After`がない、または不正な場合は既存backoffと同じ段階式のfallback（最終attemptでは3秒）を適用します。解消しない429は0件の検索品質失敗ではなく、rate limit errorとretry回数として記録して次のケースへ進みます。
- 各requestにはNode.js標準の`AbortSignal.timeout`で10秒のtimeoutを適用します。応答が停止したケースはerrorとして記録し、後続ケースの測定を継続します。

上記は2026年9月にGeoapify公式の[Forward Geocoding API](https://apidocs.geoapify.com/docs/geocoding/forward-geocoding/)と[Address Autocomplete API](https://apidocs.geoapify.com/docs/geocoding/address-autocomplete/)の仕様を確認する前提の固定条件です。実API実行前に、契約プランを含む最新仕様も再確認してください。

## ケースと選定意図

固定ケースはスクリプト内に一元化し、Issue #64の分類（基本駅、曖昧地点、観光地・広域地点、ドライブ向け施設、店舗、住所、市区町村付き地点、表記ゆれ、Autocomplete入力途中）を網羅します。店舗には、繁華街の著名チェーン、地域を付けないと曖昧な本店、ドライブ需要のある地域チェーンを選びました。店舗は移転・閉店・改称があり得るため、実測時に営業状況を人間が再確認します。

## レポートの読み方と合格基準への対応

各ケースにquery、API種別、キーを除くrequest条件、HTTP status、duration、件数、上位5候補の名称・住所・行政区・座標・地点種別・provider identifier、errorを記録します。`durationMs`はpacingとbackoffを除いたAPI通信時間の合計で、待機は`waitDurationMs`として分離します。

| 判断項目 | レポート上の確認方法 | 判定方法 |
|---|---|---|
| 目的地点が見つかる | 期待語と「期待候補順位（補助）」、候補一覧 | 文字列一致は補助。実地点か人間が確認 |
| 上位何位か | サマリーとケース詳細 | 期待語が全て候補表示に含まれる最初の順位 |
| 候補を区別できる | formatted、都道府県、市区町村、種別 | 曖昧地点を人間が確認 |
| Routingに利用可能 | latitude / longitudeと「Routing用座標」 | 有限な両座標の存在を自動確認 |
| 日本語表示が十分 | name、formatted、行政区 | 自然さ・欠落を人間が確認 |

文字列だけでは「東京駅の建物と同名店舗」「富士山の山頂と行政地物」などを正しく判別できません。そのため自動順位を合否とはせず、レポートで明示した人間確認を経てIssue #64の合格基準に照らして総合判断します。HTTPエラーや0件はケース単位で記録し、後続ケースの測定を継続します。

## テスト方針

`npm test`ではmockした`fetch`だけを使用し、実Geoapify APIやquotaを消費しません。`categories`を含むレスポンス抽出、期待語のAND/OR条件、timeout、0件、HTTPエラー、秘密情報のredaction、Markdown生成に加え、request間隔、`Retry-After`、bounded retry、rate limit後の測定継続を検証します。実測はAPIキーを持つレビュー担当者が明示的に`npm run poc:geoapify`を実行してください。
