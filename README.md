# 世界樹の年代記 — Kingdom Observer

原始集落から始まる多種族ファンタジー世界を観察する、自律型2Dドット絵シミュレーション。神として自由に介入でき、勝利条件はない。

## 設計資料
- [01 基本企画](docs/01_game_overview.md) / [02 開発計画](docs/02_roadmap.md)
- [03 世界と時間](docs/03_world_time.md) / [04 住民AIと家族](docs/04_citizens_ai.md)
- [05 経済と建築](docs/05_economy_construction.md) / [06 国家と外交](docs/06_nations_war.md)
- [07 冒険と戦闘](docs/07_adventure_combat.md) / [08 文明・研究・魔法](docs/08_research_magic.md)
- [09 歴史とイベント](docs/09_history_events.md) / [10 神の能力](docs/10_god_powers.md)
- [11 UIと演出](docs/11_ui_visuals.md) / [12 技術・データ設計](docs/12_architecture.md)
- [13 保存・性能・テスト](docs/13_save_testing.md) / [14 ゲームデータ・調整表](docs/14_game_data.md)

## 運用資料
- [仕様決定履歴](DECISIONS.md)
- [未決定事項](OPEN_QUESTIONS.md)
- [変更履歴](CHANGELOG.md)

## ブラウザ版

公開先は [garatnic.github.io/kingdom](https://garatnic.github.io/kingdom/) です。公開・検証状況は [開発進捗](DEVELOPMENT_STATUS.md) を参照してください。

## 起動とテスト

Node.js 22以降で `npm start` を実行し、ブラウザで [http://127.0.0.1:8080/](http://127.0.0.1:8080/) を開く。依存パッケージのインストールは不要。

- `npm test` でシミュレーション、経路探索、カメラ、セーブを検証。
- `npm run test:integration` で固定刻み30分相当と3シードの20倍・2ゲーム年を検証。
- Chromiumが起動できる環境では `npm run test:browser` で画面起動、操作、セーブの往復を検証。実行ファイルは `CHROMIUM` で指定できる。

## ステータス

Ver.0.1を公開し、最終受入を完了しました。集落の生活・建築・家族、冒険、建国・研究、歴史、神の介入、JSON入出力とブラウザ自動保存を実装しました。[進捗と検証結果](DEVELOPMENT_STATUS.md) ・ [開発計画](docs/02_roadmap.md)

Ver.0.2以降の開発では、冒険者による新地域の発見、遠景処理の初期段階、鉄器・王国・魔導時代、敵対国間の進軍・包囲・占領を追加しています。[最新の開発状況](DEVELOPMENT_STATUS.md)
