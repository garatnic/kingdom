# 14 ゲームデータ定義・バランス表
**この文書の数値・対象はすべて暫定。確定したバランス値ではない。**
## Ver.0.1候補
| 区分 | 内容 |
|---|---|
| 世界 | 64×64タイル、初期12人、最大詳細100人程度 |
| 種族 | 人間、エルフ、ドワーフ |
| 職業 | 農民、木こり、鉱夫、建築家、冒険者 |
| 建物 | 住宅、畑、倉庫、鍛冶屋、ギルド、兵舎 |
| 資源 | 食料、木材、石材、鉄、魔石 |
| 魔物 | スライム、ゴブリン |
| 国家 | 最大2、友好/中立/敵対 |
| 研究 | 農業、建築、武器、魔法 |
## 設定データの推奨列
ID、表示名、カテゴリ、前提条件、コスト、効果、更新間隔、アニメーションID、実装段階、備考。
## 具体的に要調整
- 初期資源、住民の1日食料消費、採集速度、運搬量、倉庫容量
- 住宅収容数、建築コストと時間、人口増加・寿命・出生率
- 攻撃力、HP、索敵距離、魔物再出現条件、撤退閾値
- 建国条件、研究コスト、研究速度、文明進化条件
## 方針
数値をプログラムに直書きせず、設定ファイルに分離する。説明用グラフの数値をゲームの正式値として転用しない。

## v0.6 設定値の単一ソース【すべて暫定】
| キー | 値 | 参照 |
|---|---:|---|
| TIME_TICKS_PER_MINUTE | 10 | 03/04/09/13 |
| TIME_TICKS_PER_DAY | 14400 | 03 |
| TIME_TICKS_PER_YEAR | 432000 | 03/04 |
| REAL_STEP_MS | 100 | 03/12 |
| TICKS_PER_STEP_AT_1X | 12 | 03 |
| FOOD_HUNGER_PER_HOUR | 3 | 04/05 |
| FOOD_HUNGER_RESTORED | 40 | 04/05 |
| FOOD_PER_MEAL | 1 | 04/05 |
| FOOD_TARGET_PER_PERSON | 4 | 05 |
| FOOD_EMERGENCY_PER_PERSON | 2 | 05 |
| FOOD_BIRTH_PER_PERSON | 3 | 04/05 |
| BIRTH_CHECK_INTERVAL_TICKS | 432000 | 04 |
| BIRTH_PROBABILITY_PER_YEAR | 0.35 | 04 |
| MAGIC_AFFINITY_THRESHOLD | 0.7 | 04/08 |
| INITIAL_MAGIC_AFFINITY_MIN_COUNT | 1 | 04/08 |
| INITIAL_IRON_NODE_MIN_QTY | 6 | 05/08 |
| INITIAL_MANA_NODE_MIN_QTY | 2 | 05/08 |

実装では `data/balance.js` にこれらを定義し、各システムは定数を参照する。仕様書中の数値は説明であり、調整時はこの表を起点に関連資料を更新する。

## v0.6 データ参照ルール
- 時刻フィールドは `worldTimeTick`、出生は `birthWorldTimeTick`、年次抽選は `nextBirthCheckTick`。`worldMinute` 等の旧名称は使用しない。
- 研究の資源条件は倉庫の利用可能在庫のみ。建築資材予約と共有しない。
- 初期資源0でも、鉄/魔石ノードと鉱夫の採掘により研究へ到達可能とする。
