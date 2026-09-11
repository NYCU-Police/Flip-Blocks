# Flip Blocks Unity

Unity 移植版，來源原型為 Codea/Lua 的 `Flip Blocks / 翻轉方塊 / 블록 뒤집기`。

## 開啟方式

1. 用 Unity Hub 開啟這個資料夾：`FlipBlocksUnity`
2. 開啟 `Assets/Scenes/Main.unity`
3. 在 Game 視窗按 Play，會看到「翻轉方塊」開始畫面

專案使用 Unity UGUI，不需要外部圖片或音效資源。目前已用本機 Unity `6000.4.10f1` 的 Roslyn 編譯器做過腳本檢查。

## 已移植內容

- 開始畫面
- 配對/選色畫面
- 本機雙人對戰模式
- 10x20 黑白區域棋盤
- I/O/T/S/Z/J/L 方塊
- P1：方向鍵移動/旋轉/軟降，Enter 硬降
- P2：A/D 移動，W 旋轉，S 軟降，Space 硬降
- 方塊碰到自己顏色後落定並翻色
- 被包圍且沒有連回 home row 的群組會翻轉
- 黑/白任一方達到 75% 佔領時結算勝負（網頁版；與 `docs/game-core.js` 的 `WIN_PCT` 一致）

## 下一步建議

- 加入真正 LAN 對戰同步
- 將假人改成 AI 控制
- 補音效、動畫、落定特效
- 改成 TextMeshPro 與更完整的響應式 UI
