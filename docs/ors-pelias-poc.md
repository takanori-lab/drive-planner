# Issue #66: ORS/Pelias 日本語地点検索 PoC

## 目的とスコープ

ORSが提供するPelias系Geocoding APIを、Geoapify PoC（Issue #64 / PR #65）と同じ22ケースで測定し、Drive PlannerのPlace Search Provider候補として比較する独立PoCです。Routing Providerとは分離して評価し、本番UI、Cloudflare Worker、Placeモデル、localStorage、ORS Directions、既存Pelias fallback、AI候補生成には接続しません。

## 実行方法とAPIキー

Node.js 22の標準`fetch`を使い、追加dependencyはありません。

```bash
read -rsp 'ORS API key: ' ORS_API_KEY && echo
export ORS_API_KEY
npm run poc:ors-pelias
unset ORS_API_KEY
```

キーは`ORS_API_KEY`からだけ読みます。未設定ならrequestを開始せず終了します。キーをsource、引数、URLのログ、error、reportへ出力しません。結果はGit管理外の`artifacts/ors-pelias-poc/report.md`へ権限`0600`で生成します。実測結果を共有する場合も、commit前に秘密情報がないことを確認してください。

## APIとrequest条件

- ORSが現在推奨するホスト`https://api.heigit.org`のPelias APIを使用します。完成した20語は`GET /pelias/v1/search`、入力途中の2語は`GET /pelias/v1/autocomplete`です。
- 共通条件は`text=<query>`、`lang=ja`、`boundary.country=JP`、`size=5`です。API keyだけはreportのrequest条件から除外します。
- Structured Searchや独自fallbackは使いません。providerの素のSearch / Autocomplete品質を測るためです。
- 2026年4月28日以降deprecatedとなった旧`https://api.openrouteservice.org/geocode/*`へ新しい依存を追加しません。旧ホストは2026年8月27日以降quota削減、2026年9月28日停止予定と案内されているため、移行先の`https://api.heigit.org/pelias/v1/*`を使用します。

API仕様とhost移行情報は実装時にORS公式の[Geocoding endpoints](https://openrouteservice.org/dev/#/api-docs/geocode)と[API Playground](https://api.heigit.org/)で確認しています。実測時にも契約上のquotaを含む最新仕様を確認してください。

## 安全な測定

request開始を250 ms以上空け、HTTP 429は`Retry-After`（秒またはHTTP-date）を優先して最大2回再試行します。headerがなければ1秒、2秒、最終attempt後は3秒の段階的backoffを使います。最終429でもcooldownしてから後続ケースへ移ります。各attemptのHTTP statusは開始時にresetし、429後のnetwork errorへ古いstatusを残しません。

`transport duration`はfetchとresponse parseに要した時間だけを合算し、pacing / backoffは別記録します。各requestは10秒でtimeoutし、timeout、network error、HTTP error、rate limitをケース単位で記録して後続測定を続けます。

## 22ケースとレポートの判定方法

ケースと分類、期待語は`CASES`に固定し、Geoapify PoCと同一の駅6、観光地・広域地点4、ドライブ施設4、店舗3、住所・地域付き地点・表記ゆれ各1、Autocomplete 2ケースを同じ順序で実行します。

文字列一致の「自動補助順位」は合否ではありません。特に「勝浦駅」が千葉県勝浦市のJR駅か、「富士山」が一般に想定する富士山か、「大石公園」が富士河口湖町か、「さわやか 御殿場インター店」が店舗そのものかを、人間が地域、座標、label/address、facility identity、layer/source/category、provider IDから確認します。府中駅・大宮駅も地域情報で同名候補を区別します。

各ケースにはAPI種別、秘密を除くrequest条件、HTTP status、transport duration、pacing/backoff、retry数、件数、補助順位、errorと上位5候補を記録します。候補にはname、label、address/region、座標、layer、source、category、provider ID、confidence/match typeを含め、`artifacts/geoapify-poc/report.md`と並べて人間が最終比較できます。このPRでは採用結論を決めず、実測後に判断します。

## テスト方針

`npm test`はmock `fetch`のみを使用し、実ORS APIを呼びません。Search / Autocomplete responseのnormalize、0件、HTTP error、429、timeout、network error後の継続、redaction、report、自動補助順位、Pelias固有metadataを検証します。実API測定はAPI keyを持つ担当者が明示的に上記コマンドを実行してください。
