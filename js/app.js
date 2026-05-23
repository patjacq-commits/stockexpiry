// StockExpiry PWA v3.0
(function () {
  'use strict';

  // ── Date helpers ───────────────────────────────────────────────────────────
  function today() { const d = new Date(); d.setHours(0,0,0,0); return d; }

  function parseDate(s) {
    if (!s) return null;
    const p = s.split('/');
    if (p.length < 3) return null;
    const year = parseInt(p[2]) < 100 ? 2000 + parseInt(p[2]) : parseInt(p[2]);
    const dt = new Date(year, parseInt(p[1])-1, parseInt(p[0]));
    return isNaN(dt.getTime()) ? null : dt;
  }

  function daysLeft(exp) {
    const d = parseDate(exp);
    if (!d) return null;
    return Math.ceil((d - today()) / 86400000);
  }

  function workingDaysLeft(exp) {
    const d = parseDate(exp);
    if (!d) return null;
    let count = 0;
    const step = new Date(today());
    const end  = new Date(d);
    while (step < end) {
      step.setDate(step.getDate()+1);
      const dow = step.getDay();
      if (dow !== 0 && dow !== 6) count++;
    }
    return count;
  }

  function urgency(days) {
    if (days === null) return 'ok';
    if (days <= 0)  return 'expired';
    if (days <= 7)  return 'critical';
    if (days <= 10) return 'warning';
    return 'ok';
  }

  function urgColor(days) {
    return { expired:'#ff3b30', critical:'#ff6b35', warning:'#ffa500', ok:'#34c759' }[urgency(days)];
  }

  function suggestPrice(price, days) {
    if (days === null || days > 10) return price;
    if (days <= 0)  return +(price * 0.30).toFixed(2);
    if (days <= 3)  return +(price * 0.50).toFixed(2);
    if (days <= 5)  return +(price * 0.65).toFixed(2);
    if (days <= 7)  return +(price * 0.80).toFixed(2);
    return +(price * 0.90).toFixed(2);
  }

  function fmtDate(ts) {
    return new Date(ts).toLocaleDateString('fr-BE', { day:'2-digit', month:'2-digit', year:'numeric' });
  }

  function uid() { return Date.now() + Math.random().toString(36).slice(2); }

  // ── Storage ────────────────────────────────────────────────────────────────
  function load(k)   { try { return JSON.parse(localStorage.getItem(k)) || null; } catch { return null; } }
  function save(k,v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} }

  // ── Version / reset ────────────────────────────────────────────────────────
  const DATA_VERSION = '2026-05-23-v5';
  if (localStorage.getItem('se_data_version') !== DATA_VERSION) {
    const existing = load('se_products') || [];
    const manual   = existing.filter(p => p._manual || p.barcode);
    const fresh     = window.INITIAL_PRODUCTS.map(p => ({
      id: uid(), name: p.name, category: window.guessCategory(p.name),
      exp: p.exp, price: 2.50, qty: 1, active: true, sold: false, addedAt: Date.now()
    }));
    save('se_products', [...fresh, ...manual]);
    localStorage.setItem('se_data_version', DATA_VERSION);
  }

  // ── Data ───────────────────────────────────────────────────────────────────
  let products     = load('se_products') || [];
  let sales        = load('se_sales')    || [];
  let expired_hist = load('se_expired')  || [];   // historique périmés retirés
  let barcodeCache = load('se_barcodes') || {};

  if (!products.length) {
    products = window.INITIAL_PRODUCTS.map(p => ({
      id: uid(), name: p.name, category: window.guessCategory(p.name),
      exp: p.exp, price: 2.50, qty: 1, active: true, sold: false, addedAt: Date.now()
    }));
    save('se_products', products);
  }

  const CATS = ['Toutes','Chocolat','Chips & Snacks','Charcuterie','Biscuits & Bonbons','Épicerie','Autres'];

  // ── State ──────────────────────────────────────────────────────────────────
  let state = {
    view: 'stock',          // 'stock' | 'sales' | 'expired_hist' | 'settings'
    search: '',
    filterUrg: 'Tous',      // 'Tous'|'perime'|'rapide'|'critique'|'ok'
    filterCat: 'Toutes',
    modal: null,            // null|'add'|'edit'|'scan'|'qty'
    editId: null,
    qtyId: null,
    form: { name:'', category:'', exp:'', price:'', barcode:'' },
    toast: null,
    scanning: false,
    cameraStream: null,
    barcodeDetector: null,
    barcodeLoading: false,
    voiceField: null,
    recognition: null,
  };

  // ── Computed groups ────────────────────────────────────────────────────────
  function activeProducts() { return products.filter(p => p.active && !p.sold); }
  function quickSaleProducts() {
    return activeProducts().filter(p => {
      const wd = workingDaysLeft(p.exp);
      return wd !== null && wd <= 5 && daysLeft(p.exp) > 0;
    });
  }

  // ── Notifications ──────────────────────────────────────────────────────────
  function scheduleNotif() {
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    const exp = activeProducts().filter(p => daysLeft(p.exp) <= 0);
    const qs  = quickSaleProducts();
    if (exp.length)     new Notification('⛔ Produits périmés !',        { body:`${exp.length} produit(s) à retirer`, icon:'icons/icon-192.png' });
    else if (qs.length) new Notification('🏷️ Vente rapide conseillée',   { body:`${qs.length} produit(s) à -50%`,   icon:'icons/icon-192.png' });
  }

  async function requestNotif() {
    if (!('Notification' in window)) { showToast('Non supporté','error'); return; }
    const p = await Notification.requestPermission();
    showToast(p === 'granted' ? 'Notifications activées ✓' : 'Permission refusée', p === 'granted' ? 'success' : 'error');
    if (p === 'granted') scheduleNotif();
    render();
  }

  // ── Toast ──────────────────────────────────────────────────────────────────
  function showToast(msg, type='info') {
    state.toast = { msg, type };
    render();
    clearTimeout(state._tt);
    state._tt = setTimeout(() => { state.toast = null; render(); }, 3000);
  }

  // ── Open Food Facts ────────────────────────────────────────────────────────
  async function lookupBarcode(code) {
    if (barcodeCache[code]) return barcodeCache[code];
    try {
      const r = await fetch(`https://world.openfoodfacts.org/api/v2/product/${code}?fields=product_name,product_name_fr,brands,categories_tags`, { signal: AbortSignal.timeout(6000) });
      if (!r.ok) return null;
      const j = await r.json();
      if (j.status !== 1 || !j.product) return null;
      const prod = j.product;
      const name  = prod.product_name_fr || prod.product_name || '';
      const brand = prod.brands ? prod.brands.split(',')[0].trim() : '';
      const fullName = brand && !name.toLowerCase().includes(brand.toLowerCase()) ? `${brand} ${name}` : name;
      const tags  = (prod.categories_tags || []).join(' ');
      let cat = 'Autres';
      if (/chocolate|chocolat/.test(tags))            cat = 'Chocolat';
      else if (/chips|crisps|snack|biscuit|wafer|gaufre|cookie/.test(tags)) cat = 'Biscuits & Bonbons';
      else if (/charcuterie|saucisse|viande/.test(tags)) cat = 'Charcuterie';
      const result = { name: fullName, brand, category: cat };
      barcodeCache[code] = result;
      save('se_barcodes', barcodeCache);
      return result;
    } catch { return null; }
  }

  // ── Camera / Barcode ───────────────────────────────────────────────────────
  async function startScan() {
    state.modal = 'scan'; state.scanning = true; render();
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video:{ facingMode:'environment', width:{ideal:1280}, height:{ideal:720} } });
      state.cameraStream = stream;
      await new Promise(r => setTimeout(r,200));
      const video = document.getElementById('cam-video');
      if (video) { video.srcObject = stream; await video.play(); }
      if ('BarcodeDetector' in window) {
        state.barcodeDetector = new BarcodeDetector({ formats:['ean_13','ean_8','code_128','upc_a','upc_e'] });
        requestAnimationFrame(() => scanLoop(video));
      } else showToast('BarcodeDetector non dispo — saisie manuelle','info');
    } catch { showToast('Caméra inaccessible','error'); stopScan(); }
  }

  async function scanLoop(video) {
    if (!state.scanning || !state.barcodeDetector) return;
    try {
      const codes = await state.barcodeDetector.detect(video);
      if (codes.length > 0) {
        const code = codes[0].rawValue;
        stopScan();
        state.form.barcode = code;
        state.modal = 'add';
        state.barcodeLoading = true; render();
        showToast('Code détecté : ' + code + ' — recherche…','info');
        const info = await lookupBarcode(code);
        state.barcodeLoading = false;
        if (info && info.name) { state.form.name = info.name; state.form.category = info.category || ''; showToast('Produit trouvé : ' + info.name,'success'); }
        else showToast('Produit non trouvé — saisie manuelle','info');
        render(); return;
      }
    } catch {}
    if (state.scanning) requestAnimationFrame(() => scanLoop(video));
  }

  function stopScan() {
    state.scanning = false;
    if (state.cameraStream) { state.cameraStream.getTracks().forEach(t => t.stop()); state.cameraStream = null; }
    state.barcodeDetector = null;
  }

  async function lookupManual(code) {
    if (!code || code.length < 8) return;
    state.barcodeLoading = true; render();
    const info = await lookupBarcode(code);
    state.barcodeLoading = false;
    if (info && info.name) { state.form.name = info.name; state.form.category = info.category || state.form.category; showToast('✓ ' + info.name,'success'); }
    else showToast('Produit non trouvé dans Open Food Facts','info');
    render();
  }

  // ── Brand corrections (voice) ──────────────────────────────────────────────
  const BRAND_CORRECTIONS = [
    [/\bcroky\b|\bcroquis\b|\bcroque\b|\bcrokey\b|\bcroquet\b|\bcroquer\b/i,'Croky'],
    [/\blay'?s\b|\bneils?\b|\bneil\b|\blés\b|\blait\b|\blei\b|\bley\b/i,"Lay's"],
    [/\bdoritos\b|\bdorito\b|\bdo rito\b|\bdolitos\b|\bdorritos\b/i,'Doritos'],
    [/\bbugles\b|\bbugle\b|\bbougles\b|\bbugl\b|\bbug les\b/i,'Bugles'],
    [/\bpringles\b|\bpringle\b|\bpringel\b|\bpringels\b/i,'Pringles'],
    [/\bgrills\b|\bgrill\b|\bgrils\b|\bgris\b/i,'Grills'],
    [/\bcha.?cha\b|\bcha cha\b|\btcha tcha\b/i,'Cha-cha'],
    [/\btuc\b|\btuck\b|\btuk\b/i,'Tuc'],
    [/\bcrac.?à.?nut\b|\bcrac a nut\b|\bcrac au nut\b|\bkrak a nut\b/i,'Crac à nut'],
    [/\bcurly\b|\bcurli\b|\bcurlé\b|\bcurley\b/i,'Curly'],
    [/\bmilka\b|\bmilca\b|\bmilkà\b|\bmilqa\b/i,'Milka'],
    [/\bcôte.?d.?or\b|\bcôté.?d.?or\b|\bcote.?d.?or\b|\bcode or\b|\bkot d'or\b/i,"Côte d'or"],
    [/\bkinder\b|\bquinder\b|\bkinderl\b|\bkindre\b/i,'Kinder'],
    [/\bbueno\b|\bbuenno\b|\bweno\b|\bbuemo\b/i,'Bueno'],
    [/\bbounty\b|\bbounti\b|\bbounté\b|\bboundy\b/i,'Bounty'],
    [/\btwix\b|\btwicks\b|\btouix\b/i,'Twix'],
    [/\bsnickers\b|\bsniker\b|\bsnikers\b|\bsniqueur\b/i,'Snickers'],
    [/\bbalisto\b|\bbalistot\b|\bbalisteau\b/i,'Balisto'],
    [/\boreo\b|\borréo\b|\boréo\b|\boreos\b/i,'Oreo'],
    [/\bdinosaurus\b|\bdinosaus\b|\bdinosaure\b/i,'Dinosaurus'],
    [/\bcanasta\b|\bkanasta\b/i,'Canasta'],
    [/\baiki\b|\baïki\b|\baicky\b|\baïky\b/i,'Aiki'],
    [/\baoste\b|\baost\b|\baôste\b|\bauste\b/i,'Aoste'],
    [/\bbifi\b|\bbify\b|\bbiffy\b|\bbeaufi\b|\bbéfi\b/i,'Bifi'],
    [/\bzwan\b|\bzouane\b|\bsouan\b|\bzouant\b/i,'Zwan'],
    [/\bbelvita\b|\bbel vita\b|\bbelvitah\b|\bbelwita\b/i,'Belvita'],
    [/\bdubai\b|\bdoubaï\b|\bdubay\b/i,'Dubai'],
    [/\bfreedent\b|\bfree dent\b|\bfrident\b|\bfreedant\b/i,'Freedent'],
    [/\bknorr\b|\bnor\b|\bknor\b|\bknorre\b/i,'Knorr'],
    [/\bléo\b|\bleo\b/i,'Léo'],
    [/\bpaprika\b|\bpapriqua\b|\bpaprica\b/i,'paprika'],
    [/\bcurry\b|\bcuri\b|\bcurri\b/i,'curry'],
  ];

  function correctBrands(text) {
    let r = text;
    for (const [pat, rep] of BRAND_CORRECTIONS) r = r.replace(pat, rep);
    return r.charAt(0).toUpperCase() + r.slice(1);
  }

  // ── Voice ──────────────────────────────────────────────────────────────────
  function startVoice(fieldKey) {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) { showToast('Saisie vocale non supportée','error'); return; }
    if (state.recognition) state.recognition.stop();
    const rec = new SR();
    rec.lang = 'fr-BE';
    rec.interimResults = false;
    rec.maxAlternatives = 5;
    state.recognition = rec;
    state.voiceField  = fieldKey;
    render();
    rec.onresult = (e) => {
      let transcript = e.results[0][0].transcript.trim();
      if (fieldKey === 'name') {
        for (let i = 0; i < e.results[0].length; i++) {
          const alt = e.results[0][i].transcript.trim();
          const corrected = correctBrands(alt);
          if (corrected !== alt.charAt(0).toUpperCase() + alt.slice(1)) { transcript = corrected; break; }
        }
        transcript = correctBrands(transcript);
      } else if (fieldKey === 'exp') {
        transcript = parseVoiceDate(transcript) || transcript;
      } else if (fieldKey === 'price') {
        transcript = parseVoicePrice(transcript) || transcript;
      }
      state.form[fieldKey] = transcript;
      state.voiceField = null; state.recognition = null;
      showToast('✓ Compris : ' + transcript, 'success');
      render();
    };
    rec.onerror = () => { state.voiceField = null; state.recognition = null; showToast('Erreur micro','error'); render(); };
    rec.onend   = () => { if (state.voiceField === fieldKey) { state.voiceField = null; state.recognition = null; render(); } };
    rec.start();
  }

  function parseVoiceDate(s) {
    const months  = { janvier:1,février:2,mars:3,avril:4,mai:5,juin:6,juillet:7,août:8,septembre:9,octobre:10,novembre:11,décembre:12 };
    const numbers = { un:1,deux:2,trois:3,quatre:4,cinq:5,six:6,sept:7,huit:8,neuf:9,dix:10,onze:11,douze:12,treize:13,quatorze:14,quinze:15,seize:16,'dix-sept':17,'dix-huit':18,'dix-neuf':19,vingt:20,'vingt et un':21,'vingt-deux':22,'vingt-trois':23,'vingt-quatre':24,'vingt-cinq':25,'vingt-six':26,'vingt-sept':27,'vingt-huit':28,'vingt-neuf':29,trente:30,'trente et un':31 };
    const sl = s.toLowerCase();
    let month = null, monthIdx = -1;
    for (const [k,v] of Object.entries(months)) { const i = sl.indexOf(k); if (i >= 0) { month = v; monthIdx = i; break; } }
    if (!month) return null;
    const before = sl.slice(0, monthIdx).trim();
    let day = parseInt(before) || null;
    if (!day) for (const [k,v] of Object.entries(numbers)) { if (before.includes(k)) { day = v; break; } }
    const after = sl.slice(monthIdx).trim();
    const yMatch = after.match(/\b(20\d\d)\b/) || after.match(/\b(\d\d)\b/);
    let year = yMatch ? parseInt(yMatch[1]) : new Date().getFullYear();
    if (year < 100) year += 2000;
    if (!day || !month) return null;
    return `${String(day).padStart(2,'0')}/${String(month).padStart(2,'0')}/${year}`;
  }

  function parseVoicePrice(s) {
    const sl = s.toLowerCase().replace('virgule','.').replace('point','.');
    const direct = parseFloat(sl.replace(/[^\d.]/g,''));
    if (!isNaN(direct)) return String(direct);
    return null;
  }

  // ── Product CRUD ───────────────────────────────────────────────────────────
  function validateForm() {
    const f = state.form;
    if (!f.name.trim())  { showToast('Le nom est requis','error'); return false; }
    if (!f.exp.trim())   { showToast('La date est requise','error'); return false; }
    if (!parseDate(f.exp)) { showToast('Date invalide — format JJ/MM/AAAA','error'); return false; }
    if (!f.price || isNaN(parseFloat(f.price))) { showToast('Le prix est requis','error'); return false; }
    return true;
  }

  function addProduct() {
    if (!validateForm()) return;
    const f = state.form;
    const cat = f.category || window.guessCategory(f.name);
    products.unshift({ id:uid(), name:f.name.trim(), category:cat, exp:f.exp.trim(), price:parseFloat(f.price), qty:1, active:true, sold:false, addedAt:Date.now(), barcode:f.barcode||'', _manual:true });
    save('se_products', products);
    state.form = { name:'', category:'', exp:'', price:'', barcode:'' };
    state.modal = null;
    showToast('Produit ajouté ✓','success');
  }

  function openEdit(id) {
    const p = products.find(x => x.id === id);
    if (!p) return;
    state.editId = id;
    state.form = { name:p.name, category:p.category, exp:p.exp, price:String(p.price), barcode:p.barcode||'' };
    state.modal = 'edit';
    render();
  }

  function saveEdit() {
    if (!validateForm()) return;
    const f = state.form;
    products = products.map(p => p.id === state.editId ? { ...p, name:f.name.trim(), category:f.category||p.category, exp:f.exp.trim(), price:parseFloat(f.price), barcode:f.barcode||p.barcode } : p);
    save('se_products', products);
    state.modal = null; state.editId = null;
    showToast('Modifié ✓','success');
  }

  // ── Quantity ───────────────────────────────────────────────────────────────
  function openQty(id) {
    state.qtyId  = id;
    state.modal  = 'qty';
    render();
  }

  function changeQty(id, delta) {
    products = products.map(p => {
      if (p.id !== id) return p;
      const newQty = Math.max(0, (p.qty || 1) + delta);
      return { ...p, qty: newQty };
    });
    save('se_products', products);
    render();
  }

  function setQtyDirect(id, val) {
    const v = parseInt(val);
    if (isNaN(v) || v < 0) return;
    products = products.map(p => p.id !== id ? p : { ...p, qty: v });
    save('se_products', products);
  }

  // ── Mark sold ──────────────────────────────────────────────────────────────
  function markSold(id, customPrice) {
    const p = products.find(x => x.id === id);
    if (!p) return;
    const d     = daysLeft(p.exp);
    const price = customPrice !== undefined ? customPrice : suggestPrice(p.price, d);
    const qty   = p.qty || 1;
    sales.unshift({ id:uid(), product:p.name, price, normal:p.price, qty, date:fmtDate(Date.now()), days:d, category:p.category });
    save('se_sales', sales);
    products = products.map(x => x.id === id ? { ...x, sold:true } : x);
    save('se_products', products);
    showToast(`Vendu à ${price.toFixed(2)}€ ✓`,'success');
    render();
  }

  function markQuickSale(id) {
    const p = products.find(x => x.id === id);
    if (!p) return;
    markSold(id, +(p.price * 0.50).toFixed(2));
  }

  // ── Mark expired (retire + historique) ────────────────────────────────────
  function markExpired(id) {
    const p = products.find(x => x.id === id);
    if (!p) return;
    expired_hist.unshift({ id:uid(), product:p.name, exp:p.exp, qty:p.qty||1, category:p.category, removedAt:fmtDate(Date.now()), price:p.price });
    save('se_expired', expired_hist);
    products = products.map(x => x.id === id ? { ...x, active:false } : x);
    save('se_products', products);
    showToast('Retiré & archivé dans les périmés ✓','info');
    render();
  }

  function deleteProduct(id) {
    products = products.map(x => x.id === id ? { ...x, active:false } : x);
    save('se_products', products);
    showToast('Retiré','info');
    render();
  }

  function clearExpiredHist() {
    if (!confirm('Effacer tout l\'historique des périmés ?')) return;
    expired_hist = []; save('se_expired', expired_hist); showToast('Historique effacé','info'); render();
  }

  function clearSales() {
    if (!confirm('Effacer tout l\'historique des ventes ?')) return;
    sales = []; save('se_sales', sales); showToast('Historique effacé','info'); render();
  }

  // ── Filters ────────────────────────────────────────────────────────────────
  function getFiltered() {
    let list = activeProducts();
    if (state.search) {
      const s = state.search.toLowerCase();
      list = list.filter(p => p.name.toLowerCase().includes(s) || (p.barcode||'').includes(s));
    }
    if (state.filterCat !== 'Toutes') list = list.filter(p => p.category === state.filterCat);
    if (state.filterUrg !== 'Tous') {
      list = list.filter(p => {
        const d = daysLeft(p.exp); const u = urgency(d);
        if (state.filterUrg === 'perime')   return u === 'expired';
        if (state.filterUrg === 'rapide')   return workingDaysLeft(p.exp) <= 5 && d > 0;
        if (state.filterUrg === 'critique') return u === 'critical';
        if (state.filterUrg === 'attention')return u === 'warning';
        if (state.filterUrg === 'ok')       return u === 'ok';
        return true;
      });
    }
    return list.sort((a,b) => (daysLeft(a.exp)??9999) - (daysLeft(b.exp)??9999));
  }

  // ── Card HTML ──────────────────────────────────────────────────────────────
  function cardHTML(p) {
    const d   = daysLeft(p.exp);
    const wd  = workingDaysLeft(p.exp);
    const uc  = urgColor(d);
    const bgMap = { '#ff3b30':'rgba(255,59,48,0.10)', '#ff6b35':'rgba(255,107,53,0.09)', '#ffa500':'rgba(255,165,0,0.09)', '#34c759':'rgba(52,199,89,0.07)' };
    const bdMap = { '#ff3b30':'rgba(255,59,48,0.25)', '#ff6b35':'rgba(255,107,53,0.22)', '#ffa500':'rgba(255,165,0,0.22)', '#34c759':'rgba(52,199,89,0.15)' };
    const bg  = bgMap[uc] || 'rgba(255,255,255,0.04)';
    const bd  = bdMap[uc] || 'rgba(255,255,255,0.1)';
    const sp  = suggestPrice(p.price, d);
    const pct = p.price > 0 ? Math.round((1 - sp/p.price)*100) : 0;
    const dayLabel = d === null ? '?' : d <= 0 ? 'PÉRIMÉ' : `J-${d}`;
    const isQS = wd !== null && wd <= 5 && d > 0;
    const qty  = p.qty || 1;

    const qsBanner = isQS ? `
      <div class="qs-banner">
        <span class="qs-icon">🏷️</span>
        <span class="qs-text">Vente rapide · <strong>${wd}j ouv.</strong> · <strong>${(p.price*0.5).toFixed(2)}€</strong> <span class="qs-pct">-50%</span></span>
        <button class="qs-btn" onclick="App.markQuickSale('${p.id}')">Vendre</button>
      </div>` : '';

    const priceHTML = sp < p.price
      ? `<div class="price-suggest">${sp.toFixed(2)}€<span class="discount-tag">-${pct}%</span></div><div class="price-normal">${p.price.toFixed(2)}€</div>`
      : `<div class="price-ok">${p.price.toFixed(2)}€</div>`;

    // Qty controls inline on card
    const qtyHTML = `<div class="qty-row">
      <button class="qty-btn" onclick="App.changeQty('${p.id}',-1)">−</button>
      <span class="qty-val">${qty}</span>
      <button class="qty-btn" onclick="App.changeQty('${p.id}',1)">+</button>
      <span class="qty-unit">unité${qty>1?'s':''}</span>
    </div>`;

    // If expired show "Retirer" instead of "Vendu"
    const isExpired = d !== null && d <= 0;
    const actionBtns = isExpired
      ? `<button class="action-btn btn-expired" onclick="App.markExpired('${p.id}')">⛔ Retirer</button>
         <button class="action-btn btn-edit"    onclick="App.openEdit('${p.id}')">✏</button>`
      : `<button class="action-btn btn-sell"    onclick="App.markSold('${p.id}')">✓ Vendu</button>
         <button class="action-btn btn-edit"    onclick="App.openEdit('${p.id}')">✏</button>
         <button class="action-btn btn-del"     onclick="App.deleteProduct('${p.id}')">🗑</button>`;

    return `<div class="product-card" style="background:${bg};border-color:${bd};border-left-color:${uc}">
      ${qsBanner}
      <div class="card-body">
        <div class="card-left">
          <div class="card-name">${p.name}</div>
          <div class="card-meta">${p.category}${p.barcode?' · 🔲 '+p.barcode:''} · ${p.exp}</div>
          ${qtyHTML}
          <div class="card-actions">${actionBtns}</div>
        </div>
        <div class="card-right">
          <div class="days-badge" style="background:${uc}">${dayLabel}</div>
          ${priceHTML}
        </div>
      </div>
    </div>`;
  }

  // ── Form ───────────────────────────────────────────────────────────────────
  function voiceBtn(fieldKey, label) {
    const isRec = state.voiceField === fieldKey;
    return `<button type="button" class="voice-btn${isRec?' recording':''}" onclick="App.startVoice('${fieldKey}')" title="Dicter ${label}">${isRec?'⏹':'🎙️'}</button>`;
  }

  function formInner(actionFn) {
    const f = state.form;
    const isLoading = state.barcodeLoading;
    return `
      <div class="form-field">
        <div class="field-row"><label class="field-label">Nom du produit <span class="req">*</span></label>${voiceBtn('name','nom')}</div>
        <input class="field-input${state.voiceField==='name'?' listening':''}" id="f-name" value="${f.name}" placeholder="ex: Milka noisette" oninput="App.setForm('name',this.value)" autocomplete="off">
      </div>
      <div class="form-field">
        <div class="field-row"><label class="field-label">Date de péremption <span class="req">*</span></label>${voiceBtn('exp','date')}</div>
        <input class="field-input${state.voiceField==='exp'?' listening':''}" id="f-exp" value="${f.exp}" placeholder="JJ/MM/AAAA" oninput="App.setForm('exp',this.value)" autocomplete="off">
      </div>
      <div class="form-field">
        <div class="field-row"><label class="field-label">Prix normal (€) <span class="req">*</span></label>${voiceBtn('price','prix')}</div>
        <input class="field-input${state.voiceField==='price'?' listening':''}" id="f-price" type="number" step="0.10" min="0" value="${f.price}" placeholder="2.50" oninput="App.setForm('price',this.value)">
      </div>
      <div class="form-field">
        <label class="field-label">Catégorie</label>
        <select class="field-select" onchange="App.setForm('category',this.value)">
          <option value="">Auto-détection</option>
          ${['Chocolat','Chips & Snacks','Charcuterie','Biscuits & Bonbons','Épicerie','Autres'].map(c=>`<option value="${c}"${f.category===c?' selected':''}>${c}</option>`).join('')}
        </select>
      </div>
      <div class="form-field">
        <label class="field-label">Code-barres</label>
        <div class="barcode-row">
          <input class="field-input" style="margin:0;flex:1" id="f-barcode" value="${f.barcode}" placeholder="Scanner ou saisir" oninput="App.setForm('barcode',this.value)" autocomplete="off">
          <button class="scan-btn" onclick="App.startScan()" title="Scanner">📷</button>
          <button class="scan-btn${isLoading?' loading':''}" onclick="App.lookupManual(document.getElementById('f-barcode').value)" title="Rechercher">${isLoading?'⏳':'🔍'}</button>
        </div>
        ${isLoading?'<div class="lookup-hint">Recherche dans Open Food Facts…</div>':'<div class="lookup-hint">Saisir le code puis 🔍 pour identifier</div>'}
      </div>
      <button class="submit-btn" onclick="App.${actionFn}()">${actionFn==='addProduct'?'➕ Ajouter':'💾 Enregistrer'}</button>
      <button class="cancel-btn" onclick="App.closeModal()">Annuler</button>
    `;
  }

  // ── Render ─────────────────────────────────────────────────────────────────
  function render() {
    const filtered    = getFiltered();
    const active      = activeProducts();
    const expiredCnt  = active.filter(p => daysLeft(p.exp) <= 0).length;
    const criticalCnt = active.filter(p => { const d=daysLeft(p.exp); return d>0&&d<=7; }).length;
    const qsCnt       = quickSaleProducts().length;

    const groups = {
      expired:  filtered.filter(p => daysLeft(p.exp) <= 0),
      critical: filtered.filter(p => { const d=daysLeft(p.exp); return d>0&&d<=7; }),
      warning:  filtered.filter(p => { const d=daysLeft(p.exp); return d>7&&d<=10; }),
      ok:       filtered.filter(p => daysLeft(p.exp) > 10),
    };

    const totalRev    = sales.reduce((s,x)=>s+x.price,0);
    const totalRabais = sales.reduce((s,x)=>s+(x.normal-x.price),0);

    let pageHTML = '';

    // ── STOCK ──
    if (state.view === 'stock') {
      // Clickable stat cards → set filter
      const stats = `<div class="stats-row">
        <div class="stat-card clickable${state.filterUrg==='perime'?' stat-active':''}" style="--c:#ff3b30" onclick="App.setFilterUrg(state.filterUrg==='perime'?'Tous':'perime')">
          <div class="stat-num">${expiredCnt}</div><div class="stat-label">Périmés</div>
        </div>
        <div class="stat-card clickable${state.filterUrg==='rapide'?' stat-active':''}" style="--c:#a78bfa" onclick="App.setFilterUrg(state.filterUrg==='rapide'?'Tous':'rapide')">
          <div class="stat-num">${qsCnt}</div><div class="stat-label">Vente rapide</div>
        </div>
        <div class="stat-card clickable${state.filterUrg==='critique'?' stat-active':''}" style="--c:#ff6b35" onclick="App.setFilterUrg(state.filterUrg==='critique'?'Tous':'critique')">
          <div class="stat-num">${criticalCnt}</div><div class="stat-label">&lt; 7 jours</div>
        </div>
      </div>`;

      const hint = state.filterUrg !== 'Tous'
        ? `<div class="filter-active-hint">Filtre actif : <strong>${{perime:'⛔ Périmés',rapide:'🏷️ Vente rapide',critique:'🔴 < 7 jours',attention:'🟠 Attention',ok:'🟢 OK'}[state.filterUrg]}</strong> — <button onclick="App.setFilterUrg('Tous')" class="clear-filter-btn">✕ Tout afficher</button></div>` : '';

      const searchRow = `<div class="search-row">
        <input class="search-input" placeholder="🔍 Rechercher…" value="${state.search}" oninput="App.setSearch(this.value)">
        <button class="scan-btn" onclick="App.startScan()" style="background:#1a1d27;border:1px solid #2a2d3e;border-radius:8px;padding:9px 12px;color:#4f8ef7;font-size:18px">📷</button>
      </div>`;

      const catFilter = `<div class="filter-row">${CATS.map(c=>`<button class="filter-btn${state.filterCat===c?' active':''}" onclick="App.setFilterCat('${c}')">${c}</button>`).join('')}</div>`;

      const showAll   = state.filterUrg === 'Tous';
      const showExp   = showAll || state.filterUrg === 'perime';
      const showRap   = showAll || state.filterUrg === 'rapide';
      const showCrit  = showAll || state.filterUrg === 'critique';
      const showWarn  = showAll || state.filterUrg === 'attention';
      const showOk    = showAll || state.filterUrg === 'ok';

      let cards = '';
      if (showExp  && groups.expired.length)  cards += `<div class="section-title expired">⛔ Périmés — retirer (${groups.expired.length})</div>${groups.expired.map(cardHTML).join('')}`;
      if (showRap) {
        const qs = filtered.filter(p => { const wd=workingDaysLeft(p.exp); return wd!==null&&wd<=5&&daysLeft(p.exp)>0; });
        if (qs.length) cards += `<div class="section-title qs-title">🏷️ Vente rapide ≤ 5j ouvrables (${qs.length})</div>${qs.map(cardHTML).join('')}`;
      }
      if (showCrit && groups.critical.length) cards += `<div class="section-title critical">🔴 Critique — &lt; 7 jours (${groups.critical.length})</div>${groups.critical.map(cardHTML).join('')}`;
      if (showWarn && groups.warning.length)  cards += `<div class="section-title warning">🟠 Attention — ≤ 10 jours (${groups.warning.length})</div>${groups.warning.map(cardHTML).join('')}`;
      if (showOk  && groups.ok.length)        cards += `<div class="section-title ok">🟢 OK — &gt; 10 jours (${groups.ok.length})</div>${groups.ok.map(cardHTML).join('')}`;
      if (!cards) cards = `<div class="empty"><div class="empty-icon">📦</div>Aucun produit</div>`;

      pageHTML = stats + hint + searchRow + catFilter + cards;
    }

    // ── VENTES ──
    if (state.view === 'sales') {
      pageHTML = `
        <div class="stats-row">
          <div class="stat-card" style="--c:#4f8ef7"><div class="stat-num">${sales.length}</div><div class="stat-label">Vendus</div></div>
          <div class="stat-card" style="--c:#34c759"><div class="stat-num">${totalRev.toFixed(0)}€</div><div class="stat-label">Encaissé</div></div>
          <div class="stat-card" style="--c:#ffa500"><div class="stat-num">${totalRabais.toFixed(0)}€</div><div class="stat-label">Rabais</div></div>
        </div>
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
          <div class="section-title ok" style="margin:0">Historique des ventes</div>
          ${sales.length>0?`<button class="filter-btn" onclick="App.clearSales()" style="color:#ff6b35;border-color:rgba(255,107,53,0.3)">Effacer</button>`:''}
        </div>
        ${sales.length===0?`<div class="empty"><div class="empty-icon">🛒</div>Aucune vente enregistrée</div>`:
          sales.map(s=>`<div class="sale-item">
            <div>
              <div class="sale-name">${s.product}</div>
              <div class="sale-meta">${s.date}${s.qty>1?' · x'+s.qty:''}${s.days!==null?' · '+(s.days<=0?'périmé':'J-'+s.days):''}</div>
            </div>
            <div style="text-align:right">
              <div class="sale-price">${s.price.toFixed(2)}€</div>
              ${s.price<s.normal?`<div class="sale-price-normal">${s.normal.toFixed(2)}€</div>`:''}
            </div>
          </div>`).join('')}`;
    }

    // ── PÉRIMÉS (historique) ──
    if (state.view === 'expired_hist') {
      const totalPerte = expired_hist.reduce((s,x)=>s+(x.price*(x.qty||1)),0);
      pageHTML = `
        <div class="stats-row">
          <div class="stat-card" style="--c:#ff3b30"><div class="stat-num">${expired_hist.length}</div><div class="stat-label">Retirés</div></div>
          <div class="stat-card" style="--c:#ff6b35"><div class="stat-num">${expired_hist.reduce((s,x)=>s+(x.qty||1),0)}</div><div class="stat-label">Unités perdues</div></div>
          <div class="stat-card" style="--c:#888"><div class="stat-num">${totalPerte.toFixed(0)}€</div><div class="stat-label">Perte estimée</div></div>
        </div>
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
          <div class="section-title expired" style="margin:0">Produits périmés retirés</div>
          ${expired_hist.length>0?`<button class="filter-btn" onclick="App.clearExpiredHist()" style="color:#ff6b35;border-color:rgba(255,107,53,0.3)">Effacer</button>`:''}
        </div>
        ${expired_hist.length===0?`<div class="empty"><div class="empty-icon">✅</div>Aucun produit retiré pour péremption</div>`:
          expired_hist.map(e=>`<div class="sale-item" style="border-left:3px solid #ff3b30">
            <div>
              <div class="sale-name">${e.product}</div>
              <div class="sale-meta">Retiré le ${e.removedAt} · DLC : ${e.exp}${e.qty>1?' · x'+e.qty+' unités':''}</div>
            </div>
            <div style="text-align:right">
              <div style="font-size:13px;color:#ff6b35;font-weight:700">−${(e.price*(e.qty||1)).toFixed(2)}€</div>
              <div class="sale-price-normal">${e.price.toFixed(2)}€/u</div>
            </div>
          </div>`).join('')}`;
    }

    // ── RÉGLAGES ──
    if (state.view === 'settings') {
      const notifPerm = 'Notification' in window ? Notification.permission : 'unsupported';
      pageHTML = `
        <div class="section-title ok" style="margin-top:0">Notifications</div>
        ${notifPerm!=='granted'?`<button class="notif-btn" onclick="App.requestNotif()">🔔 Activer les notifications push</button>`:'<div style="color:#34c759;font-size:13px;margin-bottom:12px">✓ Notifications activées</div>'}
        <div class="section-title ok">Données</div>
        <div style="color:#666;font-size:13px;margin-bottom:10px">${active.length} produits · ${sales.length} ventes · ${expired_hist.length} périmés retirés · ${Object.keys(barcodeCache).length} codes en cache</div>
        <button class="notif-btn" onclick="App.exportData()">📤 Exporter JSON</button>
        <button class="notif-btn" style="color:#ff6b35;margin-top:4px" onclick="App.resetAll()">🗑 Réinitialiser toutes les données</button>
        <div class="section-title ok" style="margin-top:18px">Tarification automatique</div>
        <div class="price-table">
          <div class="pt-row"><span>Périmé</span><span style="color:#ff3b30">-70%</span></div>
          <div class="pt-row qs-row"><span>🏷️ Vente rapide (≤5j ouvrables)</span><span style="color:#a78bfa">-50%</span></div>
          <div class="pt-row"><span>J-3</span><span style="color:#ff6b35">-50%</span></div>
          <div class="pt-row"><span>J-5</span><span style="color:#ff6b35">-35%</span></div>
          <div class="pt-row"><span>J-7</span><span style="color:#ffa500">-20%</span></div>
          <div class="pt-row"><span>J-10</span><span style="color:#ffa500">-10%</span></div>
        </div>`;
    }

    // ── Modals ──
    let modalHTML = '';
    if (state.modal === 'add' || state.modal === 'edit') {
      const title = state.modal==='add' ? '➕ Nouveau produit' : '✏️ Modifier';
      const fn    = state.modal==='add' ? 'addProduct' : 'saveEdit';
      modalHTML = `<div class="modal-overlay" onclick="if(event.target===this)App.closeModal()">
        <div class="modal-box">
          <div class="modal-title">${title}<button class="modal-close" onclick="App.closeModal()">✕</button></div>
          ${formInner(fn)}
        </div>
      </div>`;
    }
    if (state.modal === 'scan') {
      modalHTML = `<div class="modal-overlay">
        <div class="modal-box">
          <div class="modal-title">📷 Scanner<button class="modal-close" onclick="App.closeModal()">✕</button></div>
          <div class="camera-wrap"><video id="cam-video" autoplay playsinline muted></video><div class="camera-aim"></div></div>
          <div style="font-size:12px;color:#666;text-align:center;margin-bottom:12px">Pointez vers le code-barres</div>
          <button class="cancel-btn" onclick="App.closeModal()" style="margin-top:0">Annuler</button>
        </div>
      </div>`;
    }

    const toastHTML = state.toast ? `<div class="toast toast-${state.toast.type}">${state.toast.msg}</div>` : '';

    const expBadge  = expiredCnt  > 0 ? `<span class="badge badge-red">${expiredCnt}</span>`    : '';
    const critBadge = criticalCnt > 0 ? `<span class="badge badge-orange">${criticalCnt}</span>` : '';
    const qsBadge   = qsCnt       > 0 ? `<span class="badge badge-purple">${qsCnt}</span>`       : '';

    document.getElementById('app').innerHTML = `
      <div class="app-header">
        <div class="header-left">
          <span style="font-size:22px">🏪</span>
          <span class="header-title">StockExpiry</span>
          <div class="header-badges">${expBadge}${critBadge}${qsBadge}</div>
        </div>
      </div>
      <div class="page"><div class="page-inner">${pageHTML}</div></div>
      <nav class="nav-tabs">
        <button class="nav-tab${state.view==='stock'?' active':''}"        onclick="App.setView('stock')"><span class="tab-icon">📦</span>Stock</button>
        <button class="nav-tab${state.view==='sales'?' active':''}"        onclick="App.setView('sales')"><span class="tab-icon">🛒</span>Ventes</button>
        <button class="nav-tab${state.view==='expired_hist'?' active':''}" onclick="App.setView('expired_hist')"><span class="tab-icon">⛔</span>Périmés${expired_hist.length>0?`<span class="tab-badge">${expired_hist.length}</span>`:''}</button>
        <button class="nav-tab${state.view==='settings'?' active':''}"     onclick="App.setView('settings')"><span class="tab-icon">⚙️</span>Réglages</button>
      </nav>
      ${state.view==='stock'?`<button class="fab" onclick="App.openAdd()">+</button>`:''}
      ${modalHTML}
      ${toastHTML}
    `;

    // expose state for onclick toggle
    window.state = state;

    if (state.modal==='scan' && state.scanning && state.cameraStream) {
      const v = document.getElementById('cam-video');
      if (v) { v.srcObject = state.cameraStream; v.play().then(()=>{ if (state.barcodeDetector) requestAnimationFrame(()=>scanLoop(v)); }); }
    }
  }

  // ── Public API ─────────────────────────────────────────────────────────────
  window.App = {
    setView(v)         { state.view = v; render(); },
    setSearch(v)       { state.search = v; render(); },
    setFilterCat(v)    { state.filterCat = v; render(); },
    setFilterUrg(v)    { state.filterUrg = v; render(); },
    openAdd()          { state.form = { name:'', category:'', exp:'', price:'', barcode:'' }; state.modal = 'add'; render(); },
    openEdit(id)       { openEdit(id); },
    closeModal()       { stopScan(); if (state.recognition) state.recognition.stop(); state.voiceField = null; state.modal = null; state.editId = null; state.qtyId = null; render(); },
    setForm(k,v)       { state.form[k] = v; },
    addProduct()       { addProduct(); },
    saveEdit()         { saveEdit(); },
    openQty(id)        { openQty(id); },
    changeQty(id,d)    { changeQty(id,d); },
    setQtyDirect(id,v) { setQtyDirect(id,v); render(); },
    markSold(id)       { markSold(id); },
    markQuickSale(id)  { markQuickSale(id); },
    markExpired(id)    { markExpired(id); },
    deleteProduct(id)  { deleteProduct(id); },
    clearSales()       { clearSales(); },
    clearExpiredHist() { clearExpiredHist(); },
    startScan()        { startScan(); },
    lookupManual(c)    { lookupManual(c); },
    startVoice(k)      { startVoice(k); },
    requestNotif()     { requestNotif(); },
    exportData() {
      const blob = new Blob([JSON.stringify({ products:products.filter(p=>p.active&&!p.sold), sales, expired_hist }, null,2)], { type:'application/json' });
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
      a.download = `stockexpiry-${new Date().toISOString().slice(0,10)}.json`; a.click();
      showToast('Export téléchargé ✓','success');
    },
    resetAll() {
      if (confirm('Réinitialiser TOUTES les données ?')) { ['se_products','se_sales','se_expired','se_barcodes','se_data_version'].forEach(k=>localStorage.removeItem(k)); location.reload(); }
    }
  };

  render();
  setTimeout(() => { if ('Notification' in window && Notification.permission === 'granted') scheduleNotif(); }, 800);

})();
