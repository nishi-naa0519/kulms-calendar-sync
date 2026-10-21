# KULMS Calendar Sync v0.5 (試験版)

## v0.5で変わった点

- **提出済み判定を修正**: KULMSは未開始の課題でも `submitted: true` を返すことがあるため、`submitted === true` に加えて `draft !== true` かつ実際の提出日時 (`dateSubmittedEpochSeconds > 0` または解析可能な `dateSubmitted`) がある場合だけ提出済みと判定します。
- Google Calendar APIまで同期が完了した後にだけ5分クールダウンを開始するように修正しました。
- KULMS実環境で `itemSubmission/{assignmentId}.json` の応答が `{ assignment_collection: [ ... ] }` になることを確認したため、提出状態パーサーを修正しました。
- `assignment_collection` 内の submission が `submitted === true` かつ `draft !== true` の場合、対応イベントを削除します。
- **未提出でも提出期限を過ぎたらイベントを削除**します。
- `chrome.alarms` を使い、管理中イベントのうち最も早い締切時刻に次の削除チェックを予約します。KULMSページを開いていなくても、Chromeが動作できる状態なら期限到来後に削除します。
- PCのスリープ中やChrome終了中は処理できないため、その場合はChromeが再び動作した後に削除されます。

## 削除条件
この拡張機能が作成した `kulmsManaged=v1` のイベントについて、次の**どちらか**を満たしたら削除します。

1. KULMSの提出APIで `submitted === true` かつ `draft !== true` を確認した。
2. `dueTime`（イベントの `extendedProperties.private.kulmsDue` に保存）を現在時刻が過ぎた。

提出APIがエラーになっても、期限前なら勝手に提出済み扱いにはしません。期限後は提出状態に関係なく削除します。

## KULMSで確認できた提出APIの形
```json
{
  "assignment_collection": [
    {
      "draft": false,
      "submitted": true,
      "dateSubmittedEpochSeconds": 0,
      "status": "..."
    }
  ]
}
```

実際の応答では `assignment_collection[0].submitted` を確認できます。v0.4ではキー名を固定した1階層だけの実装ではなく、ネストしたオブジェクトを再帰的に探索してSakaiの差異にも少し耐えるようにしています。

## 予定の作成ルール
- `/direct/assignment/my.json` から課題一覧を取得。
- 締切は `dueTime.epochSecond` / `nano` を使用。
- 締切ちょうど24時間前から5分間の予定を作成。
- タイトルは授業名。説明欄に課題名と提出期限を入れる。
- 課題ID・授業ID・締切を `extendedProperties.private` に保存。
- 期限変更時は同じイベントを更新。
- イベント色は「マンゴー」ラベルを使用。

## Google OAuth設定
1. Google Cloud ConsoleでGoogle Calendar APIを有効化。
2. Chrome拡張機能用OAuthクライアントを作成し、拡張機能IDを登録。
3. `manifest.json` の `REPLACE_WITH_YOUR_CLIENT_ID.apps.googleusercontent.com` を実際のクライアントIDに置換。
4. Chromeで拡張機能を再読み込み。
5. 拡張機能から「Googleアカウントを接続」→「今すぐ同期」。

## 授業名
`/direct/site/{context}.json` から授業名を取得します。取得できない授業はポップアップの「授業名の上書き」に次の形式で設定できます。

```json
{
  "授業ID": "授業名"
}
```

## 注意
- `chrome.alarms` はリアルタイムOSタイマーではありません。Chrome終了・PCスリープ中には実行されず、復帰後に処理されます。
- 削除対象は `kulmsManaged=v1` を持つ、この拡張機能が管理するイベントだけです。
- 最初はテスト用Googleカレンダーでの確認を推奨します。
