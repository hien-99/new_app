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
    const body = interpolate(bodyTpl || '{person} {company} {time}', vars);

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
    const { to, subject, body } = state.preview;
    const href = mailtoLink(to, subject, body);
    // Must be user gesture; called inside click handlers
    window.location.href = href;
  }

  // QR SCANNER START
  const qr_state = {
    scanner: null,
    lastText: '',
    lastAt: 0,
  };

  function qr_setMsg(msg) {
    const el = document.getElementById('qr_msg');
    if (!el) return;
    el.textContent = msg || '';
  }

  function qr_isHttpUrl(text) {
    try {
      const u = new URL(String(text || '').trim());
      return u.protocol === 'http:' || u.protocol === 'https:';
    } catch {
      return false;
    }
  }

  function qr_setResult(text) {
    const t = String(text || '').trim();
    const out = document.getElementById('qr_resultText');
    if (out) out.textContent = t || '-';

    const btnOpen = document.getElementById('qr_btnOpen');
    if (btnOpen) btnOpen.classList.toggle('hidden', !qr_isHttpUrl(t));
  }

  function qr_humanizeError(err) {
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
    return (
      '読み取りを開始できませんでした。\n' +
      '※ Safari/Chromeで開いてください（アプリ内ブラウザでは動かない場合があります）。'
    );
  }

  async function qr_stop({ silent = false } = {}) {
    const btnStart = document.getElementById('qr_btnStart');
    const btnStop = document.getElementById('qr_btnStop');
    const videoWrap = document.getElementById('qr_videoWrap');
    const video = document.getElementById('qr_video');

    try {
      if (qr_state.scanner) {
        await qr_state.scanner.stop();
        qr_state.scanner.destroy();
        qr_state.scanner = null;
      }
    } catch {
      // ignore
    }

    if (video) {
      try {
        video.pause();
      } catch {
        // ignore
      }
      video.srcObject = null;
    }
    if (videoWrap) videoWrap.classList.add('hidden');
    if (btnStart) btnStart.disabled = false;
    if (btnStop) btnStop.disabled = true;

    if (!silent) qr_setMsg('停止しました。');
  }

  async function qr_start() {
    const btnStart = document.getElementById('qr_btnStart');
    const btnStop = document.getElementById('qr_btnStop');
    const videoWrap = document.getElementById('qr_videoWrap');
    const video = document.getElementById('qr_video');

    qr_setMsg('');
    qr_setResult('-');

    if (!video || !btnStart || !btnStop || !videoWrap) return;

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      qr_setMsg(
        'このブラウザはカメラに対応していません。\n※ Safari/Chromeで開いてください（アプリ内ブラウザでは動かない場合があります）。'
      );
      return;
    }

    const QrScannerLib = window.QrScanner;
    if (!QrScannerLib) {
      qr_setMsg('QR読み取りライブラリの読み込みに失敗しました。通信状況を確認してください。');
      return;
    }

    try {
      await qr_stop({ silent: true });

      // Always start by user gesture only (called from click handler)
      btnStart.disabled = true;
      btnStop.disabled = false;
      videoWrap.classList.remove('hidden');

      // Worker path (CDN)
      if (!QrScannerLib.WORKER_PATH) {
        QrScannerLib.WORKER_PATH = 'https://cdn.jsdelivr.net/npm/qr-scanner@1.4.2/qr-scanner-worker.min.js';
      }

      qr_state.lastText = '';
      qr_state.lastAt = 0;

      qr_state.scanner = new QrScannerLib(
        video,
        (result) => {
          const text = typeof result === 'string' ? result : result?.data;
          const t = String(text || '').trim();
          if (!t) return;

          const now = Date.now();
          if (t === qr_state.lastText && now - qr_state.lastAt < 1200) return;

          qr_state.lastText = t;
          qr_state.lastAt = now;
          qr_setResult(t);
        },
        {
          preferredCamera: 'environment',
          highlightScanRegion: false,
          highlightCodeOutline: false,
        }
      );

      await qr_state.scanner.start();
      qr_setMsg('カメラを起動しました。QRコードを映してください。');
    } catch (err) {
      await qr_stop({ silent: true });
      btnStart.disabled = false;
      btnStop.disabled = true;
      videoWrap.classList.add('hidden');
      qr_setMsg(qr_humanizeError(err));
    }
  }

  function qr_init() {
    const btnStart = document.getElementById('qr_btnStart');
    const btnStop = document.getElementById('qr_btnStop');
    const btnOpen = document.getElementById('qr_btnOpen');

    if (!btnStart || !btnStop) return;

    btnStart.addEventListener('click', () => {
      qr_start();
    });
    btnStop.addEventListener('click', () => {
      qr_stop();
    });

    btnOpen?.addEventListener('click', () => {
      const text = document.getElementById('qr_resultText')?.textContent || '';
      if (!qr_isHttpUrl(text)) return;
      window.open(String(text).trim(), '_blank', 'noopener');
    });

    // Stop camera when leaving the page or app goes background
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) qr_stop({ silent: true });
    });
    window.addEventListener('pagehide', () => {
      qr_stop({ silent: true });
    });

    // Stop when user starts existing flows (home buttons)
    document.getElementById('btnStartEmergency')?.addEventListener('click', () => qr_stop({ silent: true }));
    document.getElementById('btnStartUnsure')?.addEventListener('click', () => qr_stop({ silent: true }));
    document.getElementById('btnAdmin')?.addEventListener('click', () => qr_stop({ silent: true }));
  }
  // QR SCANNER END

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

    // QR SCANNER START
    qr_init();
    // QR SCANNER END
  });
})();
