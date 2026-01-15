/* =========================================================
   命をツナグ - Vanilla JS single-page app (offline)
   - 状況 → 所属 → 対象者 → (部位) → 判断結果 → メール作成
   - マスタは localStorage に保存（パスワード付 管理画面で変更）
   ========================================================= */

(() => {
  'use strict';

  const STORAGE_KEY = 'inochi_master_v1';
  const SESSION_KEY = 'inochi_session_v1';

  /** =========================
   *  Utilities
   *  ========================= */
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  function nowIsoLocal() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return (
      d.getFullYear() +
      '-' +
      pad(d.getMonth() + 1) +
      '-' +
      pad(d.getDate()) +
      ' ' +
      pad(d.getHours()) +
      ':' +
      pad(d.getMinutes())
    );
  }

  function toast(msg) {
    const el = $('#toast');
    if (!el) return;
    el.textContent = msg;
    el.classList.add('show');
    window.clearTimeout(toast._t);
    toast._t = window.setTimeout(() => el.classList.remove('show'), 1800);
  }

  function uuid() {
    return 'id-' + Math.random().toString(16).slice(2) + '-' + Date.now().toString(16);
  }

  function normalizeEmails(str) {
    return String(str || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>'"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c]));
  }

  function kanaGroupFromKana(kana) {
    // Expect hiragana/katakana reading; group by first char.
    const s = (kana || '').trim();
    if (!s) return '他';

    const ch = s[0];
    const hira = toHiragana(ch);

    const groups = [
      { label: 'あ', chars: 'あいうえお' },
      { label: 'か', chars: 'かきくけこがぎぐげご' },
      { label: 'さ', chars: 'さしすせそざじずぜぞ' },
      { label: 'た', chars: 'たちつてとだぢづでど' },
      { label: 'な', chars: 'なにぬねの' },
      { label: 'は', chars: 'はひふへほばびぶべぼぱぴぷぺぽ' },
      { label: 'ま', chars: 'まみむめも' },
      { label: 'や', chars: 'やゆよ' },
      { label: 'ら', chars: 'らりるれろ' },
      { label: 'わ', chars: 'わをん' },
    ];

    for (const g of groups) {
      if (g.chars.includes(hira)) return g.label;
    }
    return '他';
  }

  function toHiragana(ch) {
    // Convert katakana to hiragana (single char)
    const code = ch.charCodeAt(0);
    // Katakana range
    if (code >= 0x30a1 && code <= 0x30f6) {
      return String.fromCharCode(code - 0x60);
    }
    return ch;
  }

  function mailtoLink(to, subject, body) {
    const list = (to || []).filter(Boolean).join(',');
    const qs = new URLSearchParams();
    qs.set('subject', subject || '');
    qs.set('body', body || '');
    // Some mail clients don't like '+' encoding; use encodeURIComponent via URLSearchParams is ok.
    return `mailto:${list}?${qs.toString()}`;
  }

  async function sha256Hex(text) {
    const enc = new TextEncoder();
    const buf = enc.encode(text);
    const digest = await crypto.subtle.digest('SHA-256', buf);
    const arr = Array.from(new Uint8Array(digest));
    return arr.map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  /** =========================
   *  Master data (defaults)
   *  ========================= */
  function defaultMaster() {
    return {
      version: 1,
      admin: {
        passwordHash: '', // SHA-256 hex
      },
      globalContacts: {
        safetyHQ: 'safety@example.com',
        rescueTeam: 'rescue@example.com',
        ambulanceCenter: 'dispatch@example.com',
      },
      companies: [
        { id: 'own', name: '自社', emails: ['aa@example.com', 'bb@example.com'] },
        { id: 'a', name: 'A造船', emails: ['cc@example.com', 'dd@example.com'] },
        { id: 'b', name: 'B株式会社', emails: ['ee@example.com'] },
      ],
      staff: [
        // NOTE: kana is the reading used for sorting buttons
        { id: uuid(), companyId: 'own', name: '佐藤 一郎', kana: 'さとういちろう' },
        { id: uuid(), companyId: 'own', name: '高橋 花子', kana: 'たかはしはなこ' },
        { id: uuid(), companyId: 'a', name: '山田 太郎', kana: 'やまだたろう' },
        { id: uuid(), companyId: 'a', name: '伊藤 次郎', kana: 'いとうじろう' },
        { id: uuid(), companyId: 'b', name: '鈴木 三郎', kana: 'すずきさぶろう' },
      ],
      situations: [
        {
          id: 'unconscious',
          label: '意識なし',
          hint: '',
          icon: '🧠',
          requiresBody: false,
          defaultAction: 'emergency',
          includeEmergency: ['safetyHQ', 'rescueTeam', 'ambulanceCenter'],
          includeObserve: ['safetyHQ'],
          recommendTextEmergency:
            '反応がない場合は呼吸や脈を確認し、すぐに救急車（119）を呼んでください。可能なら心肺蘇生（CPR）を開始します。',
          recommendTextObserve:
            '反応がない場合は緊急性が高い可能性があります。ためらわず緊急要請を選択してください。',
          subjectTpl: '[命をツナグ] {company} {person} - 意識なし',
          bodyTplEmergency:
            '{person}さん、「意識なし」、緊急救護必要、担架要請\n所属：{company}\n発生時刻：{time}\n\n状況：{detail}',
          bodyTplObserve:
            '{person}さん、「意識なし」疑い、至急確認をお願いします\n所属：{company}\n発生時刻：{time}\n\n状況：{detail}',
        },
        {
          id: 'bleeding_major',
          label: '大量出血',
          hint: '',
          icon: '🩸',
          requiresBody: true,
          defaultAction: 'emergency',
          includeEmergency: ['safetyHQ', 'rescueTeam', 'ambulanceCenter'],
          includeObserve: ['safetyHQ'],
          recommendTextEmergency:
            '出血部位を圧迫して止血し、可能なら患部を心臓より高く保ちます。迷わず救急車（119）を呼んでください。',
          recommendTextObserve:
            '出血が続く・多い場合は緊急要請が必要です。圧迫止血を継続してください。',
          subjectTpl: '[命をツナグ] {company} {person} - 大量出血',
          bodyTplEmergency:
            '{person}さん、「大量出血（{part}）」、緊急救護必要\n所属：{company}\n発生時刻：{time}\n\n状況：{detail}',
          bodyTplObserve:
            '{person}さん、「出血（{part}）」、経過観察しつつ状況共有\n所属：{company}\n発生時刻：{time}\n\n状況：{detail}',
        },
        {
          id: 'bleeding',
          label: '出血',
          hint: '',
          icon: '🩸',
          requiresBody: true,
          defaultAction: 'observe',
          includeEmergency: ['safetyHQ', 'rescueTeam', 'ambulanceCenter'],
          includeObserve: ['safetyHQ'],
          recommendTextEmergency:
            '出血が止まらない・量が多い・意識がぼんやりする場合は、迷わず救急要請してください。',
          recommendTextObserve:
            '出血部位を圧迫して止血し、改善しない場合は緊急要請へ切り替えてください。',
          subjectTpl: '[命をツナグ] {company} {person} - 出血',
          bodyTplEmergency:
            '{person}さん、「出血（{part}）」、緊急救護必要\n所属：{company}\n発生時刻：{time}\n\n状況：{detail}',
          bodyTplObserve:
            '{person}さん、「出血（{part}）」、様子を見つつ状況共有\n所属：{company}\n発生時刻：{time}\n\n状況：{detail}',
        },
        {
          id: 'fall',
          label: '転落',
          hint: '',
          icon: '🧗',
          requiresBody: false,
          defaultAction: 'emergency',
          includeEmergency: ['safetyHQ', 'rescueTeam', 'ambulanceCenter'],
          includeObserve: ['safetyHQ'],
          recommendTextEmergency:
            '頭部・体幹を動かさず安静にし、必要に応じて救急車（119）を呼んでください。',
          recommendTextObserve:
            '痛み・しびれ・意識変容があれば緊急要請へ切り替えてください。',
          subjectTpl: '[命をツナグ] {company} {person} - 転落',
          bodyTplEmergency:
            '{person}さん、「転落」、緊急救護必要\n所属：{company}\n発生時刻：{time}\n\n状況：{detail}',
          bodyTplObserve:
            '{person}さん、「転落」疑い、状況共有\n所属：{company}\n発生時刻：{time}\n\n状況：{detail}',
        },
        {
          id: 'electric',
          label: '感電',
          hint: '電気事故',
          icon: '⚡',
          requiresBody: false,
          defaultAction: 'emergency',
          includeEmergency: ['safetyHQ', 'rescueTeam', 'ambulanceCenter'],
          includeObserve: ['safetyHQ'],
          recommendTextEmergency:
            '安全確保（通電停止）後、意識・呼吸を確認。異常があれば救急車（119）を呼んでください。',
          recommendTextObserve:
            '軽症でも遅れて症状が出ることがあります。必ず上長・安全課へ共有してください。',
          subjectTpl: '[命をツナグ] {company} {person} - 感電',
          bodyTplEmergency:
            '{person}さん、「感電」、緊急救護必要\n所属：{company}\n発生時刻：{time}\n\n状況：{detail}',
          bodyTplObserve:
            '{person}さん、「感電」疑い、状況共有\n所属：{company}\n発生時刻：{time}\n\n状況：{detail}',
        },
        {
          id: 'pinched',
          label: '挟まれ',
          hint: '',
          icon: '🧱',
          requiresBody: false,
          defaultAction: 'emergency',
          includeEmergency: ['safetyHQ', 'rescueTeam'],
          includeObserve: ['safetyHQ'],
          recommendTextEmergency:
            '挟まれの場合は二次災害に注意しつつ救出。出血や意識障害があれば救急車（119）。',
          recommendTextObserve:
            '痛みや腫れが強い場合は緊急要請へ切り替えてください。',
          subjectTpl: '[命をツナグ] {company} {person} - 挟まれ',
          bodyTplEmergency:
            '{person}さん、「挟まれ」、緊急救護必要\n所属：{company}\n発生時刻：{time}\n\n状況：{detail}',
          bodyTplObserve:
            '{person}さん、「挟まれ」疑い、状況共有\n所属：{company}\n発生時刻：{time}\n\n状況：{detail}',
        },
        {
          id: 'pain',
          label: '痛み',
          hint: '',
          icon: '🤕',
          requiresBody: true,
          defaultAction: 'observe',
          includeEmergency: ['safetyHQ', 'rescueTeam'],
          includeObserve: ['safetyHQ'],
          recommendTextEmergency:
            '強い痛み、変形、しびれ、出血がある場合は緊急要請を選択してください。',
          recommendTextObserve:
            '患部を安静にし、症状が改善しない/悪化する場合は緊急要請へ切り替えてください。',
          subjectTpl: '[命をツナグ] {company} {person} - 痛み',
          bodyTplEmergency:
            '{person}さん、「{part}に痛み」、緊急救護必要\n所属：{company}\n発生時刻：{time}\n\n状況：{detail}',
          bodyTplObserve:
            '{person}さん、{part}に痛み、様子を見る\n所属：{company}\n発生時刻：{time}\n\n状況：{detail}',
        },
        {
          id: 'dizzy',
          label: '立ち眩み',
          hint: '',
          icon: '💫',
          requiresBody: false,
          defaultAction: 'observe',
          includeEmergency: ['safetyHQ'],
          includeObserve: ['safetyHQ'],
          recommendTextEmergency:
            '意識低下、胸痛、呼吸困難などがある場合は緊急要請してください。',
          recommendTextObserve:
            '安全な場所で座らせ、無理に立たせず、改善しない場合は緊急要請へ切り替えてください。',
          subjectTpl: '[命をツナグ] {company} {person} - 立ち眩み',
          bodyTplEmergency:
            '{person}さん、「立ち眩み」、緊急対応が必要\n所属：{company}\n発生時刻：{time}\n\n状況：{detail}',
          bodyTplObserve:
            '{person}さん、「立ち眩み」、様子を見つつ状況共有\n所属：{company}\n発生時刻：{time}\n\n状況：{detail}',
        },
        {
          id: 'vomit',
          label: '嘔吐',
          hint: '',
          icon: '🤢',
          requiresBody: false,
          defaultAction: 'observe',
          includeEmergency: ['safetyHQ'],
          includeObserve: ['safetyHQ'],
          recommendTextEmergency:
            '意識障害、血を吐く、激しい腹痛がある場合は緊急要請してください。',
          recommendTextObserve:
            '横向きに寝かせ、誤嚥に注意し、改善しない場合は緊急要請へ切り替えてください。',
          subjectTpl: '[命をツナグ] {company} {person} - 嘔吐',
          bodyTplEmergency:
            '{person}さん、「嘔吐」、緊急対応が必要\n所属：{company}\n発生時刻：{time}\n\n状況：{detail}',
          bodyTplObserve:
            '{person}さん、「嘔吐」、様子を見つつ状況共有\n所属：{company}\n発生時刻：{time}\n\n状況：{detail}',
        },
        {
          id: 'cant_stand',
          label: '立てない',
          hint: '',
          icon: '🧍',
          requiresBody: false,
          defaultAction: 'observe',
          includeEmergency: ['safetyHQ'],
          includeObserve: ['safetyHQ'],
          recommendTextEmergency:
            '意識がない、呼吸が苦しい、強い痛みがある場合は緊急要請してください。',
          recommendTextObserve:
            '無理に動かさず安静にし、改善しない場合は緊急要請へ切り替えてください。',
          subjectTpl: '[命をツナグ] {company} {person} - 立てない',
          bodyTplEmergency:
            '{person}さん、「立てない」、緊急対応が必要\n所属：{company}\n発生時刻：{time}\n\n状況：{detail}',
          bodyTplObserve:
            '{person}さん、「立てない」、様子を見つつ状況共有\n所属：{company}\n発生時刻：{time}\n\n状況：{detail}',
        },
        {
          id: 'other',
          label: 'その他',
          hint: '',
          icon: '➕',
          requiresBody: false,
          defaultAction: 'observe',
          includeEmergency: ['safetyHQ', 'rescueTeam'],
          includeObserve: ['safetyHQ'],
          recommendTextEmergency:
            '緊急性が疑われる場合は、迷わず緊急要請してください。',
          recommendTextObserve:
            '状況を整理して共有し、必要に応じて緊急要請へ切り替えてください。',
          subjectTpl: '[命をツナグ] {company} {person} - その他',
          bodyTplEmergency:
            '{person}さん、「その他」、緊急救護必要\n所属：{company}\n発生時刻：{time}\n\n状況：{detail}',
          bodyTplObserve:
            '{person}さん、「その他」、状況共有\n所属：{company}\n発生時刻：{time}\n\n状況：{detail}',
        },
      ],
      bodyParts: [
        { id: 'head', label: '頭' },
        { id: 'neck', label: '首' },
        { id: 'torso', label: '胸/腹' },
        { id: 'leftArm', label: '左腕' },
        { id: 'rightArm', label: '右腕' },
        { id: 'leftHand', label: '左手' },
        { id: 'rightHand', label: '右手' },
        { id: 'hips', label: '腰' },
        { id: 'leftLeg', label: '左脚' },
        { id: 'rightLeg', label: '右脚' },
        { id: 'leftFoot', label: '左足' },
        { id: 'rightFoot', label: '右足' },
      ],
    };
  }

  function loadMaster() {
    // Merge with defaults so new fields/situations are added even if older data exists in localStorage
    const def = defaultMaster();

    function mergeById(defArr, savedArr) {
      const map = new Map();
      defArr.forEach((x) => map.set(x.id, x));

      if (Array.isArray(savedArr)) {
        for (const x of savedArr) {
          if (!x || !x.id) continue;
          const base = map.get(x.id) || {};
          map.set(x.id, { ...base, ...x });
        }
      }

      const ordered = [];
      const seen = new Set();
      for (const x of defArr) {
        const v = map.get(x.id);
        if (v) {
          ordered.push(v);
          seen.add(x.id);
        }
      }
      for (const [id, v] of map.entries()) {
        if (!seen.has(id)) ordered.push(v);
      }
      return ordered;
    }

    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return def;

      const parsed = JSON.parse(raw) || {};
      const merged = { ...def, ...parsed };

      merged.companies = mergeById(def.companies, parsed.companies);
      merged.staff = mergeById(def.staff, parsed.staff);
      merged.situations = mergeById(def.situations, parsed.situations);
      merged.bodyParts = mergeById(def.bodyParts, parsed.bodyParts);

      return merged;
    } catch (e) {
      console.warn('Failed to load master; using default', e);
      return def;
    }
  }

  function saveMaster(master) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(master));
  }

  function loadSession() {
    try {
      const raw = localStorage.getItem(SESSION_KEY);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  function saveSession(session) {
    localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  }

  /** =========================
   *  App state & navigation
   *  ========================= */
  const state = {
    mode: 'unsure', // 'emergency' | 'unsure' (affects visible situations)
    situationId: null,
    companyId: null,
    personId: null,
    bodyPartId: null,
    detailNote: '', // optional
    action: null, // 'emergency' | 'observe' (selected on result)
    preview: { to: [], subject: '', body: '' },
  };

  const nav = {
    stack: ['view-home'],
    show(viewId, { push = true } = {}) {
      $$('.view').forEach((v) => v.classList.remove('active'));
      const el = document.getElementById(viewId);
      if (!el) return;
      el.classList.add('active');

      // Topbar visibility
      const topbar = $('#topbar');
      if (viewId === 'view-home') topbar.style.display = 'none';
      else topbar.style.display = 'flex';

      if (push) {
        const current = nav.stack[nav.stack.length - 1];
        if (current !== viewId) nav.stack.push(viewId);
      }
    },
    back() {
      if (nav.stack.length <= 1) {
        nav.show('view-home', { push: false });
        nav.stack = ['view-home'];
        return;
      }
      nav.stack.pop();
      nav.show(nav.stack[nav.stack.length - 1], { push: false });
    },
    restartAll() {
      nav.stack = ['view-home'];
      resetFlow();
      nav.show('view-home', { push: false });
    },
  };

  function resetFlow() {
    state.situationId = null;
    state.companyId = null;
    state.personId = null;
    state.bodyPartId = null;
    state.detailNote = '';
    state.action = null;
    state.preview = { to: [], subject: '', body: '' };

    // reset body selection UI
    $$('#bodySvg .body-part').forEach((p) => p.classList.remove('selected'));
    $('#bodySelectedLabel').textContent = '未選択';
    $('#btnBodyNext').disabled = true;

    // clear kana
    $$('#kanaBar .kana-btn').forEach((b) => b.classList.remove('active'));

    saveSession({ ...state, nav: nav.stack });
  }

  /** =========================
   *  Rendering
   *  ========================= */
  let master = loadMaster();

  function getSituation(id) {
    return master.situations.find((s) => s.id === id) || null;
  }
  function getCompany(id) {
    return master.companies.find((c) => c.id === id) || null;
  }
  function getPerson(id) {
    return master.staff.find((p) => p.id === id) || null;
  }
  function getBodyPart(id) {
    return master.bodyParts.find((b) => b.id === id) || null;
  }

  const STATUS_PRESET = {
    emergency: ['unconscious', 'bleeding_major', 'fall', 'electric', 'pinched', 'other'],
    unsure: ['bleeding', 'dizzy', 'pain', 'vomit', 'cant_stand', 'other'],
  };

  function getPresetSituations(mode) {
    const ids = STATUS_PRESET[mode];
    if (!ids) return null;
    const list = [];
    for (const id of ids) {
      const s = getSituation(id);
      if (s) list.push(s);
    }
    return list;
  }

  function renderStatusGrid() {
    const grid = $('#statusGrid');
    grid.innerHTML = '';

    let situations = getPresetSituations(state.mode) || master.situations.slice();

    for (const s of situations) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'card-btn status-card';
      btn.setAttribute('role', 'listitem');
      const iconHtml = s.icon ? `<div class="icon" aria-hidden="true">${escapeHtml(s.icon || '')}</div>` : '';
      const hintHtml = s.hint ? `<span>${escapeHtml(s.hint || '')}</span>` : '';
      btn.innerHTML = `
        ${iconHtml}
        <div class="label">
          <strong>${escapeHtml(s.label)}</strong>
          ${hintHtml}
        </div>
      `;
      btn.addEventListener('click', () => {
        // pick situation
        state.situationId = s.id;
        state.companyId = null;
        state.personId = null;
        state.bodyPartId = null;
        state.action = null;

        saveSession({ ...state, nav: nav.stack });

        // If body-part selection is required, do it BEFORE affiliation/person
        if (s.requiresBody) {
          $('#bodyTitle').textContent = s.label;
          const q = $('#bodyQuestion');
          if (q) q.textContent = '出血・痛みの部位をタップしてください。';
          nav.show('view-body');
          return;
        }

        // Emergency mode: auto request (demo) right after situation
        if (state.mode === 'emergency') {
          showEmergencyCallView();
          return;
        }

        renderCompanyList();
        nav.show('view-company');
      });
      grid.appendChild(btn);
    }
  }

  function renderCompanyList() {
    const wrap = $('#companyList');
    wrap.innerHTML = '';

    for (const c of master.companies) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'list-btn';
      btn.setAttribute('role', 'listitem');

      const emails = (c.emails || []).join(', ');
      btn.innerHTML = `${escapeHtml(c.name)}<span class="sub">${emails ? '送信先: ' + escapeHtml(emails) : ''}</span>`;
      btn.addEventListener('click', () => {
        state.companyId = c.id;
        state.personId = null;
        saveSession({ ...state, nav: nav.stack });

        // Affiliation -> staff selection (unsure flow also uses staff selection)
        renderKanaBar();
        renderPersonList('あ');
        nav.show('view-person');
      });
      wrap.appendChild(btn);
    }
  }

  function renderKanaBar() {
    const bar = $('#kanaBar');
    bar.innerHTML = '';

    const groups = ['あ', 'か', 'さ', 'た', 'な', 'は', 'ま', 'や', 'ら', 'わ', '他'];
    groups.forEach((g, idx) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'kana-btn';
      b.textContent = g;
      b.addEventListener('click', () => {
        $$('#kanaBar .kana-btn').forEach((x) => x.classList.remove('active'));
        b.classList.add('active');
        renderPersonList(g);
      });
      if (idx === 0) b.classList.add('active');
      bar.appendChild(b);
    });
  }

  function renderPersonList(groupLabel) {
    const list = $('#personList');
    list.innerHTML = '';

    const people = master.staff
      .filter((p) => p.companyId === state.companyId)
      .map((p) => ({ ...p, group: kanaGroupFromKana(p.kana) }))
      .filter((p) => (groupLabel ? p.group === groupLabel : true))
      .sort((a, b) => (a.kana || '').localeCompare(b.kana || '', 'ja'));

    if (people.length === 0) {
      const div = document.createElement('div');
      div.className = 'small';
      div.textContent = '該当する職員がいません（管理画面で登録してください）。';
      list.appendChild(div);
      return;
    }

    for (const p of people) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'list-btn';
      btn.setAttribute('role', 'listitem');
      btn.innerHTML = `${escapeHtml(p.name)}<span class="sub">よみ: ${escapeHtml(p.kana || '')}</span>`;
      btn.addEventListener('click', () => {
        state.personId = p.id;
        saveSession({ ...state, nav: nav.stack });

        const s = getSituation(state.situationId);

        // Safety: if body is required but not selected yet, ask body first
        if (s && s.requiresBody && !state.bodyPartId) {
          $('#bodyTitle').textContent = s.label;
          nav.show('view-body');
          return;
        }

        if (state.mode === 'emergency') {
          showEmergencyCallView();
          return;
        }

        // unsure flow -> result + (existing) mail preview
        buildResultPreview();
        nav.show('view-result');
      });
      list.appendChild(btn);
    }
  }

  function renderBodyPartsHandlers() {
    $$('#bodySvg .body-part').forEach((el) => {
      el.addEventListener('click', () => {
        $$('#bodySvg .body-part').forEach((p) => p.classList.remove('selected'));
        el.classList.add('selected');
        state.bodyPartId = el.getAttribute('data-part');
        const bp = getBodyPart(state.bodyPartId);
        $('#bodySelectedLabel').textContent = bp ? bp.label : '選択中';
        $('#btnBodyNext').disabled = !state.bodyPartId;
        saveSession({ ...state, nav: nav.stack });
      });
    });
  }

  /** =========================
   *  Result / mail preview
   *  ========================= */
  function interpolate(tpl, vars) {
    return String(tpl || '').replace(/\{(\w+)\}/g, (_, k) => (vars[k] != null ? String(vars[k]) : ''));
  }

  function buildRecipientsForAction(action) {
    const s = getSituation(state.situationId);
    const c = getCompany(state.companyId);

    const groups = action === 'emergency' ? (s?.includeEmergency || []) : (s?.includeObserve || []);
    const to = [];

    // global groups
    for (const g of groups) {
      if (g === 'safetyHQ' && master.globalContacts.safetyHQ) to.push(master.globalContacts.safetyHQ);
      if (g === 'rescueTeam' && master.globalContacts.rescueTeam) to.push(master.globalContacts.rescueTeam);
      if (g === 'ambulanceCenter' && master.globalContacts.ambulanceCenter) to.push(master.globalContacts.ambulanceCenter);
    }

    // company contacts
    if (c && c.emails) to.push(...c.emails);

    // de-dup
    return Array.from(new Set(to.filter(Boolean)));
  }

  function showEmergencyCallView() {
    // Emergency mode: auto "request" (demo) + mail launch button only (no preview UI)
    state.action = 'emergency';
    state.preview = buildMail('emergency');

    nav.show('view-emergency');
    saveSession({ ...state, nav: nav.stack });

    // FEATURE START
    feature_renderDetailMount();
    // FEATURE END

    // Demo feedback
    toast('（デモ）救急要請を開始しました');
  }


  function buildMail(action) {
    const s = getSituation(state.situationId);
    const c = getCompany(state.companyId);
    const p = getPerson(state.personId);
    const bp = getBodyPart(state.bodyPartId);

    const time = nowIsoLocal();
    const part = bp ? bp.label : '';
    const detail = state.detailNote || '';
    const vars = {
      company: c?.name || '',
      person: p?.name || '',
      time,
      part,
      detail: detail || '（追記なし）',
    };

    const subject = interpolate(s?.subjectTpl || '[命をツナグ] 連絡', vars);
    const bodyTpl = action === 'emergency' ? s?.bodyTplEmergency : s?.bodyTplObserve;
    let body = interpolate(bodyTpl || '{person} {company} {time}', vars);

    // FEATURE START
    try {
      const caseData = feature_state.currentCaseId ? feature_getCaseById(feature_state.currentCaseId) : null;
      feature_state.lastMailTime = time;
      body = buildMailBody(caseData);
    } catch {
      // ignore
    }
    // FEATURE END

    return { to: buildRecipientsForAction(action), subject, body };
  }

  function buildResultText(action) {
    const s = getSituation(state.situationId);
    return action === 'emergency' ? s?.recommendTextEmergency : s?.recommendTextObserve;
  }

  function buildResultPreview() {
    const s = getSituation(state.situationId);
    const action = state.action || s?.defaultAction || 'observe';

    state.action = action;
    state.preview = buildMail(action);

    // Summary
    $('#sumStatus').textContent = s?.label || '-';
    $('#sumCompany').textContent = getCompany(state.companyId)?.name || '-';
    $('#sumPerson').textContent = getPerson(state.personId)?.name || '-';

    const bp = getBodyPart(state.bodyPartId);
    const detail = bp ? `${bp.label}${s?.id === 'pain' ? 'に痛み' : ''}` : '';
    const hasDetail = Boolean(detail);
    $('#sumDetailRow').style.display = hasDetail ? 'flex' : 'none';
    $('#sumDetail').textContent = hasDetail ? detail : '-';

    // Result text
    $('#resultText').textContent = buildResultText(action) || '';

    // Buttons labels/toggles
    const btnE = $('#btnActionEmergency');
    const btnO = $('#btnActionObserve');

    // In emergency mode / emergency default, keep emergency prominent but still allow observe.
    btnE.style.display = 'block';
    btnO.style.display = 'block';

    // Preview
    $('#mailToPreview').textContent = (state.preview.to || []).join(', ') || '-';
    $('#mailSubjectPreview').textContent = state.preview.subject || '-';
    $('#mailBodyPreview').textContent = state.preview.body || '-';

    // FEATURE START
    feature_renderDetailMount();
    // FEATURE END

    saveSession({ ...state, nav: nav.stack });
  }

  async function copyPreview() {
    const text =
      `宛先: ${state.preview.to.join(', ')}\n` +
      `件名: ${state.preview.subject}\n` +
      `本文:\n${state.preview.body}`;
    try {
      await navigator.clipboard.writeText(text);
      toast('コピーしました');
    } catch {
      // fallback
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
      toast('コピーしました');
    }
  }

  function openMail() {
    // FEATURE START
    try {
      // Ensure the latest case info is reflected at the moment of opening mail
      const s = getSituation(state.situationId);
      const action = state.action || s?.defaultAction || 'observe';
      state.action = action;
      state.preview = buildMail(action);
    } catch {
      // ignore
    }
    // FEATURE END
    const { to, subject, body } = state.preview;
    const href = mailtoLink(to, subject, body);
    // Must be user gesture; called inside click handlers
    window.location.href = href;
  }

  // FEATURE START
  const FEATURE_CASES_KEY = 'inochi_cases_v1';
  const feature_state = {
    currentCaseId: null,
    activeQrKey: null, // 'personal' | 'location' | null
    sessionId: String(Date.now()),
    lastMailTime: null,
    qr: {
      personal: { scanner: null },
      location: { scanner: null },
    },
    mapTempTap: null,
  };

  const FEATURE_NAME_CANDIDATES = [
    '山田 太郎',
    '佐藤 花子',
    '鈴木 次郎',
    '高橋 三郎',
    '田中 四郎',
  ];

  const FEATURE_LOC_DICT = {
    機械ヤード: '/assets/maps/機械ヤード.png',
  };

  const BASE_ORIGIN = 'https://new-app-j02t.onrender.com';

  function toAbsoluteUrl(pathOrUrl) {
    if (!pathOrUrl) return '';
    if (pathOrUrl.startsWith('http')) return pathOrUrl;
    return BASE_ORIGIN.replace(/\/$/, '') + '/' + pathOrUrl.replace(/^\//, '');
  }

  function buildMailBody(caseData) {
    const s = getSituation(state.situationId);
    const c = getCompany(state.companyId);
    const p = getPerson(state.personId);
    const bp = getBodyPart(state.bodyPartId);

    const time = feature_state.lastMailTime || nowIsoLocal();
    const part = bp ? bp.label : '';
    const detail = state.detailNote || '';

    const cd = caseData || {};
    const personal = cd.personalQrText ? cd.personalQrText : '未設定';
    const loc = cd.locationQrValue ? cd.locationQrValue : '未設定';

    const abs = cd.locationMapResolved ? toAbsoluteUrl(cd.locationMapResolved) : '';
    const mapUrl = abs ? encodeURI(abs) : '';
    const map = mapUrl ? mapUrl : '未設定';

    const metaAll = Array.isArray(cd.attachmentsMeta) ? cd.attachmentsMeta : [];
    const meta = metaAll.filter((m) => m && m.sessionId === feature_state.sessionId);
    const imgs = meta.filter((m) => String(m?.type || '').startsWith('image/'));
    const vids = meta.filter((m) => String(m?.type || '').startsWith('video/'));

    const listNames = (arr) => arr.slice(0, 5).map((m) => m.name).filter(Boolean).join(', ');

    const flowType = cd.flowType || '未設定';
    const symptomName = cd.symptomName || s?.label || '未設定';
    const caseStatus = cd.status || '未設定';
    const assignee = cd.assignee ? cd.assignee : '';
    const action = state.action || (s?.defaultAction || 'observe');
    const actionLabel = action === 'emergency' ? '緊急要請' : action === 'observe' ? '様子見' : String(action);

    let body = '';
    body += `状況：${s?.label || '未設定'}\n`;
    body += `所属：${c?.name || '未設定'}\n`;
    body += `対象者：${p?.name || '未設定'}\n`;
    body += `発生時刻：${time}\n`;
    body += `症状：${symptomName}\n`;
    if (part) body += `部位：${part}\n`;
    body += `対応方針：${actionLabel}\n`;
    body += `対応状況：${caseStatus}${assignee ? `（担当：${assignee}）` : ''}\n`;
    body += `種別：${flowType}\n`;
    body += `追記：${detail || '（追記なし）'}\n`;

    body += `\n【QR読取情報】\n`;
    body += `個人情報：${personal}\n`;
    body += `場所：${loc}\n`;
    body += `地図URL：${map}\n`;

    body += `\n【添付情報（※ファイルは添付されません）】\n`;
    body += `画像：${imgs.length}件${imgs.length ? `（${listNames(imgs)}）` : ''}\n`;
    body += `動画：${vids.length}件${vids.length ? `（${listNames(vids)}）` : ''}\n`;
    body += `\n※ファイルはメールに添付されません（本文に件数/名前のみ記載）。再読み込み後は再選択が必要です。`;
    return body;
  }

  function feature_loadCases() {
    try {
      const raw = localStorage.getItem(FEATURE_CASES_KEY);
      const arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr : [];
    } catch {
      return [];
    }
  }

  function feature_saveCases(cases) {
    localStorage.setItem(FEATURE_CASES_KEY, JSON.stringify(cases || []));
  }

  function feature_getCaseById(caseId) {
    return feature_loadCases().find((c) => c && c.id === caseId) || null;
  }

  function feature_upsertCase(next) {
    const cases = feature_loadCases();
    const idx = cases.findIndex((c) => c && c.id === next.id);
    if (idx >= 0) cases[idx] = next;
    else cases.push(next);
    feature_saveCases(cases);
  }

  function feature_makeCase({ flowType, symptomName }) {
    return {
      id: uuid(),
      createdAt: new Date().toISOString(),
      flowType,
      symptomName,
      personalQrText: '',
      locationQrValue: '',
      locationMapResolved: '',
      selectedName: '',
      status: '未対応',
      assignee: '',
      mapTap: null,
      attachmentsMeta: [],
    };
  }

  function feature_ensureCurrentCase(flowType) {
    const s = getSituation(state.situationId);
    const symptomName = s?.label || '';

    const existing = feature_state.currentCaseId ? feature_getCaseById(feature_state.currentCaseId) : null;
    if (existing && existing.flowType === flowType && existing.symptomName === symptomName) return existing;

    const created = feature_makeCase({ flowType, symptomName });
    feature_state.currentCaseId = created.id;
    feature_upsertCase(created);
    return created;
  }

  function feature_setMsg(el, msg) {
    if (!el) return;
    el.textContent = msg || '';
  }

  function feature_humanizeCameraError(err) {
    const name = err?.name || '';
    if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
      return (
        'カメラの利用が許可されませんでした。ブラウザの設定でカメラ許可をONにして、もう一度お試しください。\n' +
        '※ Safari/Chromeで開いてください（アプリ内ブラウザでは動かない場合があります）。'
      );
    }
    if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
      return 'カメラが見つかりませんでした。端末にカメラがあるか確認してください。';
    }
    if (name === 'NotReadableError' || name === 'TrackStartError') {
      return 'カメラを起動できませんでした。他のアプリがカメラを使用中の可能性があります。';
    }
    if (name === 'SecurityError') {
      return 'セキュリティの制約でカメラを利用できませんでした。HTTPSで開いてください。';
    }
    return '読み取りを開始できませんでした。\n※ Safari/Chromeで開いてください（アプリ内ブラウザでは動かない場合があります）。';
  }

  function feature_stopAllQr({ silent = true } = {}) {
    feature_stopQr('personal', { silent });
    feature_stopQr('location', { silent });
  }

  async function feature_stopQr(kind, { silent = false } = {}) {
    const slot = feature_state.qr[kind];
    if (!slot) return;

    try {
      if (slot.scanner) {
        await slot.scanner.stop();
        slot.scanner.destroy();
        slot.scanner = null;
      }
    } catch {
      // ignore
    }

    const wrap = document.getElementById(`feature_${kind}_videoWrap`);
    const video = document.getElementById(`feature_${kind}_video`);
    const btnStart = document.getElementById(`feature_${kind}_btnStart`);
    const btnStop = document.getElementById(`feature_${kind}_btnStop`);
    const msg = document.getElementById(`feature_${kind}_msg`);

    if (video) {
      try {
        video.pause();
      } catch {
        // ignore
      }
      video.srcObject = null;
    }
    wrap?.classList.add('hidden');
    if (btnStart) btnStart.disabled = false;
    if (btnStop) btnStop.disabled = true;

    if (!silent) feature_setMsg(msg, '停止しました。');
    if (feature_state.activeQrKey === kind) feature_state.activeQrKey = null;
  }

  function feature_locNormalizeKey(id) {
    return String(id || '')
      .trim()
      .replace(/[ \u3000]/g, '');
  }

  async function feature_resolveLocationMap(locRaw) {
    const raw = String(locRaw || '').trim();
    if (!raw.startsWith('LOC:')) {
      return { ok: false, message: '場所QRは "LOC:<id>" の形式で読み取ってください。' };
    }
    const id = raw.slice(4).trim();
    const key = feature_locNormalizeKey(id);
    if (!key) return { ok: false, message: '場所QRのIDが空です。' };

    const direct = FEATURE_LOC_DICT[key];
    if (direct) return { ok: true, url: direct, key };

    const fallbackUrl = `/assets/maps/${encodeURIComponent(id)}.png`;
    // Existence check (best-effort)
    try {
      await new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve();
        img.onerror = () => reject(new Error('notfound'));
        img.src = fallbackUrl;
      });
      return { ok: true, url: fallbackUrl, key };
    } catch {
      return { ok: false, message: `未登録の場所です: ${id}` };
    }
  }

  async function feature_startQr(kind) {
    const other = kind === 'personal' ? 'location' : 'personal';
    await feature_stopQr(other, { silent: true });

    const btnStart = document.getElementById(`feature_${kind}_btnStart`);
    const btnStop = document.getElementById(`feature_${kind}_btnStop`);
    const wrap = document.getElementById(`feature_${kind}_videoWrap`);
    const video = document.getElementById(`feature_${kind}_video`);
    const msg = document.getElementById(`feature_${kind}_msg`);

    if (!btnStart || !btnStop || !wrap || !video) return;

    feature_setMsg(msg, '');

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      feature_setMsg(
        msg,
        'このブラウザはカメラに対応していません。\n※ Safari/Chromeで開いてください（アプリ内ブラウザでは動かない場合があります）。'
      );
      return;
    }

    const QrScannerLib = window.QrScanner;
    if (!QrScannerLib) {
      feature_setMsg(msg, 'QR読み取りライブラリの読み込みに失敗しました。通信状況を確認してください。');
      return;
    }

    // Worker 404 再発防止（必ず生成前に設定）
    QrScannerLib.WORKER_PATH = 'https://unpkg.com/qr-scanner@1.4.2/qr-scanner-worker.min.js';

    try {
      await feature_stopQr(kind, { silent: true });
      btnStart.disabled = true;
      btnStop.disabled = false;
      wrap.classList.remove('hidden');

      feature_state.activeQrKey = kind;

      feature_state.qr[kind].scanner = new QrScannerLib(
        video,
        async (result) => {
          const text = typeof result === 'string' ? result : (result?.data ?? '');
          const t = String(text || '').trim();
          if (!t) return;

          const c = feature_state.currentCaseId ? feature_getCaseById(feature_state.currentCaseId) : null;
          if (!c) return;

          if (kind === 'personal') {
            c.personalQrText = t;
            feature_upsertCase(c);
            feature_renderDetailMount();
            return;
          }

          // location
          c.locationQrValue = t;
          c.locationMapResolved = '';
          feature_upsertCase(c);

          const res = await feature_resolveLocationMap(t);
          if (res.ok) {
            c.locationMapResolved = res.url;
            feature_upsertCase(c);
          } else {
            feature_setMsg(msg, res.message);
          }
          feature_renderDetailMount();
        },
        {
          preferredCamera: 'environment',
          highlightScanRegion: false,
          highlightCodeOutline: false,
        }
      );

      await feature_state.qr[kind].scanner.start();
      feature_setMsg(msg, 'カメラを起動しました。QRコードを映してください。');
    } catch (err) {
      await feature_stopQr(kind, { silent: true });
      btnStart.disabled = false;
      btnStop.disabled = true;
      wrap.classList.add('hidden');
      feature_setMsg(msg, feature_humanizeCameraError(err));
    }
  }

  function feature_shorten(s, max = 18) {
    const t = String(s || '');
    if (t.length <= max) return t;
    return t.slice(0, max) + '…';
  }

  function feature_refreshMailPreviewUi() {
    const view = document.getElementById('view-result');
    if (!view || !view.classList.contains('active')) return;

    const s = getSituation(state.situationId);
    const action = state.action || s?.defaultAction || 'observe';
    state.action = action;
    state.preview = buildMail(action);

    $('#mailToPreview').textContent = (state.preview.to || []).join(', ') || '-';
    $('#mailSubjectPreview').textContent = state.preview.subject || '-';
    $('#mailBodyPreview').textContent = state.preview.body || '-';
  }

  function feature_renderDetailMount() {
    const mountResult = document.getElementById('featureMountResult');
    const mountEmergency = document.getElementById('featureMountEmergency');

    // Prevent duplicated IDs across views by keeping only one rendered instance
    if (mountResult) mountResult.innerHTML = '';
    if (mountEmergency) mountEmergency.innerHTML = '';

    feature_clearMailAttachMounts();

    const isResult = !!mountResult?.closest('.view')?.classList.contains('active');
    const isEmergency = !!mountEmergency?.closest('.view')?.classList.contains('active');
    const activeMount = isResult ? mountResult : isEmergency ? mountEmergency : null;
    if (!activeMount) return;

    const flowType = isEmergency ? '緊急事態' : '判断に迷う';
    const c = feature_ensureCurrentCase(flowType);

    activeMount.innerHTML = `
      <div class="card feature-card" aria-label="個人情報QR">
        <div class="card-title">個人情報QR</div>
        <div class="feature-actions">
          <button id="feature_personal_btnStart" class="btn btn-primary feature-btn" type="button">開始</button>
          <button id="feature_personal_btnStop" class="btn btn-secondary feature-btn" type="button" disabled>停止</button>
        </div>
        <div id="feature_personal_videoWrap" class="feature-video-wrap hidden">
          <video id="feature_personal_video" class="feature-video" muted playsinline></video>
        </div>
        <div class="feature-result">
          <div class="small">読み取り結果</div>
          <div class="mono feature-result-text">${escapeHtml(c.personalQrText || '-')}</div>
        </div>
        <p id="feature_personal_msg" class="small"></p>
      </div>

      <div class="card feature-card" aria-label="場所QR">
        <div class="card-title">場所QR</div>
        <div class="feature-actions">
          <button id="feature_location_btnStart" class="btn btn-primary feature-btn" type="button">開始</button>
          <button id="feature_location_btnStop" class="btn btn-secondary feature-btn" type="button" disabled>停止</button>
        </div>
        <div id="feature_location_videoWrap" class="feature-video-wrap hidden">
          <video id="feature_location_video" class="feature-video" muted playsinline></video>
        </div>
        <div class="feature-result">
          <div class="small">読み取り結果</div>
          <div class="mono feature-result-text">${escapeHtml(c.locationQrValue || '-')}</div>
          <div class="small">地図</div>
          <div class="mono feature-result-text">${escapeHtml(c.locationMapResolved || '-')}</div>
          <div class="small">位置</div>
          <div class="mono feature-result-text">${c.mapTap ? escapeHtml(`${Math.round(c.mapTap.x * 100)}%, ${Math.round(c.mapTap.y * 100)}%`) : '-'}</div>
          <button id="feature_btnToMap" class="btn btn-primary feature-btn ${c.locationMapResolved ? '' : 'hidden'}" type="button">地図へ</button>
        </div>
        <p id="feature_location_msg" class="small"></p>
      </div>

      <div class="card feature-card" aria-label="名前検索">
        <div class="card-title">名前検索</div>
        <label class="field">
          <span>名前</span>
          <input id="feature_nameInput" list="feature_nameList" type="text" placeholder="名前を入力" value="${escapeHtml(c.selectedName || '')}" />
          <datalist id="feature_nameList">
            ${FEATURE_NAME_CANDIDATES.map((n) => `<option value="${escapeHtml(n)}"></option>`).join('')}
          </datalist>
        </label>
        <button id="feature_btnNameConfirm" class="btn btn-primary feature-btn" type="button">検索（確定）</button>
        <p class="small">確定: <span class="mono">${escapeHtml(c.selectedName || '-')}</span></p>
      </div>
    `;

    // wire
    document.getElementById('feature_personal_btnStart')?.addEventListener('click', () => feature_startQr('personal'));
    document.getElementById('feature_personal_btnStop')?.addEventListener('click', () => feature_stopQr('personal'));
    document.getElementById('feature_location_btnStart')?.addEventListener('click', () => feature_startQr('location'));
    document.getElementById('feature_location_btnStop')?.addEventListener('click', () => feature_stopQr('location'));

    document.getElementById('feature_btnToMap')?.addEventListener('click', () => {
      feature_stopAllQr({ silent: true });
      feature_renderMapView();
      nav.show('view-map');
    });

    document.getElementById('feature_btnNameConfirm')?.addEventListener('click', () => {
      const input = document.getElementById('feature_nameInput');
      const v = String(input?.value || '').trim();
      c.selectedName = v;
      feature_upsertCase(c);
      feature_renderDetailMount();
    });

    feature_renderMailAttachmentsComposer(c);
    feature_refreshMailPreviewUi();
  }

  function feature_clearMailAttachMounts() {
    const a = document.getElementById('featureMailAttachMountResult');
    const b = document.getElementById('featureMailAttachMountEmergency');
    if (a) a.innerHTML = '';
    if (b) b.innerHTML = '';
  }

  function feature_getActiveMailAttachMount() {
    const viewResult = document.getElementById('view-result');
    const viewEmergency = document.getElementById('view-emergency');

    if (viewResult && viewResult.classList.contains('active')) {
      let mount = document.getElementById('featureMailAttachMountResult');
      if (!mount) {
        const mail = viewResult.querySelector('.mail-preview');
        const actions = mail?.querySelector('.mail-preview-actions');
        mount = document.createElement('div');
        mount.id = 'featureMailAttachMountResult';
        if (mail && actions) mail.insertBefore(mount, actions);
        else if (mail) mail.appendChild(mount);
      }
      return mount;
    }

    if (viewEmergency && viewEmergency.classList.contains('active')) {
      let mount = document.getElementById('featureMailAttachMountEmergency');
      if (!mount) {
        const actions = viewEmergency.querySelector('.actions');
        mount = document.createElement('div');
        mount.id = 'featureMailAttachMountEmergency';
        if (actions) actions.insertAdjacentElement('afterend', mount);
        else viewEmergency.appendChild(mount);
      }
      return mount;
    }

    return null;
  }

  function feature_renderMailAttachmentsComposer(caseData) {
    const mount = feature_getActiveMailAttachMount();
    if (!mount) return;

    const c = caseData || {};
    mount.innerHTML = `
      <div class="card feature-card" aria-label="画像＆撮影を追加">
        <div class="card-title">画像＆撮影を追加</div>
        <label class="btn btn-secondary feature-file-btn" for="feature_fileInput">画像＆撮影を追加</label>
        <input id="feature_fileInput" type="file" accept="image/*,video/*" capture multiple />
        <div id="feature_attachSummary" class="small"></div>
        <div id="feature_attachList" class="small"></div>
        <p class="small">※ファイルはメールに添付されません（本文に件数/名前のみ記載）。再読み込み後は再選択が必要です。</p>
      </div>
    `;

    const fileInput = document.getElementById('feature_fileInput');
    fileInput?.addEventListener('change', () => {
      const files = Array.from(fileInput.files || []);
      const now = new Date().toISOString();
      const metas = files.map((f) => ({
        name: f.name,
        type: f.type,
        size: f.size,
        selectedAt: now,
        sessionId: feature_state.sessionId,
      }));

      const next = feature_state.currentCaseId ? feature_getCaseById(feature_state.currentCaseId) : null;
      if (!next) return;

      next.attachmentsMeta = Array.isArray(next.attachmentsMeta) ? next.attachmentsMeta.concat(metas) : metas;
      feature_upsertCase(next);
      fileInput.value = '';
      feature_refreshMailPreviewUi();
      feature_renderDetailMount();
    });

    feature_renderAttachmentsUi(c);
  }

  function feature_renderAttachmentsUi(caseData) {
    const c = caseData || {};
    const metaAll = Array.isArray(c.attachmentsMeta) ? c.attachmentsMeta : [];
    const meta = metaAll.filter((m) => m && m.sessionId === feature_state.sessionId);
    const summary = document.getElementById('feature_attachSummary');
    const list = document.getElementById('feature_attachList');
    if (!summary || !list) return;

    const imgs = meta.filter((m) => String(m?.type || '').startsWith('image/'));
    const vids = meta.filter((m) => String(m?.type || '').startsWith('video/'));

    summary.textContent = `画像${imgs.length}件 / 動画${vids.length}件`;

    if (!meta.length) {
      list.textContent = '選択済みファイルはありません。';
      return;
    }

    const show = meta.slice(0, 10);
    list.innerHTML = show
      .map((m, i) => {
        const idx = i;
        return `
          <div class="feature-attach-row">
            <span class="mono">${escapeHtml(m.name || 'file')}</span>
            <button type="button" class="btn btn-secondary feature-attach-del" data-idx="${idx}">削除</button>
          </div>
        `;
      })
      .join('');

    list.querySelectorAll('.feature-attach-del').forEach((btn) => {
      btn.addEventListener('click', () => {
        const idx = Number(btn.getAttribute('data-idx'));
        const next = feature_getCaseById(feature_state.currentCaseId);
        if (!next) return;
        const arrAll = Array.isArray(next.attachmentsMeta) ? next.attachmentsMeta.slice() : [];
        const arr = arrAll.filter((m) => m && m.sessionId === feature_state.sessionId);
        arr.splice(idx, 1);
        next.attachmentsMeta = arrAll.filter((m) => !m || m.sessionId !== feature_state.sessionId).concat(arr);
        feature_upsertCase(next);
        feature_renderDetailMount();
      });
    });
  }

  function feature_renderCasesView() {
    const wrap = document.getElementById('featureCasesList');
    if (!wrap) return;

    const cases = feature_loadCases().slice().sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    if (!cases.length) {
      wrap.innerHTML = '<div class="small">案件履歴はありません。</div>';
      return;
    }

    wrap.innerHTML = '';
    for (const c of cases) {
      const row = document.createElement('div');
      row.className = 'card feature-case-row';
      const hasAttach =
        Array.isArray(c.attachmentsMeta) && c.attachmentsMeta.some((m) => m && m.sessionId === feature_state.sessionId);

      row.innerHTML = `
        <div class="feature-case-main">
          <div class="feature-case-title"><strong>${escapeHtml(c.symptomName || '-')}</strong></div>
          <div class="small">
            ${escapeHtml(c.createdAt || '')}<br/>
            種別: ${escapeHtml(c.flowType || '-')}
          </div>
          <div class="small">個人: ${escapeHtml(feature_shorten(c.personalQrText || '未設定'))}</div>
          <div class="small">場所: ${escapeHtml(feature_shorten(c.locationQrValue || '未設定'))}</div>
          <div class="small">位置: ${c.mapTap ? escapeHtml('設定済み') : escapeHtml('未設定')}</div>
          <div class="small">添付: ${hasAttach ? 'あり' : 'なし'}</div>
        </div>
        <div class="feature-case-side">
          <label class="field">
            <span>ステータス</span>
            <select class="feature-case-status" data-id="${escapeHtml(c.id)}">
              ${['未対応', '対応中', '対応済み']
                .map((s) => `<option value="${escapeHtml(s)}" ${c.status === s ? 'selected' : ''}>${escapeHtml(s)}</option>`)
                .join('')}
            </select>
          </label>
          <label class="field">
            <span>担当者</span>
            <input class="feature-case-assignee" data-id="${escapeHtml(c.id)}" type="text" value="${escapeHtml(c.assignee || '')}" placeholder="担当者名" />
          </label>
        </div>
      `;
      wrap.appendChild(row);
    }

    wrap.querySelectorAll('.feature-case-status').forEach((sel) => {
      sel.addEventListener('change', () => {
        const id = sel.getAttribute('data-id');
        const c = feature_getCaseById(id);
        if (!c) return;
        c.status = sel.value;
        feature_upsertCase(c);
      });
    });
    wrap.querySelectorAll('.feature-case-assignee').forEach((inp) => {
      inp.addEventListener('input', () => {
        const id = inp.getAttribute('data-id');
        const c = feature_getCaseById(id);
        if (!c) return;
        c.assignee = inp.value;
        feature_upsertCase(c);
      });
    });
  }

  function feature_renderMapView() {
    const wrap = document.getElementById('featureMapWrap');
    const c = feature_state.currentCaseId ? feature_getCaseById(feature_state.currentCaseId) : null;
    if (!wrap || !c) return;

    if (!c.locationMapResolved) {
      wrap.innerHTML = '<div class="card"><div class="card-title">地図</div><p class="small">地図が未解決です。場所QRを読み取ってください。</p></div>';
      return;
    }

    const tap = c.mapTap;
    const markerStyle = tap ? `left:${tap.x * 100}%; top:${tap.y * 100}%;` : '';

    wrap.innerHTML = `
      <div class="card feature-card">
        <div class="card-title">施設内地図</div>
        <p class="small">地図をタップして位置を選択してください。</p>
        <div id="feature_mapArea" class="feature-map-area">
          <img id="feature_mapImg" class="feature-map-img" src="${escapeHtml(c.locationMapResolved)}" alt="施設内地図" />
          <div id="feature_mapMarker" class="feature-map-marker ${tap ? '' : 'hidden'}" style="${markerStyle}"></div>
        </div>
        <button id="feature_btnMapConfirm" class="btn btn-primary feature-btn" type="button">確定</button>
      </div>
    `;

    const area = document.getElementById('feature_mapArea');
    const img = document.getElementById('feature_mapImg');
    const marker = document.getElementById('feature_mapMarker');

    area?.addEventListener('click', (e) => {
      const rect = area.getBoundingClientRect();
      const x = (e.clientX - rect.left) / rect.width;
      const y = (e.clientY - rect.top) / rect.height;
      feature_state.mapTempTap = { x: Math.max(0, Math.min(1, x)), y: Math.max(0, Math.min(1, y)) };
      if (marker) {
        marker.classList.remove('hidden');
        marker.style.left = feature_state.mapTempTap.x * 100 + '%';
        marker.style.top = feature_state.mapTempTap.y * 100 + '%';
      }
    });

    img?.addEventListener('error', () => {
      wrap.innerHTML = '<div class="card"><div class="card-title">地図</div><p class="small">地図画像の読み込みに失敗しました。場所IDが未登録の可能性があります。</p></div>';
    });

    document.getElementById('feature_btnMapConfirm')?.addEventListener('click', () => {
      const next = feature_getCaseById(feature_state.currentCaseId);
      if (!next) return;
      if (!feature_state.mapTempTap) return;
      next.mapTap = feature_state.mapTempTap;
      feature_upsertCase(next);
      feature_state.mapTempTap = null;
      nav.back();
      feature_renderDetailMount();
    });
  }
  // FEATURE END

  /** =========================
   *  Admin (password-protected)
   *  ========================= */
  const admin = {
    authed: false,
    async initGate() {
      const hasPass = Boolean(master.admin.passwordHash);
      $('#adminFirstSet').classList.toggle('hidden', hasPass);
      $('#adminLogin').classList.toggle('hidden', !hasPass);
      $('#adminGateMsg').textContent = '';
    },
    async setPass() {
      const p1 = $('#adminNewPass1').value;
      const p2 = $('#adminNewPass2').value;
      if (!p1 || p1.length < 4) return (toast('4文字以上で設定してください'), void 0);
      if (p1 !== p2) return (toast('確認が一致しません'), void 0);
      master.admin.passwordHash = await sha256Hex(p1);
      saveMaster(master);
      toast('パスワードを設定しました');
      await admin.initGate();
    },
    async login() {
      const p = $('#adminPass').value;
      if (!p) return toast('パスワードを入力してください');
      const h = await sha256Hex(p);
      if (h !== master.admin.passwordHash) {
        $('#adminGateMsg').textContent = 'パスワードが違います。';
        toast('ログイン失敗');
        return;
      }
      admin.authed = true;
      $('#adminGate').classList.add('hidden');
      $('#adminPanel').classList.remove('hidden');
      toast('ログインしました');
      renderAdminAll();
    },
    logout() {
      admin.authed = false;
      $('#adminGate').classList.remove('hidden');
      $('#adminPanel').classList.add('hidden');
      $('#adminPass').value = '';
      admin.initGate();
    },
    async changePass() {
      const oldP = $('#adminChangeOld').value;
      const n1 = $('#adminChangeNew1').value;
      const n2 = $('#adminChangeNew2').value;
      const msg = $('#adminChangeMsg');
      msg.textContent = '';

      if (!oldP || !n1 || !n2) return (msg.textContent = 'すべて入力してください');
      if (n1 !== n2) return (msg.textContent = '確認が一致しません');
      const hOld = await sha256Hex(oldP);
      if (hOld !== master.admin.passwordHash) return (msg.textContent = '現在のパスワードが違います');
      if (n1.length < 4) return (msg.textContent = '4文字以上で設定してください');

      master.admin.passwordHash = await sha256Hex(n1);
      saveMaster(master);
      msg.textContent = '変更しました';
      toast('パスワードを変更しました');
      $('#adminChangeOld').value = '';
      $('#adminChangeNew1').value = '';
      $('#adminChangeNew2').value = '';
    },
  };

  function renderAdminAll() {
    renderAdminCompanies();
    renderAdminGlobalContacts();
    renderAdminStaffSelectors();
    renderAdminStaffList();
    renderAdminSituations();
  }

  function renderAdminCompanies() {
    const wrap = $('#adminCompanies');
    wrap.innerHTML = '';

    master.companies.forEach((c) => {
      const div = document.createElement('div');
      div.className = 'admin-item';

      const emails = (c.emails || []).join(', ');
      div.innerHTML = `
        <div><strong>${escapeHtml(c.name)}</strong> <span class="small">(${escapeHtml(c.id)})</span></div>
        <div class="small">送信先: ${escapeHtml(emails)}</div>
        <div class="form-grid">
          <input data-k="name" value="${escapeHtml(c.name)}" />
          <input data-k="emails" value="${escapeHtml(emails)}" />
          <button class="btn btn-secondary" data-act="save">保存</button>
          <button class="btn btn-secondary" data-act="del">削除</button>
        </div>
      `;

      div.querySelector('[data-act="save"]').addEventListener('click', () => {
        const name = div.querySelector('input[data-k="name"]').value.trim();
        const em = normalizeEmails(div.querySelector('input[data-k="emails"]').value);
        if (!name) return toast('会社名を入力してください');
        c.name = name;
        c.emails = em;
        saveMaster(master);
        toast('保存しました');
        renderCompanyList();
        renderAdminCompanies();
      });

      div.querySelector('[data-act="del"]').addEventListener('click', () => {
        if (!confirm('削除しますか？（所属と紐づく職員がいる場合は注意）')) return;
        master.companies = master.companies.filter((x) => x.id !== c.id);
        // detach staff
        master.staff = master.staff.map((s) => (s.companyId === c.id ? { ...s, companyId: '' } : s));
        saveMaster(master);
        toast('削除しました');
        renderCompanyList();
        renderAdminAll();
      });

      wrap.appendChild(div);
    });
  }

  function renderAdminGlobalContacts() {
    $('#gcSafetyHQ').value = master.globalContacts.safetyHQ || '';
    $('#gcRescueTeam').value = master.globalContacts.rescueTeam || '';
    $('#gcAmbulance').value = master.globalContacts.ambulanceCenter || '';
  }

  function renderAdminStaffSelectors() {
    const sel1 = $('#staffCompanyFilter');
    const sel2 = $('#newStaffCompany');
    sel1.innerHTML = '';
    sel2.innerHTML = '';

    const optAll = document.createElement('option');
    optAll.value = '__all__';
    optAll.textContent = 'すべて';
    sel1.appendChild(optAll);

    master.companies.forEach((c) => {
      const o1 = document.createElement('option');
      o1.value = c.id;
      o1.textContent = c.name;
      sel1.appendChild(o1);

      const o2 = document.createElement('option');
      o2.value = c.id;
      o2.textContent = c.name;
      sel2.appendChild(o2);
    });
  }

  function renderAdminStaffList() {
    const wrap = $('#adminStaff');
    const filter = $('#staffCompanyFilter').value || '__all__';
    wrap.innerHTML = '';

    let items = master.staff.slice();
    if (filter !== '__all__') items = items.filter((s) => s.companyId === filter);

    if (items.length === 0) {
      const d = document.createElement('div');
      d.className = 'small';
      d.textContent = '職員が未登録です。';
      wrap.appendChild(d);
      return;
    }

    items
      .slice()
      .sort((a, b) => (a.kana || '').localeCompare(b.kana || '', 'ja'))
      .forEach((s) => {
        const div = document.createElement('div');
        div.className = 'admin-item';

        const companyName = getCompany(s.companyId)?.name || '（未設定）';
        div.innerHTML = `
          <div><strong>${escapeHtml(s.name)}</strong> <span class="small">(${escapeHtml(companyName)})</span></div>
          <div class="small">よみ: ${escapeHtml(s.kana || '')} / グループ: ${escapeHtml(kanaGroupFromKana(s.kana))}</div>
          <div class="form-grid">
            <select data-k="company"></select>
            <input data-k="name" value="${escapeHtml(s.name)}" />
            <input data-k="kana" value="${escapeHtml(s.kana || '')}" />
            <button class="btn btn-secondary" data-act="save">保存</button>
            <button class="btn btn-secondary" data-act="del">削除</button>
          </div>
        `;

        const sel = div.querySelector('select[data-k="company"]');
        master.companies.forEach((c) => {
          const o = document.createElement('option');
          o.value = c.id;
          o.textContent = c.name;
          if (c.id === s.companyId) o.selected = true;
          sel.appendChild(o);
        });

        div.querySelector('[data-act="save"]').addEventListener('click', () => {
          const name = div.querySelector('input[data-k="name"]').value.trim();
          const kana = div.querySelector('input[data-k="kana"]').value.trim();
          const companyId = div.querySelector('select[data-k="company"]').value;
          if (!name) return toast('氏名を入力してください');
          if (!kana) return toast('よみ（かな）を入力してください');
          s.name = name;
          s.kana = kana;
          s.companyId = companyId;
          saveMaster(master);
          toast('保存しました');
          renderAdminStaffList();
        });

        div.querySelector('[data-act="del"]').addEventListener('click', () => {
          if (!confirm('削除しますか？')) return;
          master.staff = master.staff.filter((x) => x.id !== s.id);
          saveMaster(master);
          toast('削除しました');
          renderAdminStaffList();
        });

        wrap.appendChild(div);
      });
  }

  function renderAdminSituations() {
    const wrap = $('#adminSituations');
    wrap.innerHTML = '';

    master.situations.forEach((s) => {
      const div = document.createElement('div');
      div.className = 'admin-item';

      const includeE = (s.includeEmergency || []).join(', ');
      const includeO = (s.includeObserve || []).join(', ');

      div.innerHTML = `
        <div><strong>${escapeHtml(s.label)}</strong> <span class="small">(${escapeHtml(s.id)})</span></div>
        <div class="small">推奨: ${escapeHtml(s.defaultAction === 'emergency' ? '緊急' : '様子見')}</div>

        <div class="form-grid">
          <select data-k="defaultAction">
            <option value="emergency">緊急</option>
            <option value="observe">様子見</option>
          </select>
          <label class="field" style="grid-column: span 2;">
            <span>部位選択を使う</span>
            <select data-k="requiresBody">
              <option value="false">いいえ</option>
              <option value="true">はい</option>
            </select>
          </label>
        </div>

        <div class="form-col">
          <label class="field">
            <span>緊急：含める部署（safetyHQ,rescueTeam,ambulanceCenter をカンマ区切り）</span>
            <input data-k="includeEmergency" value="${escapeHtml(includeE)}" />
          </label>
          <label class="field">
            <span>様子見：含める部署（同上）</span>
            <input data-k="includeObserve" value="${escapeHtml(includeO)}" />
          </label>

          <label class="field">
            <span>表示文（緊急）</span>
            <textarea data-k="recommendTextEmergency">${escapeHtml(s.recommendTextEmergency || '')}</textarea>
          </label>
          <label class="field">
            <span>表示文（様子見）</span>
            <textarea data-k="recommendTextObserve">${escapeHtml(s.recommendTextObserve || '')}</textarea>
          </label>

          <label class="field">
            <span>件名テンプレ（例: [命をツナグ] {company} {person} - ...）</span>
            <input data-k="subjectTpl" value="${escapeHtml(s.subjectTpl || '')}" />
          </label>

          <label class="field">
            <span>本文テンプレ（緊急）</span>
            <textarea data-k="bodyTplEmergency">${escapeHtml(s.bodyTplEmergency || '')}</textarea>
          </label>

          <label class="field">
            <span>本文テンプレ（様子見）</span>
            <textarea data-k="bodyTplObserve">${escapeHtml(s.bodyTplObserve || '')}</textarea>
          </label>

          <button class="btn btn-primary" data-act="save">保存</button>
        </div>
      `;

      div.querySelector('select[data-k="defaultAction"]').value = s.defaultAction;
      div.querySelector('select[data-k="requiresBody"]').value = String(!!s.requiresBody);

      div.querySelector('[data-act="save"]').addEventListener('click', () => {
        s.defaultAction = div.querySelector('select[data-k="defaultAction"]').value;
        s.requiresBody = div.querySelector('select[data-k="requiresBody"]').value === 'true';

        s.includeEmergency = normalizeEmails(div.querySelector('input[data-k="includeEmergency"]').value).map((x) => x);
        // normalizeEmails splits by comma; here we want raw tokens, so do manual:
        s.includeEmergency = String(div.querySelector('input[data-k="includeEmergency"]').value)
          .split(',')
          .map((x) => x.trim())
          .filter(Boolean);

        s.includeObserve = String(div.querySelector('input[data-k="includeObserve"]').value)
          .split(',')
          .map((x) => x.trim())
          .filter(Boolean);

        s.recommendTextEmergency = div.querySelector('textarea[data-k="recommendTextEmergency"]').value.trim();
        s.recommendTextObserve = div.querySelector('textarea[data-k="recommendTextObserve"]').value.trim();
        s.subjectTpl = div.querySelector('input[data-k="subjectTpl"]').value.trim();
        s.bodyTplEmergency = div.querySelector('textarea[data-k="bodyTplEmergency"]').value.replace(/\r\n/g, '\n');
        s.bodyTplObserve = div.querySelector('textarea[data-k="bodyTplObserve"]').value.replace(/\r\n/g, '\n');

        saveMaster(master);
        toast('保存しました');
      });

      wrap.appendChild(div);
    });
  }

  /** =========================
   *  Wire events
   *  ========================= */
  function wireGlobalEvents() {
    $('#btnBack').addEventListener('click', () => nav.back());
    $('#btnRestartGlobal').addEventListener('click', () => nav.restartAll());

    $('#btnStartEmergency').addEventListener('click', () => {
      state.mode = 'emergency';
      renderStatusGrid();
      nav.show('view-status');
      saveSession({ ...state, nav: nav.stack });
    });

    $('#btnStartUnsure').addEventListener('click', () => {
      state.mode = 'unsure';
      renderStatusGrid();
      nav.show('view-status');
      saveSession({ ...state, nav: nav.stack });
    });

    // FEATURE START
    document.getElementById('btnStartEmergency')?.addEventListener('click', () => {
      feature_state.currentCaseId = null;
      feature_stopAllQr({ silent: true });
    });
    document.getElementById('btnStartUnsure')?.addEventListener('click', () => {
      feature_state.currentCaseId = null;
      feature_stopAllQr({ silent: true });
    });
    document.getElementById('btnRestartGlobal')?.addEventListener('click', () => {
      feature_state.currentCaseId = null;
      feature_stopAllQr({ silent: true });
    });
    document.getElementById('btnBack')?.addEventListener('click', () => {
      feature_stopAllQr({ silent: true });
    });

    document.getElementById('btnCases')?.addEventListener('click', () => {
      feature_stopAllQr({ silent: true });
      feature_renderCasesView();
      nav.show('view-cases');
    });

    document.addEventListener('visibilitychange', () => {
      if (document.hidden) feature_stopAllQr({ silent: true });
    });
    window.addEventListener('pagehide', () => {
      feature_stopAllQr({ silent: true });
    });
    // FEATURE END

    $('#btnBodyNext').addEventListener('click', () => {
      if (!state.bodyPartId) return;

      // Emergency mode: auto request (demo) right after body-part
      if (state.mode === 'emergency') {
        showEmergencyCallView();
        return;
      }

      // If company/person are already chosen, proceed to the final screen
      if (state.companyId && state.personId) {
        buildResultPreview();
        nav.show('view-result');
        return;
      }

      // Otherwise continue the normal flow (body -> affiliation)
      renderCompanyList();
      nav.show('view-company');
    });

    $('#btnActionEmergency').addEventListener('click', () => {
      state.action = 'emergency';
      buildResultPreview();
    });
    $('#btnActionObserve').addEventListener('click', () => {
      state.action = 'observe';
      buildResultPreview();
    });

    $('#btnOpenMail').addEventListener('click', () => openMail());
    $('#btnOpenMailEmergency')?.addEventListener('click', () => openMail());
    $('#btnCopyMail').addEventListener('click', () => copyPreview());

    // Admin entry
    $('#btnAdmin').addEventListener('click', async () => {
      await admin.initGate();
      $('#adminPanel').classList.add('hidden');
      $('#adminGate').classList.remove('hidden');
      admin.authed = false;
      nav.show('view-admin');
    });

    // Admin gate
    $('#btnAdminSetPass').addEventListener('click', () => admin.setPass());
    $('#btnAdminLogin').addEventListener('click', () => admin.login());
    $('#btnAdminChangePass').addEventListener('click', () => admin.changePass());

    // Admin tabs
    $$('.tab').forEach((t) => {
      t.addEventListener('click', () => {
        $$('.tab').forEach((x) => x.classList.remove('active'));
        t.classList.add('active');
        const key = t.getAttribute('data-tab');

        $$('.admin-tab').forEach((p) => p.classList.remove('active'));
        const panel = document.querySelector(`[data-tab-panel="${key}"]`);
        if (panel) panel.classList.add('active');
      });
    });

    // Admin: add company
    $('#btnAddCompany').addEventListener('click', () => {
      const name = $('#newCompanyName').value.trim();
      const emails = normalizeEmails($('#newCompanyEmails').value);
      if (!name) return toast('会社名を入力してください');

      const id = name === '自社' ? 'own' : uuid().slice(0, 8);
      master.companies.push({ id, name, emails });
      saveMaster(master);

      $('#newCompanyName').value = '';
      $('#newCompanyEmails').value = '';
      toast('追加しました');
      renderCompanyList();
      renderAdminAll();
    });

    // Admin: save global contacts
    $('#btnSaveGlobalContacts').addEventListener('click', () => {
      master.globalContacts.safetyHQ = $('#gcSafetyHQ').value.trim();
      master.globalContacts.rescueTeam = $('#gcRescueTeam').value.trim();
      master.globalContacts.ambulanceCenter = $('#gcAmbulance').value.trim();
      saveMaster(master);
      toast('保存しました');
    });

    // Admin: staff list filter
    $('#btnStaffFilter').addEventListener('click', () => renderAdminStaffList());

    // Admin: add staff
    $('#btnAddStaff').addEventListener('click', () => {
      const companyId = $('#newStaffCompany').value;
      const name = $('#newStaffName').value.trim();
      const kana = $('#newStaffKana').value.trim();
      if (!companyId) return toast('会社を選択してください');
      if (!name) return toast('氏名を入力してください');
      if (!kana) return toast('よみ（かな）を入力してください');

      master.staff.push({ id: uuid(), companyId, name, kana });
      saveMaster(master);

      $('#newStaffName').value = '';
      $('#newStaffKana').value = '';
      toast('追加しました');
      renderAdminStaffList();
    });

    // Admin: Export JSON
    $('#btnExportJson').addEventListener('click', () => {
      const blob = new Blob([JSON.stringify(master, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'inochi_master.json';
      a.click();
      URL.revokeObjectURL(a.href);
      toast('JSONを書き出しました');
    });

    // Admin: Import JSON
    $('#importJson').addEventListener('change', async (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      try {
        const text = await file.text();
        const imported = JSON.parse(text);
        if (!imported || typeof imported !== 'object') throw new Error('invalid');
        master = { ...defaultMaster(), ...imported };
        saveMaster(master);
        toast('読み込みました');
        $('#adminIoMsg').textContent = '読み込みました。画面を更新しました。';
        renderAdminAll();
        renderStatusGrid();
        renderCompanyList();
      } catch (err) {
        console.error(err);
        $('#adminIoMsg').textContent = '読み込みに失敗しました。JSON形式を確認してください。';
        toast('読み込み失敗');
      } finally {
        e.target.value = '';
      }
    });
  }

  /** =========================
   *  Boot
   *  ========================= */
  function restoreIfPossible() {
    const ses = loadSession();
    if (!ses) return;

    // Restore selection state only (do not auto-open deep screens)
    state.mode = ses.mode || 'unsure';
    state.situationId = ses.situationId || null;
    state.companyId = ses.companyId || null;
    state.personId = ses.personId || null;
    state.bodyPartId = ses.bodyPartId || null;
    state.action = ses.action || null;
    state.detailNote = ses.detailNote || '';

    // Restore nav stack if valid
    if (Array.isArray(ses.nav) && ses.nav.length) {
      nav.stack = ses.nav.filter((id) => typeof id === 'string' && document.getElementById(id));
      if (!nav.stack.length) nav.stack = ['view-home'];
    }

    // If in body view, restore selection highlight
    if (state.bodyPartId) {
      const el = document.querySelector(`#bodySvg .body-part[data-part="${state.bodyPartId}"]`);
      if (el) {
        el.classList.add('selected');
        const bp = getBodyPart(state.bodyPartId);
        $('#bodySelectedLabel').textContent = bp ? bp.label : '選択中';
        $('#btnBodyNext').disabled = false;
      }
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    // init
    renderStatusGrid();
    renderCompanyList();
    renderBodyPartsHandlers();
    wireGlobalEvents();
    restoreIfPossible();

    // Start on home always (safer), but keep session state
    nav.show('view-home', { push: false });
    nav.stack = ['view-home'];
    saveSession({ ...state, nav: nav.stack });

    // If first time, show admin set screen on admin view when opened
    admin.initGate();
  });
})();
