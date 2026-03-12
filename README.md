# Bridge

スプリットデバイス AI チャットクライアント。信頼できない PC で安全に AI チャットを利用するためのエアギャップ構成。

## 概要

- **モバイル（信頼）**: プロンプト入力、モデル選択、認証
- **PC（不信頼）**: ストリーミング出力の表示のみ
- **Cloudflare Tunnel**: VPS アドレスを隠蔽
- **fin-hub (VPS)**: AI 実行・セッション管理

PC に API キー・VPS アドレス・プロンプト内容を渡さない。

## アーキテクチャ

```
モバイル (信頼)                      PC (不信頼)
┌──────────────┐                   ┌──────────────┐
│ Mobile UI    │                   │ PC UI        │
│ - プロンプト  │                   │ - チャット表示 │
│ - モデル選択  │                   │ - 入力欄なし  │
└──────┬───────┘                   └──────┬───────┘
       │ HTTPS                            │ HTTPS
       ▼                                  ▼
┌─────────────────────────────────────────────────┐
│          Cloudflare Quick Tunnel                 │
│          (VPS アドレス隠蔽)                       │
└──────────────────┬──────────────────────────────┘
                   │
            ┌──────┴──────┐
            │ Bridge Server│ ← FastAPI (VPS)
            │ - UI 配信    │
            │ - fin-hub    │
            │   リレー     │
            └──────┬──────┘
                   │
            ┌──────┴──────┐
            │   fin-hub    │
            └─────────────┘
```

## セットアップ

```bash
# VPS
cd ~/bridge
python -m venv .venv
.venv/bin/pip install -r requirements.txt

# 環境変数
export FIN_HUB_URL=http://localhost:8400
export HUB_AUTH_TOKEN=<token>

# 起動
.venv/bin/uvicorn server.main:app --host 0.0.0.0 --port 3001

# Cloudflare Tunnel
cloudflared tunnel --url http://localhost:3001
```

## 使い方

1. モバイルで Tunnel URL `/mobile/` を開く
2. QR コードまたは URL を PC ブラウザで開く
3. モバイルでプロンプト送信 → PC に出力ストリーム
