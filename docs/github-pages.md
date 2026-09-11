# 將靜態網頁遊戲發佈到 GitHub Pages

這份說明只處理**不需主機的靜態版**（同機雙人、單人對戰 AI）。線上對戰見 [README](../README.md#線上對戰) 與 [線上對戰說明](lan-play.md)。公開網站部署見 [拉取式部署說明](deploy.md)。

網頁檔在 `docs/`，使用 HTML、CSS、JavaScript，不需 Unity WebGL 或額外建置。資源使用相對路徑，可放在 GitHub Pages 的子路徑，也可直接開啟 `docs/index.html`。

## 1. 推送到 GitHub

在儲存庫根目錄把變更提交並推到 `main`（請先把 `origin` 設成你的 Git 遠端）。若在其他分支開發，請先合併到 `main` 再發佈，不要用強制推送蓋掉遠端提交。

## 2. 開啟 Pages（只需設定一次）

1. 打開 GitHub 儲存庫的 **Settings → Pages**。
2. 在 **Build and deployment → Source** 選擇 **Deploy from a branch**。
3. **Branch** 選 **main**，資料夾選 **/docs**，按 **Save**。
4. 等待 GitHub 顯示發佈完成；也可以到 **Actions → pages build and deployment** 查看進度。

沒有自訂網域時，發佈後網址為：

**`https://<owner>.github.io/<repo>/`**

建立網頁檔案不代表已經上線，需完成推送及上述設定。之後更新 `docs/` 並推送到 `main`，GitHub 會自動重新發佈。`docs/.nojekyll` 讓 GitHub 直接提供靜態檔案。

官方說明：[設定 GitHub Pages 發佈來源](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site)。

## 本機預覽

直接開啟 `docs/index.html` 即可玩同機雙人或單人對戰 AI（不必輸入暱稱）。線上對戰、觀戰與排行榜需執行連線主機，見 [README 的「自架主機」](../README.md#自架主機)。也可：

```sh
python3 -m http.server 4173 --bind 127.0.0.1 --directory docs
```

然後開啟 `http://127.0.0.1:4173/`。

## 操作與規則

| 動作 | 玩家一 | 玩家二 |
| --- | --- | --- |
| 左右移動 | ← / → | A / D |
| 旋轉 | ↑ | W |
| 按住加速 | ↓ | S |
| 直接落定 | Enter | Space |
| 暫停／繼續 | Esc | Esc |

兩位玩家也可使用各自面板的觸控按鈕；切換分頁或視窗會自動暫停。單人 AI 時只有玩家一可操作。

- 黑方基地位於底部，方塊往下推進；白方基地位於頂部，方塊往上推進。選色只交換玩家所屬顏色。
- 方塊碰到己方領地前落定，將當前格子翻色。檢查棋盤邊界，前進時再檢查己方顏色。
- 與自己基地列失去上下左右連結的敵方群組會被翻色，斜角不算連結。
- 佔領 70%（140 格）獲勝；己方顏色出現在全部 20 列也能取勝。
- 綠色與紫色實心方塊分別代表玩家一、玩家二；虛線顯示預計落點。

網頁版修正了 Unity 版選白色時的初始領地方向不一致，並加上前進邊界限制，避免沒有己方格子的直行造成硬降無限迴圈。Unity 與 Lua 原始碼保持原狀。
