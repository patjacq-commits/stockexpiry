// StockExpiry PWA - Main App
(function() {
  'use strict';

  // ── Helpers ──────────────────────────────────────────────────────────────
  const TODAY = () => { const d = new Date(); d.setHours(0,0,0,0); return d; };

  function parseDate(s) {
    if (!s) return null;
    const parts = s.split('/');
    if (parts.length < 3) return null;
    const [dd, mm, yy] = parts;
    const year = parseInt(yy) < 100 ? 2000 + parseInt(yy) : parseInt(yy);
    const dt = new Date(year, parseInt(mm) - 1, parseInt(dd));
    return isNaN(dt.getTime()) ? null : dt;
  }

  function daysLeft(exp) {
    const d = parseDate(exp);
    if (!d) return null;
    return Math.ceil((d - TODAY()) / 86400000);
  }

  function urgency(days) {
    if (days === null) return 'ok';
    if (days <= 0) return 'expired';
    if (days <= 7) return 'critical';
    if (days <= 10) return 'warning';
    return 'ok';
  }

  function urgColor(days) {
    const u = urgency(days);
    return { expired: '#ff3b30', critical: '#ff6b35', warning: '#ffa500', ok: '#34c759' }[u];
  }

  function suggestPrice(price, days) {
    if (days === null || days > 10) return price;
    if (days <= 0)  return +(price * 0.30).toFixed(2);
    if (days <= 3)  return +(price * 0.50).toFixed(2);
    if (days <= 5)  return +(price * 0.65).toFixed(2);
    if (days <= 7)  return +(price * 0.80).toFixed(2);
    if (days <= 10) return +(price * 0.90).toFixed(2);
    return price;
  }

  function fmtDate(d) {
    return new Date(d).toLocaleDateString('fr-BE', { day:'2-digit', month:'2-digit', year:'numeric' });
  }

  function uid() { return Date.now() + Math.random().toString(36).slice(2); }

  // ── Storage ───────────────────────────────────────────────────────────────
  function load(key) {
    try { return JSON.parse(localStorage.getItem(key)) || null; } catch { return null; }
  }
  function save(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); } catch {}
  }

  // ── State ─────────────────────────────────────────────────────────────────
  let products = load('se_products');
  if (!products) {
    products = window.INITIAL_PRODUCTS.map(p => ({
      id: uid(),
      name: p.name,
      category: window.guessCategory(p.name),
      exp: p.exp,
      price: 2.50,
      active: true,
      sold: false,
      addedAt: Date.now()
    }));
    save('se_products', products);
  }

  let sales = load('se_sales') || [];

  let state = {
    view: 'stock',       // 'stock' | 'sales' | 'settings'
    search: '',
    filterCat: 'Toutes',
    filterUrg: 'Tous',
    modal: null,         // null | 'add' | 'scan' | 'edit' | 'confirm'
    editId: null,
    confirmAction: null,
    form: { name:'', category:'', exp:'', price:'', barcode:'' },
    toast: null,
    scanning: false,
    barcodeDetector: null,
    cameraStream: null,
  };

  // ── Notifications ─────────────────────────────────────────────────────────
  function scheduleNotifications() {
    if (!('Notification' in window)) return;
    const critical = products.filter(p => p.active && !p.sold && daysLeft(p.exp) !== null && daysLeft(p.exp) <= 7 && daysLeft(p.exp) > 0);
    const expired = products.filter(p => p.active && !p.sold && daysLeft(p.exp) !== null && daysLeft(p.exp) <= 0);
    if (Notification.permission === 'granted') {
      if (expired.length > 0) {
        new Notification('⛔ Produits périmés!', { body: `${expired.length} produit(s) à retirer immédiatement`, icon: 'icons/icon-192.png' });
      } else if (critical.length > 0) {
        new Notification('🔴 Péremptions critiques', { body: `${critical.length} produit(s) expirent dans ≤ 7 jours`, icon: 'icons/icon-192.png' });
      }
    }
  }

  async function requestNotifications() {
    if (!('Notification' in window)) { showToast('Notifications non supportées', 'error'); return; }
    const perm = await Notification.requestPermission();
    if (perm === 'granted') { showToast('Notifications activées ✓', 'success'); scheduleNotifications(); }
    else showToast('Permission refusée', 'error');
    render();
  }

  // ── Toast ─────────────────────────────────────────────────────────────────
  function showToast(msg, type = 'info') {
    state.toast = { msg, type };
    render();
    clearTimeout(state._toastTimer);
    state._toastTimer = setTimeout(() => { state.toast = null; render(); }, 2600);
  }

  // ── Camera / Barcode ──────────────────────────────────────────────────────
  async function startScan() {
    state.modal = 'scan';
    state.scanning = true;
    render();
    // Start camera
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
      state.cameraStream = stream;
      const video = document.getElementById('camera-video');
      if (video) { video.srcObject = stream; video.play(); }
      // Try BarcodeDetector
      if ('BarcodeDetector' in window) {
        state.barcodeDetector = new BarcodeDetector({ formats: ['ean_13', 'ean_8', 'code_128', 'qr_code', 'upc_a'] });
        scanFrame(video);
      }
    } catch (e) {
      showToast('Caméra non accessible', 'error');
      stopScan();
    }
  }

  async function scanFrame(video) {
    if (!state.scanning || !state.barcodeDetector) return;
    try {
      const codes = await state.barcodeDetector.detect(video);
      if (codes.length > 0) {
        const code = codes[0].rawValue;
        stopScan();
        state.form.barcode = code;
        state.modal = 'add';
        render();
        showToast('Code scanné : ' + code, 'success');
        return;
      }
    } catch {}
    if (state.scanning) requestAnimationFrame(() => scanFrame(video));
  }

  function stopScan() {
    state.scanning = false;
    if (state.cameraStream) {
      state.cameraStream.getTracks().forEach(t => t.stop());
      state.cameraStream = null;
    }
  }

  // ── Product actions ───────────────────────────────────────────────────────
  function addProduct() {
    const f = state.form;
    if (!f.name.trim()) { showToast('Le nom est requis', 'error'); return; }
    if (!f.exp.trim())  { showToast('La date est requise', 'error'); return; }
    if (!parseDate(f.exp)) { showToast('Date invalide (JJ/MM/AAAA)', 'error'); return; }
    const cat = f.category || window.guessCategory(f.name);
    const p = {
      id: uid(),
      name: f.name.trim(),
      category: cat,
      exp: f.exp.trim(),
      price: parseFloat(f.price) || 2.50,
      active: true,
      sold: false,
      addedAt: Date.now(),
      barcode: f.barcode || ''
    };
    products.unshift(p);
    save('se_products', products);
    state.form = { name:'', category:'', exp:'', price:'', barcode:'' };
    state.modal = null;
    showToast('Produit ajouté ✓', 'success');
  }

  function editProduct() {
    const f = state.form;
    if (!f.name.trim() || !f.exp.trim()) { showToast('Champs requis manquants', 'error'); return; }
    if (!parseDate(f.exp)) { showToast('Date invalide (JJ/MM/AAAA)', 'error'); return; }
    products = products.map(p => p.id === state.editId ? {
      ...p, name: f.name.trim(), category: f.category || p.category,
      exp: f.exp.trim(), price: parseFloat(f.price) || p.price, barcode: f.barcode || p.barcode
    } : p);
    save('se_products', products);
    state.modal = null; state.editId = null;
    showToast('Produit modifié ✓', 'success');
  }

  function openEdit(id) {
    const p = products.find(x => x.id === id);
    if (!p) return;
    state.editId = id;
    state.form = { name: p.name, category: p.category, exp: p.exp, price: String(p.price), barcode: p.barcode || '' };
    state.modal = 'edit';
    render();
  }

  function markSold(id) {
    const p = products.find(x => x.id === id);
    if (!p) return;
    const d = daysLeft(p.exp);
    const sp = suggestPrice(p.price, d);
    sales.unshift({ id: uid(), product: p.name, price: sp, normal: p.price, date: fmtDate(Date.now()), days: d, category: p.category });
    save('se_sales', sales);
    products = products.map(x => x.id === id ? { ...x, sold: true } : x);
    save('se_products', products);
    showToast(`Vendu à ${sp.toFixed(2)}€ ✓`, 'success');
  }

  function deleteProduct(id) {
    products = products.map(x => x.id === id ? { ...x, active: false } : x);
    save('se_products', products);
    showToast('Produit retiré', 'info');
  }

  function clearSales() {
    sales = [];
    save('se_sales', sales);
    showToast('Historique effacé', 'info');
  }

  // ── Computed views ────────────────────────────────────────────────────────
  const CATS = ['Toutes', 'Chocolat', 'Chips & Snacks', 'Charcuterie', 'Biscuits & Bonbons', 'Épicerie', 'Autres'];
  const URG_FILTERS = [
    { key: 'Tous', label: 'Tous' },
    { key: 'critique', label: '🔴 Critique' },
    { key: 'attention', label: '🟠 Attention' },
    { key: 'ok', label: '🟢 OK' },
  ];

  function getFiltered() {
    let list = products.filter(p => p.active && !p.sold);
    if (state.search) list = list.filter(p => p.name.toLowerCase().includes(state.search.toLowerCase()) || (p.barcode || '').includes(state.search));
    if (state.filterCat !== 'Toutes') list = list.filter(p => p.category === state.filterCat);
    if (state.filterUrg !== 'Tous') {
      list = list.filter(p => {
        const d = daysLeft(p.exp);
        const u = urgency(d);
        if (state.filterUrg === 'critique') return u === 'critical' || u === 'expired';
        if (state.filterUrg === 'attention') return u === 'warning';
        if (state.filterUrg === 'ok') return u === 'ok';
        return true;
      });
    }
    return list.sort((a, b) => {
      const da = daysLeft(a.exp) ?? 9999;
      const db = daysLeft(b.exp) ?? 9999;
      return da - db;
    });
  }

  // ── HTML Builders ─────────────────────────────────────────────────────────
  function cardHTML(p) {
    const d = daysLeft(p.exp);
    const uc = urgColor(d);
    const ubg = uc.replace(')', ', 0.08)').replace('rgb', 'rgba').replace('#', 'rgba(').replace('rgba(#', 'rgba(');
    // Use inline rgba
    const bgMap = { '#ff3b30': 'rgba(255,59,48,0.1)', '#ff6b35': 'rgba(255,107,53,0.09)', '#ffa500': 'rgba(255,165,0,0.09)', '#34c759': 'rgba(52,199,89,0.07)' };
    const bdMap = { '#ff3b30': 'rgba(255,59,48,0.25)', '#ff6b35': 'rgba(255,107,53,0.2)', '#ffa500': 'rgba(255,165,0,0.2)', '#34c759': 'rgba(52,199,89,0.15)' };
    const bg = bgMap[uc] || 'rgba(255,255,255,0.04)';
    const bd = bdMap[uc] || 'rgba(255,255,255,0.1)';
    const sp = suggestPrice(p.price, d);
    const pct = p.price > 0 ? Math.round((1 - sp / p.price) * 100) : 0;
    const dayLabel = d === null ? '?' : d <= 0 ? 'PÉRIMÉ' : `J-${d}`;
    const priceHTML = sp < p.price
      ? `<div class="price-suggest">${sp.toFixed(2)}€<span class="discount-tag">-${pct}%</span></div><div class="price-normal">${p.price.toFixed(2)}€</div>`
      : `<div class="price-ok">${p.price.toFixed(2)}€</div>`;

    return `<div class="product-card" style="--uc:${uc};background:${bg};border-color:${bd}">
      <div class="card-left">
        <div class="card-name" title="${p.name}">${p.name}</div>
        <div class="card-meta">${p.category}${p.barcode ? ' · 🔲 ' + p.barcode : ''} · ${p.exp}</div>
        <div class="card-actions">
          <button class="action-btn btn-sell" onclick="App.markSold('${p.id}')">✓ Vendu</button>
          <button class="action-btn btn-edit" onclick="App.openEdit('${p.id}')">✏</button>
          <button class="action-btn btn-del" onclick="App.deleteProduct('${p.id}')">🗑</button>
        </div>
      </div>
      <div class="card-right">
        <div class="days-badge" style="background:${uc}">${dayLabel}</div>
        ${priceHTML}
      </div>
    </div>`;
  }

  function formHTML(title, action) {
    const f = state.form;
    return `
      <div class="modal-title">${title}<button class="modal-close" onclick="App.closeModal()">✕</button></div>
      <label class="field-label">Nom du produit *</label>
      <input class="field-input" id="f-name" value="${f.name}" placeholder="ex: Milka noisette" oninput="App.setForm('name',this.value)">
      <label class="field-label">Catégorie</label>
      <select class="field-select" id="f-cat" onchange="App.setForm('category',this.value)">
        <option value="">Auto-détection</option>
        ${['Chocolat','Chips & Snacks','Charcuterie','Biscuits & Bonbons','Épicerie','Autres'].map(c => `<option value="${c}"${f.category===c?' selected':''}>${c}</option>`).join('')}
      </select>
      <label class="field-label">Date de péremption * (JJ/MM/AAAA)</label>
      <input class="field-input" id="f-exp" value="${f.exp}" placeholder="25/12/2025" oninput="App.setForm('exp',this.value)">
      <label class="field-label">Prix normal (€)</label>
      <input class="field-input" id="f-price" type="number" step="0.10" min="0" value="${f.price}" placeholder="2.50" oninput="App.setForm('price',this.value)">
      <label class="field-label">Code-barres</label>
      <div style="display:flex;gap:8px;margin-bottom:13px">
        <input class="field-input" style="margin:0;flex:1" id="f-barcode" value="${f.barcode}" placeholder="Scanner ou saisir" oninput="App.setForm('barcode',this.value)">
        <button class="scan-btn" onclick="App.startScan()" style="border-radius:8px;padding:0 14px;font-size:22px">📷</button>
      </div>
      <button class="submit-btn" onclick="App.${action}()">${action === 'addProduct' ? 'Ajouter le produit' : 'Enregistrer les modifications'}</button>
      <button class="cancel-btn" onclick="App.closeModal()">Annuler</button>
    `;
  }

  // ── Render ────────────────────────────────────────────────────────────────
  function render() {
    const filtered = getFiltered();
    const all = products.filter(p => p.active && !p.sold);
    const expiredCount = all.filter(p => daysLeft(p.exp) <= 0).length;
    const criticalCount = all.filter(p => { const d = daysLeft(p.exp); return d > 0 && d <= 7; }).length;
    const warningCount = all.filter(p => { const d = daysLeft(p.exp); return d > 7 && d <= 10; }).length;

    // Group filtered
    const groups = {
      expired:  filtered.filter(p => daysLeft(p.exp) <= 0),
      critical: filtered.filter(p => { const d = daysLeft(p.exp); return d > 0 && d <= 7; }),
      warning:  filtered.filter(p => { const d = daysLeft(p.exp); return d > 7 && d <= 10; }),
      ok:       filtered.filter(p => daysLeft(p.exp) > 10),
    };

    // Sales stats
    const totalRev = sales.reduce((s, x) => s + x.price, 0);
    const totalRabais = sales.reduce((s, x) => s + (x.normal - x.price), 0);

    let pageHTML = '';

    if (state.view === 'stock') {
      const alertBanner = (expiredCount > 0)
        ? `<div class="alert-banner">⛔ <div class="alert-banner-text">${expiredCount} produit(s) périmé(s) — à retirer immédiatement !</div></div>` : '';

      const statsRow = `<div class="stats-row">
        <div class="stat-card" style="--c:#ff3b30"><div class="stat-num">${expiredCount}</div><div class="stat-label">Périmés</div></div>
        <div class="stat-card" style="--c:#ff6b35"><div class="stat-num">${criticalCount}</div><div class="stat-label">≤ 7 jours</div></div>
        <div class="stat-card" style="--c:#ffa500"><div class="stat-num">${warningCount}</div><div class="stat-label">≤ 10 jours</div></div>
      </div>`;

      const searchRow = `<div class="search-row">
        <input class="search-input" placeholder="🔍 Rechercher..." value="${state.search}" oninput="App.setSearch(this.value)">
        <button class="scan-btn" onclick="App.startScan()">📷</button>
      </div>`;

      const urgFilter = `<div class="filter-row">${URG_FILTERS.map(f => `<button class="filter-btn${state.filterUrg===f.key?' active':''}" onclick="App.setFilterUrg('${f.key}')">${f.label}</button>`).join('')}</div>`;
      const catFilter = `<div class="filter-row">${CATS.map(c => `<button class="filter-btn${state.filterCat===c?' active':''}" onclick="App.setFilterCat('${c}')">${c}</button>`).join('')}</div>`;

      const showExpired = state.filterUrg === 'Tous' || state.filterUrg === 'critique';
      const showCritical = state.filterUrg === 'Tous' || state.filterUrg === 'critique';
      const showWarning = state.filterUrg === 'Tous' || state.filterUrg === 'attention';
      const showOk = state.filterUrg === 'Tous' || state.filterUrg === 'ok';

      let cardsHTML = '';
      if (showExpired && groups.expired.length) cardsHTML += `<div class="section-title expired">⛔ Périmés — à retirer (${groups.expired.length})</div>${groups.expired.map(cardHTML).join('')}`;
      if (showCritical && groups.critical.length) cardsHTML += `<div class="section-title critical">🔴 Critique — ≤ 7 jours (${groups.critical.length})</div>${groups.critical.map(cardHTML).join('')}`;
      if (showWarning && groups.warning.length)  cardsHTML += `<div class="section-title warning">🟠 Attention — ≤ 10 jours (${groups.warning.length})</div>${groups.warning.map(cardHTML).join('')}`;
      if (showOk && groups.ok.length)            cardsHTML += `<div class="section-title ok">🟢 OK — &gt; 10 jours (${groups.ok.length})</div>${groups.ok.map(cardHTML).join('')}`;
      if (!cardsHTML) cardsHTML = `<div class="empty"><div class="empty-icon">📦</div>Aucun produit trouvé</div>`;

      pageHTML = alertBanner + statsRow + searchRow + urgFilter + catFilter + cardsHTML;
    }

    if (state.view === 'sales') {
      pageHTML = `
        <div class="stats-row">
          <div class="stat-card" style="--c:#4f8ef7"><div class="stat-num">${sales.length}</div><div class="stat-label">Vendus</div></div>
          <div class="stat-card" style="--c:#34c759"><div class="stat-num">${totalRev.toFixed(0)}€</div><div class="stat-label">Encaissé</div></div>
          <div class="stat-card" style="--c:#ffa500"><div class="stat-num">${totalRabais.toFixed(0)}€</div><div class="stat-label">Rabais</div></div>
        </div>
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
          <div class="section-title ok" style="margin:0">Historique des ventes</div>
          ${sales.length > 0 ? `<button class="filter-btn" onclick="App.clearSales()" style="color:#ff6b35;border-color:rgba(255,107,53,0.3)">Effacer</button>` : ''}
        </div>
        ${sales.length === 0 ? `<div class="empty"><div class="empty-icon">🛒</div>Aucune vente enregistrée</div>` :
          sales.map(s => `<div class="sale-item">
            <div>
              <div class="sale-name">${s.product}</div>
              <div class="sale-meta">${s.date} · ${s.days !== null && s.days <= 0 ? 'périmé' : s.days !== null ? `J-${s.days} restant` : ''}</div>
            </div>
            <div>
              <div class="sale-price">${s.price.toFixed(2)}€</div>
              ${s.price < s.normal ? `<div class="sale-price-normal">${s.normal.toFixed(2)}€</div>` : ''}
            </div>
          </div>`).join('')
        }`;
    }

    if (state.view === 'settings') {
      const notifPerm = 'Notification' in window ? Notification.permission : 'unsupported';
      pageHTML = `
        <div class="section-title ok" style="margin-top:0">Notifications</div>
        ${notifPerm !== 'granted' ? `<button class="notif-btn" onclick="App.requestNotifications()">🔔 Activer les notifications push</button>` : '<div style="color:#34c759;font-size:13px;margin-bottom:12px">✓ Notifications activées</div>'}
        <div class="section-title ok">Données</div>
        <div style="color:#666;font-size:13px;margin-bottom:10px">${products.filter(p=>p.active&&!p.sold).length} produits actifs · ${sales.length} ventes enregistrées</div>
        <button class="notif-btn" onclick="App.exportData()" style="color:#4f8ef7">📤 Exporter les données (JSON)</button>
        <button class="notif-btn" style="color:#ff6b35;margin-top:4px" onclick="App.resetAll()">🗑 Réinitialiser toutes les données</button>
        <div class="section-title ok" style="margin-top:20px">Tarification suggérée</div>
        <div style="font-size:13px;color:#888;line-height:1.8">
          ≤ 0 jour : <strong style="color:#ff3b30">-70%</strong><br>
          J-3 : <strong style="color:#ff6b35">-50%</strong><br>
          J-5 : <strong style="color:#ff6b35">-35%</strong><br>
          J-7 : <strong style="color:#ffa500">-20%</strong><br>
          J-10 : <strong style="color:#ffa500">-10%</strong>
        </div>
        <div class="section-title ok" style="margin-top:20px">À propos</div>
        <div style="font-size:12px;color:#444">StockExpiry v1.0 · PWA · Stockage local · Scan code-barres</div>`;
    }

    // Modal
    let modalHTML = '';
    if (state.modal === 'add') {
      modalHTML = `<div class="modal-overlay" onclick="if(event.target===this)App.closeModal()"><div class="modal-box">${formHTML('➕ Nouveau produit', 'addProduct')}</div></div>`;
    } else if (state.modal === 'edit') {
      modalHTML = `<div class="modal-overlay" onclick="if(event.target===this)App.closeModal()"><div class="modal-box">${formHTML('✏️ Modifier le produit', 'editProduct')}</div></div>`;
    } else if (state.modal === 'scan') {
      modalHTML = `<div class="modal-overlay"><div class="modal-box">
        <div class="modal-title">📷 Scanner un code-barres<button class="modal-close" onclick="App.closeModal()">✕</button></div>
        <div class="camera-wrap"><video id="camera-video" autoplay playsinline muted></video><div class="camera-aim"></div></div>
        <div style="font-size:12px;color:#666;text-align:center;margin-bottom:12px">Pointez vers le code-barres du produit</div>
        <button class="cancel-btn" onclick="App.closeModal()" style="margin-top:0">Annuler</button>
      </div></div>`;
    }

    // Toast
    const toastHTML = state.toast ? `<div class="toast toast-${state.toast.type}">${state.toast.msg}</div>` : '';

    // Badges
    const headerBadges = (criticalCount > 0 || expiredCount > 0) ? `
      <div class="header-badges">
        ${expiredCount > 0 ? `<span class="badge badge-red">${expiredCount}</span>` : ''}
        ${criticalCount > 0 ? `<span class="badge badge-orange">${criticalCount}</span>` : ''}
      </div>` : '';

    const html = `
      <div class="app-header">
        <div class="header-left">
          <span style="font-size:22px">🏪</span>
          <span class="header-title">StockExpiry</span>
          ${headerBadges}
        </div>
      </div>
      <div class="page"><div class="page-inner">${pageHTML}</div></div>
      <nav class="nav-tabs">
        <button class="nav-tab${state.view==='stock'?' active':''}" onclick="App.setView('stock')"><span class="tab-icon">📦</span>Stock</button>
        <button class="nav-tab${state.view==='sales'?' active':''}" onclick="App.setView('sales')"><span class="tab-icon">🛒</span>Ventes</button>
        <button class="nav-tab${state.view==='settings'?' active':''}" onclick="App.setView('settings')"><span class="tab-icon">⚙️</span>Réglages</button>
      </nav>
      <button class="fab" onclick="App.openAdd()" ${state.view!=='stock'?'style="display:none"':''}>+</button>
      ${modalHTML}
      ${toastHTML}
    `;

    document.getElementById('app').innerHTML = html;

    // If scan modal just rendered, start camera
    if (state.modal === 'scan' && state.scanning) {
      const video = document.getElementById('camera-video');
      if (video && state.cameraStream) {
        video.srcObject = state.cameraStream;
        video.play();
        if (state.barcodeDetector) scanFrame(video);
      }
    }
  }

  // ── Public API (called from HTML) ─────────────────────────────────────────
  window.App = {
    setView(v) { state.view = v; render(); },
    setSearch(v) { state.search = v; render(); },
    setFilterCat(v) { state.filterCat = v; render(); },
    setFilterUrg(v) { state.filterUrg = v; render(); },
    openAdd() { state.form = { name:'', category:'', exp:'', price:'', barcode:'' }; state.modal = 'add'; render(); },
    openEdit(id) { openEdit(id); },
    closeModal() { stopScan(); state.modal = null; state.editId = null; render(); },
    setForm(k, v) { state.form[k] = v; },
    addProduct() { addProduct(); },
    editProduct() { editProduct(); },
    markSold(id) { markSold(id); render(); },
    deleteProduct(id) { deleteProduct(id); render(); },
    clearSales() { if (confirm('Effacer tout l\'historique des ventes ?')) clearSales(); render(); },
    startScan() { startScan(); },
    requestNotifications() { requestNotifications(); },
    exportData() {
      const data = { products: products.filter(p=>p.active&&!p.sold), sales };
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `stockexpiry-${new Date().toISOString().slice(0,10)}.json`;
      a.click();
      showToast('Export téléchargé ✓', 'success');
    },
    resetAll() {
      if (confirm('Réinitialiser TOUTES les données ? Cette action est irréversible.')) {
        localStorage.removeItem('se_products');
        localStorage.removeItem('se_sales');
        location.reload();
      }
    }
  };

  // ── Init ──────────────────────────────────────────────────────────────────
  function init() {
    render();
    // Auto-notify on launch
    setTimeout(() => { if (Notification.permission === 'granted') scheduleNotifications(); }, 1000);
  }

  // Wait for DOM
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

})();
