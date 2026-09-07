# Flip Blocks / 翻轉方塊

本機雙人方塊對戰遊戲，包含可直接在瀏覽器遊玩的網頁版，以及移植自 Codea/Lua 原型的 Unity 版。

## 網頁版（GitHub Pages）

用瀏覽器開啟 **`docs/index.html`** 即可遊玩，不需安裝 Unity 或其他套件。支援鍵盤、觸控按鈕、選色、下個方塊預覽、落點提示、暫停與再戰；切換分頁或視窗會自動暫停。

發佈方式：將變更推送到 GitHub，然後到儲存庫 **Settings → Pages**，選 **Deploy from a branch → main → /docs → Save**。

完成 Pages 設定後的遊戲網址：[yuxzs.github.io/Flip-Blocks](https://yuxzs.github.io/Flip-Blocks/)。

完整步驟與網頁版規則請見 [GitHub Pages 發佈說明](docs/github-pages.md)。

![本機雙人遊戲畫面](docs/screenshots/flip-blocks-local-2p.png)

## 專案結構

```text
.
├── .gitignore
├── .gitattributes
├── README.md
├── FlipBlocksUnity/
│   ├── Assets/             # 腳本、場景、Shader 及對應 .meta
│   ├── Packages/           # 套件清單與版本鎖定檔
│   ├── ProjectSettings/    # Unity 專案設定
│   └── README.md
├── docs/
│   ├── index.html         # 網頁遊戲入口 / GitHub Pages
│   ├── style.css          # 響應式遊戲介面
│   ├── game-core.js       # 獨立遊戲規則
│   ├── game.js            # 畫面、鍵盤與觸控
│   ├── github-pages.md    # 網頁版發佈說明
│   ├── github-upload.md
│   └── screenshots/      # 現行版本與開發過程截圖
└── tests/
    └── game-core.test.cjs # node --test tests/game-core.test.cjs
```

## Unity 版：開啟與遊玩

1. 使用 Unity Hub 安裝 Unity **6000.4.10f1**，版本以 `FlipBlocksUnity/ProjectSettings/ProjectVersion.txt` 為準。
2. 在 Unity Hub 加入本儲存庫內的 **`FlipBlocksUnity` 子資料夾**。
3. 等待套件還原與資源匯入，開啟 `Assets/Scenes/Main.unity`。
4. 按 Play，選擇顏色後開始本機雙人對戰。

專案使用 Unity UGUI，套件設定已包含在 `Packages`。目前支援同一台電腦的雙人操作；LAN 連線尚未實作。

| 動作 | P1 | P2 |
| --- | --- | --- |
| 左右移動 | ← / → | A / D |
| 旋轉 | ↑ | W |
| 軟降 | ↓ | S |
| 硬降 | Enter | Space |

棋盤大小為 10 × 20，包含 I/O/T/S/Z/J/L 方塊。方塊落定及包圍區域會造成翻色，任一顏色達到 70% 佔領時結算勝負。

## 建置 macOS 版本

建置入口為 `FlipBlocksUnity/Assets/Editor/BuildFlipBlocks.cs` 中的 `BuildFlipBlocks.BuildMac`。輸出位置是儲存庫根目錄下的 `FlipBlocksUnityBuild/FlipBlocks.app`；建置成品已由 `.gitignore` 排除。

## 版本管理

請將**包含本 README 的資料夾**作為 Git 儲存庫根目錄。`Assets` 與其 `.meta`、`Packages`、`ProjectSettings` 都需要上傳，Unity 快取及個人編輯器設定則由 `.gitignore` 排除。

原工作資料夾中的下列內容僅保留於本機，不會納入 Git：

- `FlipBlocksUnity 2/`：較早的假人測試版本；正式版本為 `FlipBlocksUnity/`。
- `FlipBlocksUnity.zip`：現有的專案壓縮檔。
- `FlipBlocksUnityBuild/`：macOS 建置成品。
- `FlipBlocksUnity/My project/`、`FlipBlocksUnity/My project (1)/`、`FlipBlocksUnity/Setup Guide In-Editor Tutorial/`：獨立的 Unity 範例或教學專案。
- `Library/`、`Temp/`、`Logs/`、`UserSettings/` 等自動產生的內容。

所有原始截圖集中於 `docs/screenshots/`。其中 `flip-blocks-local-2p.png` 為本機雙人版本截圖，其餘保留作為開發過程紀錄。
