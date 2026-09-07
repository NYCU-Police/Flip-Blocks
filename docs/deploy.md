# 拉取式自動部署（連線主機）

伺服器沒有公網、也不走 SSH 推送。流程是：本機／CI 把映像推到 GitHub Container Registry，伺服器上的 Watchtower 定期拉取並重啟。

映像名稱為 `ghcr.io/<擁有者>/<儲存庫>`，字母皆小寫。此儲存庫預設為 `ghcr.io/nycu-police/flip-blocks`。標籤包含 `:latest` 與 `:sha-<短 SHA>`。

## 伺服器初次部署

1. 安裝 [Docker Engine](https://docs.docker.com/engine/install/) 與 Compose 外掛。
2. 建立目錄，例如 `/opt/flip-blocks`，放入本儲存庫的 `deploy/docker-compose.yml`。
3. 若映像是 **public**，可直接啟動。若是 **private**（GHCR 套件預設為私有），先登入：

   ```sh
   # 在 GitHub → Settings → Developer settings → Personal access tokens
   # 建立 PAT，權限勾選 read:packages（讀取此組織／帳號的套件）。
   echo YOUR_PAT | docker login ghcr.io -u YOUR_GITHUB_USERNAME --password-stdin
   ```

   同一個登入也要給 Watchtower 用。較簡單的作法是在伺服器先 `docker login`，Watchtower 會透過 Docker socket 沿用該憑證。也可改用 [Watchtower 的 repo 認證](https://containrrr.dev/watchtower/usage-overview/#notifications) 環境變數。
4. 啟動：

   ```sh
   cd /opt/flip-blocks
   docker compose -f docker-compose.yml up -d
   ```

5. 驗證：

   ```sh
   curl -s http://localhost:8787/healthz
   ```

   應回 `200` 與 JSON，例如 `{"ok":true,"uptime":…,"room":{…}}`。瀏覽器開啟 `http://伺服器IP:8787` 即可建立房間。

## 之後的更新（不用再登入伺服器）

1. 把變更合併並推到 `main`。
2. GitHub Actions 跑 `npm test`。
3. 測試通過後把映像推到 GHCR（`:latest` 與 `:sha-…`）。
4. 伺服器上的 Watchtower **每 5 分鐘**檢查一次，只監控帶有 `com.centurylinklabs.watchtower.enable=true` 的 `flip-blocks` 容器，拉取新映像後重啟，並清理舊映像。

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
