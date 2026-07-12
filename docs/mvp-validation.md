# MVP 検証チェックリスト

このドキュメントは、InterpreterApp の MVP 完了判定を行うためのチェックリストです。

## MVP の必須条件

1. Microsoft Foundry のリアルタイム翻訳機能を持つ GPT モデルを対象にする
2. `openai/v1/realtime/translations?model=<deployment>` への WebSocket 接続が成功する
3. マイク音声が `session.input_audio_buffer.append` で送信される
4. `response.text.delta` が継続的に受信され、日本語翻訳が UI に逐次表示される
5. `response.text.done` まで受信できる
4. macOS ローカルで上記の一連の流れが再現できる
5. Windows ローカルでビルド・起動でき、上記翻訳検証が再現できる

## 事前確認

- .env に Foundry 接続値が設定されている
- 対象デプロイが有効で、API キーが利用可能である
- npm run start でアプリが起動する
- マイク利用許可が与えられている

## 実施手順 (最小)

1. Start Realtime Translation を押す
2. 英語で発話する
3. 日本語翻訳が逐次表示されることを確認する
4. Stop でセッション終了できることを確認する

## 完了判定

- 上記「MVP の必須条件」5項目がすべて満たされたら MVP 完了

## 補足

- TTS は MVP 対象外
- 多言語対応は MVP 対象外 (当面は英語 -> 日本語のみ)