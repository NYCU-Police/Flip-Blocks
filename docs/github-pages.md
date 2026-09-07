# 將網頁遊戲發佈到 GitHub Pages

網頁版已放在 `docs/`，使用純 HTML、CSS、JavaScript，不需 Unity WebGL、npm 安裝或額外建置。所有遊戲資源使用相對路徑，可支援 GitHub Pages 的 `/Flip-Blocks/` 子路徑，也可直接雙擊 `docs/index.html` 開啟。

## 1. 上傳本次變更

在儲存庫根目錄執行（本機已設定 `origin` 為 `git@github.com:yuxzs/Flip-Blocks.git`）：

```sh
git add README.md docs/index.html docs/style.css docs/game-core.js docs/game.js docs/network.js docs/lan-play.md docs/favicon.svg docs/.nojekyll docs/github-pages.md tests/game-core.test.cjs tests/network.test.cjs server/index.cjs package.json pnpm-lock.yaml .gitignore
git diff --cached --stat
git commit -m "Add browser game for GitHub Pages"
git push origin main
```

如果你正在其他分支開發，請先將這些變更合併到 `main` 再發佈。不要用強制推送蓋掉遠端提交。

## 2. 開啟 Pages（只需設定一次）

1. 打開 [Flip-Blocks 儲存庫的 Pages 設定](https://github.com/yuxzs/Flip-Blocks/settings/pages)。
2. 在 **Build and deployment → Source** 選擇 **Deploy from a branch**。
3. **Branch** 選 **main**，資料夾選 **/docs**，按 **Save**。
4. 等待 GitHub 顯示發佈完成；也可以到 **Actions → pages build and deployment** 查看進度。

在沒有自訂網域的情況下，發佈後網址為：

**[https://yuxzs.github.io/Flip-Blocks/](https://yuxzs.github.io/Flip-Blocks/)**

這是預期的發佈位址，建立網頁檔案不代表它已上線。需完成推送及上述 Pages 設定。

之後更新 `docs/` 並推送至 `main`，GitHub 便會自動重新發佈。`docs/.nojekyll` 讓 GitHub 直接提供靜態檔案。

官方說明：[設定 GitHub Pages 發佈來源](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site)。

## 本機預覽與驗證

直接用瀏覽器開啟 `docs/index.html`，或在根目錄啟動本機伺服器：

```sh
python3 -m http.server 4173 --bind 127.0.0.1 --directory docs
```

然後開啟 [本機預覽](http://127.0.0.1:4173/)。

核心規則測試（Node.js 18 以上；不需安裝套件）：

```sh
node --test tests/game-core.test.cjs
```

## 操作與規則

| 動作 | 玩家一 | 玩家二 |
| --- | --- | --- |
| 左右移動 | ← / → | A / D |
| 旋轉 | ↑ | W |
| 按住加速 | ↓ | S |
| 直接落定 | Enter | Space |
| 暫停／繼續 | Esc | Esc |

兩位玩家也可使用各自面板的觸控按鈕；切換分頁或視窗會自動暫停。預設為**同一台裝置的雙人對戰**；跨裝置遊玩請使用「區域網路 / IP 連線對戰」，由一台電腦啟動主機，詳見 [連線對戰說明](lan-play.md)。GitHub Pages 本身不能執行此主機。

- 黑方基地位於底部，方塊往下推進；白方基地位於頂部，方塊往上推進。選色只交換玩家所屬顏色。
- 方塊碰到己方領地前落定，將當前格子翻色。沿用 Unity 的左右移動／旋轉規則：檢查棋盤邊界，前進時再檢查己方顏色。
- 與自己基地列失去上下左右連結的敵方群組會被翻色，斜角不算連結。
- 佔領 70%（140 格）獲勝；沿用 Unity 的另一個勝利條件：己方顏色出現在全部 20 列。
- 綠色與紫色實心方塊分別代表玩家一、玩家二；虛線顯示預計落點。

網頁版修正了 Unity 版選白色時的初始領地方向不一致，並加上前進邊界限制，避免沒有己方格子的直行造成硬降無限迴圈。Unity 與 Lua 原始碼保持原狀。
