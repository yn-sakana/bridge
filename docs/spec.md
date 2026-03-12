# Bridge 仕様書

## 1. 目的

Bridge は fin-hub のスプリットデバイスクライアント。
信頼できない PC（漫喫、共有端末など）で AI チャットを利用するためのエアギャップ構成を提供する。

- **モバイル（信頼）**: プロンプト入力、モデル選択、認証
- **PC（不信頼）**: ストリーミング出力の表示のみ
- PC に API キー・VPS アドレス・プロンプト内容を渡さない

## 2. 脅威モデル

| 要素 | 信頼レベル | 備考 |
|------|-----------|------|
| モバイル端末 | 信頼 | 認証情報・入力すべてを保持 |
| Cloudflare Workers | 信頼 | リレー + UI 配信 |
| fin-hub (VPS) | 信頼 | AI 実行・セッション管理 |
| PC ブラウザ | **不信頼** | 表示のみ。入力なし |

**PC から守られるもの:**
- API キー・認証トークン
- VPS のアドレス（Workers URL のみ露出）
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
│ - 認証トークン │                   │              │
└──────┬───────┘                   └──────┬───────┘
       │ HTTPS                            │ HTTPS
       ▼                                  ▼
┌─────────────────────────────────────────────────┐
│              Cloudflare Workers                  │
│                                                  │
│  - 静的 UI 配信 (Mobile / PC)                    │
│  - fin-hub へのリレー (認証付き)                   │
│  - セッション→PC 接続のマッピング                   │
│  - PC 向け SSE 出力ストリーム配信                   │
└──────────────────┬──────────────────────────────┘
                   │ HTTPS
                   ▼
            ┌─────────────┐
            │   fin-hub   │
            │   (VPS)     │
            └─────────────┘
```

**データフロー:**

1. モバイルが Workers 経由で fin-hub にチャットリクエスト送信
2. fin-hub が SSE でストリーミング応答を返す
3. Workers が SSE イベントを受信し、PC 接続にリレー
4. PC ブラウザがリアルタイムで出力を表示

## 4. 接続フロー

```
Mobile                    Workers                    PC
  │                          │                        │
  │  POST /api/room          │                        │
  │  (auth_token)            │                        │
  │ ─────────────────────►   │                        │
  │                          │  room_id 生成 (小文字英数字7桁) │
  │  ◄─────────────────────  │                        │
  │  {room_id}               │                        │
  │                          │                        │
  │  URLを表示:              │                        │
  │  bridge.example.com      │                        │
  │  /a7x9k2m                │    PCでURLを開く        │
  │  ─ ─ ─ ─ ─ 目視 ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─►  │
  │                          │                        │
  │                          │  GET /{room_id}       │
  │                          │  ◄─────────────────── │
  │                          │                        │
  │                          │  PC UI 配信 + SSE 接続  │
  │                          │  ═══════════════════► │
```

1. モバイルが `/api/room` で認証付きルーム作成 → Workers が英数字 7 桁の room_id を発行
2. モバイルに URL (`bridge.example.com/{room_id}`) が表示される
3. ユーザーが PC ブラウザのアドレスバーに URL を入力して開く
4. PC に表示専用 UI が配信され、SSE 接続が自動確立

PC 側に入力フォームはない。URL を開くだけで接続完了。
room_id は小文字英数字 7 桁（36^7 ≈ 783 億通り）、有効期限 5 分（未接続時）。

## 5. Workers API

### 5.1 ルーム作成（モバイルのみ）

```
POST /api/room
  Headers: Authorization: Bearer <hub_auth_token>
  Response: { room_id: string, url: string, expires_in: 300 }
```

### 5.2 PC ページ配信 + SSE

```
GET /r/:room_id
  Response: PC UI (HTML)
  → ページ内 JS が自動的に SSE 接続を確立:

GET /api/stream/:room_id
  Response: SSE (text/event-stream)
  Events:
    - message: { role: "user" | "assistant", content: string }
    - text: テキストチャンク (ストリーミング中)
    - done: ストリーム完了
    - error: エラー
    - waiting: 次のリクエスト待ち
```

PC はこのエンドポイントに接続し続ける。モバイルがチャットを送るたびにストリームが流れる。

### 5.3 チャット（モバイル → fin-hub リレー）

```
POST /api/chat
  Headers: Authorization: Bearer <hub_auth_token>
  Body: {
    room_id: string,
    messages: [...],          // fin-hub ChatStreamRequest 互換
    provider: string,
    model: string,
    temperature: float,
    max_tokens: int | null,
    system_prompt: string,
    session_id: string,
    thinking_mode: string,
    reasoning_effort: string | null
  }
  Response: SSE stream (モバイルにも返す)
```

Workers の処理:
1. モバイルからのリクエストを fin-hub `/api/chat/stream` にプロキシ
2. fin-hub からの SSE イベントを受信
3. モバイルにそのまま返す（モバイルでも出力確認可能）
4. 同時に room_id で接続中の PC にもリレー

### 5.4 モデル一覧（モバイル → fin-hub リレー）

```
GET /api/models/:provider
  Headers: Authorization: Bearer <hub_auth_token>
  Response: fin-hub /api/models/{provider} をそのまま返す
```

### 5.5 セッション管理（モバイル → fin-hub リレー）

```
GET /api/sessions
  Headers: Authorization: Bearer <hub_auth_token>
  Response: fin-hub /api/sessions をそのまま返す

DELETE /api/sessions/:session_id
  Headers: Authorization: Bearer <hub_auth_token>
  Response: fin-hub /api/sessions/{session_id} をそのまま返す
```

## 6. Mobile UI

モバイルブラウザで動作する軽量 HTML。Workers から配信。

### 6.1 画面構成

```
┌─────────────────────────┐
│ Bridge           [設定]  │
├─────────────────────────┤
│ ┌─────────────────────┐ │
│ │ PC: 接続中 ●        │ │
│ └─────────────────────┘ │
│                         │
│ Provider: [anthropic ▼] │
│ Model:    [claude... ▼] │
│ Thinking: [auto     ▼] │
│                         │
│ ┌─────────────────────┐ │
│ │                     │ │
│ │   プロンプト入力     │ │
│ │                     │ │
│ └─────────────────────┘ │
│           [送信]        │
│                         │
│ Session: abc-123  [新規] │
└─────────────────────────┘
```

### 6.2 設定項目

| 項目 | UI | 備考 |
|------|-----|------|
| Provider | ドロップダウン | openai / anthropic / google |
| Model | ドロップダウン | fin-hub から動的取得 |
| Thinking Mode | ドロップダウン | auto / low / medium / high |
| Temperature | スライダー | 0.0 - 2.0 |
| System Prompt | テキストエリア | 設定画面内 |
| Hub Auth Token | テキスト入力 | 設定画面内、初回のみ |

### 6.3 機能

- プロンプト入力・送信
- モデル・プロバイダ切り替え（fin-hub /api/models 経由）
- PC ペアリング（QR コード表示）
- セッション管理（新規作成 / 継続）
- PC 接続状態の表示
- 送信中のストリーミング状態表示

## 7. PC UI

PC ブラウザで動作する軽量 HTML。Workers から配信。入力欄なし。

### 7.1 画面構成

```
┌──────────────────────────────────────────────┐
│ Bridge                          Connected ●  │
├──────────────────────────────────────────────┤
│                                              │
│  ┌─────────────────────────────────────────┐ │
│  │ User                                    │ │
│  │ このコードをレビューして                    │ │
│  └─────────────────────────────────────────┘ │
│                                              │
│  ┌─────────────────────────────────────────┐ │
│  │ Assistant                               │ │
│  │ コードを確認しました。以下の点が...        │ │
│  │ █ (streaming)                           │ │
│  └─────────────────────────────────────────┘ │
│                                              │
│                                              │
│                                              │
│  ┌─────────────────────────────────────────┐ │
│  │ 待機中... モバイルからメッセージを送信     │ │
│  └─────────────────────────────────────────┘ │
└──────────────────────────────────────────────┘
```

### 7.2 機能

- チャット履歴の表示（ユーザー / アシスタント メッセージ）
- ストリーミングテキストのリアルタイム表示
- Markdown レンダリング（コードブロック、リスト等）
- 接続状態の表示
- 自動スクロール
- コード部分のコピーボタン

### 7.3 非機能

- テキスト入力欄なし
- API キー・認証情報の保持なし
- ローカルストレージへの保存なし

## 8. 技術スタック

| コンポーネント | 技術 |
|--------------|------|
| Workers | Cloudflare Workers (JavaScript) |
| Workers ストレージ | Durable Objects (ペアリング状態 + SSE リレー) |
| Mobile UI | HTML + Vanilla JS (Workers 配信) |
| PC UI | HTML + Vanilla JS + Markdown レンダラー (Workers 配信) |
| fin-hub 通信 | fetch + SSE (Workers → fin-hub) |

## 9. セッションライフサイクル

```
1. モバイルで Hub Auth Token を設定（初回のみ）
2. モバイルでペアリング開始 → QR コード表示
3. PC でコード入力 → SSE 接続確立
4. モバイルでプロンプト送信 → PC に出力ストリーム
5. 繰り返し（同一セッション or 新規セッション）
6. PC のタブを閉じる → セッション終了、PC 側にデータ残らず
```

ペアリングの有効期限: 5 分（未接続時）。
接続後はモバイルが切断するかタブを閉じるまで維持。

## 10. ディレクトリ構成

```
bridge/
├── workers/              # Cloudflare Workers
│   ├── src/
│   │   ├── index.ts      # エントリポイント + ルーティング
│   │   ├── pair.ts       # ペアリングロジック
│   │   ├── relay.ts      # fin-hub SSE リレー
│   │   └── auth.ts       # 認証ヘッダー検証
│   ├── wrangler.toml     # Workers 設定
│   └── package.json
├── static/               # Workers から配信する静的ファイル
│   ├── mobile/
│   │   ├── index.html
│   │   ├── app.js
│   │   └── style.css
│   └── pc/
│       ├── index.html
│       ├── app.js
│       └── style.css
├── docs/
│   └── spec.md
└── README.md
```
