# 上傳 GitHub

本專案已整理好 `.gitignore` 與 `.gitattributes`。整理工作本身未建立 Git 儲存庫、提交或推送遠端。

## 第一次上傳至新的空白儲存庫

1. 在 GitHub 建立一個空白儲存庫，自行選擇公開或私人。建立時不要預先加入 README、`.gitignore` 或授權檔，以便直接推送本機內容。
2. 在包含根目錄 `README.md` 與 `FlipBlocksUnity/` 的資料夾開啟終端機。原始位置為：

   ```sh
   cd '/Users/htciu-mac/Documents/Codex/2026-06-04/yuxzs-flip-blocks-https-github-com/outputs'
   ```

3. 初始化並檢查將加入的檔案：

   ```sh
   git init -b main
   git add .
   git status --short
   git diff --cached --stat
   ```

   清單應以 `.gitignore`、`.gitattributes`、README、`FlipBlocksUnity/Assets`、`FlipBlocksUnity/Packages`、`FlipBlocksUnity/ProjectSettings` 與 `docs` 為主，不應包含 Unity `Library`、舊版副本或 `.app` 成品。

4. 檢查完成後提交：

   ```sh
   git commit -m "Add Flip Blocks Unity project"
   ```

5. 將以下示例中的 `YOUR_ACCOUNT` 與 `YOUR_REPOSITORY` 替換成你在 GitHub 建立的儲存庫資料，再執行：

   ```sh
   git remote add origin https://github.com/YOUR_ACCOUNT/YOUR_REPOSITORY.git
   git push -u origin main
   ```

   登入驗證依照本機 Git 設定完成，不要把存取權杖寫入專案檔案。

## 後續更新

```sh
git status --short
git add .
git diff --cached --stat
git commit -m "Update Flip Blocks"
git push
```

## 已有 GitHub 儲存庫的情況

若遠端已有提交，先 clone 該儲存庫，再把此專案中未被忽略的內容放入 clone 出來的資料夾，保留既有的 `.git` 與歷史；若有同名檔案，先比對並合併。不要直接用強制推送覆蓋既有歷史。

`.gitignore` 只影響未追蹤檔案；若快取或成品先前已被提交，新增規則不會自動停止追蹤。可用 `git ls-files -ci --exclude-standard` 列出這類檔案，再逐項確認處理。

透過 Git 提交時會套用 `.gitignore`；直接把整個原始資料夾拖曳到網頁上傳並不會替你篩選本機內容。
