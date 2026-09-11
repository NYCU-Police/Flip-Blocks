# 拉取式自動部署（連線主機）

這份說明寫**怎麼把連線主機放到伺服器上**。玩家怎麼玩見 [README 的「線上對戰」](../README.md#線上對戰) 與 [線上對戰說明](lan-play.md)；本機 `npm start` 見 [README 的「自架主機」](../README.md#自架主機)。

流程是：CI 把映像推到 GitHub Container Registry，伺服器上的 Watchtower 定期拉取並重啟。映像名稱為 `ghcr.io/<擁有者>/<儲存庫>`，字母皆小寫。請把 `deploy/docker-compose.yml` 裡的映像路徑改成你的倉庫。標籤包含 `:latest` 與 `:sha-<短 SHA>`。

## 伺服器初次部署

1. 安裝 [Docker Engine](https://docs.docker.com/engine/install/) 與 Compose 外掛。
2. 建立目錄，例如 `/opt/flip-blocks`，放入本儲存庫的 `deploy/docker-compose.yml`。
3. 從 [`.env.example`](../.env.example) 複製出本機 `.env`（已列入 `.gitignore`），只填變數、不要提交實際值。
4. 若映像是 **public**，可直接啟動。若是 **private**（GHCR 套件預設為私有），先登入：

   ```sh
   # 在 GitHub → Settings → Developer settings → Personal access tokens
   # 建立 PAT，權限勾選 read:packages（讀取此組織／帳號的套件）。
   echo '<your-token>' | docker login ghcr.io -u '<your-username>' --password-stdin
   ```

   同一個登入也要給 Watchtower 用。較簡單的作法是在伺服器先 `docker login`，Watchtower 會透過 Docker socket 沿用該憑證。也可改用 [Watchtower 的 repo 認證](https://containrrr.dev/watchtower/usage-overview/#notifications) 環境變數。
5. 啟動：

   ```sh
   cd /opt/flip-blocks
   docker compose -f docker-compose.yml up -d
   ```

6. 驗證：

   ```sh
   curl -s http://localhost:8787/healthz
   ```

   應回 `200` 與 JSON，例如 `{"ok":true,"uptime":…,"rooms":0}`。瀏覽器開啟該主機位址即可建立房間。排行榜寫在掛載的資料目錄（容器內 `DATA_DIR`），請保留該目錄，更新後戰績才還在。

`TRUST_PROXY` 關閉時以 TCP 遠端位址辨識訪客（本機、區域網路、Tailscale 直連）。若主機在 **Cloudflare Tunnel** 後方，於 `.env` 開啟 `TRUST_PROXY`，改從 `CF-Connecting-IP`（優先）或 `X-Forwarded-For` 第一個位址取真實 IP，否則所有連線會被看成同一條出口而誤觸每 IP 上限。不要在未受信任的反代前方開啟此選項。

## 之後的更新（不用再登入伺服器）

1. 把變更合併並推到 `main`。
2. GitHub Actions 跑 `npm test`。
3. 測試通過後把映像推到 GHCR（`:latest` 與 `:sha-…`）。
4. 伺服器上的 Watchtower 定期檢查，只監控帶有 `com.centurylinklabs.watchtower.enable=true` 的遊戲容器，拉取新映像後重啟，並清理舊映像。

## 排錯

- 看 Watchtower：`docker logs flip-blocks-watchtower`
- 看遊戲主機：`docker logs flip-blocks`
- 健康檢查失敗：`curl -v http://localhost:8787/healthz`
- 手動強制更新：

  ```sh
  cd /opt/flip-blocks
  docker compose pull flip-blocks
  docker compose up -d flip-blocks
  ```

- 映像拉取 401：確認 `docker login ghcr.io` 仍有效，且 PAT 有 `read:packages`。
- 若要把 GHCR 套件改成公開：GitHub 儲存庫 → Packages → 該映像 → Package settings → Change visibility → Public。公開後伺服器不必 `docker login`。
