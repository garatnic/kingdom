# 12 プログラム構成・データ設計 — 時間・AI連携追補 v0.2
> HTML/CSS/JavaScript ES Modules、Canvas 2Dは**暫定技術案**。世界拡張・ハイブリッド処理は**確定方針**。

## モジュール
`engine/GameLoop,World,Camera,Renderer`、`simulation/CitizenAI,Economy,Construction,Combat,NationAI,Research`、`systems/Events,History,GodPowers,SaveManager`、`data/races,buildings,technologies,balance`、`ui/HUD,Inspector`。

## 時間の単一ソース
`worldTimeTick` は整数精度の唯一の内部時間（1 tick=ゲーム内0.1分）。1年=30日、通常速度で実時間120秒=ゲーム内1日（03の暫定値）。AI/経済/人口/国家はすべてこの時間を参照し、描画フレーム数を直接参照しない。速度変更時も同じシミュレーションイベント順を守る。

## 更新パイプライン
1. 時間進行と期限到来イベント抽出
2. 欲求・危険状態更新
3. 意思決定（分散）
4. 移動・作業・戦闘
5. 経済トランザクションと建築完了
6. 出生死亡・研究・国家判断
7. 歴史イベント追加と通知
8. 描画用スナップショット構築
シミュレーション更新は固定刻み、描画はrequestAnimationFrame。非表示時に停止し、復帰時の壁時計経過を補填しない。

## IDとデータ所有権
IDは `citizen:N`, `settlement:N`, `nation:N`, `building:N`, `node:N`, `event:N` など。単調増加のカウンタを保存。IDは再利用しない。
- CitizenAIは行動意図を発行し、Economyが資源移動を確定。
- Constructionは建築現場の状態と資材予約を管理。
- Historyは確定したイベントのみ記録。
- UIは読み取り専用の投影を表示し、神の介入はコマンドとして検証後に適用。
- 単一スレッドのシミュレーションを初版の正本とし、Worker導入は後続。

## 保存
`schemaVersion`, `worldTimeTick`, `gameSpeed`, `rngState`, `idCounters`, `map`, `citizens`, `settlements`, `nations`, `resourceNodes`, `stockpiles`, `constructionSites`, `events`, `settings`。予約・輸送中の資源も保存。ロード後に参照整合性を検証する。

## 遠景処理【将来】
近景は個別AI、遠景は統計更新。集約前後で人物ID・家系・人口・在庫・重要履歴を保存する。詳細な集約/復元規則は未決定。

## 技術的受入条件
フレームレート差で世界時間が変わらない。経済台帳は非負。セーブ復元後のID重複なし。AI行動とアニメーションの結果が一致。

## v0.5 歴史・LOD・保存連携【暫定】
- Historyは確定トランザクションからのみイベントを受け取る。イベントの `sourceTransactionId + type` を一意キーとして重複記録を防ぐ（09）。
- SaveManagerは固定刻み境界の整合したスナップショットを取得し、旧世代を維持したまま新世代をIndexedDBへ書く（13）。
- 近景/遠景LODは**将来対象**。Ver.0.1では全住民を詳細更新し、カメラ距離でAIを止めない。将来のLOD切替は個人ID・人口・在庫・国家所属・家系を保存する（13）。
- カメラはHistoryのイベント位置・重要度を読み取り、UIからの手動操作を優先する（11）。
- イベント逆引き索引、描画スプライトキャッシュは派生データ。セーブから復元後に再生成可能にする。
