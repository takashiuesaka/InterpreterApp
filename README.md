# InterpreterApp

Electron Forge を使用したリアルタイム翻訳デスクトップアプリの開発リポジトリ。

## 目的

- リアルタイム翻訳アプリを開発する
- macOS / Windows の両方で動作させる
- カンファレンス参加時やオンラインミーティング時などでの利用を想定する

## 技術方針

- フレームワーク: Electron Forge
- 翻訳 LLM: Microsoft Foundry の `gpt-realtime-translate` を使用
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

## クイックスタート

このセクションは、このアプリを最短で使い始めるための手順です。

1. 依存関係をインストールする

- npm install

2. アプリを起動する

- npm run start

3. 初回起動時に表示される Configuration Popup で設定を入力して Save する

- 入力項目の詳細は「Foundry 設定」セクションを参照

4. Save 後、Start を押して翻訳を開始する

補足:
- 設定値は OS ごとの userData 配下に app-config.json として保存され、次回起動時に再入力は不要です。
- 設定画面はヘッダーの歯車アイコンからいつでも開き直して編集できます。

## 翻訳機能の初期実装

現在は、`gpt-realtime-translate` へマイク音声を Realtime API でストリーミングし、
日本語翻訳テキストを逐次表示する実装です。

## MVP 検証観点

本プロジェクトの MVP は、UI の見た目ではなく以下の技術検証を満たすことを重視します。

1. Microsoft Foundry 上の `gpt-realtime-translate` デプロイへ実際に接続できること
2. アプリからそのモデルへ入力を送信し、翻訳結果を受信できること
3. 英語音声入力に対して日本語翻訳が継続的に返ること (英語 -> 日本語)
4. macOS ローカル環境で上記 1-3 を再現できること
5. Windows ローカル環境でもビルド/起動し、同様に 1-3 を検証できること

詳細な確認項目は docs/mvp-validation.md を参照してください。

### Foundry 設定

このアプリでは、Foundry 設定は環境変数ではなく構成ポップアップから入力して保存します。

設定が必要な値:

- FOUNDRY_ENDPOINT: `https://<RESOURCE_NAME>.services.ai.azure.com`
- FOUNDRY_DEPLOYMENT: MS Foundry にデプロイした `gpt-realtime-translate` のデプロイ名
- AZURE_TENANT_ID: Foundry リソースが属する Azure Tenant の ID

手順:

1. `npm run start` でアプリを起動する
2. 初回起動時に表示される Configuration Popup で上記3項目を入力して Save する
3. 以後はヘッダーの歯車アイコンから設定を開いて変更できる

補足:

- 認証は Entra ID (Bearer) を使用
- 起動時にブラウザーを開いて Entra ID 認証を実行
- アプリケーション登録は不要 (InteractiveBrowserCredential を使用)

### 構成ファイルの保存先

構成情報は Electron の `app.getPath('userData')` 配下に `app-config.json` として保存されます。

- macOS: `~/Library/Application Support/InterpreterApp/app-config.json`
- Linux: `~/.config/InterpreterApp/app-config.json`
- Windows: `%APPDATA%/InterpreterApp/app-config.json`

翻訳結果の保持ファイルも同じフォルダに保存されます。

- `translation-output.txt`

### Entra ID ログイン

アプリ起動時にブラウザーサインイン (`InteractiveBrowserCredential`) が毎回実行されます。

### 起動

- npm run start

Start Realtime Translation を押すとマイク入力が開始され、
Foundry Realtime Translate からの `response.text.delta` が画面へ逐次表示されます。

補足: 音声入力は `session.input_audio_buffer.append` を連続送信し、
`gpt-realtime-translate` のセッション設定により翻訳テキストを逐次受信します。