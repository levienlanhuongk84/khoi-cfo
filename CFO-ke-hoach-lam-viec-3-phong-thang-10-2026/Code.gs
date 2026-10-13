/**
 * KẾ HOẠCH CÔNG VIỆC – HỆ THỐNG HOÀNG TUẤN
 * Máy chủ Google Apps Script cho trang GitHub Pages.
 * Lưu dữ liệu vào chính Google Sheet chứa script này; tài liệu tải lên lưu trong một thư mục Google Drive.
 *
 * Cài đặt: Tiện ích mở rộng › Apps Script › dán toàn bộ file này › Lưu
 *          › Triển khai › Tùy chọn triển khai mới › Ứng dụng web
 *          › Thực thi với tư cách: Tôi · Người có quyền truy cập: Bất kỳ ai › Triển khai
 *          › sao chép URL kết thúc bằng /exec.
 */

const MAX_FILE_MB = 10;
const TOKEN_DAYS = 7;
const TASK_LOG_CAP = 60;
const HASH_ROUNDS = 400;

/* ───────── Bảng tính ───────── */
function ss_() { return SpreadsheetApp.getActiveSpreadsheet(); }
function sheet_(name, headers) {
  const ss = ss_();
  let s = ss.getSheetByName(name);
  if (!s) { s = ss.insertSheet(name); s.appendRow(headers); s.setFrozenRows(1); }
  return s;
}
const TASKS = () => sheet_('Tasks', ['id', 'deptId', 'ownerId', 'period', 'updatedAt', 'title', 'json']);
const FILES = () => sheet_('Files', ['id', 'deptId', 'taskId', 'name', 'size', 'driveId', 'json']);
const LOG = () => sheet_('Log', ['at', 'by', 'deptId', 'taskId', 'act', 'title', 'detail', 'changes']);
const CONF = () => sheet_('Config', ['key', 'value']);

function rows_(sh) { const n = sh.getLastRow(); return n < 2 ? [] : sh.getRange(2, 1, n - 1, sh.getLastColumn()).getValues(); }
function findRow_(sh, id) {
  const n = sh.getLastRow(); if (n < 2) return -1;
  const hit = sh.getRange(2, 1, n - 1, 1).createTextFinder(id).matchEntireCell(true).findNext();
  return hit ? hit.getRow() : -1;
}

/* ───────── HTTP ───────── */
function doGet() { return out_({ ok: true, app: 'ke-hoach-cong-viec-ht' }); }
function doPost(e) {
  let req;
  try { req = JSON.parse(e.postData.contents); } catch (x) { return out_({ ok: false, err: 'bad_json' }); }
  try {
    const fn = API[req.action];
    if (!fn) throw new Error('unknown_action');
    return out_(Object.assign({ ok: true }, fn(req)));
  } catch (x) { return out_({ ok: false, err: String(x && x.message || x) }); }
}
function out_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }
function fail_(code) { throw new Error(code); }
function withLock_(fn) { const l = LockService.getScriptLock(); l.waitLock(20000); try { return fn(); } finally { l.releaseLock(); } }

/* ───────── Mật khẩu & phiên ───────── */
function hex_(bytes) { return bytes.map(b => ((b + 256) % 256).toString(16).padStart(2, '0')).join(''); }
function hash_(pw, salt) {
  let h = salt + '|' + pw;
  for (let i = 0; i < HASH_ROUNDS; i++) h = hex_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, h + salt, Utilities.Charset.UTF_8));
  return h;
}
function makePw_(pw) {
  if (!pw || String(pw).length < 6) fail_('weak_pw');
  const s = Utilities.getUuid().replace(/-/g, '');
  return { s: s, h: hash_(String(pw), s) };
}
function secret_() {
  const p = PropertiesService.getScriptProperties();
  let s = p.getProperty('SECRET');
  if (!s) { s = Utilities.getUuid() + Utilities.getUuid(); p.setProperty('SECRET', s); }
  return s;
}
function sign_(payload) { return Utilities.base64EncodeWebSafe(Utilities.computeHmacSha256Signature(payload, secret_())); }
function entityPw_(org, role, deptId, personId) {
  if (role === 'admin') return org.admin;
  if (role === 'lead') { const d = org.depts.find(x => x.id === deptId); return d && d.active !== false ? d.pw : null; }
  const p = org.people.find(x => x.id === personId); return p && p.active !== false ? p.pw : null;
}
function issue_(org, role, deptId, personId) {
  const pw = entityPw_(org, role, deptId, personId);
  const payload = Utilities.base64EncodeWebSafe(JSON.stringify({ r: role, d: deptId || null, p: personId || null, k: pw.h.slice(0, 16), e: Date.now() + TOKEN_DAYS * 864e5 }));
  return payload + '.' + sign_(payload);
}
function auth_(req) {
  const tok = String(req.token || ''), i = tok.indexOf('.');
  if (i < 0 || sign_(tok.slice(0, i)) !== tok.slice(i + 1)) fail_('auth');
  const t = JSON.parse(Utilities.newBlob(Utilities.base64DecodeWebSafe(tok.slice(0, i))).getDataAsString());
  if (t.e < Date.now()) fail_('auth');
  const org = getOrg_(); if (!org) fail_('auth');
  let deptId = t.d;
  if (t.r === 'staff') { const p = org.people.find(x => x.id === t.p); if (!p) fail_('auth'); deptId = p.deptId; }
  const pw = entityPw_(org, t.r, deptId, t.p);
  if (!pw || pw.h.slice(0, 16) !== t.k) fail_('auth');
  return { role: t.r, deptId: deptId, personId: t.p, org: org, name: actorName_(org, t.r, deptId, t.p) };
}
function actorName_(org, role, deptId, personId) {
  if (role === 'admin') return 'Quản trị (BGĐ/CFO)';
  const d = org.depts.find(x => x.id === deptId) || {};
  if (role === 'lead') return (d.leadName ? d.leadName + ' · ' : '') + 'Trưởng phòng ' + (d.name || '');
  const p = org.people.find(x => x.id === personId) || {};
  return p.name || 'Nhân sự';
}
function throttle_(key) {
  const c = CacheService.getScriptCache(), n = Number(c.get('f:' + key) || 0);
  if (n >= 8) fail_('locked');
  return () => c.put('f:' + key, String(n + 1), 900);
}

/* ───────── Tổ chức ───────── */
function getOrg_() { const s = CONF(); if (s.getLastRow() < 2) return null; const v = s.getRange(2, 2).getValue(); return v ? JSON.parse(v) : null; }
function setOrg_(o) { CONF().getRange(2, 1, 1, 2).setValues([['org', JSON.stringify(o)]]); }
function publicOrg_(org) {
  return {
    depts: org.depts.map(d => ({ id: d.id, name: d.name, leadName: d.leadName || '', hasPw: !!d.pw, active: d.active !== false })),
    people: org.people.map(p => ({ id: p.id, name: p.name, title: p.title || '', deptId: p.deptId, hasPw: !!p.pw, active: p.active !== false }))
  };
}
function log_(by, deptId, taskId, act, title, detail, ch) {
  LOG().appendRow([new Date().toISOString(), by, deptId || '', taskId || '', act, title || '', detail || '', ch && ch.length ? JSON.stringify(ch) : '']);
}
const newId_ = p => p + Utilities.getUuid().replace(/-/g, '').slice(0, 14);

/* ───────── Quyền ───────── */
function inScope_(s, deptId) { return s.role === 'admin' || deptId === s.deptId; }
function canEdit_(s, t) {
  if (s.role === 'admin') return true;
  if (s.role === 'lead') return t.deptId === s.deptId;
  return t.ownerId === s.personId && t.deptId === s.deptId && !t.accepted;
}
function canReview_(s, t) { return s.role === 'admin' || (s.role === 'lead' && t.deptId === s.deptId); }

/* ───────── API ───────── */
const API = {
  init() {
    const org = getOrg_();
    if (!org) return { setup: true };
    const o = publicOrg_(org);
    return { setup: false, depts: o.depts.filter(d => d.active), people: o.people.filter(p => p.active).map(p => ({ id: p.id, name: p.name, deptId: p.deptId, hasPw: p.hasPw })) };
  },

  setup(req) {
    return withLock_(() => {
      if (getOrg_()) fail_('already_setup');
      const depts = (req.depts || []).map(n => String(n).trim()).filter(Boolean).slice(0, 30)
        .map(name => ({ id: newId_('d'), name: name, leadName: '', pw: null, active: true }));
      const org = { admin: makePw_(req.pw), depts: depts, people: [], createdAt: new Date().toISOString() };
      setOrg_(org); TASKS(); FILES(); LOG();
      log_('Quản trị (BGĐ/CFO)', '', '', 'Thiết lập hệ thống', '', depts.length + ' phòng ban');
      return { token: issue_(org, 'admin') };
    });
  },

  login(req) {
    const org = getOrg_(); if (!org) fail_('not_setup');
    const role = req.role, key = role + ':' + (req.personId || req.deptId || 'admin');
    const bump = throttle_(key);
    let deptId = req.deptId, personId = req.personId;
    if (role === 'staff') { const p = org.people.find(x => x.id === personId); if (!p) fail_('not_found'); deptId = p.deptId; }
    const pw = entityPw_(org, role, deptId, personId);
    if (!pw) fail_('no_pw');
    if (hash_(String(req.pw || ''), pw.s) !== pw.h) { bump(); fail_('wrong_pw'); }
    return { token: issue_(org, role, deptId, personId) };
  },

  load(req) {
    const s = auth_(req);
    const tasks = rows_(TASKS()).filter(r => inScope_(s, r[1])).map(r => JSON.parse(r[6]));
    const files = rows_(FILES()).filter(r => inScope_(s, r[1])).map(r => JSON.parse(r[6]));
    const L = LOG(), n = L.getLastRow(), start = Math.max(2, n - 3000);
    const log = n < 2 ? [] : L.getRange(start, 1, n - start + 1, 8).getValues()
      .filter(r => s.role === 'admin' || r[2] === s.deptId)
      .slice(-400).reverse()
      .map(r => ({ at: r[0] instanceof Date ? r[0].toISOString() : r[0], by: r[1], deptId: r[2], taskId: r[3], act: r[4], title: r[5], detail: r[6], ch: r[7] ? JSON.parse(r[7]) : [] }));
    return { session: { role: s.role, deptId: s.deptId, personId: s.personId, name: s.name }, org: publicOrg_(s.org), tasks: tasks, files: files, log: log };
  },

  saveTask(req) {
    return withLock_(() => {
      const s = auth_(req), sh = TASKS(), inT = req.task || {};
      const row = inT.id ? findRow_(sh, inT.id) : -1;
      const old = row > 0 ? JSON.parse(sh.getRange(row, 7).getValue()) : null;
      if (inT.id && !old) fail_('not_found');
      const FIELDS = ['title', 'deptId', 'ownerId', 'horizon', 'period', 'kind', 'prio', 'due', 'output', 'metric', 'target', 'actual', 'unit', 'progress', 'status', 'selfNote', 'issue', 'doneAt', 'fromId', 'deleted'];
      const REVIEW = ['quality', 'review', 'accepted'];
      const t = Object.assign({}, old || {});
      const editable = old ? canEdit_(s, old) : true;
      const reviewable = old ? canReview_(s, old) : false;
      if (editable) FIELDS.forEach(k => { if (k in inT) t[k] = inT[k]; });
      if (reviewable) REVIEW.forEach(k => { if (k in inT) t[k] = inT[k]; });
      if (!editable && !reviewable) fail_('forbidden');
      if (!canEdit_(s, Object.assign({}, t, { accepted: false })) && !reviewable) fail_('forbidden');
      if (s.role === 'staff' && (t.ownerId !== s.personId || t.deptId !== s.deptId)) fail_('forbidden');
      if (s.role === 'lead' && t.deptId !== s.deptId) fail_('forbidden');
      if (!t.title || !t.due || !t.period) fail_('missing');
      const now = new Date().toISOString();
      if (!old) { t.id = newId_('t'); t.createdAt = now; t.createdBy = s.name; }
      t.updatedAt = now; t.updatedBy = s.name;
      const ch = (req.ch || []).slice(0, 25).map(c => [String(c[0]), String(c[1]).slice(0, 200), String(c[2]).slice(0, 200)]);
      const act = String(req.act || (old ? 'Sửa' : 'Tạo việc')).slice(0, 80);
      t.log = (old && old.log || []).concat([{ at: now, by: s.name, act: act, ch: ch }]).slice(-TASK_LOG_CAP);
      while (JSON.stringify(t).length > 45000 && t.log.length > 1) t.log.shift();
      const vals = [[t.id, t.deptId, t.ownerId, t.period, now, t.title, JSON.stringify(t)]];
      if (row > 0) sh.getRange(row, 1, 1, 7).setValues(vals); else sh.appendRow(vals[0]);
      log_(s.name, t.deptId, t.id, act, t.title, '', ch);
      return { task: t };
    });
  },

  upload(req) {
    const s = auth_(req);
    const deptId = s.role === 'admin' ? req.deptId : s.deptId;
    if (!deptId || !s.org.depts.some(d => d.id === deptId)) fail_('no_dept');
    let task = null;
    if (req.taskId) {
      const r = findRow_(TASKS(), req.taskId); if (r < 0) fail_('not_found');
      task = JSON.parse(TASKS().getRange(r, 7).getValue());
      if (!canEdit_(s, task) && !canReview_(s, task)) fail_('forbidden');
    }
    const bytes = Utilities.base64Decode(String(req.b64 || ''));
    if (!bytes.length) fail_('empty');
    if (bytes.length > MAX_FILE_MB * 1048576) fail_('too_large');
    const name = String(req.name || 'tai-lieu').slice(0, 180);
    const file = folder_().createFile(Utilities.newBlob(bytes, req.mime || 'application/octet-stream', name));
    const meta = { id: newId_('f'), name: name, ext: (name.split('.').pop() || '').toLowerCase(), size: bytes.length, mime: req.mime || '', deptId: task ? task.deptId : deptId,
      taskId: task ? task.id : null, ownerPersonId: s.personId || null, by: s.name, at: new Date().toISOString(), deleted: false };
    withLock_(() => FILES().appendRow([meta.id, meta.deptId, meta.taskId || '', meta.name, meta.size, file.getId(), JSON.stringify(meta)]));
    log_(s.name, meta.deptId, meta.taskId, 'Tải lên tài liệu', task ? task.title : '', name);
    return { file: meta };
  },

  download(req) {
    const s = auth_(req), sh = FILES(), r = findRow_(sh, req.id);
    if (r < 0) fail_('not_found');
    const v = sh.getRange(r, 1, 1, 7).getValues()[0], meta = JSON.parse(v[6]);
    if (!inScope_(s, meta.deptId) || meta.deleted) fail_('not_found');
    const blob = DriveApp.getFileById(v[5]).getBlob();
    return { name: meta.name, mime: blob.getContentType(), b64: Utilities.base64Encode(blob.getBytes()) };
  },

  deleteFile(req) {
    return withLock_(() => {
      const s = auth_(req), sh = FILES(), r = findRow_(sh, req.id);
      if (r < 0) fail_('not_found');
      const v = sh.getRange(r, 1, 1, 7).getValues()[0], meta = JSON.parse(v[6]);
      const ok = s.role === 'admin' || (s.role === 'lead' && meta.deptId === s.deptId) || (meta.ownerPersonId && meta.ownerPersonId === s.personId);
      if (!ok) fail_('forbidden');
      try { DriveApp.getFileById(v[5]).setTrashed(true); } catch (x) {}
      meta.deleted = true; meta.delBy = s.name; meta.delAt = new Date().toISOString();
      sh.getRange(r, 7).setValue(JSON.stringify(meta));
      log_(s.name, meta.deptId, meta.taskId, 'Xóa tài liệu', '', meta.name);
      return {};
    });
  },

  orgSave(req) {
    return withLock_(() => {
      const s = auth_(req), org = s.org, op = req.op, d = req.data || {};
      let act = '', detail = '', deptId = '';
      if (op === 'adminPw') {
        if (s.role !== 'admin') fail_('forbidden');
        org.admin = makePw_(d.pw); act = 'Đổi mật khẩu quản trị';
      } else if (op === 'dept') {
        if (s.role === 'staff') fail_('forbidden');
        let dep = d.id ? org.depts.find(x => x.id === d.id) : null;
        if (s.role === 'lead' && (!dep || dep.id !== s.deptId)) fail_('forbidden');
        if (!dep) { if (!d.name) fail_('missing'); dep = { id: newId_('d'), name: '', leadName: '', pw: null, active: true }; org.depts.push(dep); act = 'Thêm phòng'; }
        else act = d.pw ? 'Đặt mật khẩu phòng' : 'Sửa thông tin phòng';
        if (s.role === 'admin' && d.name) dep.name = String(d.name).trim();
        if ('leadName' in d) dep.leadName = String(d.leadName || '').trim();
        if (d.pw) dep.pw = makePw_(d.pw);
        detail = dep.name; deptId = dep.id;
      } else if (op === 'person') {
        if (s.role === 'staff') fail_('forbidden');
        let p = d.id ? org.people.find(x => x.id === d.id) : null;
        if (s.role === 'lead' && p && p.deptId !== s.deptId) fail_('forbidden');
        if (!p) { if (!d.name) fail_('missing'); p = { id: newId_('p'), name: '', title: '', deptId: s.role === 'lead' ? s.deptId : d.deptId, pw: null, active: true }; org.people.push(p); act = 'Thêm nhân sự'; }
        else act = d.pw ? 'Đặt mật khẩu nhân sự' : 'Sửa thông tin nhân sự';
        if (d.name) p.name = String(d.name).trim();
        if ('title' in d) p.title = String(d.title || '').trim();
        if (s.role === 'admin' && d.deptId && org.depts.some(x => x.id === d.deptId)) p.deptId = d.deptId;
        if ('active' in d) p.active = !!d.active;
        if (d.pw) p.pw = makePw_(d.pw);
        detail = p.name; deptId = p.deptId;
      } else if (op === 'myPw') {
        if (s.role !== 'staff') fail_('forbidden');
        const p = org.people.find(x => x.id === s.personId);
        if (hash_(String(d.old || ''), p.pw.s) !== p.pw.h) fail_('wrong_pw');
        p.pw = makePw_(d.pw); act = 'Đổi mật khẩu cá nhân'; detail = p.name; deptId = p.deptId;
      } else fail_('unknown_op');
      setOrg_(org);
      log_(s.name, deptId, '', act, '', detail);
      let token = null;
      try { token = issue_(org, s.role, s.deptId, s.personId); } catch (x) {}
      return { token: token };
    });
  }
};

function folder_() {
  const p = PropertiesService.getScriptProperties();
  const id = p.getProperty('FOLDER_ID');
  if (id) { try { return DriveApp.getFolderById(id); } catch (x) {} }
  const f = DriveApp.createFolder('Kế hoạch công việc HT - Tài liệu');
  p.setProperty('FOLDER_ID', f.getId());
  return f;
}

/** Chạy hàm này một lần trong trình soạn Apps Script để cấp quyền Sheet + Drive trước khi triển khai. */
function capQuyen() { TASKS(); FILES(); LOG(); CONF(); folder_(); secret_(); Logger.log('Đã sẵn sàng.'); }
