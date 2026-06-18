# 雲端同步智慧記帳系統 - Firebase Auth 安全版說明書

這是一套專為手機與電腦同步設計的**免後端 (Serverless) 智慧記帳系統**。您的資料存放於您個人的免費 **Firebase Firestore** 雲端資料庫中，並有 **Firebase Authentication 身份驗證** 作為密碼鎖，安全、即時且完全免費。

---

## 🚀 快速開始四步驟

### 第一步：建立您的 Firebase 專案與 Firestore 資料庫

> [!NOTE]
> **您的本機記帳 App 專屬對接專案名稱已選定為**：`aisdlc-gen-document-poc`。請在登入 Firebase 控制台後，直接點選此專案，或點擊「將 Firebase 新增到 Google Cloud 專案」並選取它。

1. 前往 [Firebase Console (https://console.firebase.google.com/)](https://console.firebase.google.com/)，登入您的 Google 帳戶。
2. 進入您已新增 Firebase 的 `aisdlc-gen-document-poc` 專案。
3. 在左側選單點選 **「Firestore Database」** (或「資料庫和儲存空間」-> Cloud Firestore)。
4. 點擊 **「建立資料庫」**：
   * **資料庫 ID**：保留預設的 `(default)`，點選下一步。
   * **安全規則**：選擇 **「以正式版模式啟動」**，點選下一步。
   * **位置**：選擇 `asia-east1` (台灣) 或 `asia-northeast1` (東京)，點選啟用。

---

### 第二步：啟用身份驗證與建立您的記帳帳密

為了幫您的帳本加上「密碼鎖」，請按照以下步驟啟用驗證：

1. 在 Firebase 後台左側選單點選 **「Authentication」**（或「產品類別」->「安全性」->「Authentication」）。
2. 點擊 **「Get Started」** (開始使用)。
3. 在「登入方法」(Sign-in method) 清單中，選擇 **「Email/Password」** (電子郵件/密碼)。
4. 將第一項 **「啟用」** (Enable) 打開（第二項免密碼連結不用開），然後點選 **「儲存」** (Save)。
5. 切換到上方的 **「Users」** (使用者) 頁籤。
6. 點擊右側的 **「新增使用者」** (Add user)：
   * 輸入您個人的記帳 Email（例如：`myexpense@user.com`，不用是真實信箱，只要好記即可）。
   * 輸入您想設定的**記帳密碼**。
   * 點擊「新增使用者」。
7. **複製專屬 UID**：
   * 新增成功後，在使用者清單的右側會出現一串長長的 **「使用者 UID」**（例如：`kL92Js1aM8...`）。
   * **請複製這串 UID**，我們等一下要用它來鎖住資料庫。

---

### 第三步：設定絕對安全規則

為了保證全世界只有您這組帳密可以讀寫資料：

1. 回到 **「Firestore Database」** 頁面。
2. 點擊中上方的 **「Rules」** (規則) 頁籤。
3. 將裡面的安全規則全部刪除，並貼上以下程式碼：
   ```javascript
   rules_version = '2';
   service cloud.firestore {
     match /databases/{database}/documents {
       match /{document=**} {
         // 只有當使用者已成功登入，且其 UID 與您個人的專屬 UID 完全一致時，才允許讀寫
         allow read, write: if request.auth != null && request.auth.uid == '請貼上您剛才複製的UID';
       }
     }
   }
   ```
4. 將 `'請貼上您剛才複製的UID'` 替換成您剛才複製的長串 UID（例如：`'kL92Js1aM8...'`，兩側單引號要保留）。
5. 點擊右上角 **「Publish」** (發布) 存檔。

*現在，您的資料庫已被徹底鎖死。沒有這組帳密，任何人即使拿到您的金鑰也完全打不開資料！*

---

### 第四步：設定網頁連線與登入

1. 回到 Firebase 控制台的專案首頁，點選 **網頁圖示 `</>`** (Web) 註冊應用程式。
2. 輸入名稱（例如：`myexpenses-web`），直接點擊 **「註冊應用程式」**。
3. 複製畫面中出現的 `firebaseConfig` 物件內容（大括號 `{ ... }` 裡面的所有設定）。
4. 在本專案的 `app/static/` 目錄下，雙擊開啟 `index.html`。
5. 網頁會自動跳轉至 **「設定」** 頁面，將您複製的 Firebase Config JSON 內容貼入輸入框中，點擊 **「儲存連線設定」**。
6. 設定儲存後，網頁會彈出 **「解鎖帳本」** 的登入畫面，輸入您剛才在第二步設定的 **記帳 Email 與密碼** 即可成功登入！
7. 登入成功後，系統會自動在您的雲端資料庫中初始化基礎分類與付款方式，您可以直接在「備份」頁面拖入 CSV 檔案進行一鍵匯入囉！

---

## 📱 手機記帳作業方式

1. **部署網頁**：
   您可以使用免費的雲端靜態託管（如 [GitHub Pages](https://pages.github.com/)、[Vercel](https://vercel.com/) 或 [Netlify](https://www.netlify.com/)），將 `app/static/` 裡的 `index.html`、`style.css`、`app.js` 部署上去，即可獲得一個專屬的線上網址。
2. **手機開啟並設定**：
   在手機瀏覽器輸入該網址，並同樣在「設定」中貼入您的 Firebase Config 存檔，然後輸入您的帳密登入（系統會自動記住登入狀態，不需要每次都輸入）。
3. **加入主畫面 (PWA)**：
   * **iPhone (Safari)**：點擊分享按鈕 -> 選擇 **「加入主畫面」**。
   * **Android (Chrome)**：點擊右上角選單 -> 選擇 **「安裝應用程式」** 或 **「加到主畫面」**。
   這樣在您的手機桌面上就會出現專屬的記帳 App 圖示，體驗與原生 App 無異！
