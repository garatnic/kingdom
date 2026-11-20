# 12 プログラム構成・データ設計
## 技術案【暫定】
HTML/CSS/JavaScript ES Modules、Canvas 2D。シミュレーションと描画を分離。必要ならWeb Workerを導入。
## モジュール
engine/{GameLoop,World,Camera,Renderer}; simulation/{CitizenAI,Economy,Construction,Combat,NationAI,Research}; systems/{Events,History,GodPowers,SaveManager}; data/{races,buildings,technologies}; ui/{HUD,Inspector}。
## 更新方式
固定シミュレーション刻み（例100ms）と requestAnimationFrame 描画を分離。住民AIは数秒間隔で分散更新。国家AI・研究はゲーム内日単位で更新。
## データの責務
人物、国家、建物、資源ノード、チャンク、イベントは一意ID。参照はIDで管理。位置と所有権の更新は単一のシステムが確定し、二重消費・重複生成を防ぐ。
## 近景・遠景
近景は個人の行動を更新、遠景は集約。切替時に人口・在庫・主要人物・家系が保存されることが必須。詳細な集約・復元アルゴリズムは未決定。
## 再現性
乱数シード、時間、イベント順序を保存。完全な決定論的リプレイは初版の必須条件ではない。
