# Bridge 仕様書

## 1. 目的

Bridge は fin-hub のスプリットデバイスクライアント。
信頼できない PC（漫喫、共有端末など）で AI チャットを利用するためのエアギャップ構成を提供する。

- **モバイル（信頼）**: プロンプト入力、モデル選択
- **PC（不信頼）**: ストリーミング出力の表示のみ
- PC に API キー・VPS アドレス・プロンプト内容を渡さない

## 2. 脅威モデル

| 要素 | 信頼レベル | 備考 |
|------|-----------|------|
| モバイル端末 | 信頼 | 入力すべてを保持 |
| Cloudflare Tunnel | 信頼 | VPS アドレス隠蔽 |
| Bridge Server (VPS) | 信頼 | リレー + UI 配信 + 認証トークン管理 |
| fin-hub (VPS) | 信頼 | AI 実行・セッション管理 |
| PC ブラウザ | **不信頼** | 表示のみ。入力なし |

**PC から守られるもの:**
- API キー・認証トークン（サーバー側環境変数で管理）
- VPS のアドレス（Cloudflare Tunnel URL のみ露出）
- プロンプト内容（モバイルで入力）

**守れないもの:**
- 画面に表示された出力（表示中は見える）
- ブラウザメモリ上のデータ（表示中は存在する）

## 3. アーキテクチャ

```
モバイル (信頼)                      PC (不信頼)
┌──────────────┐                   ┌──────────────┐
│ Mobile UI    │                   │ PC UI        │
│ - プロンプト入力│                   │ - チャット表示  │
│ - モデル選択  │                   │ - 入力欄なし   │
└──────┬───────┘                   └──────┬───────┘
       │ HTTPS                            │ HTTPS
       ▼                                  ▼
┌─────────────────────────────────────────────────┐
│           Cloudflare Quick Tunnel                │
│           (VPS アドレス隠蔽)                      │
└──────────────────┬──────────────────────────────┘
                   │
            ┌──────┴──────┐
            │ Bridge Server│  FastAPI (uvicorn)
            │ port 3001    │
            └──────┬──────┘
                   │ HTTP
            ┌──────┴──────┐
            │   fin-hub    │
            │ port 8400    │
            └─────────────┘
```

**データフロー:**

1. モバイルが Bridge Server 経由で fin-hub にチャットリクエスト送信
2. fin-hub が SSE でストリーミング応答を返す
3. Bridge Server が SSE イベントを受信し、ルームのイベントバッファに保存
4. PC がポーリングでイベントバッファから新しいイベントを取得・表示

## 4. 接続フロー

```
Mobile                    Bridge Server               PC
  │                          │                        │
  │  POST /api/room          │                        │
  │ ─────────────────────►   │                        │
  │                          │  room_id 生成           │
  │  ◄─────────────────────  │  (小文字英数字7桁)       │
  │  {room_id, url}          │                        │
  │                          │                        │
  │  QR / URL 表示           │                        │
  │  ─ ─ ─ ─ 目視 ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─►   │
  │                          │                        │
  │                          │  GET /{room_id}        │
  │                          │  ◄──────────────────── │
  │                          │                        │
  │                          │  PC UI 配信             │
  │                          │  ═════════════════════► │
  │                          │                        │
  │                          │  GET /api/events/{id}  │
  │                          │  ◄──── (polling 2s) ── │
```

1. モバイルが `/api/room` でルーム作成 → 英数字 7 桁の room_id を発行
2. モバイルに URL + QR コードが表示される
3. ユーザーが PC ブラウザで URL を開く
4. PC に表示専用 UI が配信され、ポーリングが自動開始
5. モバイルがチャット送信 → イベントバッファに蓄積 → PC がポーリングで取得

PC 側に入力フォームはない。URL を開くだけで接続完了。
room_id は小文字英数字 7 桁（36^7 ≈ 783 億通り）、有効期限 12 時間。

## 5. API

### 5.1 ルーム作成

```
POST /api/room
  Response: { room_id: string, url: string, expires_in: 300 }
```

### 5.2 PC ページ配信

```
GET /{room_id}
  Response: PC UI (HTML)
```

### 5.3 PC イベントポーリング

```
GET /api/events/{room_id}?after={index}
  Response: {
    mobile: boolean,
    events: [{ event: string, data: string }, ...],
    next: number
  }
```

PC はこのエンドポイントを 2 秒間隔（ストリーミング中は 500ms）でポーリングする。

### 5.4 チャット（モバイル → fin-hub リレー）

```
POST /api/chat
  Body: {
    room_id: string,
    messages: [...],
    provider: string,
    model: string,
    temperature: float,
    max_tokens: int | null,
    system_prompt: string,
    session_id: string,
    thinking_mode: string,
    reasoning_effort: string | null
  }
  Response: SSE stream (モバイルに返す)
```

Bridge Server の処理:
1. モバイルからのリクエストを fin-hub `/api/chat/stream` にプロキシ
2. fin-hub からの SSE イベントを受信
3. モバイルにそのまま返す（モバイルでも出力確認可能）
4. 同時にルームのイベントバッファに蓄積（PC がポーリングで取得）

CLI プロバイダ（claude_code, codex）は会話履歴をシステムプロンプトに埋め込み。
API プロバイダは fin-hub の session_id で会話管理。

### 5.5 モデル一覧（fin-hub リレー）

```
GET /api/models/{provider}
  Response: fin-hub /api/models/{provider} をそのまま返す
```

### 5.6 セッション管理（fin-hub リレー）

```
GET /api/sessions
DELETE /api/sessions/{session_id}
```

## 6. Mobile UI

モバイルブラウザで動作する軽量 HTML。2 つのモードを切替可能。

### 6.1 スタンドアロンモード

初期表示時は QR コード・URL・Provider/Model/Thinking 設定行を表示。
最初のメッセージ送信後は QR・設定行が非表示になり、チャット + 入力欄のみ。
設定は歯車アイコンのオーバーレイから変更可能。

### 6.2 入力機モード

ヘッダー + コンパクト設定バー + 入力欄のみ。
iPhone/iPad を横置きにして外付けキーボードで入力するユースケース。
チャット表示なし、最低限の情報のみ。

### 6.3 設定オーバーレイ

| 項目 | 備考 |
|------|------|
| Room URL | ルーム作成後に表示 |
| Provider | ドロップダウン |
| Model | fin-hub から動的取得 |
| Temperature | スライダー 0.0 - 2.0 |
| Thinking Mode | off / auto / low / medium / high |
| System Prompt | テキストエリア |

### 6.4 認証

認証トークンはサーバー側環境変数（`HUB_AUTH_TOKEN`）で管理。
モバイル UI でのトークン入力は不要。

## 7. PC UI

PC ブラウザで動作する軽量 HTML。入力欄なし。

### 7.1 機能

- チャット履歴の表示（ユーザー / アシスタント メッセージ）
- ストリーミングテキストのリアルタイム表示（ポーリング）
- Markdown レンダリング（コードブロック、太字、斜体等）
- 接続状態の表示
- 自動スクロール（ChatGPT 式：手動スクロールで追従停止）
- コード部分のコピーボタン

### 7.2 非機能

- テキスト入力欄なし
- API キー・認証情報の保持なし
- ローカルストレージへの保存なし

## 8. 技術スタック

| コンポーネント | 技術 |
|--------------|------|
| Bridge Server | Python FastAPI + uvicorn |
| Tunnel | Cloudflare Quick Tunnel (cloudflared) |
| ルーム管理 | インメモリ dict |
| Mobile UI | HTML + Vanilla JS |
| PC UI | HTML + Vanilla JS + Markdown レンダラー |
| fin-hub 通信 | httpx (SSE ストリーミング) |
| デプロイ | GitHub Actions → SSH → systemd user service |

## 9. セッションライフサイクル

1. モバイルでページを開く → ルーム自動作成、QR コード表示
2. PC で URL を開く → ポーリング開始
3. モバイルでプロンプト送信 → PC に出力ストリーム
4. 繰り返し（同一セッション or 新規セッション）
5. PC のタブを閉じる → PC 側にデータ残らず

ルーム有効期限: 12 時間。

## 10. ディレクトリ構成

```
bridge/
├── server/               # Bridge Server (FastAPI)
│   ├── __init__.py
│   ├── main.py           # ルーティング + ポーリングエンドポイント
│   ├── room.py           # ルーム管理 (インメモリ)
│   └── relay.py          # fin-hub SSE リレー
├── static/               # 静的ファイル
│   ├── mobile/
│   │   ├── index.html
│   │   ├── app.js
│   │   └── style.css
│   └── pc/
│       ├── index.html
│       ├── app.js
│       └── style.css
├── .github/
│   └── workflows/
│       └── deploy.yml    # GitHub Actions デプロイ
├── docs/
│   └── spec.md
├── requirements.txt
└── README.md
```
