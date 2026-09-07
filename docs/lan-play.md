# 區域網路 / IP 連線對戰（網頁版）

## 開始遊玩

1. 房主電腦安裝 Node.js 22 以上。在包含 `package.json` 的專案根目錄執行 `npm install`，之後每次遊玩執行 `npm start` 即可。使用 pnpm 的開發者可執行 `pnpm install --frozen-lockfile` 使用已鎖定套件。
2. 房主開啟 `http://localhost:8787`，展開「區域網路 / IP 連線對戰」，輸入 2–12 字暱稱，按「建立房間」。畫面會顯示 6 位房間代碼（大寫字母與數字，不含易混淆的 0/O/1/I）。
3. 主機啟動時會列出區域網路位址，例如 `http://192.168.1.20:8787`。另一位玩家連上相同 Wi-Fi，開啟該網址，輸入暱稱與房間代碼後按「加入房間」。也可在 IP 欄填主機位址並帶上代碼，前往該主機頁面。
4. 知道房間代碼者可按「觀戰」只看狀態、不能操作。房內會顯示觀戰人數與暱稱。
5. 房主選擇玩家一的顏色。雙方按「我準備好了」，房主按棋盤上的「房主開始對戰」。房主換色會取消雙方準備。
6. 每台裝置使用方向鍵或 WASD 操作自己的方塊，Enter / Space 直接落定；觸控只開放自己的面板。觀戰者沒有操作權。


一台主機可同時開最多 50 間雙人房。暱稱會記住（`localStorage`）；同機與單人 AI 不必輸入暱稱。大廳可開啟匿名勝場榜（前 20，同暱稱累計勝場）。

## 暫停、再戰與斷線

- 對局玩家可暫停 / 繼續；切換分頁或視窗會同步暫停雙方。觀戰者不會送出暫停。
- 房主可按「新對局」，或在結算後按「再戰 / 重新準備」。雙方需重新按準備才能開局。
- 大廳中離開會立刻讓出自己的座位，房間代碼仍有效；新的玩家可用同一代碼入座。
- 對局進行中（含暫停）若 WebSocket 中斷，該房間會暫停並保留棋盤與方塊，進入最多 60 秒的重連視窗（`RECONNECT_MS`）。`sessionToken` 綁定房間代碼，重連回到原房間原座位。
- 雙方都離開（含重連逾時清座位）後，房間再保留 5 分鐘（`ROOM_TTL_MS`）供重連或再戰，然後回收。逾時未歸則判留下的玩家獲勝。
- 按「離開連線」立刻退出，不進入重連等待。

## 協定（WebSocket `/match`）

客戶端送出 JSON，身分由連線決定，不信任客戶端填的座位或棋盤。

| 方向 | `type` | 說明 |
| --- | --- | --- |
| C→S | `join` | `{ role: 'host'\|'guest'\|'spectate', name, code?, color? }`。建立房間時不要帶 `code`；加入／觀戰必填 6 位代碼。 |
| C→S | `reconnect` | `{ sessionToken, code }`，兩者都必須通過格式檢查。 |
| C→S | `ready` / `color` / `start` / `restart` / `pause` / `resume` / `input` / `leave` | 僅座位玩家有效；觀戰者的操作會被忽略。 |
| S→C | `joined` | `{ owner, sessionToken?, code, name, role }`。觀戰沒有 `sessionToken`。 |
| S→C | `state` | 壓縮棋盤快照，另含 `names`、`spectators`、`spectatorNames`、`code`、`reconnect`。 |
| S→C | `tick` | 進行中的較小更新，玩家與觀戰者都收得到。 |
| S→C | `reconnect-waiting` / `reconnected` / `reconnect-timeout` | 重連狀態。 |
| S→C | `error` | 驗證失敗或滿房等；隨後斷線。 |

輸入驗證：暱稱去掉控制字元與首尾空白後須為 2–12 字；房間代碼須符合字元集；字串欄位超過 64 字、非法 JSON、或每連線每秒超過 30 則訊息會直接斷線。`GET /leaderboard` 只回 `{ rankings: [{ name, wins }] }`，不含 token 或內部狀態。

排行榜由伺服器在連線對局結算時寫入 SQLite（`DATA_DIR`，預設 `./data`），同一房間同一局（`match_key`）只記一次，不接受客戶端上報結果。

## 位址及連線問題

- **只有自己能連：** 朋友需用房主的區域網路 IP，不能使用 `localhost` 或 `127.0.0.1`。若電腦有 VPN／多張網卡，選擇與朋友相同網段的位址。
- **無法連線：** 確認主機正在執行、IP／連接埠正確、作業系統防火牆允許 Node.js 的 TCP 8787 連線。訪客 Wi-Fi 或 AP 隔離可能禁止裝置互連。
- **連接埠被占用：** macOS／Linux 可用 `PORT=9000 npm start`；Windows PowerShell 使用 `$env:PORT=9000; npm start`。朋友的位址也需改為 `主機IP:9000`。
- **房間已滿：** 主機同時最多 50 間房。空房約 5 分鐘後回收。
- **GitHub Pages 或直接開啟 HTML：** 同機／AI 可直接玩。連線需前往主機提供的 HTTP 頁面。
- **不同網路：** 請先透過可互通的私人 VPN 連至同一網路。本版本沒有公網中繼、NAT 穿透或 LAN 自動搜尋。

## 開發與驗證

```sh
npm install
npm test
```

`server/index.cjs` 使用 [ws](https://github.com/websockets/ws) 與 [better-sqlite3](https://github.com/WiseLibs/better-sqlite3)。伺服器每 50ms 更新各房間；落定、勝負與房間事件廣播壓縮快照，平時送較小的 `tick`。測試涵蓋多房間隔離、代碼拒絕、房間回收、觀戰不能操作、暱稱驗證、排行榜去重與速率限制，以及既有的重連與規則測試。
