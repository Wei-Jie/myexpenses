/* ==========================================================================
   智慧記帳系統核心 JS 邏輯 (Firebase Auth 安全版)
   ========================================================================== */

let db = null;
let categoriesCache = [];
let paymentsCache = [];
let transactionsCache = [];
let autocompleteList = [];

// 當前正在存取的帳本擁有者 (用於共享帳本，預設為當前登入者)
let currentLedgerOwnerUid = null;
let currentLedgerOwnerEmail = null;

// 當前選取的月份 (預設為今天所在的月份)
let currentYear = new Date().getFullYear();
let currentMonth = new Date().getMonth() + 1; // 1-indexed

// 離線佇列
let offlineQueue = JSON.parse(localStorage.getItem('expense_offline_queue') || '[]');

// 初始化網頁
document.addEventListener('DOMContentLoaded', () => {
  setupAppVersion();
  initFirebaseConnection();
  setupEventListeners();
  setDefaultDates();
  registerServiceWorker();
  
  // 定時嘗試同步離線資料 (每30秒)
  setInterval(syncOfflineQueue, 30000);
  window.addEventListener('online', syncOfflineQueue);
});

// 註冊 Service Worker 實現 PWA
function registerServiceWorker() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('service-worker.js')
      .then(reg => {
        console.log('[PWA] Service Worker 註冊成功，Scope:', reg.scope);
      })
      .catch(err => {
        console.error('[PWA] Service Worker 註冊失敗:', err);
      });
  }
}

// 1. 更版快取檢測與版本設定 (Cache Busting)
const APP_VERSION = '20260618_17';
function setupAppVersion() {
  console.log(`智慧記帳系統 (Firebase Auth 版) 啟動，版本號: ${APP_VERSION}`);
  const lastVersion = localStorage.getItem('app_version');
  if (lastVersion && lastVersion !== APP_VERSION) {
    console.log('偵測到系統版本更新，清除快取並強制重載...');
    localStorage.setItem('app_version', APP_VERSION);
    window.location.reload(true);
  } else {
    localStorage.setItem('app_version', APP_VERSION);
  }
}

// 2. 初始化 Firebase 連線
function initFirebaseConnection() {
  const configStr = localStorage.getItem('firebase_config');
  const statusIndicator = document.querySelector('.status-indicator');
  const statusText = document.querySelector('.status-text');
  
  if (configStr) {
    try {
      const firebaseConfig = JSON.parse(configStr);
      
      // 防止重複初始化
      if (firebase.apps.length === 0) {
        firebase.initializeApp(firebaseConfig);
      }
      
      db = firebase.firestore();
      
      statusIndicator.className = 'status-indicator connected';
      statusText.textContent = '已連線 (Firebase)';
      document.getElementById('connection-status').style.borderColor = 'rgba(0, 230, 118, 0.3)';
      document.getElementById('set-config').value = JSON.stringify(firebaseConfig, null, 2);
      
      // 設定身份驗證監聽器 (安全性關鍵！)
      setupAuthListener();
    } catch (e) {
      console.error('Firebase 初始化錯誤:', e);
      showConnectionError();
      showToast('❌ Firebase Config 格式有誤', 'error');
    }
  } else {
    showConnectionError();
    switchPage('page-settings');
    showToast('⚠️ 請先設定 Firebase Config', 'error');
  }
}

function showConnectionError() {
  const statusIndicator = document.querySelector('.status-indicator');
  const statusText = document.querySelector('.status-text');
  statusIndicator.className = 'status-indicator disconnected';
  statusText.textContent = '未登入/未連線';
  document.getElementById('connection-status').style.borderColor = 'rgba(255, 23, 68, 0.3)';
}

// 身份驗證狀態監聽 (Auth Listener)
function setupAuthListener() {
  firebase.auth().onAuthStateChanged(async (user) => {
    const loginOverlay = document.getElementById('login-overlay');
    const logoutBtn = document.getElementById('btn-logout');
    const ledgerWrapper = document.getElementById('ledger-select-wrapper');
    
    if (user) {
      console.log('帳本已解鎖，使用者:', user.email);
      loginOverlay.classList.add('hidden');
      logoutBtn.classList.remove('hidden');
      
      // 初始化當前帳本擁有者為自己
      currentLedgerOwnerUid = user.uid;
      currentLedgerOwnerEmail = user.email;
      
      // 確保連線狀態正確
      const statusIndicator = document.querySelector('.status-indicator');
      const statusText = document.querySelector('.status-text');
      statusIndicator.className = 'status-indicator connected';
      statusText.textContent = '已解鎖 (Firebase)';
      
      // A. 背景向 users 集合寫入/更新使用者 Email 與 UID 關係
      try {
        await db.collection('users').doc(user.uid).set({
          email: user.email,
          updated_at: firebase.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
      } catch (err) {
        console.error('更新使用者 Email 記錄失敗 (請確認 Rules 是否已部署):', err);
      }
      
      // B. 先在背景執行舊資料自癒補齊 UID (加上標記防重複執行，避免權限與效能阻力)
      if (localStorage.getItem('self_healed_uid') !== user.uid) {
        try {
          await selfHealMissingUid(user.uid);
          localStorage.setItem('self_healed_uid', user.uid);
        } catch (healErr) {
          console.warn('[自癒機制] 執行出錯 (可能已是隔離版，忽略此警告):', healErr);
        }
      }
      
      // C. 載入並建立共享帳本關係與切換選單
      await initLedgerSharing();
      
      // 載入與初始化雲端資料
      await loadAndInitializeData();
    } else {
      console.log('帳本鎖定中，請先解鎖登入');
      loginOverlay.classList.remove('hidden');
      logoutBtn.classList.add('hidden');
      if (ledgerWrapper) ledgerWrapper.classList.add('hidden');
      showConnectionError();
      
      // 清空本地快取，保護隱私
      categoriesCache = [];
      paymentsCache = [];
      transactionsCache = [];
      autocompleteList = [];
      currentLedgerOwnerUid = null;
      currentLedgerOwnerEmail = null;
    }
  });
}

// 3. 設定預設日期
function setDefaultDates() {
  const today = new Date();
  const yyyy = today.getFullYear();
  const mm = String(today.getMonth() + 1).padStart(2, '0');
  const dd = String(today.getDate()).padStart(2, '0');
  const dateStr = `${yyyy}-${mm}-${dd}`;
  
  document.getElementById('exp-date').value = dateStr;
  document.getElementById('dg-date').value = dateStr;
  
  updateWeekDay('exp-date', 'exp-weekday');
  document.getElementById('export-month').value = `${yyyy}-${mm}`;
}

// 4. 全域事件監聽
function setupEventListeners() {
  // PWA/手機導覽列切換
  document.querySelectorAll('.nav-item').forEach(item => {
    item.addEventListener('click', (e) => {
      e.preventDefault();
      document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
      item.classList.add('active');
      const targetId = item.getAttribute('data-target');
      switchPage(targetId);
    });
  });

  // 登入解鎖表單提交
  document.getElementById('login-form').addEventListener('submit', handleLoginSubmit);
  
  // 登出鎖定按鈕
  document.getElementById('btn-logout').addEventListener('click', handleLogout);

  // 日期聯動星期
  document.getElementById('exp-date').addEventListener('change', () => {
    updateWeekDay('exp-date', 'exp-weekday');
  });

  // 初始化收支 Toggle 的切換邏輯
  setupToggleBehavior('quickadd-type-toggle', (type) => {
    updateAmountTip();
  });
  setupToggleBehavior('edit-type-toggle');

  // 記帳金額輸入提示與正負號自動修正
  const amountInput = document.getElementById('exp-amount');
  amountInput.addEventListener('input', updateAmountTip);

  // 連動分類項目決定收支類型與提示
  document.getElementById('exp-category').addEventListener('change', (e) => {
    autoSwitchToggleByCategory(e.target.value);
  });

  // 連動付款方式決定收支類型與提示
  document.getElementById('exp-payment').addEventListener('change', (e) => {
    autoSwitchToggleByPayment(e.target.value);
    updatePaymentTip();
  });

  // Autocomplete 品項提示
  const itemInput = document.getElementById('exp-item');
  itemInput.addEventListener('input', () => {
    showAutocomplete(itemInput.value);
  });
  itemInput.addEventListener('blur', () => {
    setTimeout(() => {
      document.getElementById('autocomplete-list').classList.add('hidden');
      predictCategoryAndPayment(itemInput.value);
    }, 200);
  });

  // 表單與功能事件
  document.getElementById('expense-form').addEventListener('submit', handleSaveExpense);
  document.getElementById('settings-form').addEventListener('submit', handleSaveSettings);
  document.getElementById('btn-clear-settings').addEventListener('click', handleClearSettings);

  // 月份切換
  document.getElementById('btn-prev-month').addEventListener('click', () => changeMonth(-1));
  document.getElementById('btn-next-month').addEventListener('click', () => changeMonth(1));
  document.getElementById('btn-dashboard-prev-month').addEventListener('click', () => changeMonth(-1));
  document.getElementById('btn-dashboard-next-month').addEventListener('click', () => changeMonth(1));

  // 篩選與搜尋
  document.getElementById('search-query').addEventListener('input', renderTransactionTable);
  document.getElementById('filter-category').addEventListener('change', renderTransactionTable);
  document.getElementById('filter-payment').addEventListener('change', renderTransactionTable);

  // 小灶私廚代購表單
  document.getElementById('daigou-form').addEventListener('submit', handleSaveDaigou);

  // CSV 拖曳匯入
  const dropZone = document.getElementById('drop-zone');
  const fileInput = document.getElementById('csv-file-input');
  dropZone.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    if (fileInput.files.length > 0) handleCSVImport(fileInput.files[0]);
  });
  dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZone.classList.add('dragover');
  });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
  dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('dragover');
    if (e.dataTransfer.files.length > 0) {
      handleCSVImport(e.dataTransfer.files[0]);
    }
  });

  // 匯出 CSV
  document.getElementById('btn-export-csv').addEventListener('click', handleExportCSV);
  document.getElementById('btn-export-daigou').addEventListener('click', handleExportDaigouCSV);

  // 編輯 Modal
  document.getElementById('btn-cancel-edit').addEventListener('click', () => {
    document.getElementById('edit-modal').classList.add('hidden');
  });
  document.getElementById('edit-form').addEventListener('submit', handleUpdateExpense);
  document.getElementById('edit-date').addEventListener('change', () => {
    updateWeekDay('edit-date', 'edit-weekday');
  });

  // 分類與付款新增
  document.getElementById('btn-add-category').addEventListener('click', handleAddCategory);
  document.getElementById('btn-add-payment').addEventListener('click', handleAddPayment);

  // [NEW] 帳本共享邀請
  const btnAddShare = document.getElementById('btn-add-share');
  if (btnAddShare) {
    btnAddShare.addEventListener('click', handleAddShare);
  }
}

// 5. 分頁切換
function switchPage(pageId) {
  document.querySelectorAll('.page-section').forEach(section => {
    section.classList.remove('active');
  });
  
  const targetSection = document.getElementById(pageId);
  if (targetSection) {
    targetSection.classList.add('active');
    
    // 只有在 Firebase 已連線且登入狀態下，切換頁面才載入資料 (防止未連線時報錯)
    if (firebase.apps.length > 0 && firebase.auth().currentUser) {
      if (pageId === 'page-dashboard') {
        updateDashboardData();
      } else if (pageId === 'page-transactions') {
        loadTransactions();
      } else if (pageId === 'page-daigou') {
        loadDaigouData();
      } else if (pageId === 'page-recurring') {
        loadRecurringExpenses();
      } else if (pageId === 'page-settings') {
        renderSettingsLists();
      }
    }
  }
}

// 6. 星期推導
const WEEK_DAYS = ['日', '一', '二', '三', '四', '五', '六'];
function updateWeekDay(dateInputId, weekdayInputId) {
  const dateVal = document.getElementById(dateInputId).value;
  if (dateVal) {
    const d = new Date(dateVal);
    document.getElementById(weekdayInputId).value = WEEK_DAYS[d.getDay()];
  } else {
    document.getElementById(weekdayInputId).value = '';
  }
}

// 7. 載入並初始化 Firebase 資料 (防呆自動補全)
async function loadAndInitializeData() {
  if (!db || !firebase.auth().currentUser) return;
  
  // 優先使用當前切換的帳本擁有者 UID
  const uid = currentLedgerOwnerUid || firebase.auth().currentUser.uid;
  
  try {
    // A. 載入分類 (限定當前帳本的 UID)
    let catSnap = await db.collection('categories')
      .where('uid', '==', uid)
      .get();
      
    if (catSnap.empty) {
      console.log('偵測到此帳戶無分類資料，自動初始化基礎分類資料...');
      const defaultCats = [
        { name: '食', display_order: 1 },
        { name: '衣', display_order: 2 },
        { name: '住', display_order: 3 },
        { name: '行', display_order: 4 },
        { name: '育', display_order: 5 },
        { name: '樂', display_order: 6 },
        { name: '其他', display_order: 7 },
        { name: '家用', display_order: 8 },
        { name: '育兒', display_order: 9 },
        { name: '小灶私廚代墊', display_order: 10 },
        { name: '醫療', display_order: 11 },
        { name: '保險', display_order: 12 },
        { name: '投資', display_order: 13 },
        { name: '其它', display_order: 14 },
        { name: '收入', display_order: 15 }
      ];
      
      const batch = db.batch();
      defaultCats.forEach(cat => {
        const ref = db.collection('categories').doc();
        batch.set(ref, { ...cat, uid: uid });
      });
      await batch.commit();
      
      catSnap = await db.collection('categories')
        .where('uid', '==', uid)
        .get();
    }
    
    categoriesCache = [];
    catSnap.forEach(doc => {
      categoriesCache.push({ id: doc.id, ...doc.data() });
    });
    
    categoriesCache.sort((a, b) => a.display_order - b.display_order);
    
    // B. 載入付款方式 (限定當前帳本的 UID)
    let paySnap = await db.collection('payment_methods')
      .where('uid', '==', uid)
      .get();
      
    if (paySnap.empty) {
      console.log('偵測到此帳戶無付款管道，自動初始化基礎付款管道...');
      const defaultPays = [
        { name: '現金', is_credit: false },
        { name: 'LineBank', is_credit: false },
        { name: '收入', is_credit: false },
        { name: 'J卡Point', is_credit: true },
        { name: 'J卡Cash', is_credit: true },
        { name: 'momo卡', is_credit: true },
        { name: '熊卡', is_credit: true },
        { name: 'LinePoint', is_credit: true },
        { name: 'momo紅利金', is_credit: true },
        { name: 'mo幣', is_credit: true },
        { name: '富邦聯名卡', is_credit: true },
        { name: '遠東商銀卡', is_credit: true },
        { name: '富邦好市多聯名卡', is_credit: true },
        { name: '全聯儲值金餘額', is_credit: true }
      ];
      
      const batch = db.batch();
      defaultPays.forEach(pay => {
        const ref = db.collection('payment_methods').doc();
        batch.set(ref, { ...pay, uid: uid });
      });
      await batch.commit();
      
      paySnap = await db.collection('payment_methods')
        .where('uid', '==', uid)
        .get();
    }
    
    paymentsCache = [];
    paySnap.forEach(doc => {
      paymentsCache.push({ id: doc.id, ...doc.data() });
    });
    
    // C. 一次性載入前 5000 筆歷史交易明細至快取 (繞過複合索引，在前端進行高效月份篩選)
    console.log(`[快取機制] 正在載入帳本 ${uid} 的歷史交易資料...`);
    const transSnap = await db.collection('transactions')
      .where('uid', '==', uid)
      .limit(5000)
      .get();
      
    transactionsCache = [];
    transSnap.forEach(doc => {
      transactionsCache.push({ id: doc.id, ...doc.data() });
    });
    
    // 依日期與建立時間排序 (與原本 Firestore 排序規則一致)
    transactionsCache.sort((a, b) => {
      const dateDiff = new Date(b.date) - new Date(a.date);
      if (dateDiff !== 0) return dateDiff;
      
      const tA = a.created_at ? (a.created_at.seconds ? a.created_at.seconds * 1000 : a.created_at) : 0;
      const tB = b.created_at ? (b.created_at.seconds ? b.created_at.seconds * 1000 : b.created_at) : 0;
      return tB - tA;
    });
    
    console.log(`[快取機制] 成功快取了 ${transactionsCache.length} 筆交易`);
    
    // 從快取直接生成 autocompleteList 智慧推薦提示
    autocompleteList = [];
    transactionsCache.slice(0, 500).forEach(data => {
      autocompleteList.push({
        item_name: data.item_name,
        category_name: data.category_name,
        payment_method_name: data.payment_method_name
      });
    });
    
    populateDropdowns();
    
    // 重整當前選定頁面的渲染
    const activeSection = document.querySelector('.page-section.active');
    if (activeSection) {
      switchPage(activeSection.id);
    }
    
    if (offlineQueue.length > 0) {
      showToast(`🔌 偵測到 ${offlineQueue.length} 筆本機暫存帳目，嘗試同步中...`);
      syncOfflineQueue();
    }
  } catch (err) {
    console.error('初始化與載入雲端資料失敗:', err);
    showToast('❌ 載入雲端配置失敗，請檢查權限與連線', 'error');
  }
}

function populateDropdowns() {
  const selectCat = document.getElementById('exp-category');
  const selectPay = document.getElementById('exp-payment');
  const filterCat = document.getElementById('filter-category');
  const filterPay = document.getElementById('filter-payment');
  const editCat = document.getElementById('edit-category');
  const editPay = document.getElementById('edit-payment');
  
  selectCat.innerHTML = '';
  selectPay.innerHTML = '';
  editCat.innerHTML = '';
  editPay.innerHTML = '';
  filterCat.innerHTML = '<option value="">全部分類</option>';
  filterPay.innerHTML = '<option value="">全部付款方式</option>';
  
  categoriesCache.forEach(cat => {
    const opt = `<option value="${cat.name}">${cat.name}</option>`;
    selectCat.insertAdjacentHTML('beforeend', opt);
    editCat.insertAdjacentHTML('beforeend', opt);
    filterCat.insertAdjacentHTML('beforeend', opt);
  });
  
  paymentsCache.forEach(pay => {
    const opt = `<option value="${pay.name}">${pay.name}</option>`;
    selectPay.insertAdjacentHTML('beforeend', opt);
    editPay.insertAdjacentHTML('beforeend', opt);
    filterPay.insertAdjacentHTML('beforeend', opt);
  });
  
  updatePaymentTip();
}

function updatePaymentTip() {
  const paySelect = document.getElementById('exp-payment');
  const amountTip = document.getElementById('amount-calc-tip');
  const payName = paySelect.value;
  const payment = paymentsCache.find(p => p.name === payName);
  
  if (payment) {
    if (payment.is_credit) {
      amountTip.textContent = `💳 刷卡消費將填入 [刷卡金額] 欄位`;
    } else if (payment.name === '收入') {
      amountTip.textContent = `💰 收入項目將填入 [金額] 欄位（以正數記錄）`;
    } else {
      amountTip.textContent = `💵 現金或轉帳將填入 [金額] 欄位（以負數記錄）`;
    }
  }
}

// 8. 品項 Autocomplete 提示
function showAutocomplete(val) {
  const container = document.getElementById('autocomplete-list');
  container.innerHTML = '';
  
  if (!val) {
    container.classList.add('hidden');
    return;
  }
  
  const query = val.toLowerCase();
  const matched = [];
  
  for (let entry of autocompleteList) {
    if (entry.item_name && entry.item_name.toLowerCase().includes(query)) {
      if (!matched.includes(entry.item_name)) {
        matched.push(entry.item_name);
      }
    }
    if (matched.length >= 8) break;
  }
  
  if (matched.length === 0) {
    container.classList.add('hidden');
    return;
  }
  
  matched.forEach(item => {
    const div = document.createElement('div');
    div.innerHTML = `<strong>${item.substr(0, val.length)}</strong>${item.substr(val.length)}`;
    div.addEventListener('click', () => {
      document.getElementById('exp-item').value = item;
      container.classList.add('hidden');
      predictCategoryAndPayment(item);
    });
    container.appendChild(div);
  });
  
  container.classList.remove('hidden');
}

// 9. 智慧預測
function predictCategoryAndPayment(itemName) {
  if (!itemName) return;
  
  const matches = autocompleteList.filter(entry => entry.item_name && entry.item_name.toLowerCase() === itemName.toLowerCase());
  
  if (matches.length > 0) {
    const catCounts = {};
    const payCounts = {};
    
    matches.forEach(m => {
      if (m.category_name) catCounts[m.category_name] = (catCounts[m.category_name] || 0) + 1;
      if (m.payment_method_name) payCounts[m.payment_method_name] = (payCounts[m.payment_method_name] || 0) + 1;
    });
    
    const bestCatName = Object.keys(catCounts).reduce((a, b) => catCounts[a] > catCounts[b] ? a : b, null);
    const bestPayName = Object.keys(payCounts).reduce((a, b) => payCounts[a] > payCounts[b] ? a : b, null);
    
    if (bestCatName) {
      document.getElementById('exp-category').value = bestCatName;
      autoSwitchToggleByCategory(bestCatName);
    }
    if (bestPayName) {
      document.getElementById('exp-payment').value = bestPayName;
      autoSwitchToggleByPayment(bestPayName);
      updatePaymentTip();
    }
  }
}

// 10. 登入與登出處理 (Auth UI)
async function handleLoginSubmit(e) {
  e.preventDefault();
  
  const email = document.getElementById('login-email').value.trim();
  const password = document.getElementById('login-password').value;
  
  const btn = document.getElementById('btn-login');
  const btnText = btn.querySelector('.btn-text');
  const spinner = btn.querySelector('.spinner');
  
  btn.disabled = true;
  btnText.textContent = '解鎖中...';
  spinner.classList.remove('hidden');
  
  try {
    await firebase.auth().signInWithEmailAndPassword(email, password);
    showToast('🎉 帳本已成功解鎖！');
  } catch (err) {
    console.error('登入失敗:', err);
    showToast('❌ 密碼錯誤或此帳號不存在', 'error');
  } finally {
    btn.disabled = false;
    btnText.textContent = '解鎖帳本';
    spinner.classList.add('hidden');
  }
}

async function handleLogout() {
  const confirmed = await showCustomConfirm('您確定要鎖定帳本並登出嗎？離線時將無法記帳。', '確定要登出鎖定嗎？', 'shiba_guard.png', '確認登出', '取消');
  if (!confirmed) return;
  
  try {
    await firebase.auth().signOut();
    showToast('🔒 帳本已鎖定，登出成功');
    switchPage('page-dashboard');
  } catch (err) {
    console.error('登出失敗:', err);
    showToast('❌ 登出失敗', 'error');
  }
}

// 11. 儲存記帳資料 (Firestore)
async function handleSaveExpense(e) {
  e.preventDefault();
  
  const date = document.getElementById('exp-date').value;
  const weekDay = document.getElementById('exp-weekday').value;
  const item = document.getElementById('exp-item').value.trim();
  const paymentName = document.getElementById('exp-payment').value;
  let amount = parseFloat(document.getElementById('exp-amount').value);
  const categoryName = document.getElementById('exp-category').value;
  const remark = document.getElementById('exp-remark').value.trim();
  const isFixed = document.getElementById('exp-fixed').checked;
  
  const toggle = document.getElementById('quickadd-type-toggle');
  const activeBtn = toggle ? toggle.querySelector('.type-btn.active') : null;
  const type = activeBtn ? activeBtn.getAttribute('data-type') : 'expense';
  
  if (isNaN(amount) || amount === 0) {
    showToast('❌ 金額不可為空或 0', 'error');
    return;
  }
  
  // 依 Toggle 類型轉換為正確正負號
  if (type === 'expense') {
    amount = -Math.abs(amount);
  } else {
    amount = Math.abs(amount);
  }
  
  const uid = currentLedgerOwnerUid || firebase.auth().currentUser.uid;
  const payload = {
    uid: uid,
    date,
    week_day: weekDay,
    item_name: item,
    payment_method_name: paymentName,
    amount,
    category_name: categoryName,
    remark: remark || null,
    is_fixed: isFixed,
    created_at: new Date().getTime()
  };
  
  const btn = document.getElementById('btn-save-expense');
  const btnText = btn.querySelector('.btn-text');
  const spinner = btn.querySelector('.spinner');
  
  btn.disabled = true;
  btnText.textContent = '儲存中...';
  spinner.classList.remove('hidden');
  
  if (navigator.onLine && db && firebase.auth().currentUser) {
    try {
      const toSend = { ...payload, created_at: firebase.firestore.FieldValue.serverTimestamp() };
      const docRef = await db.collection('transactions').add(toSend);
      
      // 同步插入至本地快取
      const newDoc = { id: docRef.id, ...payload };
      transactionsCache.unshift(newDoc);
      // 重新排序快取
      transactionsCache.sort((a, b) => {
        const dateDiff = new Date(b.date) - new Date(a.date);
        if (dateDiff !== 0) return dateDiff;
        const tA = a.created_at ? (a.created_at.seconds ? a.created_at.seconds * 1000 : a.created_at) : 0;
        const tB = b.created_at ? (b.created_at.seconds ? b.created_at.seconds * 1000 : b.created_at) : 0;
        return tB - tA;
      });
      
      showToast('🎉 記帳成功！');
      
      autocompleteList.unshift({
        item_name: item,
        category_name: categoryName,
        payment_method_name: paymentName
      });
      
      document.getElementById('exp-item').value = '';
      document.getElementById('exp-amount').value = '';
      document.getElementById('exp-remark').value = '';
      document.getElementById('exp-fixed').checked = false;
      document.getElementById('amount-calc-tip').className = 'amount-tip';
      document.getElementById('amount-calc-tip').textContent = '預計填入金額欄位';
      
    } catch (err) {
      console.error('Firebase 儲存失敗，轉為離線暫存:', err);
      saveToOfflineQueue(payload);
    } finally {
      btn.disabled = false;
      btnText.textContent = '儲存記帳';
      spinner.classList.add('hidden');
    }
  } else {
    saveToOfflineQueue(payload);
    btn.disabled = false;
    btnText.textContent = '儲存記帳';
    spinner.classList.add('hidden');
  }
}

function saveToOfflineQueue(payload) {
  offlineQueue.push(payload);
  localStorage.setItem('expense_offline_queue', JSON.stringify(offlineQueue));
  showToast('⚠️ 網路斷開，已將該筆帳目暫存於本機', 'error');
  
  document.getElementById('exp-item').value = '';
  document.getElementById('exp-amount').value = '';
  document.getElementById('exp-remark').value = '';
  document.getElementById('exp-fixed').checked = false;
}

// 離線同步
async function syncOfflineQueue() {
  if (offlineQueue.length === 0 || !navigator.onLine || !db || !firebase.auth().currentUser) return;
  
  console.log(`開始同步離線資料至 Firestore... 共 ${offlineQueue.length} 筆`);
  
  const toSync = [...offlineQueue];
  const batch = db.batch();
  
  toSync.forEach(data => {
    const ref = db.collection('transactions').doc();
    batch.set(ref, {
      ...data,
      created_at: firebase.firestore.FieldValue.serverTimestamp()
    });
  });
  
  try {
    await batch.commit();
    offlineQueue = [];
    localStorage.removeItem('expense_offline_queue');
    showToast(`🎉 成功同步 ${toSync.length} 筆本機暫存帳目至雲端！`);
    
    const activeSection = document.querySelector('.page-section.active');
    if (activeSection) {
      switchPage(activeSection.id);
    }
  } catch (err) {
    console.error('離線同步失敗:', err);
  }
}

// 12. 載入明細列表
async function loadTransactions() {
  document.getElementById('trans-month-label').textContent = `${currentYear}年 ${currentMonth}月`;
  // 直接進行前端渲染 (資料已在 loadAndInitializeData 中全量快取至 transactionsCache)
  renderTransactionTable();
}

function renderTransactionTable() {
  const tbody = document.getElementById('transaction-table-body');
  tbody.innerHTML = '';
  
  const searchQuery = document.getElementById('search-query').value.toLowerCase();
  const filterCatName = document.getElementById('filter-category').value;
  const filterPayName = document.getElementById('filter-payment').value;
  
  // 計算當月日期區間
  const startDate = `${currentYear}-${String(currentMonth).padStart(2, '0')}-01`;
  let nextYr = currentYear;
  let nextMth = currentMonth + 1;
  if (nextMth > 12) {
    nextMth = 1;
    nextYr++;
  }
  const endDate = `${nextYr}-${String(nextMth).padStart(2, '0')}-01`;
  
  const filtered = transactionsCache.filter(t => {
    // 1. 月份過濾
    const matchesMonth = t.date >= startDate && t.date < endDate;
    // 2. 搜尋關鍵字過濾
    const matchesSearch = 
      (t.item_name && t.item_name.toLowerCase().includes(searchQuery)) ||
      (t.remark && t.remark.toLowerCase().includes(searchQuery));
    // 3. 分類過濾
    const matchesCat = !filterCatName || t.category_name === filterCatName;
    // 4. 付款方式過濾
    const matchesPay = !filterPayName || t.payment_method_name === filterPayName;
    
    return matchesMonth && matchesSearch && matchesCat && matchesPay;
  });
  
  if (filtered.length === 0) {
    tbody.innerHTML = `<tr><td colspan="9" class="center-text">本月查無相符明細</td></tr>`;
    return;
  }
  
  filtered.forEach(t => {
    const payment = paymentsCache.find(p => p.name === t.payment_method_name);
    const isCredit = payment ? payment.is_credit : false;
    
    let displayAmount = '';
    let displayCredit = '';
    
    if (isCredit) {
      displayCredit = t.amount;
    } else {
      displayAmount = t.amount;
    }
    
    const amtClass = t.amount > 0 ? 'plus' : 'minus';
    const isFixedBadge = t.is_fixed ? `<span class="tag">固定</span>` : '';
    
    const d = new Date(t.date);
    const dateFormatted = `${d.getFullYear()}/${d.getMonth()+1}/${d.getDate()}`;
    
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${dateFormatted}</td>
      <td>${t.week_day}</td>
      <td>${t.item_name} ${isFixedBadge}</td>
      <td>${t.payment_method_name || '現金'}</td>
      <td class="num-col ${amtClass}">${displayAmount ? parseFloat(displayAmount).toLocaleString() : ''}</td>
      <td class="num-col ${amtClass}">${displayCredit ? parseFloat(displayCredit).toLocaleString() : ''}</td>
      <td>${t.category_name || '其他'}</td>
      <td>${t.remark || ''}</td>
      <td>
        <button class="btn btn-secondary btn-sm edit-btn" data-id="${t.id}">改</button>
        <button class="btn btn-danger btn-sm del-btn" data-id="${t.id}">刪</button>
      </td>
    `;
    
    tr.querySelector('.edit-btn').addEventListener('click', () => showEditModal(t));
    tr.querySelector('.del-btn').addEventListener('click', () => handleDeleteExpense(t.id));
    tbody.appendChild(tr);
  });
}

function changeMonth(delta) {
  currentMonth += delta;
  if (currentMonth > 12) {
    currentMonth = 1;
    currentYear++;
  } else if (currentMonth < 1) {
    currentMonth = 12;
    currentYear--;
  }
  
  // 同步更新兩個月份標籤
  const labelStr = `${currentYear}年 ${currentMonth}月`;
  const transLabel = document.getElementById('trans-month-label');
  const dashLabel = document.getElementById('dashboard-month-label');
  if (transLabel) transLabel.textContent = labelStr;
  if (dashLabel) dashLabel.textContent = labelStr;
  
  if (firebase.apps.length > 0 && firebase.auth().currentUser) {
    loadTransactions();
    updateDashboardData();
  }
}

// 13. 編輯與刪除 (Firestore)
function showEditModal(t) {
  document.getElementById('edit-id').value = t.id;
  document.getElementById('edit-date').value = t.date;
  document.getElementById('edit-weekday').value = t.week_day;
  document.getElementById('edit-item').value = t.item_name;
  
  // 依金額正負決定編輯的收支類型 Toggle 並帶入正值
  const editType = t.amount >= 0 ? 'income' : 'expense';
  setToggleType('edit-type-toggle', editType);
  document.getElementById('edit-amount').value = Math.abs(t.amount);
  
  document.getElementById('edit-remark').value = t.remark || '';
  document.getElementById('edit-fixed').checked = t.is_fixed;
  
  const editCat = document.getElementById('edit-category');
  const editPay = document.getElementById('edit-payment');
  
  editCat.innerHTML = '';
  editPay.innerHTML = '';
  
  categoriesCache.forEach(cat => {
    editCat.insertAdjacentHTML('beforeend', `<option value="${cat.name}">${cat.name}</option>`);
  });
  paymentsCache.forEach(pay => {
    editPay.insertAdjacentHTML('beforeend', `<option value="${pay.name}">${pay.name}</option>`);
  });
  
  editCat.value = t.category_name;
  editPay.value = t.payment_method_name;
  
  document.getElementById('edit-modal').classList.remove('hidden');
}

async function handleUpdateExpense(e) {
  e.preventDefault();
  
  const id = document.getElementById('edit-id').value;
  const date = document.getElementById('edit-date').value;
  const weekDay = document.getElementById('edit-weekday').value;
  const item = document.getElementById('edit-item').value.trim();
  const paymentName = document.getElementById('edit-payment').value;
  let amount = parseFloat(document.getElementById('edit-amount').value);
  const categoryName = document.getElementById('edit-category').value;
  const remark = document.getElementById('edit-remark').value.trim();
  const isFixed = document.getElementById('edit-fixed').checked;
  
  const toggle = document.getElementById('edit-type-toggle');
  const activeBtn = toggle ? toggle.querySelector('.type-btn.active') : null;
  const type = activeBtn ? activeBtn.getAttribute('data-type') : 'expense';
  
  if (type === 'expense') {
    amount = -Math.abs(amount);
  } else {
    amount = Math.abs(amount);
  }
  
  if (!db) return;
  
  try {
    await db.collection('transactions').doc(id).update({
      date,
      week_day: weekDay,
      item_name: item,
      payment_method_name: paymentName,
      amount,
      category_name: categoryName,
      remark: remark || null,
      is_fixed: isFixed
    });
    
    // 同步更新本地快取
    const cacheIdx = transactionsCache.findIndex(t => t.id === id);
    if (cacheIdx !== -1) {
      transactionsCache[cacheIdx] = {
        ...transactionsCache[cacheIdx],
        date,
        week_day: weekDay,
        item_name: item,
        payment_method_name: paymentName,
        amount,
        category_name: categoryName,
        remark: remark || null,
        is_fixed: isFixed
      };
      
      // 重新排序快取
      transactionsCache.sort((a, b) => {
        const dateDiff = new Date(b.date) - new Date(a.date);
        if (dateDiff !== 0) return dateDiff;
        const tA = a.created_at ? (a.created_at.seconds ? a.created_at.seconds * 1000 : a.created_at) : 0;
        const tB = b.created_at ? (b.created_at.seconds ? b.created_at.seconds * 1000 : b.created_at) : 0;
        return tB - tA;
      });
    }
    
    showToast('🎉 流水帳更新成功！');
    document.getElementById('edit-modal').classList.add('hidden');
    loadTransactions();
  } catch (err) {
    console.error('更新失敗:', err);
    showToast('❌ 更新明細失敗', 'error');
  }
}

async function handleDeleteExpense(id) {
  const confirmed = await showCustomConfirm('真的要刪除這筆消費明細嗎？柴柴會哭哭喔... (ಥ_ಥ)', '真的要刪除嗎？', 'sad_shiba.png', '確認刪除', '留著帳目');
  if (!confirmed) return;
  if (!db) return;
  
  try {
    await db.collection('transactions').doc(id).delete();
    
    // 同步移除本地快取
    transactionsCache = transactionsCache.filter(t => t.id !== id);
    
    showToast('🗑️ 明細已成功刪除');
    loadTransactions();
  } catch (err) {
    console.error('刪除失敗:', err);
    showToast('❌ 刪除明細失敗', 'error');
  }
}

// 14. 儀表板與盲點診斷 (Dashboard)
let categoryChartObj = null;
let trendChartObj = null;

async function updateDashboardData() {
  if (!db || !firebase.auth().currentUser) return;
  
  const yr = currentYear;
  const mth = currentMonth;
  
  document.getElementById('dashboard-month-label').textContent = `${yr}年 ${mth}月`;
  
  const startDate = `${yr}-${String(mth).padStart(2, '0')}-01`;
  let nextYr = yr;
  let nextMth = mth + 1;
  if (nextMth > 12) {
    nextMth = 1;
    nextYr++;
  }
  const endDate = `${nextYr}-${String(nextMth).padStart(2, '0')}-01`;
  
  try {
    const uid = currentLedgerOwnerUid || firebase.auth().currentUser.uid;
    
    const daigouSnap = await db.collection('daigou')
      .where('uid', '==', uid)
      .get();
      
    let totalIncome = 0;
    let totalExpense = 0;
    let totalCredit = 0;
    let totalDaigou = 0;
    const seenDaigouKeys = new Set();
    
    daigouSnap.forEach(doc => {
      const d = doc.data();
      // 容錯布林值判定，若欄位被錯誤寫入空字串也視為未請款
      const isClaimed = d.is_claimed === true || (d.is_claimed && (String(d.is_claimed).trim().toUpperCase() === 'Y' || String(d.is_claimed).trim() === '已請款'));
      
      if (!isClaimed) {
        const key = `${d.date}_${d.item_name}_${d.amount}`;
        if (!seenDaigouKeys.has(key)) {
          seenDaigouKeys.add(key);
          totalDaigou += parseFloat(d.amount || 0);
        }
      }
    });
    
    const categorySums = {};
    const dailySums = {};
    let cardBillPayments = [];
    
    // 從快取直接過濾出當月交易明細 (免 Composite Index 避雷設計)
    const currentMonthTransactions = transactionsCache.filter(t => t.date >= startDate && t.date < endDate);
    
    currentMonthTransactions.forEach(t => {
      const amt = parseFloat(t.amount);
      const payment = paymentsCache.find(p => p.name === t.payment_method_name);
      const isCredit = payment ? payment.is_credit : false;
      let catName = t.category_name || '其他';
      
      // 自動自我修復：只要品項包含「卡費」，且分類不是「轉帳」，自動將資料庫該筆分類改為「轉帳」
      if (t.item_name.includes('卡費') && catName !== '轉帳') {
        console.log(`[自動自我修復] 發現卡費支出文檔 ${t.id} 分類非「轉帳」，自動修正為「轉帳」`);
        db.collection('transactions').doc(t.id).update({ category_name: '轉帳' }).catch(err => console.error('自癒修復卡費分類失敗:', err));
        t.category_name = '轉帳'; // 同步修改本地快取
        catName = '轉帳'; // 前端當下直接套用，免重整
      }
      
      if (amt > 0) {
        totalIncome += amt;
      } else {
        // 統計排除「轉帳」分類：避免重複計算卡費
        if (catName !== '轉帳') {
          totalExpense += amt;
          if (isCredit) {
            totalCredit += amt;
          }
          categorySums[catName] = (categorySums[catName] || 0) + Math.abs(amt);
          const day = t.date.split('-')[2];
          dailySums[day] = (dailySums[day] || 0) + Math.abs(amt);
        }
      }
      
      if (t.item_name.includes('卡費') && amt < 0) {
        cardBillPayments.push({ ...t, category_name: catName });
      }
    });
    
    document.getElementById('stat-total-income').textContent = `$${Math.round(totalIncome).toLocaleString()}`;
    document.getElementById('stat-total-expense').textContent = `$${Math.round(Math.abs(totalExpense)).toLocaleString()}`;
    document.getElementById('stat-total-credit').textContent = `$${Math.round(Math.abs(totalCredit)).toLocaleString()}`;
    document.getElementById('stat-total-daigou').textContent = `$${Math.round(totalDaigou).toLocaleString()}`;
    
    renderDiagnostics(cardBillPayments, totalIncome, totalExpense, totalDaigou);
    renderCharts(categorySums, dailySums);
    
  } catch (err) {
    console.error('載入儀表板圖表失敗:', err);
  }
}

function renderDiagnostics(cardBills, income, expense, unpaidDaigou) {
  const list = document.getElementById('diagnostic-list');
  list.innerHTML = '';
  const absExpense = Math.abs(expense);
  const tips = [];
  
  if (cardBills.length > 0) {
    const totalBills = cardBills.reduce((sum, b) => sum + Math.abs(parseFloat(b.amount)), 0);
    tips.push({
      type: 'info',
      icon: '✅',
      text: `系統已自動為您將 ${cardBills.length} 筆卡費支出（共 $${totalBills.toLocaleString()}）歸類至「轉帳」分類，並在消費總支出統計中自動剔除，成功避免了重複支出統計！`
    });
  }
  
  if (unpaidDaigou > 0) {
    tips.push({
      type: 'info',
      icon: '💡',
      text: `目前您尚有 **$${unpaidDaigou.toLocaleString()}** 的小灶私廚代墊款項未請款，請記得按時一鍵發送請款，以維持現金流平衡。`
    });
  }
  
  const fixedExpenses = transactionsCache.filter(t => t.is_fixed && t.amount < 0);
  const totalFixed = fixedExpenses.reduce((sum, f) => sum + Math.abs(parseFloat(f.amount)), 0);
  if (totalFixed > 0 && income > 0) {
    const ratio = (totalFixed / income) * 100;
    if (ratio > 50) {
      tips.push({
        type: 'warning',
        icon: '⚠️',
        text: `您的固定開銷（如房貸、保險等）占總收入的 **${ratio.toFixed(1)}%**，偏向警示水位（建議控制在 50% 以下），請謹慎控制您的非固定性消費。`
      });
    } else {
      tips.push({
        type: 'info',
        icon: '✅',
        text: `您的固定開銷占總收入的 **${ratio.toFixed(1)}%**，處於健康的水準（50% 以下）。`
      });
    }
  }
  
  if (income > 0 && absExpense > income) {
    tips.push({
      type: 'warning',
      icon: '🚨',
      text: `本月目前處於**超支狀態**！支出已超出收入 $${(absExpense - income).toLocaleString()} 元，建議檢視「明細列表」減少非必要開支。`
    });
  }
  
  if (tips.length === 0) {
    list.innerHTML = `
      <div class="diagnostic-item info">
        <span class="diag-icon">🎉</span>
        <p class="diag-text">太棒了！本月帳目未偵測到重複記帳或不合理超支，記帳結構非常健康！</p>
      </div>
    `;
  } else {
    tips.forEach(tip => {
      const div = document.createElement('div');
      div.className = `diagnostic-item ${tip.type}`;
      div.innerHTML = `<span class="diag-icon">${tip.icon}</span><p class="diag-text">${tip.text}</p>`;
      list.appendChild(div);
    });
  }
}

function renderCharts(categorySums, dailySums) {
  const catCtx = document.getElementById('categoryChart').getContext('2d');
  const catLabels = Object.keys(categorySums);
  const catData = Object.values(categorySums);
  
  if (categoryChartObj) categoryChartObj.destroy();
  
  categoryChartObj = new Chart(catCtx, {
    type: 'doughnut',
    data: {
      labels: catLabels,
      datasets: [{
        data: catData,
        backgroundColor: [
          '#c62828', '#2e7d32', '#8d6e63', '#d84315', '#ef6c00', 
          '#2e7d32', '#9c27b0', '#009688', '#4caf50', '#795548'
        ],
        borderWidth: 1,
        borderColor: 'rgba(141, 110, 99, 0.15)'
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          position: 'right',
          labels: { color: '#6d4c41', font: { family: 'Outfit', weight: '600' } }
        }
      }
    }
  });
  
  const trendCtx = document.getElementById('trendChart').getContext('2d');
  const daysInMonth = new Date(currentYear, currentMonth, 0).getDate();
  const trendLabels = Array.from({ length: daysInMonth }, (_, i) => String(i + 1).padStart(2, '0'));
  const trendData = trendLabels.map(d => dailySums[d] || 0);
  
  let runningSum = 0;
  const accumData = trendData.map(val => {
    runningSum += val;
    return runningSum;
  });
  
  if (trendChartObj) trendChartObj.destroy();
  
  trendChartObj = new Chart(trendCtx, {
    type: 'line',
    data: {
      labels: trendLabels.map(d => parseInt(d)),
      datasets: [
        {
          label: '單日支出',
          data: trendData,
          borderColor: '#c62828',
          backgroundColor: 'rgba(198, 40, 40, 0.05)',
          fill: true,
          tension: 0.3
        },
        {
          label: '累計支出',
          data: accumData,
          borderColor: '#8d6e63',
          borderDash: [5, 5],
          tension: 0.1,
          hidden: true
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        x: { grid: { color: 'rgba(141, 110, 99, 0.1)' }, ticks: { color: '#6d4c41', font: { weight: '600' } } },
        y: { grid: { color: 'rgba(141, 110, 99, 0.1)' }, ticks: { color: '#6d4c41', font: { weight: '600' } } }
      },
      plugins: {
        legend: { labels: { color: '#6d4c41', font: { weight: '600' } } }
      }
    }
  });
}

// 15. 小灶私廚代購管理 (Firestore)
async function loadDaigouData() {
  if (!db || !firebase.auth().currentUser) return;
  
  try {
    const uid = currentLedgerOwnerUid || firebase.auth().currentUser.uid;
    const snap = await db.collection('daigou')
      .where('uid', '==', uid)
      .get();
    
    const unpaidBody = document.getElementById('daigou-unpaid-body');
    const paidBody = document.getElementById('daigou-paid-body');
    
    unpaidBody.innerHTML = '';
    paidBody.innerHTML = '';
    
    let unpaidSum = 0;
    let unpaidCount = 0;
    let paidCount = 0;
    
    const daigouList = [];
    const seenKeys = new Set();
    const dupIdsToDelete = [];
    
    snap.forEach(doc => {
      const d = doc.data();
      
      // 容錯布林值判定與修復
      const rawClaimed = d.is_claimed;
      const isClaimed = rawClaimed === true || (rawClaimed && (String(rawClaimed).trim().toUpperCase() === 'Y' || String(rawClaimed).trim() === '已請款'));
      
      // 自我修復：如果發現不是標準的布林值，在背景更新為正確布林值，確保儀表板能被 where 查詢正確讀到
      if (typeof rawClaimed !== 'boolean') {
        console.log(`[自動自我修復] 發現代購文檔 ${doc.id} 的請款欄位非布林值，自動修復為 ${isClaimed}`);
        db.collection('daigou').doc(doc.id).update({ is_claimed: isClaimed }).catch(err => console.error('自癒修復請款欄位失敗:', err));
      }
      
      const key = `${d.date}_${d.item_name}_${d.amount}_${isClaimed}`;
      if (seenKeys.has(key)) {
        dupIdsToDelete.push(doc.id);
      } else {
        seenKeys.add(key);
        daigouList.push({ id: doc.id, ...d, is_claimed: isClaimed }); // 傳遞布林化後的狀態
      }
    });
    
    // 背景靜默刪除重複文檔，自動自我修復資料庫
    if (dupIdsToDelete.length > 0) {
      console.log(`[自動自我修復] 偵測到 ${dupIdsToDelete.length} 筆重複的代購項目，已在背景進行去重清理。`);
      dupIdsToDelete.forEach(id => {
        db.collection('daigou').doc(id).delete().catch(err => console.error('自動刪除重複代購失敗:', err));
      });
    }
    
    daigouList.sort((a, b) => new Date(b.date) - new Date(a.date));
    
    daigouList.forEach(d => {
      const amt = parseFloat(d.amount);
      const dt = new Date(d.date);
      const dateFormatted = `${dt.getFullYear()}/${dt.getMonth()+1}/${dt.getDate()}`;
      
      const tr = document.createElement('tr');
      
      if (!d.is_claimed) {
        unpaidSum += amt;
        unpaidCount++;
        tr.innerHTML = `
          <td>${dateFormatted}</td>
          <td>${d.item_name}</td>
          <td class="num-col minus">$${amt.toLocaleString()}</td>
          <td>
            <button class="btn btn-secondary btn-sm claim-btn" data-id="${d.id}">一鍵請款</button>
          </td>
        `;
        tr.querySelector('.claim-btn').addEventListener('click', () => handleClaimDaigou(d.id));
        unpaidBody.appendChild(tr);
      } else {
        paidCount++;
        tr.innerHTML = `
          <td>${dateFormatted}</td>
          <td>${d.item_name}</td>
          <td class="num-col plus">$${amt.toLocaleString()}</td>
          <td><span class="tag" style="background-color: rgba(0, 230, 118, 0.15); color: var(--color-income)">已請款</span></td>
        `;
        paidBody.appendChild(tr);
      }
    });
    
    document.getElementById('unpaid-daigou-total').textContent = `未請款總計: $${unpaidSum.toLocaleString()}`;
    
    if (unpaidCount === 0) {
      unpaidBody.innerHTML = `<tr><td colspan="4" class="center-text">無未請款明細</td></tr>`;
    }
    if (paidCount === 0) {
      paidBody.innerHTML = `<tr><td colspan="4" class="center-text">無已請款明細</td></tr>`;
    }
  } catch (err) {
    console.error('載入代購清單失敗:', err);
    showToast('❌ 載入代購資料失敗', 'error');
  }
}

async function handleSaveDaigou(e) {
  e.preventDefault();
  
  const date = document.getElementById('dg-date').value;
  const item = document.getElementById('dg-item').value.trim();
  const amount = parseFloat(document.getElementById('dg-amount').value);
  
  if (isNaN(amount) || amount <= 0) {
    showToast('❌ 金額必須大於 0', 'error');
    return;
  }
  
  if (!db) return;
  
  try {
    const uid = currentLedgerOwnerUid || firebase.auth().currentUser.uid;
    await db.collection('daigou').add({
      uid: uid,
      date,
      item_name: item,
      amount,
      is_claimed: false
    });
    
    showToast('🎉 代購項目新增成功！');
    document.getElementById('dg-item').value = '';
    document.getElementById('dg-amount').value = '';
    loadDaigouData();
  } catch (err) {
    console.error('新增代購失敗:', err);
    showToast('❌ 新增代購失敗', 'error');
  }
}

async function handleClaimDaigou(id) {
  if (!db) return;
  
  try {
    await db.collection('daigou').doc(id).update({ is_claimed: true });
    showToast('🎉 已標記為已請款！');
    loadDaigouData();
  } catch (err) {
    console.error('請款更新失敗:', err);
    showToast('❌ 請款標記失敗', 'error');
  }
}

// 16. CSV 匯入清洗 (寫入 Firestore)
async function handleCSVImport(file) {
  const csvType = document.getElementById('csv-type').value;
  const progressWrapper = document.getElementById('import-progress');
  const progressFill = document.getElementById('progress-bar-fill');
  const progressText = document.getElementById('progress-status-text');
  
  progressWrapper.classList.remove('hidden');
  progressFill.style.width = '0%';
  progressText.textContent = '開始讀取檔案...';
  
  const reader = new FileReader();
  reader.onload = function(e) {
    const csvContent = e.target.result;
    
    Papa.parse(csvContent, {
      header: true,
      skipEmptyLines: 'greedy',
      complete: async function(results) {
        const rows = results.data;
        if (rows.length === 0) {
          showToast('❌ 檔案無內容', 'error');
          progressWrapper.classList.add('hidden');
          return;
        }
        
        try {
          if (csvType === 'expense') {
            await importExpenseRows(rows, progressFill, progressText);
          } else {
            await importDaigouRows(rows, progressFill, progressText);
          }
        } catch (err) {
          console.error('匯入中斷:', err);
          showToast(`❌ 匯入失敗: ${err.message}`, 'error');
          progressWrapper.classList.add('hidden');
        }
      },
      error: function(err) {
        showToast(`❌ 解析 CSV 失敗: ${err.message}`, 'error');
        progressWrapper.classList.add('hidden');
      }
    });
  };
  reader.readAsText(file, 'UTF-8');
}

async function importExpenseRows(rows, progressBar, progressText) {
  if (!db) throw new Error('Firestore 未連線');
  await loadAndInitializeData();
  
  const total = rows.length;
  let successCount = 0;
  progressText.textContent = '清洗資料並準備寫入...';
  
  const transactionsToInsert = [];
  
  for (let i = 0; i < total; i++) {
    const row = rows[i];
    if (!row['日期'] || (!row['品項'] && !row['分類項目'])) continue;
    
    let rawDate = row['日期'].replace(/\./g, '/').replace(/-/g, '/').trim();
    const dateParts = rawDate.split('/');
    if (dateParts.length !== 3) {
      throw new Error(`第 ${i+2} 行日期格式錯誤: ${row['日期']}`);
    }
    const yyyy = dateParts[0];
    const mm = dateParts[1].padStart(2, '0');
    const dd = dateParts[2].padStart(2, '0');
    const dateStr = `${yyyy}-${mm}-${dd}`;
    const weekDay = WEEK_DAYS[new Date(dateStr).getDay()];
    
    const itemName = row['品項'] ? row['品項'].trim() : '(空)';
    const remark = row['備註'] ? row['備註'].trim() : null;
    
    let catName = row['分類項目'] ? row['分類項目'].trim() : '其他';
    if (catName === '其他' || catName === '其它') catName = '其他';
    
    // 智慧自動處理：如果品項包含「卡費」，分類自動修正為「轉帳」
    if (itemName.includes('卡費')) {
      catName = '轉帳';
    }
    
    const uid = currentLedgerOwnerUid || firebase.auth().currentUser.uid;
    let category = categoriesCache.find(c => c.name === catName);
    if (!category) {
      const ref = await db.collection('categories').add({ uid: uid, name: catName, display_order: categoriesCache.length + 1 });
      category = { id: ref.id, name: catName };
      categoriesCache.push(category);
    }
    
    let payName = row['付款方式'] ? row['付款方式'].trim() : '現金';
    let payment = paymentsCache.find(p => p.name === payName);
    if (!payment) {
      const isCredit = payName !== '現金' && payName !== '收入' && payName !== 'LineBank';
      const ref = await db.collection('payment_methods').add({ uid: uid, name: payName, is_credit: isCredit });
      payment = { id: ref.id, name: payName, is_credit: isCredit };
      paymentsCache.push(payment);
    }
    
    let amountVal = 0;
    const rawAmt = row['金額'] ? row['金額'].replace(/[\$,]/g, '').trim() : '';
    const rawCredit = row['刷卡金額'] ? row['刷卡金額'].replace(/[\$,]/g, '').trim() : '';
    
    if (rawCredit !== '' && !isNaN(parseFloat(rawCredit))) {
      amountVal = parseFloat(rawCredit);
    } else if (rawAmt !== '' && !isNaN(parseFloat(rawAmt))) {
      amountVal = parseFloat(rawAmt);
    }
    
    const isIncomeType = payName === '收入' || catName === '收入';
    if (!isIncomeType && amountVal > 0) {
      amountVal = -amountVal;
    }
    
    const isFixed = row['固定開銷'] && row['固定開銷'].includes('固定');
    
    transactionsToInsert.push({
      uid: uid,
      date: dateStr,
      week_day: weekDay,
      item_name: itemName,
      payment_method_name: payName,
      amount: amountVal,
      category_name: catName,
      remark: remark,
      is_fixed: isFixed ? true : false
    });
  }
  
  const batchSize = 100;
  for (let idx = 0; idx < transactionsToInsert.length; idx += batchSize) {
    const batch = db.batch();
    const subList = transactionsToInsert.slice(idx, idx + batchSize);
    
    subList.forEach(item => {
      const ref = db.collection('transactions').doc();
      batch.set(ref, {
        ...item,
        created_at: firebase.firestore.FieldValue.serverTimestamp()
      });
    });
    
    await batch.commit();
    successCount += subList.length;
    const percent = Math.round((successCount / transactionsToInsert.length) * 100);
    progressBar.style.width = `${percent}%`;
    progressText.textContent = `已匯入 ${successCount} / ${transactionsToInsert.length} 筆...`;
  }
  
  showToast(`🎉 成功匯入 ${successCount} 筆消費明細！`);
  setTimeout(() => {
    document.getElementById('import-progress').classList.add('hidden');
    loadAndInitializeData();
  }, 1000);
}

async function importDaigouRows(rows, progressBar, progressText) {
  if (!db) throw new Error('Firestore 未連線');
  
  const uid = currentLedgerOwnerUid || firebase.auth().currentUser.uid;
  
  // 先抓取目前所有 daigou 的數據，防止重複匯入 (加上 uid 以符合安全規則)
  const existingSnap = await db.collection('daigou').where('uid', '==', uid).get();
  const existingKeys = new Set();
  existingSnap.forEach(doc => {
    const d = doc.data();
    const key = `${d.date}_${d.item_name}_${d.amount}_${d.is_claimed}`;
    existingKeys.add(key);
  });

  const total = rows.length;
  let successCount = 0;
  const daigousToInsert = [];
  
  for (let i = 0; i < total; i++) {
    const row = rows[i];
    if (!row['日期'] || !row['項目'] || !row['金額']) continue;
    
    let rawDate = row['日期'].replace(/\./g, '/').replace(/-/g, '/').trim();
    const dateParts = rawDate.split('/');
    if (dateParts.length !== 3) continue;
    const dateStr = `${dateParts[0]}-${dateParts[1].padStart(2, '0')}-${dateParts[2].padStart(2, '0')}`;
    const amount = parseFloat(row['金額'].replace(/[\$,]/g, '').trim());
    // 強制轉為標準布林值，防止為空時被寫入空字串 "" 破壞資料庫
    const isClaimed = !!(row['已請款'] && (row['已請款'].trim().toUpperCase() === 'Y' || row['已請款'].trim() === '已請款'));
    
    const key = `${dateStr}_${row['項目'].trim()}_${amount}_${isClaimed}`;
    if (existingKeys.has(key)) {
      continue; // 重複了，跳過！
    }
    
    daigousToInsert.push({
      uid: uid,
      date: dateStr,
      item_name: row['項目'].trim(),
      amount,
      is_claimed: isClaimed
    });
    existingKeys.add(key); // 防止單一 CSV 檔內含有重複行
  }
  
  if (daigousToInsert.length > 0) {
    const batch = db.batch();
    daigousToInsert.forEach(item => {
      const ref = db.collection('daigou').doc();
      batch.set(ref, item);
    });
    await batch.commit();
    successCount = daigousToInsert.length;
  }
  
  progressBar.style.width = '100%';
  progressText.textContent = `成功匯入 ${successCount} 筆代購項目！`;
  showToast(`🎉 成功匯入 ${successCount} 筆代購項目！`);
  setTimeout(() => {
    document.getElementById('import-progress').classList.add('hidden');
    loadDaigouData();
  }, 1000);
}

// 17. CSV 舊格式一鍵匯出
async function handleExportCSV() {
  if (!db) {
    showToast('❌ 資料庫未連線', 'error');
    return;
  }
  
  const exportMonthVal = document.getElementById('export-month').value;
  if (!exportMonthVal) {
    showToast('❌ 請選擇匯出月份', 'error');
    return;
  }
  
  const [yr, mth] = exportMonthVal.split('-');
  const startDate = `${yr}-${mth}-01`;
  let nextYr = parseInt(yr);
  let nextMth = parseInt(mth) + 1;
  if (nextMth > 12) {
    nextMth = 1;
    nextYr++;
  }
  const endDate = `${nextYr}-${String(nextMth).padStart(2, '0')}-01`;
  
  try {
    const uid = currentLedgerOwnerUid || firebase.auth().currentUser.uid;
    const snap = await db.collection('transactions')
      .where('uid', '==', uid)
      .where('date', '>=', startDate)
      .where('date', '<', endDate)
      .get();
      
    const trans = [];
    snap.forEach(doc => {
      trans.push(doc.data());
    });
    
    if (trans.length === 0) {
      showToast('❌ 該月份無任何消費明細', 'error');
      return;
    }
    
    trans.sort((a, b) => new Date(a.date) - new Date(b.date) || a.created_at - b.created_at);
    
    const headers = ['日期', '星期', '品項', '付款方式', '金額', '刷卡金額', '分類項目', '備註', '固定開銷'];
    const csvRows = [headers.join(',')];
    
    trans.forEach(t => {
      const d = new Date(t.date);
      const dateStr = `${d.getFullYear()}/${d.getMonth()+1}/${d.getDate()}`;
      const payment = paymentsCache.find(p => p.name === t.payment_method_name);
      const isCredit = payment ? payment.is_credit : false;
      
      let amountStr = '';
      let creditStr = '';
      
      if (isCredit) {
        creditStr = String(t.amount);
      } else {
        amountStr = String(t.amount);
      }
      
      const fixedStr = t.is_fixed ? '固定' : '';
      const cleanItem = `"${t.item_name.replace(/"/g, '""')}"`;
      const cleanRemark = t.remark ? `"${t.remark.replace(/"/g, '""')}"` : '';
      
      const row = [dateStr, t.week_day, cleanItem, t.payment_method_name, amountStr, creditStr, t.category_name, cleanRemark, fixedStr];
      csvRows.push(row.join(','));
    });
    
    downloadCSVFile(csvRows.join('\n'), `115年消費 - ${parseInt(mth)}月_匯出備份.csv`);
    showToast('🎉 消費明細 CSV 匯出成功！');
  } catch (err) {
    console.error('匯出失敗:', err);
    showToast('❌ 匯出失敗', 'error');
  }
}

async function handleExportDaigouCSV() {
  if (!db) return;
  
  try {
    const uid = currentLedgerOwnerUid || firebase.auth().currentUser.uid;
    const snap = await db.collection('daigou')
      .where('uid', '==', uid)
      .get();
    const daigous = [];
    snap.forEach(doc => daigous.push(doc.data()));
    
    if (daigous.length === 0) {
      showToast('❌ 無任何代購資料', 'error');
      return;
    }
    
    daigous.sort((a, b) => new Date(a.date) - new Date(b.date));
    const headers = ['日期', '項目', '金額', '已請款'];
    const csvRows = [headers.join(',')];
    
    daigous.forEach(d => {
      const dt = new Date(d.date);
      const dateStr = `${dt.getFullYear()}/${dt.getMonth()+1}/${dt.getDate()}`;
      const cleanItem = `"${d.item_name.replace(/"/g, '""')}"`;
      const claimedStr = d.is_claimed ? 'Y' : '';
      
      const row = [dateStr, cleanItem, String(d.amount), claimedStr];
      csvRows.push(row.join(','));
    });
    
    downloadCSVFile(csvRows.join('\n'), '115年消費 - 小灶私廚代購_匯出備份.csv');
    showToast('🎉 代購 CSV 匯出成功！');
  } catch (err) {
    console.error('匯出代購失敗:', err);
    showToast('❌ 匯出代購失敗', 'error');
  }
}

function downloadCSVFile(csvString, filename) {
  const blob = new Blob([new Uint8Array([0xEF, 0xBB, 0xBF]), csvString], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.setAttribute('href', url);
  link.setAttribute('download', filename);
  link.style.visibility = 'hidden';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

// 18. 系統設定 (Firebase)
function handleSaveSettings(e) {
  e.preventDefault();
  
  const configText = document.getElementById('set-config').value.trim();
  
  try {
    // 智慧清洗與解析：支援 const firebaseConfig = { ... }; 或帶有單雙引號、無引號的 JavaScript 物件字串
    let cleaned = configText
      .replace(/^(const|let|var)\s+\w+\s*=\s*/, '') // 去除 const config = 等宣告
      .trim()
      .replace(/;$/, ''); // 去除結尾分號
      
    // 使用 New Function 做物件安全轉換，免除 Strict JSON 雙引號限制
    const parsed = new Function('return ' + cleaned)();
    
    if (!parsed || !parsed.apiKey || !parsed.projectId) {
      throw new Error('金鑰內容必須包含 apiKey 與 projectId 屬性');
    }
    
    localStorage.setItem('firebase_config', JSON.stringify(parsed));
    showToast('🎉 設定儲存成功！正在重新啟動連線...');
    
    if (firebase.apps.length > 0) {
      firebase.app().delete().then(() => {
        initFirebaseConnection();
      });
    } else {
      initFirebaseConnection();
    }
  } catch (err) {
    showToast(`❌ 格式解析錯誤: ${err.message}。請直接複製 Firebase 網頁展示的 Config 大括號內容。`, 'error');
  }
}

async function handleClearSettings() {
  const confirmed = await showCustomConfirm('您確定要清除連線設定嗎？資料庫中的資料不會遺失，但此瀏覽器將無法同步。', '清除連線設定？', 'shiba_guard.png', '確認清除', '取消');
  if (!confirmed) return;
  
  localStorage.removeItem('firebase_config');
  document.getElementById('set-config').value = '';
  showConnectionError();
  showToast('🔌 已清除設定');
}

async function renderSettingsLists() {
  const catList = document.getElementById('settings-category-list');
  const payList = document.getElementById('settings-payment-list');
  
  catList.innerHTML = '';
  payList.innerHTML = '';
  
  categoriesCache.forEach(cat => {
    catList.insertAdjacentHTML('beforeend', `<li><span>${cat.name}</span></li>`);
  });
  
  paymentsCache.forEach(pay => {
    const badge = pay.is_credit ? '<span class="tag" style="background-color: rgba(255,145,0,0.15); color: var(--color-credit)">刷卡</span>' : '<span class="tag">現金/轉帳</span>';
    payList.insertAdjacentHTML('beforeend', `<li><span>${pay.name}</span> ${badge}</li>`);
  });
  
  renderRecurringSettings();
}

async function handleAddCategory() {
  const input = document.getElementById('new-category-name');
  const name = input.value.trim();
  if (!name || !db) return;
  
  try {
    const uid = currentLedgerOwnerUid || firebase.auth().currentUser.uid;
    await db.collection('categories').add({ uid: uid, name, display_order: categoriesCache.length + 1 });
    showToast('🎉 分類新增成功！');
    input.value = '';
    loadAndInitializeData();
  } catch (err) {
    showToast('❌ 分類新增失敗', 'error');
  }
}

async function handleAddPayment() {
  const input = document.getElementById('new-payment-name');
  const isCredit = document.getElementById('new-payment-credit').checked;
  const name = input.value.trim();
  if (!name || !db) return;
  
  try {
    const uid = currentLedgerOwnerUid || firebase.auth().currentUser.uid;
    await db.collection('payment_methods').add({ uid: uid, name, is_credit: isCredit });
    showToast('🎉 付款管道新增成功！');
    input.value = '';
    document.getElementById('new-payment-credit').checked = false;
    loadAndInitializeData();
  } catch (err) {
    showToast('❌ 付款管道新增失敗', 'error');
  }
}

// 19. Toast 提示
let toastTimeout = null;
function showToast(message, type = 'success') {
  const toastId = type === 'error' ? 'error-toast' : 'network-toast';
  const toast = document.getElementById(toastId);
  const otherToast = document.getElementById(type === 'error' ? 'network-toast' : 'error-toast');
  otherToast.classList.add('hidden');
  
  toast.textContent = message;
  toast.classList.remove('hidden');
  
  if (toastTimeout) clearTimeout(toastTimeout);
  
  toastTimeout = setTimeout(() => {
    toast.classList.add('hidden');
  }, 4000);
}

// ==========================================================================
// 20. 收支類型 Toggle 與智慧判定輔助函數
// ==========================================================================
function setupToggleBehavior(toggleId, callback) {
  const toggle = document.getElementById(toggleId);
  if (!toggle) return;
  const btns = toggle.querySelectorAll('.type-btn');
  btns.forEach(btn => {
    btn.addEventListener('click', () => {
      btns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      if (callback) callback(btn.getAttribute('data-type'));
    });
  });
}

function setToggleType(toggleId, type) {
  const toggle = document.getElementById(toggleId);
  if (!toggle) return;
  const btns = toggle.querySelectorAll('.type-btn');
  btns.forEach(btn => {
    if (btn.getAttribute('data-type') === type) {
      btn.classList.add('active');
    } else {
      btn.classList.remove('active');
    }
  });
}

function updateAmountTip() {
  const amountInput = document.getElementById('exp-amount');
  const amountTip = document.getElementById('amount-calc-tip');
  const toggle = document.getElementById('quickadd-type-toggle');
  const activeBtn = toggle ? toggle.querySelector('.type-btn.active') : null;
  const type = activeBtn ? activeBtn.getAttribute('data-type') : 'expense';
  
  const val = parseFloat(amountInput.value);
  if (isNaN(val)) {
    amountTip.textContent = '請輸入金額';
    amountTip.className = 'amount-tip';
    return;
  }
  
  if (val === 0) {
    amountTip.textContent = '金額不能為 0';
    amountTip.className = 'amount-tip';
    return;
  }
  
  const absVal = Math.abs(val);
  if (type === 'expense') {
    amountTip.textContent = `💰 實際存入金額：-$${absVal.toLocaleString()} (支出)`;
    amountTip.className = 'amount-tip minus';
  } else {
    amountTip.textContent = `💰 實際存入金額：+$${absVal.toLocaleString()} (收入)`;
    amountTip.className = 'amount-tip plus';
  }
}

function autoSwitchToggleByCategory(catName) {
  const incomeCats = ['收入', '薪資', '獎金', '投資', '退款', '退稅', '利息', '發票中獎'];
  const isIncome = incomeCats.some(keyword => catName.includes(keyword));
  setToggleType('quickadd-type-toggle', isIncome ? 'income' : 'expense');
  updateAmountTip();
}

function autoSwitchToggleByPayment(payName) {
  if (payName === '收入') {
    setToggleType('quickadd-type-toggle', 'income');
    updateAmountTip();
  }
}

// ==========================================================================
// 21. 規費手帳核心邏輯 (自訂關鍵字、過濾統計、Accordion 展開與走勢圖) [NEW]
// ==========================================================================
const DEFAULT_RECURRING_CONFIG = {
  management: ['管理費', '日昇管理費'],
  water: ['水費', '日昇水費', '自來水'],
  electricity: ['電費', '電力', '台灣電力', '電工'],
  taxes: ['稅', '所得稅', '房屋稅', '地價稅', '牌照稅', '燃料稅', '退稅'],
  others: ['瓦斯', '天然氣', '皇家天然氣', '寬頻', '第四台', '網路', '管理費(其它)', '規費', '規費(其它)']
};

function getRecurringConfig() {
  const config = localStorage.getItem('recurring_config');
  if (config) {
    try {
      return JSON.parse(config);
    } catch (e) {
      console.error('解析規費設定失敗，使用預設配置:', e);
    }
  }
  localStorage.setItem('recurring_config', JSON.stringify(DEFAULT_RECURRING_CONFIG));
  return DEFAULT_RECURRING_CONFIG;
}

function saveRecurringConfig(config) {
  localStorage.setItem('recurring_config', JSON.stringify(config));
}

function renderRecurringSettings() {
  const container = document.getElementById('recurring-settings-container');
  if (!container) return;
  
  const config = getRecurringConfig();
  const categoriesMap = {
    management: { title: '🏠 管理費', key: 'management' },
    water: { title: '💧 水費', key: 'water' },
    electricity: { title: '⚡ 電費', key: 'electricity' },
    taxes: { title: '💸 稅費', key: 'taxes' },
    others: { title: '📶 其它規費', key: 'others' }
  };
  
  let html = '';
  
  for (const [key, catInfo] of Object.entries(categoriesMap)) {
    const keywords = config[key] || [];
    const tagsHtml = keywords.map(kw => `
      <span class="keyword-tag">
        <span>${kw}</span>
        <span class="keyword-tag-delete" onclick="handleDeleteKeyword('${key}', '${kw}')">×</span>
      </span>
    `).join('');
    
    html += `
      <div class="keyword-category-box">
        <div class="keyword-category-title">${catInfo.title}</div>
        <div class="keyword-tags-wrapper">
          ${tagsHtml || '<span style="font-size:0.8rem; color:var(--text-muted);">尚未設定關鍵字</span>'}
        </div>
        <div class="keyword-input-row">
          <input type="text" id="new-kw-${key}" placeholder="新增判定關鍵字" class="form-control">
          <button class="btn btn-secondary btn-sm" onclick="handleAddKeyword('${key}')">新增</button>
        </div>
      </div>
    `;
  }
  
  container.innerHTML = html;
}

window.handleDeleteKeyword = function(categoryKey, keyword) {
  const config = getRecurringConfig();
  if (config[categoryKey]) {
    config[categoryKey] = config[categoryKey].filter(k => k !== keyword);
    saveRecurringConfig(config);
    renderRecurringSettings();
    showToast(`🗑️ 已刪除判定字詞：${keyword}`);
  }
};

window.handleAddKeyword = function(categoryKey) {
  const input = document.getElementById(`new-kw-${categoryKey}`);
  if (!input) return;
  const val = input.value.trim();
  if (!val) return;
  
  const config = getRecurringConfig();
  if (!config[categoryKey]) config[categoryKey] = [];
  
  if (config[categoryKey].includes(val)) {
    showToast('⚠️ 關鍵字已存在', 'error');
    return;
  }
  
  config[categoryKey].push(val);
  saveRecurringConfig(config);
  renderRecurringSettings();
  input.value = '';
  showToast(`🎉 已新增判定字詞：${val}`);
};

window.toggleAccordion = function(header) {
  const item = header.parentElement;
  const isActive = item.classList.contains('active');
  
  // 關閉所有其它的 accordion
  document.querySelectorAll('.accordion-item').forEach(i => {
    i.classList.remove('active');
  });
  
  // 切換當前
  if (!isActive) {
    item.classList.add('active');
  }
};

let recurringChartObj = null;

async function loadRecurringExpenses() {
  if (!db || !firebase.auth().currentUser) return;
  
  const accordionLists = {
    management: document.getElementById('recurring-list-management'),
    water: document.getElementById('recurring-list-water'),
    electricity: document.getElementById('recurring-list-electricity'),
    taxes: document.getElementById('recurring-list-taxes'),
    others: document.getElementById('recurring-list-others')
  };
  
  for (const list of Object.values(accordionLists)) {
    if (list) list.innerHTML = `<tr><td colspan="4" class="center-text">載入中...</td></tr>`;
  }
  
  try {
    // 直接複製全域的交易快取進行過濾計算，免去資料庫查詢
    const allTransactions = [...transactionsCache];
    allTransactions.sort((a, b) => new Date(b.date) - new Date(a.date));
    
    const config = getRecurringConfig();
    
    let allTimeSum = 0;
    let currentMonthSum = 0;
    
    const currentYrStr = String(currentYear);
    const currentMthStr = String(currentMonth).padStart(2, '0');
    const currentYrMth = `${currentYrStr}-${currentMthStr}`;
    
    const categorizedItems = {
      management: [],
      water: [],
      electricity: [],
      taxes: [],
      others: []
    };
    
    const categorizedSums = {
      management: 0,
      water: 0,
      electricity: 0,
      taxes: 0,
      others: 0
    };
    
    const monthlySums = {};
    const activeMonths = new Set();
    
    allTransactions.forEach(t => {
      const amt = parseFloat(t.amount);
      if (isNaN(amt) || amt >= 0) return;
      
      const itemName = t.item_name || '';
      const categoryName = t.category_name || '';
      const remark = t.remark || '';
      
      let matchedCategory = null;
      
      for (const [catKey, keywords] of Object.entries(config)) {
        const matches = keywords.some(kw => itemName.includes(kw) || remark.includes(kw) || categoryName.includes(kw));
        if (matches) {
          matchedCategory = catKey;
          break;
        }
      }
      
      if (matchedCategory) {
        const absAmt = Math.abs(amt);
        allTimeSum += absAmt;
        categorizedSums[matchedCategory] += absAmt;
        categorizedItems[matchedCategory].push(t);
        
        const yrMth = t.date.substring(0, 7);
        activeMonths.add(yrMth);
        monthlySums[yrMth] = (monthlySums[yrMth] || 0) + absAmt;
        
        if (t.date.startsWith(currentYrMth)) {
          currentMonthSum += absAmt;
        }
      }
    });
    
    document.getElementById('recurring-total-alltime').textContent = `$${Math.round(allTimeSum).toLocaleString()}`;
    document.getElementById('recurring-total-month').textContent = `$${Math.round(currentMonthSum).toLocaleString()}`;
    
    const monthCount = activeMonths.size > 0 ? activeMonths.size : 1;
    const avgMonthly = allTimeSum / monthCount;
    document.getElementById('recurring-total-average').textContent = `$${Math.round(avgMonthly).toLocaleString()}`;
    
    const badgeIds = {
      management: 'recurring-sum-management',
      water: 'recurring-sum-water',
      electricity: 'recurring-sum-electricity',
      taxes: 'recurring-sum-taxes',
      others: 'recurring-sum-others'
    };
    
    for (const [key, items] of Object.entries(categorizedItems)) {
      const badge = document.getElementById(badgeIds[key]);
      if (badge) {
        badge.textContent = `$${Math.round(categorizedSums[key]).toLocaleString()}`;
      }
      
      const listEl = accordionLists[key];
      if (!listEl) continue;
      
      listEl.innerHTML = '';
      if (items.length === 0) {
        listEl.innerHTML = `<tr><td colspan="4" class="center-text">無繳費紀錄</td></tr>`;
        continue;
      }
      
      items.forEach(t => {
        const tr = document.createElement('tr');
        const d = new Date(t.date);
        const dateFormatted = `${d.getFullYear()}/${d.getMonth()+1}/${d.getDate()}`;
        tr.innerHTML = `
          <td>${dateFormatted}</td>
          <td>${t.item_name}</td>
          <td class="num-col minus">$${Math.round(Math.abs(t.amount)).toLocaleString()}</td>
          <td style="white-space: normal; max-width: 150px;">${t.remark || ''}</td>
        `;
        listEl.appendChild(tr);
      });
    }
    
    renderRecurringChart(monthlySums);
    
  } catch (err) {
    console.error('下載規費數據失敗:', err);
    showToast('❌ 載入規費手帳失敗', 'error');
  }
}

function renderRecurringChart(monthlySums) {
  const ctx = document.getElementById('recurringChart').getContext('2d');
  
  const months = Object.keys(monthlySums).sort();
  
  let labels = [];
  let data = [];
  
  if (months.length === 0) {
    const today = new Date();
    for (let i = 2; i >= 0; i--) {
      const d = new Date(today.getFullYear(), today.getMonth() - i, 1);
      const mLabel = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      labels.push(mLabel);
      data.push(0);
    }
  } else {
    labels = months.map(m => {
      const [yr, mth] = m.split('-');
      return `${parseInt(mth)}月`;
    });
    data = months.map(m => Math.round(monthlySums[m]));
  }
  
  if (recurringChartObj) recurringChartObj.destroy();
  
  recurringChartObj = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: labels,
      datasets: [{
        label: '規費支出 ($)',
        data: data,
        backgroundColor: 'rgba(141, 110, 99, 0.65)',
        borderColor: '#7d5a3c',
        borderWidth: 2,
        borderRadius: 8,
        borderSkipped: false
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        x: {
          grid: { display: false },
          ticks: { color: '#6d4c41', font: { family: 'Fredoka', weight: '700' } }
        },
        y: {
          grid: { color: 'rgba(141, 110, 99, 0.1)' },
          ticks: { color: '#6d4c41', font: { family: 'Outfit', weight: '600' } }
        }
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: function(context) {
              return ` 規費加總: $${context.parsed.y.toLocaleString()}`;
            }
          }
        }
      }
    }
  });
}

// ==========================================================================
// 22. 自訂可愛確認對話框 (Custom Confirm Dialog) [NEW]
// ==========================================================================
function showCustomConfirm(message, title = '真的要刪除嗎？', imgSrc = 'sad_shiba.png', yesText = '確認', noText = '取消') {
  return new Promise((resolve) => {
    const modal = document.getElementById('confirm-modal');
    const titleEl = modal.querySelector('.confirm-header h3');
    const msgEl = document.getElementById('confirm-message');
    const imgEl = modal.querySelector('.confirm-cute-img');
    
    // 設定自訂內容
    titleEl.textContent = title;
    msgEl.innerHTML = message.replace(/\n/g, '<br>');
    imgEl.src = imgSrc;
    
    modal.classList.remove('hidden');
    
    const btnYes = document.getElementById('btn-confirm-yes');
    const btnNo = document.getElementById('btn-confirm-no');
    
    // 動態修改按鈕文字
    btnYes.textContent = yesText;
    btnNo.textContent = noText;
    
    const cleanup = (result) => {
      modal.classList.add('hidden');
      
      const newBtnYes = btnYes.cloneNode(true);
      const newBtnNo = btnNo.cloneNode(true);
      btnYes.parentNode.replaceChild(newBtnYes, btnYes);
      btnNo.parentNode.replaceChild(newBtnNo, btnNo);
      
      resolve(result);
    };
    
    // 綁定監聽器到當下 DOM 最新對象上
    document.getElementById('btn-confirm-yes').addEventListener('click', () => cleanup(true));
    document.getElementById('btn-confirm-no').addEventListener('click', () => cleanup(false));
  });
}


// ==========================================================================
// 23. 多帳戶舊資料自癒補齊 UID 機製 [NEW]
// ==========================================================================
async function selfHealMissingUid(uid) {
  if (!db) return;
  console.log('[自癒機制] 開始檢查並補齊歷史舊資料的 UID...');
  
  const collections = ['transactions', 'daigou', 'categories', 'payment_methods'];
  let healedCount = 0;
  
  for (const colName of collections) {
    try {
      const snap = await db.collection(colName).get();
      const batch = db.batch();
      let colHealed = 0;
      
      snap.forEach(doc => {
        const data = doc.data();
        if (!data.uid) {
          batch.update(doc.ref, { uid: uid });
          colHealed++;
          healedCount++;
        }
      });
      
      if (colHealed > 0) {
        await batch.commit();
        console.log(`[自癒機制] 集合 [${colName}] 成功補齊了 ${colHealed} 筆資料的 UID`);
      }
    } catch (e) {
      console.error(`[自癒機制] 集合 [${colName}] 自癒更新失敗:`, e);
    }
  }
  
  if (healedCount > 0) {
    showToast(`🎉 系統已自動將 ${healedCount} 筆歷史資料補齊 UID，成功移入您的個人帳本！`);
  }
}

// ==========================================================================
// 24. 多帳戶帳本共享與切換邏輯 [NEW]
// ==========================================================================

// 初始化共享帳本狀態與切換選單
async function initLedgerSharing() {
  if (!db || !firebase.auth().currentUser) return;
  const user = firebase.auth().currentUser;
  
  try {
    // 1. 撈取「我共享給誰」
    const mySharesSnap = await db.collection('book_shares')
      .where('owner_uid', '==', user.uid)
      .get();
    const myShares = [];
    mySharesSnap.forEach(doc => myShares.push(doc.data()));
    
    // 2. 撈取「誰共享給我」
    const sharesToMeSnap = await db.collection('book_shares')
      .where('collaborator_uid', '==', user.uid)
      .get();
    const sharesToMe = [];
    sharesToMeSnap.forEach(doc => sharesToMe.push(doc.data()));
    
    // 3. 渲染「設定」頁面中的共享管理列表
    renderShareManagement(myShares, sharesToMe);
    
    // 4. 動態渲染與初始化頂部「切換帳本」下拉選單
    const wrapper = document.getElementById('ledger-select-wrapper');
    const select = document.getElementById('ledger-select');
    
    if (wrapper && select) {
      // 如果有人共享給我，就顯示切換下拉選單，否則隱藏
      if (sharesToMe.length > 0) {
        wrapper.classList.remove('hidden');
        
        // 重新填充下拉選項
        select.innerHTML = '';
        
        // 選項一：自己的個人帳本
        const myOpt = document.createElement('option');
        myOpt.value = user.uid;
        myOpt.textContent = `個人帳本 (${user.email})`;
        if (currentLedgerOwnerUid === user.uid) {
          myOpt.selected = true;
        }
        select.appendChild(myOpt);
        
        // 選項二+：別人共享給我的帳本
        sharesToMe.forEach(share => {
          const opt = document.createElement('option');
          opt.value = share.owner_uid;
          opt.textContent = `共用帳本 (${share.owner_email})`;
          if (currentLedgerOwnerUid === share.owner_uid) {
            opt.selected = true;
          }
          select.appendChild(opt);
        });
        
        // 綁定 change 事件（防止重複綁定）
        select.onchange = async (e) => {
          const targetUid = e.target.value;
          const targetText = select.options[select.selectedIndex].text;
          
          showToast(`🔄 正在切換至 ${targetText}...`);
          
          currentLedgerOwnerUid = targetUid;
          // 從下拉選單名稱推導 owner email
          const matchEmail = targetText.match(/\(([^)]+)\)/);
          currentLedgerOwnerEmail = matchEmail ? matchEmail[1] : user.email;
          
          // 重新載入所有雲端資料與頁面
          await loadAndInitializeData();
          showToast(`🎉 成功切換至 ${targetText}！`);
        };
      } else {
        // 沒有共享給我，則強迫設為自己，並隱藏選單
        wrapper.classList.add('hidden');
        currentLedgerOwnerUid = user.uid;
        currentLedgerOwnerEmail = user.email;
      }
    }
  } catch (err) {
    console.error('初始化共享帳本失敗 (請確認 Rules 是否已部署):', err);
  }
}

// 渲染設定頁面的共享管理卡片列表
function renderShareManagement(myShares, sharesToMe) {
  const mySharesList = document.getElementById('my-shares-list');
  const sharesToMeList = document.getElementById('shares-to-me-list');
  
  if (mySharesList) {
    mySharesList.innerHTML = '';
    if (myShares.length === 0) {
      mySharesList.innerHTML = '<li class="center-text" style="color: var(--text-secondary);">尚未共享給任何人</li>';
    } else {
      myShares.forEach(share => {
        const li = document.createElement('li');
        li.innerHTML = `
          <span>${share.collaborator_email}</span>
          <button class="btn btn-danger btn-sm" onclick="handleCancelShare('${share.collaborator_uid}', '${share.collaborator_email}')">取消</button>
        `;
        mySharesList.appendChild(li);
      });
    }
  }
  
  if (sharesToMeList) {
    sharesToMeList.innerHTML = '';
    if (sharesToMe.length === 0) {
      sharesToMeList.innerHTML = '<li class="center-text" style="color: var(--text-secondary);">目前無人共享給您</li>';
    } else {
      sharesToMe.forEach(share => {
        const li = document.createElement('li');
        li.innerHTML = `<span>${share.owner_email}</span>`;
        sharesToMeList.appendChild(li);
      });
    }
  }
}

// 處理新增邀請共享
async function handleAddShare() {
  if (!db || !firebase.auth().currentUser) return;
  const user = firebase.auth().currentUser;
  
  const emailInput = document.getElementById('share-collaborator-email');
  if (!emailInput) return;
  
  const email = emailInput.value.trim().toLowerCase();
  
  if (!email) {
    showToast('❌ 請輸入要共享的 Email', 'error');
    return;
  }
  
  if (email === user.email.toLowerCase()) {
    showToast('❌ 不能共享給自己喔！', 'error');
    return;
  }
  
  const btn = document.getElementById('btn-add-share');
  btn.disabled = true;
  btn.textContent = '搜尋中...';
  
  try {
    // 1. 查詢此 Email 註冊者的 UID
    const userSnap = await db.collection('users')
      .where('email', '==', email)
      .get();
      
    if (userSnap.empty) {
      showToast('❌ 該 Email 尚未在此記帳系統中登入過，請請他先登入一次！', 'error');
      btn.disabled = false;
      btn.textContent = '邀請共享';
      return;
    }
    
    let collaboratorUid = null;
    userSnap.forEach(doc => {
      collaboratorUid = doc.id;
    });
    
    // 2. 建立 book_shares 紀錄
    const shareId = `${user.uid}_${collaboratorUid}`;
    await db.collection('book_shares').doc(shareId).set({
      owner_uid: user.uid,
      owner_email: user.email,
      collaborator_uid: collaboratorUid,
      collaborator_email: email,
      created_at: firebase.firestore.FieldValue.serverTimestamp()
    });
    
    showToast('🎉 共享邀請成功！已加入協作者。');
    emailInput.value = '';
    
    // 重新整理共享狀態
    await initLedgerSharing();
  } catch (err) {
    console.error('邀請共享失敗:', err);
    showToast('❌ 邀請共享失敗，請確認資料庫權限', 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = '邀請共享';
  }
}

// 處理取消共享
async function handleCancelShare(collaboratorUid, collaboratorEmail) {
  if (!db || !firebase.auth().currentUser) return;
  const user = firebase.auth().currentUser;
  
  const confirmed = await showCustomConfirm(
    `您確定要取消對 [${collaboratorEmail}] 的帳本共享嗎？\n取消後對方將無法再讀寫或查看您的帳本。`,
    '確認取消共享嗎？',
    'sad_shiba.png',
    '確認取消',
    '保留共享'
  );
  if (!confirmed) return;
  
  try {
    const shareId = `${user.uid}_${collaboratorUid}`;
    await db.collection('book_shares').doc(shareId).delete();
    
    showToast('🔒 已取消該帳本共享關係');
    await initLedgerSharing();
  } catch (err) {
    console.error('取消共享失敗:', err);
    showToast('❌ 取消共享失敗', 'error');
  }
}
