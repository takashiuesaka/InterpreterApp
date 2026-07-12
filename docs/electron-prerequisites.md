# Electron 開発 事前準備

このファイルは、InterpreterApp の Electron 開発環境を自動セットアップする前提条件をまとめたものです。
自動セットアップは scripts/setup-electron-env.sh を使用します。

## 対象

- 開発OS: macOS / Windows
- 実装フレームワーク: Electron Forge

## 必須ツール

1. Node.js (推奨: 22 LTS 以上)
2. npm (Node.js 同梱)
3. Git

## OSごとの追加前提

### macOS

1. Xcode Command Line Tools
2. 任意: Homebrew (Node.js を管理する場合)

確認コマンド例:

- xcode-select -p
- node -v
- npm -v

### Windows

1. Node.js 22 LTS 以上
2. Visual Studio Build Tools (Desktop development with C++)
3. 任意: Python 3 (一部ネイティブ依存が必要な場合)

確認コマンド例 (PowerShell):

- node -v
- npm -v
- git --version

## ネットワーク要件

- npm レジストリにアクセスできること
- Electron バイナリを取得できること
- Microsoft Foundry エンドポイントへアクセスできること

## Foundry 事前準備 (MVP 検証に必須)

MVP では、リアルタイム翻訳機能を持つ GPT モデルとの実通信が必須です。

1. Foundry 上で対象モデルのデプロイを作成済みであること
2. 以下の接続情報を取得済みであること

- FOUNDRY_ENDPOINT
- FOUNDRY_DEPLOYMENT
- AZURE_TENANT_ID (必要に応じて)

補足:
- デプロイは `gpt-realtime-translate` モデルを使用
- 実装は GA WebSocket パス `openai/v1/realtime/translations?model=<deployment>` を使用
- Electron アプリでマイク利用許可が必要
- 認証は Entra ID (Bearer) を使用
- 起動時にブラウザーを開いて Entra ID 認証を実行
- アプリケーション登録は不要 (InteractiveBrowserCredential)

## 自動セットアップで実施する内容

1. Node.js / npm / Git のバージョン確認
2. package.json がない場合は作成
3. Electron Forge CLI と Electron を開発依存として導入
4. package.json に Electron Forge 用スクリプトを設定
5. 最小構成の main.js を生成 (未存在時のみ)
6. npx electron-forge --version で動作確認

## 実行方法

リポジトリルートで以下を実行:

- bash scripts/setup-electron-env.sh

## 注意事項

- この自動セットアップはクロスプラットフォームの土台構築が目的です。
- 配布用ビルド (make) は各OS上で実行して確認してください。