# Web プロキシ (Render.com デプロイ用)

シンプルな汎用Webブラウジングプロキシです。トップページのフォームにURLを入力すると、
`/proxy/`経由でそのサイトを表示します。

## 構成
- `server.js` … 共通ミドルウェアと Express + unblocker の起動処理
- `sites/` … サイト別のブラウザーパッチと API リレー
- `public/index.html` … URL入力フォーム
- `render.yaml` … Render.com 用の設定ファイル（なくてもOK、あると楽）

Gartic Phone のHTTP・WebSocket通信はWorkerを使わず、このサーバーから接続します。
Gartic Phone向けにはブラウザー形式のリクエストヘッダーを付けますが、
接続先のCloudflare設定によってはサーバーからのアクセスが拒否される場合があります。
AbemaTV の `*.abema.tv` への HTTPS 通信は `myproxy-api.xenonsan123.workers.dev` を経由します。
HTTPS 上の WebSocket は `wss://` で中継し、Unity WebGL 等のゲーム内通信に対応します。

## 注意事項
- 個人利用・学習目的の簡易プロキシです。アクセス先サイトの利用規約や著作権、
  各種法令を遵守してご利用ください。
- 動画配信サイトやログイン必須のサイトなど、正しく動作しないケースもあります。
- 無料プランはしばらくアクセスがないとスリープします（下記「デプロイ後の注意」参照）。

## デプロイ手順（Render初心者向け）

### 1. GitHubにリポジトリを作る
1. https://github.com にログイン（アカウントがなければ作成）
2. 右上の「+」→「New repository」
3. リポジトリ名を決めて（例: `my-web-proxy`）、Public/Privateどちらでも可、「Create repository」
4. このフォルダの中身（`server.js`, `package.json`, `public/`, `render.yaml`）を
   そのリポジトリにアップロードします。方法は2通り:
   - GitHubのWeb画面で「Add file」→「Upload files」からドラッグ&ドロップ
   - またはPCにGitが入っていれば以下のコマンド
     ```
     git init
     git add .
     git commit -m "initial commit"
     git branch -M main
     git remote add origin https://github.com/あなたのユーザー名/my-web-proxy.git
     git push -u origin main
     ```

### 2. Renderにアカウント登録
1. https://render.com にアクセスし「Get Started」
2. GitHubアカウントで登録するとこの後の連携が楽です

### 3. Web Serviceを作成
1. Renderのダッシュボードで「New +」→「Web Service」をクリック
2. 先ほど作ったGitHubリポジトリを選択（初回は「Configure account」でRenderに
   リポジトリへのアクセス権限を許可する必要があります）
3. 設定項目を入力:
   - **Name**: 好きな名前（これがURLの一部になります。例: `my-web-proxy` → `my-web-proxy.onrender.com`）
   - **Region**: Singapore など、日本から近いところがおすすめ
   - **Branch**: `main`
   - **Runtime**: `Node`
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Instance Type**: `Free`
4. 「Create Web Service」をクリック

### 4. デプロイ完了を待つ
- 自動的にビルド・デプロイが始まります（数分かかります）
- ログ画面に `Proxy server listening on port ...` と表示されれば成功です
- 画面上部に表示される `https://あなたのサービス名.onrender.com` が公開URLです

### 5. 動作確認
1. 発行されたURLにアクセス
2. フォームに `wikipedia.org` などと入力して「開く」を押す
3. プロキシ経由でサイトが表示されればOKです

## デプロイ後の注意
- **無料プランはスリープする**: 15分間アクセスがないとサーバーがスリープし、
  次のアクセス時に起動まで数十秒かかります。常時稼働させたい場合は有料プラン
  （Starterプランなど）へのアップグレードが必要です。
- **コードを更新したいとき**: GitHubリポジトリにpushするだけで、Renderが自動的に
  再デプロイしてくれます（Auto-Deployが有効な場合）。

## ローカルでのテスト方法
デプロイ前に手元で動作確認したい場合:
```
npm install
npm start
```
その後ブラウザで `http://localhost:3000` を開いてください。
