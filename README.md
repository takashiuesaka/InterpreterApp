# InterpreterApp

Electron Forge を使用したリアルタイム翻訳デスクトップアプリの開発リポジトリ。

## 目的

- リアルタイム翻訳アプリを開発する
- macOS / Windows の両方で動作させる
- カンファレンス参加時やオンラインミーティング時などでの利用を想定する

## 技術方針

- フレームワーク: Electron Forge
- 翻訳 LLM: Microsoft Foundry の `gpt-realtime-2.1` を使用
- クロスプラットフォーム対応: macOS / Windows

## 実装スコープ（当面）

- 翻訳方向は 英語 -> 日本語 のみ
- 翻訳結果の音声読み上げ（TTS）は実装しない

## 開発・ビルド・起動の優先順

1. まず macOS で開発・ビルド・起動ができる状態を作る
2. 次に Windows 環境でもローカルでビルド・起動できる状態を作る

## 非スコープ（現時点）

- 多言語対応（英語 -> 日本語以外）
- 翻訳結果の音声出力

## 開発環境セットアップ

事前準備の詳細は docs/electron-prerequisites.md を参照してください。

1. 事前準備を確認する
2. 自動セットアップを実行する

実行コマンド:

- bash scripts/setup-electron-env.sh

セットアップ完了後の起動コマンド:

- npm run start

## 翻訳機能の初期実装

現在は、`gpt-realtime-2.1` へマイク音声を Realtime API でストリーミングし、
日本語翻訳テキストを逐次表示する実装です。

## MVP 検証観点

本プロジェクトの MVP は、UI の見た目ではなく以下の技術検証を満たすことを重視します。

1. Microsoft Foundry 上の `gpt-realtime-2.1` デプロイへ実際に接続できること
2. アプリからそのモデルへ入力を送信し、翻訳結果を受信できること
3. 英語音声入力に対して日本語翻訳が継続的に返ること (英語 -> 日本語)
4. macOS ローカル環境で上記 1-3 を再現できること
5. Windows ローカル環境でもビルド/起動し、同様に 1-3 を検証できること

詳細な確認項目は docs/mvp-validation.md を参照してください。

### Foundry 設定

1. .env.example を参考に .env を作成
2. 以下の値を設定

- FOUNDRY_ENDPOINT
- FOUNDRY_DEPLOYMENT
- AZURE_TENANT_ID (任意)
- FOUNDRY_REALTIME_MODE (任意: `auto` / `ga` / `preview`)
- FOUNDRY_REALTIME_API_VERSION (任意: preview接続時。既定 `2025-04-01-preview`)

補足:
- `FOUNDRY_DEPLOYMENT` には `gpt-realtime-2.1` のデプロイ名を指定
- 接続先は `wss://<resource>.openai.azure.com/openai/v1/realtime?model=<deployment>` 形式 (GA)
- `FOUNDRY_REALTIME_MODE=auto` では GA -> Preview の順で接続フォールバック
- 認証は Entra ID (Bearer) を使用
- 起動時にブラウザーを開いて Entra ID 認証を実行
- アプリケーション登録は不要 (InteractiveBrowserCredential を使用)

### Entra ID ログイン

アプリ起動時にブラウザーサインイン (`InteractiveBrowserCredential`) が毎回実行されます。

### 起動

- npm run start

Start Realtime Translation を押すとマイク入力が開始され、
Foundry Realtime Translate からの `response.text.delta` が画面へ逐次表示されます。