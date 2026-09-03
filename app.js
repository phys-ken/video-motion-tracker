// Physics Tracker - app.js
// iPadおよび各種ブラウザ向け動画解析ウェブアプリコアロジック

// 意味のある修正をリリースするたびに手動で更新する。index.html の
// <script src="app.js?v=..."> と <link href="styles.css?v=..."> のクエリ値も同じ文字列に合わせること
// （キャッシュされた古いapp.jsで測定していないかを見分けるための唯一の手がかり）。
const APP_VERSION = '2026-09-03b';
window.APP_VERSION = APP_VERSION;

// --- 状態管理を一元化 ---
const appState = {
    videoElement: null,
    canvas: null,
    ctx: null,
    isPlaying: false,
    videoDuration: 0,
    videoFps: 30,
    fpsMeasured: false,    // 実測FPSが確定したか
    fpsManual: false,      // ユーザーが手動でFPSを上書きしたか
    isScanning: false,     // 読込直後のフレーム走査中か
    currentFrame: 0,
    totalFrames: 0,
    frameTimes: [],        // 実測した各フレームの提示時刻(mediaTime)。空ならfps換算にフォールバック
    viewState: { scale: 1, offsetX: 0, offsetY: 0 },
    // 中央十字＋確定方式: 通常はトラッキング。原点/スケール設定中だけ pendingCapture が立つ
    pendingCapture: null, // null | 'origin' | 'scale'
    trackingData: [], // [{ id, frame, time, x, y, objectId }]
    activeObjectId: 1,
    trackingStepSize: 1,
    calibration: {
        origin: null,         // { x, y } (動画ピクセル座標)
        scaleRatio: null,     // cm/px
        scaleStart: null,     // { x, y }
        scaleEnd: null,       // { x, y }
        scaleActual: 0,       // cm
        scaleTempStart: null  // 一時始点
    },
    targetColor: null,        // { r, g, b } サンプリングされた色
    isAutoTracking: false,    // 自動追跡実行フラグ
    selectedPointId: null,    // 現在選択されているトラックポイントのID
    videoName: null,          // 現在読み込み中の動画のファイル名（復元判定の指紋用）
    videoSize: 0,             // 同・ファイルサイズ(bytes)
    rangeIn: 0,               // 解析範囲の開始コマ（イン点）
    rangeOut: 0,               // 解析範囲の終了コマ（アウト点）
    // スロー動画対応: コンテナが自己申告するfps(=videoFps、シークにはこれを使い続ける)と、
    // 実際にその場で起きていた物理時間は、スロー撮影を書き出す過程で乖離することがある
    // （高fps撮影を見かけ上のfpsに"フラット化"して書き出す挙動。詳細はDESIGN.md StageE参照）。
    // physicsFpsMultiplier = 真の撮影fps ÷ videoFps。既定1（補正なし）。
    // frameTimeOf(物理時間)だけに乗算し、seekTimeOf(動画シーク)は絶対に触らない。
    physicsFpsMultiplier: 1,
    slowMotionCaptureFps: null, // ユーザーが入力した「実際の撮影fps」。未設定ならnull
    rawKinematics: false, // true=速度・加速度のスムージングを無効化し従来の厳密差分を使う
    scaleSkipped: false,  // 「スケールなしで進む」を選んだか（px単位のまま続行）
    motionMode: null      // 'free-fall' | 'vertical-throw' | 'projectile' | 'oblique'（起動時に選ぶ）
};

// --- 運動の種類（起動時に選ぶ4種） -------------------------------------
// このアプリは落体運動の4種に絞っている。種類が決まれば「どちらを正とするか」が
// 決まるので、生徒が符号で悩まないよう最初に選ばせて自動で入れる。
// ySign: +1 = 上向きが正（画面座標のyを反転）、-1 = 下向きが正（画面座標のまま）
const MOTION_MODES = {
    'free-fall': {
        label: '自由落下・投げおろし', ySign: -1, xSign: 1,
        axisText: '下向きが正', graphs: ['y-t', 'vy-t']
    },
    'vertical-throw': {
        label: '鉛直投げ上げ', ySign: 1, xSign: 1,
        axisText: '上向きが正', graphs: ['y-t', 'vy-t']
    },
    'projectile': {
        label: '水平投射', ySign: -1, xSign: 1,
        axisText: '下向き・右向きが正', graphs: ['x-t', 'y-t', 'vx-t', 'vy-t']
    },
    'oblique': {
        label: '斜方投射', ySign: 1, xSign: 1,
        axisText: '上向き・右向きが正', graphs: ['x-t', 'y-t', 'vx-t', 'vy-t']
    }
};
const MOTION_MODE_KEY = 'tracker_for_ipad_motion_mode_v1';
const DEFAULT_MOTION_MODE = 'free-fall';

function currentMode() {
    return MOTION_MODES[appState.motionMode] || MOTION_MODES[DEFAULT_MOTION_MODE];
}

// モードを適用する。軸の符号は表示上の変換なので、既存の打点はそのまま生きる。
// applyGraphs=false は「復元時など、生徒が選んだグラフ構成を壊したくない」場合。
function setMotionMode(key, applyGraphs) {
    if (!MOTION_MODES[key]) return;
    appState.motionMode = key;
    try { localStorage.setItem(MOTION_MODE_KEY, key); } catch (e) { /* 無視 */ }
    if (applyGraphs !== false) applyGraphTypes(MOTION_MODES[key].graphs);
    refreshModeChip();
    if (typeof updateDataTable === 'function') updateDataTable();
    if (typeof updateGraph === 'function') updateGraph();
    if (typeof drawVideoFrame === 'function' && appState.ctx) drawVideoFrame();
    logDebug(`運動の種類: ${MOTION_MODES[key].label}（${MOTION_MODES[key].axisText}）`);
}

function refreshModeChip() {
    const m = currentMode();
    const name = document.getElementById('mode-chip-name');
    const axis = document.getElementById('mode-chip-axis');
    if (name) name.textContent = appState.motionMode ? m.label : '運動を選ぶ';
    if (axis) axis.textContent = appState.motionMode ? m.axisText : '';
    document.querySelectorAll('#mode-grid .mode-card').forEach(c => {
        c.classList.toggle('active', c.dataset.mode === appState.motionMode);
    });
}

function openModePanel() {
    const ov = document.getElementById('mode-overlay');
    if (!ov) return;
    refreshModeChip();
    updateModePanelReady();
    ov.style.display = 'flex';
}

function closeModePanel() {
    const ov = document.getElementById('mode-overlay');
    if (ov) ov.style.display = 'none';
}

// 種類を選ぶまで、パネル内の読み込みボタンは押せない
function updateModePanelReady() {
    const ready = !!appState.motionMode;
    const file = document.getElementById('mode-btn-file');
    const sample = document.getElementById('mode-btn-sample');
    const foot = document.getElementById('mode-foot');
    if (file) {
        file.classList.toggle('is-disabled', !ready);
        file.setAttribute('aria-disabled', ready ? 'false' : 'true');
    }
    if (sample) sample.disabled = !ready;
    if (foot) {
        const left = ready ? null : savedTrackingSummary();
        foot.textContent = ready
            ? `${currentMode().label} — ${currentMode().axisText}。動画を読み込んで始めましょう。`
            : left
                ? `前回の打点（${left.label ? left.label + '・' : ''}${left.n}点）が残っています。運動の種類を選び直してください。同じ動画を選べば「戻す」で続きから再開できます。`
                : 'まず上から運動の種類を選んでください。';
    }
}

function setupModePanel() {
    document.querySelectorAll('#mode-grid .mode-card').forEach(card => {
        card.addEventListener('click', () => {
            setMotionMode(card.dataset.mode);
            updateModePanelReady();
        });
    });
    const sample = document.getElementById('mode-btn-sample');
    if (sample) sample.addEventListener('click', () => { closeModePanel(); openSamplePicker(); });
    const file = document.getElementById('mode-btn-file');
    if (file) file.addEventListener('click', (e) => {
        if (!appState.motionMode) { e.preventDefault(); return; }
        closeModePanel();
    });
    const chip = document.getElementById('mode-chip');
    if (chip) chip.addEventListener('click', openModePanel);

    // 前回の選択を覚えておき、パネルではそれが選ばれた状態で開く
    let saved = null;
    try { saved = localStorage.getItem(MOTION_MODE_KEY); } catch (e) { /* 無視 */ }
    if (saved && MOTION_MODES[saved]) setMotionMode(saved, false);
    refreshModeChip();
}

// グローバル（window）に公開してテストスイートからアクセス可能にする
window.appState = appState;

// 物体カラーマップ (10色)。グラフ線・映像上マーカー・打点マップで共用。
// 物体1は「実写映像にめったに出ない色相」のマゼンタ（映像注釈の定番色。
// 空・肌・床・黒板と被らず、白背景グラフでも4.7:1のコントラスト）。
// 物体2・3はOkabe-Ito系で、マゼンタとは色覚多様性でも分離する。
const COLOR_MAP = [
    '#D81B8C', // マゼンタ (物体1)
    '#D55E00', // 朱 (物体2)
    '#009E73', // 緑 (物体3)
    '#0072B2', // 青
    '#B45309', // 琥珀
    '#AA4499', // 紫
    '#A34700', // 濃朱
    '#007455', // 濃緑
    '#52606D', // グレー
    '#1F2933'  // 黒
];

// UIクロームの描画色（styles.css の CSS 変数と手動で同期。canvas 描画用）
const UI_COLORS = {
    accent: '#0B6BCB',        // 操作の青（選択・照準）
    accentBright: '#53A8FF',  // 映像上の選択リング（暗い映像でも見える明るい青）
    calBright: '#FFC400',     // 映像上の校正オーバーレイ（原点/スケール。暗い縁取りとセット）
    text: '#1F2933',
    textSub: '#52606D',
    grid: '#E4E7EB',          // グラフのグリッド
    axis: '#9AA5B1',          // グラフの主軸
    surface: '#FFFFFF'
};
const FONT_SANS = '-apple-system, BlinkMacSystemFont, "Hiragino Sans", "Noto Sans JP", sans-serif';
const FONT_MONO = 'Menlo, Consolas, monospace';

// オートトラッカー用内部Canvas
let offscreenCanvas = null;
let offscreenCtx = null;

// ピンチズーム操作時の前フレーム状態保持用変数 (吸い付きズーム用)
let activePointers = []; // Pointer Events 用の配列
let lastPointerPos = null; // ドラッグパン用の一時座標
let lastPinchDist = 0;
let lastPinchCenter = null;
let isPanning = false;
let isDraggingPoint = false;
let draggedPointIndex = -1;

// デバッグ用ログ出力
// ログは全文コピーできるようメモリにも保持する（バグ報告用）。上限つき。
const debugLines = [];
const DEBUG_MAX_LINES = 500;

function logDebug(message) {
    // 時刻＋起動からの経過秒。報告を見ながら「操作のどのタイミングか」を追える
    const elapsed = (performance.now() / 1000).toFixed(1);
    const line = `[${new Date().toLocaleTimeString()} +${elapsed}s] ${message}`;
    debugLines.push(line);
    if (debugLines.length > DEBUG_MAX_LINES) debugLines.shift();

    console.log(message);
    const logList = document.getElementById('debug-log-list');
    if (!logList) return;
    const item = document.createElement('div');
    item.textContent = line;
    logList.appendChild(item);
    while (logList.childElementCount > DEBUG_MAX_LINES) logList.removeChild(logList.firstChild);
    logList.scrollTop = logList.scrollHeight;
}

// バグ報告用: バージョン・環境・現在の状態サマリ＋全ログを1テキストにまとめる
function buildDebugReport() {
    const s = appState;
    const state = [
        `=== 動画解析トラッカー デバッグレポート ===`,
        `version: v${APP_VERSION}`,
        `userAgent: ${navigator.userAgent}`,
        `画面: ${window.innerWidth}x${window.innerHeight}`,
        `動画: ${s.videoName || '(未読込)'} / ${s.videoDuration ? s.videoDuration.toFixed(2) + 's' : '--'}`
            + ` / fps=${s.videoFps}${s.fpsMeasured ? '' : '*'} / 時刻表=${s.frameTimes.length}件`,
        `コマ: ${s.currentFrame} / ${s.totalFrames}（範囲 ${s.rangeIn}–${s.rangeOut}）`,
        `打点: ${s.trackingData.length}点 / 物体${s.activeObjectId} / ステップ幅${s.trackingStepSize}`,
        `校正: スケール=${s.calibration.scaleRatio ? s.calibration.scaleRatio.toFixed(4) + 'cm/px' : '未設定'} / 原点=最初の打点(自動)`
            + ` / スロー=${s.slowMotionCaptureFps ? s.slowMotionCaptureFps + 'fps' : 'なし'}`,
        `内部: seekBusy=${seekBusy} pending=${seekPendingFrame} flipTarget=${flipTarget}`
            + ` readyState=${s.videoElement ? s.videoElement.readyState : '-'}`,
        `=== ログ (${debugLines.length}件) ===`
    ];
    return state.concat(debugLines).join('\n');
}

async function copyDebugReport() {
    const text = buildDebugReport();
    let ok = false;
    try {
        await navigator.clipboard.writeText(text);
        ok = true;
    } catch (e) {
        // クリップボードAPIが使えない環境向けのフォールバック
        try {
            const ta = document.createElement('textarea');
            ta.value = text;
            ta.style.position = 'fixed';
            ta.style.opacity = '0';
            document.body.appendChild(ta);
            ta.select();
            ok = document.execCommand('copy');
            document.body.removeChild(ta);
        } catch (e2) { ok = false; }
    }
    logDebug(ok ? 'デバッグレポートをコピーしました（そのまま貼り付けて報告できます）'
                : 'コピーに失敗しました。ログを長押しで選択してコピーしてください。');
}

// --- Undo 履歴 ＆ 自動保存 -------------------------------------------------
// （UndoボタンのUI配線・手順ガイド等の本格対応は Stage4。ここでは中核のみ）
const undoStack = [];
const UNDO_LIMIT = 50;
const STORAGE_KEY = 'tracker_for_ipad_state_v1';

// 変更直前の状態をスナップショットして履歴に積む
function pushHistory() {
    try {
        undoStack.push(JSON.stringify({
            trackingData: appState.trackingData,
            calibration: appState.calibration
        }));
        if (undoStack.length > UNDO_LIMIT) undoStack.shift();
    } catch (e) { /* 容量超過などは無視 */ }
    updateUndoButton();
}

function undo() {
    const snap = undoStack.pop();
    if (!snap) return;
    cancelDeferredConfirm(); // 保留中の確定が取消直後に発火して混乱させない
    try {
        const before = appState.trackingData;
        const obj = JSON.parse(snap);
        appState.trackingData = obj.trackingData || [];
        appState.calibration = obj.calibration || appState.calibration;
        setSelectedPoint(null);
        refreshCalibrationLabels();
        persistState();
        updateDataTable();
        drawVideoFrame();
        updateGraph();
        // 何が取り消されたかを言葉で返し、そのコマへ移動して見せる
        const desc = describeUndo(before, appState.trackingData);
        if (desc) {
            showStepBadge(desc.text);
            if (desc.frame !== null) {
                seekToFrame(desc.frame);
                flashHitChip(desc.frame); // 打点マップ上でも場所を教える
            }
        } else {
            showStepBadge('取り消しました');
        }
        logDebug('元に戻しました' + (desc ? `: ${desc.text}` : ''));
    } catch (e) { logDebug('Undo失敗'); }
    updateUndoButton();
}

// Undo前後の点データを比べて「何が起きたか」を短文にする
function describeUndo(before, after) {
    const key = (p) => `${p.objectId}:${p.frame}`;
    const mapB = new Map(before.map(p => [key(p), p]));
    const mapA = new Map(after.map(p => [key(p), p]));
    for (const [k, p] of mapB) {
        const q = mapA.get(k);
        if (!q) return { text: `コマ${p.frame}の点を取り消し`, frame: p.frame };
        if (q.x !== p.x || q.y !== p.y) return { text: `コマ${p.frame}の点を元の位置へ`, frame: p.frame };
    }
    for (const [k, q] of mapA) {
        if (!mapB.has(k)) return { text: `コマ${q.frame}の削除を取り消し`, frame: q.frame };
    }
    return null; // 校正のみの変化など
}

function updateUndoButton() {
    const btn = document.getElementById('btn-undo');
    if (btn) btn.disabled = undoStack.length === 0;
}

// localStorage への自動保存（動画自体は保存せず、計測データと校正のみ）
// video フィンガープリント(名前・サイズ・長さ)も併せて保存し、次回同じ動画を
// 読み込んだ時だけ復元を提案できるようにする。
function persistState() {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({
            trackingData: appState.trackingData,
            calibration: appState.calibration,
            videoFps: appState.videoFps,
            trackingStepSize: appState.trackingStepSize,
            activeObjectId: appState.activeObjectId,
            physicsFpsMultiplier: appState.physicsFpsMultiplier,
            slowMotionCaptureFps: appState.slowMotionCaptureFps,
            motionMode: appState.motionMode,
            video: {
                name: appState.videoName,
                size: appState.videoSize,
                duration: appState.videoDuration
            }
        }));
    } catch (e) { /* プライベートモード等では無視 */ }
}

// 前回の打点が保存として残っているか。残っていれば {n, label} を返す。
// 共用のiPadで「前の人の作業」が残っている場合も、途中で開き直した本人の場合もある。
function savedTrackingSummary() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return null;
        const obj = JSON.parse(raw);
        if (!Array.isArray(obj.trackingData) || obj.trackingData.length === 0) return null;
        const m = MOTION_MODES[obj.motionMode];
        return { n: obj.trackingData.length, label: m ? m.label : '' };
    } catch (e) { return null; }
}

// 新しい動画を読み込む直前に呼ぶ：前回の計測データ・校正・Undo履歴・選択状態を
// 全リセットする（「前回データの中途半端な干渉」対策）。表示も同期する。
function resetForNewVideo() {
    appState.scaleSkipped = false;
    appState.trackingData = [];
    appState.calibration = {
        origin: null,
        scaleRatio: null,
        scaleStart: null,
        scaleEnd: null,
        scaleActual: 0,
        scaleTempStart: null
    };
    appState.physicsFpsMultiplier = 1;
    appState.slowMotionCaptureFps = null;
    undoStack.length = 0;
    setSelectedPoint(null);
    updateDataTable();
    updateGraph();
    refreshCalibrationLabels();
    updateUndoButton();
}

// 保存データのフィンガープリント(名前・サイズ・長さ±0.1s)が現在の動画と一致するか判定
function persistedFingerprintMatches(obj) {
    const v = obj && obj.video;
    return !!v
        && v.name === appState.videoName
        && v.size === appState.videoSize
        && typeof v.duration === 'number'
        && Math.abs(v.duration - appState.videoDuration) <= 0.1
        && Array.isArray(obj.trackingData)
        && obj.trackingData.length > 0;
}

// 前回データは「破棄が既定」。動画を読み込んだ時点で黙って捨て、直後に数秒だけ
// 「戻す」を出す。確認ダイアログにすると、後から出るトリミング窓に上書きされて
// 操作できなくなる（実際に起きた不具合）うえ、毎回手が止まる。
// 戻せるのは、同じ動画（名前・サイズ・長さが一致）のときだけ。
let discardedState = null;
function discardPreviousState() {
    discardedState = null;
    let obj = null;
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return;
        obj = JSON.parse(raw);
    } catch (e) { return; }
    try { localStorage.removeItem(STORAGE_KEY); } catch (e) { /* 無視 */ }
    if (!obj || !persistedFingerprintMatches(obj)) return;
    discardedState = obj;   // 同じ動画のときだけ復帰候補として覚えておく
}

function offerUndoDiscard() {
    const obj = discardedState;
    if (!obj) return;
    const n = obj.trackingData.length;
    showUndoBadge(`前回の${n}点を破棄しました`, '戻す', () => {
        appState.trackingData = obj.trackingData;
        if (obj.calibration) appState.calibration = obj.calibration;
        if (obj.videoFps) appState.videoFps = obj.videoFps;
        if (obj.trackingStepSize) appState.trackingStepSize = obj.trackingStepSize;
        if (obj.activeObjectId) appState.activeObjectId = obj.activeObjectId;
        if (obj.physicsFpsMultiplier) appState.physicsFpsMultiplier = obj.physicsFpsMultiplier;
        if (obj.slowMotionCaptureFps) appState.slowMotionCaptureFps = obj.slowMotionCaptureFps;
        if (obj.motionMode && MOTION_MODES[obj.motionMode]) setMotionMode(obj.motionMode, false);
        discardedState = null;
        if (appState.calibration.scaleRatio) setPendingCapture(null);
        updateDataTable();
        updateGraph();
        refreshCalibrationLabels();
        updateUndoButton();
        updateScaleBanner();
        drawVideoFrame();
        persistState();
        logDebug(`前回の${n}点を復元しました。`);
    });
}

// 画面隅に数秒だけ出る、操作を止めない通知（ダイアログの代わり）
let undoBadgeTimer = null;
function showUndoBadge(text, actionLabel, onAction) {
    const el = document.getElementById('undo-badge');
    if (!el) return;
    const label = document.getElementById('undo-badge-text');
    const btn = document.getElementById('undo-badge-action');
    if (label) label.textContent = text;
    if (btn) {
        btn.textContent = actionLabel;
        const fresh = btn.cloneNode(true);
        btn.parentNode.replaceChild(fresh, btn);
        fresh.addEventListener('click', () => { hideUndoBadge(); onAction(); });
    }
    el.hidden = false;
    if (undoBadgeTimer) clearTimeout(undoBadgeTimer);
    undoBadgeTimer = setTimeout(hideUndoBadge, 9000);
}
function hideUndoBadge() {
    const el = document.getElementById('undo-badge');
    if (el) el.hidden = true;
    if (undoBadgeTimer) { clearTimeout(undoBadgeTimer); undoBadgeTimer = null; }
}

// 校正ラベル（原点/スケール/スロー表示）を現在の状態に同期
function refreshCalibrationLabels() {
    const infoS = document.getElementById('info-scale');
    if (infoS) infoS.textContent = appState.calibration.scaleRatio ? `${appState.calibration.scaleRatio.toFixed(3)} cm/px` : '未設定';
    const infoM = document.getElementById('info-slowmo');
    if (infoM) {
        infoM.textContent = appState.slowMotionCaptureFps
            ? `${appState.slowMotionCaptureFps}fps撮影 (${appState.physicsFpsMultiplier.toFixed(2)}倍補正)`
            : '通常速度';
    }
}

// --- DOM初期化 ---
document.addEventListener('DOMContentLoaded', () => {
    logDebug("アプリケーション起動");
    logDebug(`バージョン: ${APP_VERSION}`);
    const verLabel = document.getElementById('app-version-label');
    if (verLabel) verLabel.textContent = `v${APP_VERSION}`;
    const badge = document.getElementById('app-badge');
    if (badge) badge.textContent = `v${APP_VERSION}`;

    appState.videoElement = document.getElementById('hidden-video');
    appState.canvas = document.getElementById('tracker-canvas');
    appState.ctx = appState.canvas.getContext('2d');
    
    // 各種初期化
    setupFileUpload();
    setupSampleLoad();
    setupPlaybackControls();
    setupRangeControls();
    setupHitMap();
    setupDebugConsole();
    setupCanvasTouch();
    setupModeButtons();
    setupSettingsInputs();
    setupObjectButtons();
    setupExport();
    setupStrobe();
    setupAutoTrackerUI();
    setupGraphEvents();
    setupDeletionEvent();
    setupUndo();
    setupFpsInput();
    setupSlowMotionUI();
    setupModePanel();
    setupScaleBanner();

    // ウィンドウリサイズ時の処理
    window.addEventListener('resize', scheduleRelayout);
    // iOS は回転直後に古い寸法を返すことがあるので、orientationchange でも
    // 少し遅らせて測り直す（同じ寸法なら何もしないので二重でも害はない）
    window.addEventListener('orientationchange', () => {
        scheduleRelayout();
        setTimeout(scheduleRelayout, 300);
    });

    // 起動時の無条件復帰は廃止。動画読込時に前回データは破棄し、同じ動画のときだけ
    // 数秒間「戻す」を出す（discardPreviousState / offerUndoDiscard）。
    updateUndoButton();
    updateActionHint();
    updateStepGuide();
    updateObjectButtons();
    refreshFpsUI();

    // 空スタート: まず「どの運動を測るか」を選ばせ、そのパネルから動画を読み込ませる。
    // 前回の打点が残っているときも必ず聞く。共用のiPadだと「前の人」のモードを
    // 黙って引き継いで軸の符号が逆のまま測ってしまうので、その場合は前回の種類を
    // 選択済みにもしない（1タップ増えるだけ）。途中で開き直した本人は、同じ動画を
    // 選び直せば「戻す」で打点もモードも復帰できる。
    if (window.__suppressModePanel) {
        // 自動テストが「読み込み→操作」を一直線に走らせるための抜け道
        if (!appState.motionMode) setMotionMode(DEFAULT_MOTION_MODE, false);
    } else {
        const left = savedTrackingSummary();
        if (left) {
            appState.motionMode = null;
            logDebug(`前回の打点（${left.label}・${left.n}点）が残っています。運動の種類を選び直してください。`);
        }
        openModePanel();
    }
    logDebug("起動完了。動画を読み込んでください。");
});

// --- サンプル動画の読み込み（fetch経由のバックドア） ---
// 生徒の「お試し」用 兼 自動テスト用。アップロードダイアログを回避して
// サーバ上の動画を直接 Blob 化して読み込む。
// samples/ は tools/gen_samples.py で生成した真値既知の合成動画（詳細は MANUAL.md）。
const SAMPLE_LIST = [
    { file: 'samples/free_fall.mp4',           name: '自由落下',       hint: 'v0=0・約1.6m落下' },
    { file: 'samples/vertical_throw.mp4',      name: '鉛直投げ上げ',   hint: '上がって戻ってくる' },
    { file: 'samples/projectile.mp4',          name: '水平投射',       hint: '水平に投げ出した球' },
    { file: 'samples/oblique_throw.mp4',       name: '斜方投射',       hint: '斜め45°に打ち上げ' },
    { file: 'samples/collision_elastic.mp4',   name: '衝突（弾性）',   hint: '動く球が静止球に・物体2つ' },
    { file: 'samples/collision_inelastic.mp4', name: '衝突（合体）',   hint: 'くっついて動く・物体2つ' }
];

function setupSampleLoad() {
    const btn = document.getElementById('btn-load-sample');
    if (btn) btn.addEventListener('click', showSampleDialog);
}
const openSamplePicker = () => showSampleDialog();

// サンプル選択ダイアログ。各項目に現象名と一言ヒントのみ（真値の詳細は MANUAL.md）。
function showSampleDialog() {
    const items = SAMPLE_LIST.map((s, i) =>
        `<button class="btn btn-secondary sample-item" data-idx="${i}"
                 style="width:100%; justify-content:flex-start; margin-bottom:6px;">
             <span class="material-icons-round">smart_display</span>
             ${s.name}<span style="margin-left:auto; font-size:0.72rem; color:#52606D;">${s.hint}</span>
         </button>`).join('');
    const body = `
        <p style="margin-bottom:8px; font-size:0.8rem; color:#52606D;">
            どの動画にも画面下に「1 m」のスケールバーがあります。まずそのバーで
            スケール設定してから測ってください。
        </p>
        <div>${items}</div>`;
    showInputDialog('サンプル動画を選ぶ', body, '', () => {});
    document.querySelectorAll('.sample-item').forEach(el => {
        el.addEventListener('click', () => {
            const s = SAMPLE_LIST[parseInt(el.dataset.idx)];
            document.getElementById('dialog-btn-cancel').click(); // ダイアログを閉じる
            loadSampleByUrl(s.file, `${s.name} (${s.file.split('/').pop()})`);
        });
    });
}

// テスト用バックドア（テストハーネスが直接呼ぶ。UI からは使わない）
function loadSampleVideo() {
    loadSampleByUrl('tests/fixtures/sample.mp4', 'sample.mp4');
}

function loadSampleByUrl(url, displayName) {
    logDebug(`サンプル動画 (${displayName}) を読み込みます...`);
    fetch(url)
        .then(res => {
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return res.blob();
        })
        .then(blob => {
            if (appState.videoElement.src && appState.videoElement.src.startsWith('blob:')) {
                URL.revokeObjectURL(appState.videoElement.src);
            }
            // 新しい動画を読み込む前に、前回データの中途半端な干渉を防ぐため全リセット
            resetForNewVideo();
            appState.videoName = url;
            appState.videoSize = blob.size;
            appState.videoBlob = blob; // コンテナ解析(mp4box)用に元データを保持

            const objectUrl = URL.createObjectURL(blob);
            const hintOverlay = document.getElementById('hint-overlay');
            if (hintOverlay) hintOverlay.style.opacity = '0';
            appState.fpsManual = false;
            appState.fpsMeasured = false;
            appState.frameTimes = [];
            appState.videoElement.src = objectUrl;
            appState.videoElement.load();
        })
        .catch(err => logDebug(`サンプル読み込み失敗: ${err.message}（ローカルサーバ経由で開いてください）`));
}

function setupUndo() {
    const btn = document.getElementById('btn-undo');
    if (btn) btn.addEventListener('click', undo);
}

// --- デバッグコンソールのトグル ---
function setupDebugConsole() {
    const btnToggle = document.getElementById('btn-toggle-debug');
    const consoleDiv = document.getElementById('debug-console');
    const btnClear = document.getElementById('btn-clear-debug');
    
    if (btnToggle && consoleDiv) {
        btnToggle.addEventListener('click', () => {
            consoleDiv.style.display = consoleDiv.style.display === 'none' ? 'flex' : 'none';
        });
    }
    
    if (btnClear) {
        btnClear.addEventListener('click', () => {
            debugLines.length = 0;
            const logList = document.getElementById('debug-log-list');
            if (logList) logList.innerHTML = '';
        });
    }

    const btnCopy = document.getElementById('btn-copy-debug');
    if (btnCopy) btnCopy.addEventListener('click', copyDebugReport);
}

// --- 動画のアップロード・ロード ---
function setupFileUpload() {
    const uploadInput = document.getElementById('video-upload');
    const hintOverlay = document.getElementById('hint-overlay');
    
    if (uploadInput) {
        uploadInput.addEventListener('change', (e) => {
            const file = e.target.files[0];
            if (!file) return;
            
            logDebug(`ファイル選択: ${file.name} (${(file.size / (1024 * 1024)).toFixed(2)} MB)`);

            if (appState.videoElement.src && appState.videoElement.src.startsWith('blob:')) {
                URL.revokeObjectURL(appState.videoElement.src);
            }

            // 新しい動画を読み込む前に、前回データの中途半端な干渉を防ぐため全リセット
            resetForNewVideo();
            appState.videoName = file.name;
            appState.videoSize = file.size;
            appState.videoBlob = file; // コンテナ解析(mp4box)用に元データを保持

            const fileUrl = URL.createObjectURL(file);
            if (hintOverlay) hintOverlay.style.opacity = '0';

            // 新しい動画では実FPSを測り直す
            appState.fpsManual = false;
            appState.fpsMeasured = false;
            appState.frameTimes = [];
            appState.videoElement.src = fileUrl;
            appState.videoElement.load();
        });
    }
    
    appState.videoElement.addEventListener('loadedmetadata', async () => {
        appState.videoDuration = appState.videoElement.duration;
        appState.totalFrames = Math.floor(appState.videoDuration * appState.videoFps);
        appState.currentFrame = 0;

        logDebug(`動画ロード完了: 長さ ${appState.videoDuration.toFixed(2)}s, 総フレーム数 ${appState.totalFrames} (FPS: ${appState.videoFps})`);

        const slider = document.getElementById('frame-slider');
        if (slider) {
            slider.disabled = false;
            slider.max = appState.totalFrames;
            slider.value = 0;
        }

        refreshFpsUI();
        updateTimeDisplay();
        handleResize();
        updateGraph();
        updateStepGuide();

        // 前回データは黙って破棄する（同じ動画なら、あとで「戻す」を数秒だけ出す）
        discardPreviousState();

        // 読込直後に全フレームをシーク走査し、実フレーム時刻表＋重複除外を確定して先頭へ
        await startFrameScan();

        // 読み込み完了ダイアログ（コマ数の提示＋前後カット）。閉じた後に、
        // スロー撮影の痕跡を軽く探して必要ならスロー設定ダイアログを出す。
        showTrimDialog(async () => {
            // 測定に入る前に必ずスケールを決めさせる（省略は帯の中の小さなリンクから）
            if (needsScale()) enterScaleStep();
            offerUndoDiscard();
            if (!appState.slowMotionCaptureFps) {
                const hinted = await detectSlowMotionHint(appState.videoBlob);
                const overlay = document.getElementById('dialog-overlay');
                const dialogBusy = overlay && overlay.style.display === 'flex';
                if (hinted && !dialogBusy && !appState.slowMotionCaptureFps) {
                    logDebug('スロー撮影の痕跡を検出しました。設定を確認してください。');
                    openSlowMotionDialog(true);
                }
            }
        });
    });
    
    appState.videoElement.addEventListener('canplay', () => {
        updateOffscreenCanvas();
        drawVideoFrame();
    });
    
    appState.videoElement.addEventListener('seeked', () => {
        if (appState.isScanning) return; // 走査中の大量シークでは本描画をスキップ（高速化）
        updateOffscreenCanvas();
        drawVideoFrame();
        updateTimeDisplay();
        updateFrameLabel(appState.currentFrame);
        drawTrimPreview(); // トリミングダイアログが開いている間はプレビューにも反映
    });
    
    appState.videoElement.addEventListener('error', () => {
        const err = appState.videoElement.error;
        logDebug(`動画エラー発生: ${err ? `[code ${err.code}] ${err.message}` : 'Unknown'}`);
        showVideoErrorDialog(err);
    });
}

// 動画が開けなかったことを、生徒にも分かる形で画面に出す。
// これが無いと「真っ黒な画面のまま何も起きない」だけになり、原因も対処も分からない。
// いちばん多いのは HEVC（iPhone/iPadの「高効率」で撮った動画）を、HEVCを再生
// できないブラウザ（多くのWindows/ChromeOS環境のChrome等）で開いた場合。
// iPad の Safari はHEVCを再生できるので、撮った端末でそのまま開けば起きない。
function showVideoErrorDialog(err) {
    const code = err ? err.code : 0;
    const unsupported = (code === 4);   // MEDIA_ERR_SRC_NOT_SUPPORTED
    const hintEl = document.getElementById('hint-overlay');
    if (hintEl) {
        hintEl.style.display = '';
        const p = hintEl.querySelector('p');
        if (p) p.textContent = unsupported
            ? 'この動画は、このブラウザでは開けませんでした'
            : '動画の読み込みに失敗しました';
    }
    const body = unsupported ? `
        <p style="margin-bottom:10px;">この動画の形式が、いま使っているブラウザに対応していないか、
        ファイルが途中で壊れています。いちばん多いのは
        <b>iPhone / iPad の「高効率」（HEVC）で撮った動画</b>を、他の端末のブラウザで開いたときです。</p>
        <p style="margin-bottom:6px;"><b>HEVC が原因なら、どれかひとつで直ります。</b></p>
        <ul style="margin:0 0 10px 18px; line-height:1.7;">
            <li><b>撮った iPad / iPhone の Safari でこのページを開く</b>（いちばん簡単。そのまま開けます）</li>
            <li>撮り直せるなら、端末の <b>設定 &gt; カメラ &gt; フォーマット</b> を
                <b>「互換性優先」</b>にしてから撮る（H.264 で保存されます）</li>
            <li>すでにある動画なら、共有時に「最も互換性の高い形式」で書き出す</li>
        </ul>
        <p style="font-size:0.8rem; color:#52606D;">
        ※ 動画そのものは壊れていません。再生できるブラウザで開けばそのまま使えます。</p>`
        : `<p>動画を読み込めませんでした。ファイルが壊れていないか、別の動画で試せるかを確認してください。</p>
           <p style="font-size:0.8rem; color:#52606D; margin-top:8px;">${err ? err.message : ''}</p>`;
    showInputDialog(unsupported ? 'この形式の動画は開けません' : '動画を読み込めません', body, '', () => {});
}

// --- フレーム走査（fps非依存の実フレーム時刻表＋重複除外） -----------------
// 動画をシークして全フレームの実時刻(mediaTime)を取得し、重複フレームを除外する。
// 再生せずシークするので高fps(スロー)でもコマ脱落しない。rVFC非対応の古い端末
// （格安スマホ等）では (frame+0.5)/fps の換算へ優雅に劣化し、壊れない。
let rvfcSupported = typeof HTMLVideoElement !== 'undefined'
    && 'requestVideoFrameCallback' in HTMLVideoElement.prototype;
// テスト用：rVFC非対応端末（古い格安スマホ等）を擬似的に再現する
if (typeof window !== 'undefined') window.__setRvfc = (b) => { rvfcSupported = !!b; };

// 走査用の縮小キャンバス（重複判定の画素比較に使用）
let scanCanvas = null, scanCtx = null;
const SCAN_W = 160, SCAN_H = 90;
function frameSignature(v) {
    if (!scanCanvas) {
        scanCanvas = document.createElement('canvas');
        scanCanvas.width = SCAN_W; scanCanvas.height = SCAN_H;
        scanCtx = scanCanvas.getContext('2d', { willReadFrequently: true });
    }
    try { scanCtx.drawImage(v, 0, 0, SCAN_W, SCAN_H); }
    catch (e) { return null; }
    return scanCtx.getImageData(0, 0, SCAN_W, SCAN_H).data;
}
// 2フレーム間で「明確に変化した画素」の割合(0..1)。真の複製は 0 になる。
// 1画素あたりのしきい値は低く取る（＝感度を高く保つ）。ここを鈍くすると、
// 投げ上げの頂点や自由落下の出だしのような「本当にほとんど動かないコマ」を
// エンコード複製と誤判定して捨ててしまう。実測（vertical_throw.mp4・全54コマ）:
//   d>24 … 頂点で 0.049% まで落ち、判定ライン0.08%を割って誤爆
//   d>6  … 最小でも 0.09% で、割り込まない（真の複製は 0% なので余裕を持って分離）
const PIXEL_DIFF_THRESHOLD = 6;
function changedFraction(a, b) {
    if (!a || !b || a.length !== b.length) return 1;
    let changed = 0; const n = a.length / 4;
    for (let i = 0; i < a.length; i += 4) {
        const d = Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
        if (d > PIXEL_DIFF_THRESHOLD) changed++;
    }
    return changed / n;
}
const DUP_FRACTION = 0.0008;  // 変化画素 < 0.08% ＝ ほぼ画素一致 ＝ エンコード複製
// 誤検出セーフティの上限。本来の対象である「60fpsコンテナに30fpsの中身」は
// 複製率が約50%になるため、0.2のままだと本来の用途で一度も発動しなかった。
const DUP_SAFETY_MAX = 0.60;

// シークして「表示されたフレーム」の mediaTime と署名を返す
function getFrameAt(v, targetTime) {
    return new Promise(resolve => {
        let done = false;
        const finish = (mt) => { if (done) return; done = true; resolve({ mediaTime: mt, sig: frameSignature(v) }); };
        if (rvfcSupported) {
            v.requestVideoFrameCallback((now, meta) => finish(meta.mediaTime));
        } else {
            const onSeeked = () => { v.removeEventListener('seeked', onSeeked); finish(v.currentTime); };
            v.addEventListener('seeked', onSeeked);
        }
        v.currentTime = Math.max(0, Math.min((v.duration || 0) - 1e-4, targetTime));
        setTimeout(() => finish(v.currentTime), 2500); // 安全網（応答が無い端末向け）
    });
}

// 進捗表示（ダイアログではなくヒントオーバーレイをインライン流用）
function showScanProgress(ratio) {
    const o = document.getElementById('hint-overlay');
    if (!o) return;
    o.style.opacity = '1';
    const pct = Math.round(Math.max(0, Math.min(1, ratio)) * 100);
    const p = o.querySelector('p');
    if (p) p.textContent = `解析準備中… ${pct}%`;
    const icon = o.querySelector('.material-icons-round');
    if (icon) icon.textContent = 'hourglass_top';
}
function hideScanProgress() {
    const o = document.getElementById('hint-overlay');
    if (o) o.style.opacity = '0';
}

// --- コンテナ解析（mp4box.js）: デコードもシークもせず実サンプル時刻を瞬時に取得 ---
// iPad撮影の .mov/.mp4（H.264/HEVC・スロモVFR含む）はここで数百msで時刻表が完成する。
// パース不能な形式や検証NG時のみ、従来のシーク走査へフォールバックする。
// 長い動画をうっかり読み込んでもクラッシュしないための上限。
// これ以下のファイルは従来どおり全読みでパースし、超えるものは
// 「先頭＋末尾だけ」を疎に渡してmoov(サンプル表)を探す（数GBの動画を
// ArrayBufferに全読みするとiPad Safariが落ちるため）。
const CONTAINER_WHOLE_READ_MAX = 96 * 1024 * 1024;
const CONTAINER_HEAD_BYTES = 16 * 1024 * 1024;
const CONTAINER_TAIL_BYTES = 48 * 1024 * 1024;

async function buildTimesFromContainer(blob) {
    if (typeof MP4Box === 'undefined' || !blob) return null;
    try {
        if (blob.size <= CONTAINER_WHOLE_READ_MAX) {
            const buf = await blob.arrayBuffer();
            buf.fileStart = 0;
            return await parseTimesWithMp4box([buf], false);
        }
        // 疎読み: moovは先頭(faststart)か末尾(カメラ撮って出し)にあることがほとんど
        logDebug(`大きな動画(${Math.round(blob.size / 1048576)}MB)のため疎読みでコンテナ解析します`);
        const headBuf = await blob.slice(0, CONTAINER_HEAD_BYTES).arrayBuffer();
        headBuf.fileStart = 0;
        const tailStart = Math.max(CONTAINER_HEAD_BYTES, blob.size - CONTAINER_TAIL_BYTES);
        const tailBuf = await blob.slice(tailStart, blob.size).arrayBuffer();
        tailBuf.fileStart = tailStart;
        return await parseTimesWithMp4box([headBuf, tailBuf], true);
    } catch (e) { return null; }
}

function parseTimesWithMp4box(buffers, sparse) {
    return new Promise((resolve) => {
        const mp4 = MP4Box.createFile();
        let nbSamples = 0;
        const times = [];
        const to = setTimeout(() => resolve(null), 8000); // 安全網
        const done = (r) => { clearTimeout(to); resolve(r); };
        mp4.onError = () => done(null);
        mp4.onReady = (info) => {
            const track = (info.videoTracks && info.videoTracks[0]) || null;
            if (!track || !track.nb_samples) { done(null); return; }
            nbSamples = track.nb_samples;
            // moovのサンプル表からctsを直接読む（mdat不要＝疎読みでも動く）
            if (typeof mp4.getTrackSamplesInfo === 'function') {
                try {
                    const infos = mp4.getTrackSamplesInfo(track.id);
                    if (infos && infos.length >= 2) {
                        done(infos.map(s => s.cts / s.timescale));
                        return;
                    }
                } catch (e) { /* 下の抽出方式へ */ }
            }
            if (sparse) { done(null); return; } // 疎読みではサンプル抽出はできない
            mp4.setExtractionOptions(track.id, null, { nbSamples: nbSamples });
            mp4.start();
        };
        mp4.onSamples = (id, user, samples) => {
            for (const s of samples) times.push(s.cts / s.timescale);
            if (nbSamples && times.length >= nbSamples) done(times);
        };
        for (const b of buffers) mp4.appendBuffer(b);
        mp4.flush();
    });
}

// コンテナ由来の時刻表が <video> の再生時間軸と一致しているか、実シークで数点だけ検証。
// （MP4のedit listでcts軸と再生軸がずれる動画があるため。ずれていたら走査へ切替）
async function verifyTimesAgainstVideo(v, times) {
    if (!rvfcSupported) return true; // rVFC無し端末は検証不能→信じる（換算より高精度）
    const picks = [0, Math.floor((times.length - 1) / 2)];
    for (const i of picks) {
        const lo = times[i];
        const hi = (i < times.length - 1) ? times[i + 1] : lo + (times[i] - times[i - 1] || 1 / 30);
        const fr = await getFrameAt(v, (lo + hi) / 2);
        // 表示フレームの実時刻が期待区間(±半コマ)に入っていればOK
        const tol = (hi - lo) * 0.75;
        if (Math.abs(fr.mediaTime - lo) > tol) return false;
    }
    return true;
}

// 指定の時刻表に対し、実フレームを1枚ずつ表示してピクセル署名で複製コマを除外する。
// コマ数が少ない（＝短い動画 or 解析範囲確定後）ときだけ呼ぶこと。
async function dedupTimesByPixel(v, times) {
    const kept = [];
    let lastSig = null, skipped = 0;
    for (let i = 0; i < times.length; i++) {
        const lo = times[i];
        const hi = (i < times.length - 1) ? times[i + 1] : lo + (lo - (times[i - 1] || lo - 1 / 30));
        const fr = await getFrameAt(v, (lo + hi) / 2);
        const isDup = lastSig && changedFraction(fr.sig, lastSig) < DUP_FRACTION;
        if (isDup) { skipped++; } else { kept.push(times[i]); lastSig = fr.sig; }
        showScanProgress((i + 1) / times.length);
    }
    // 誤検出セーフティ（2割超が複製判定なら除外しない）
    if (skipped > 0 && skipped <= times.length * DUP_SAFETY_MAX) return { times: kept, skipped };
    return { times: times.slice(), skipped: 0 };
}

// 読込時にその場で複製除外まで済ませてよいコマ数の上限（超える場合は範囲確定後に実施）
const DEDUP_AT_LOAD_MAX = 64;

// 読込直後に呼ばれる。コンテナ解析→（短尺なら）複製除外。不能時のみシーク走査。
async function startFrameScan() {
    const v = appState.videoElement;
    if (!v || v.readyState < 1) return;
    if (appState.fpsManual) { // 手動fps指定時は走査せず換算
        appState.frameTimes = [];
        appState.totalFrames = Math.max(0, Math.floor(appState.videoDuration * appState.videoFps));
        resetAnalysisRange();
        seekToFrame(0); return;
    }
    appState.isScanning = true;
    appState.dedupDone = false;
    showScanProgress(0);
    let result = null;

    // 1) コンテナ解析（瞬時・シーク不要）
    try {
        let times = await buildTimesFromContainer(appState.videoBlob);
        if (times && times.length >= 2) {
            const tMin = times.reduce((a, b) => (b < a ? b : a), Infinity);
            times = buildFrameTimeTable(times.map(t => t - tMin));
            if (await verifyTimesAgainstVideo(v, times)) {
                if (times.length <= DEDUP_AT_LOAD_MAX) {
                    const d = await dedupTimesByPixel(v, times);
                    result = { times: d.times, skipped: d.skipped, seeks: 0 };
                    appState.dedupDone = true;
                } else {
                    result = { times, skipped: 0, seeks: 0 };
                }
                logDebug('コンテナ解析で時刻表を取得（シーク走査なし）');
            } else {
                logDebug('コンテナ時刻表が再生軸と不一致。シーク走査に切替えます。');
            }
        }
    } catch (e) { logDebug('コンテナ解析に失敗: ' + (e && e.message)); }

    // 2) フォールバック: 従来のシーク走査。
    //    長い動画は全コマ走査すると数分〜フリーズ級になるためスキップし、
    //    fps換算（精度はやや低下・機能は無傷）へ落とす。
    const SCAN_MAX_SECONDS = 45;
    if (!result) {
        if (appState.videoDuration > SCAN_MAX_SECONDS) {
            logDebug(`長い動画(${appState.videoDuration.toFixed(0)}s)のため全コマ走査をスキップし、fps換算で続行します`);
        } else {
            try { result = rvfcSupported ? await scanAllFrames(v) : await scanGridFallback(v); }
            catch (e) { logDebug('フレーム走査に失敗: ' + (e && e.message)); }
            if (result) appState.dedupDone = true; // 走査は複製除外込み
        }
    }
    appState.isScanning = false;
    hideScanProgress();

    if (result && result.times.length >= 2) {
        appState.frameTimes = result.times;
        appState.totalFrames = result.times.length - 1;
        appState.fpsMeasured = true;
        appState.videoFps = friendlyFpsFromTimes(result.times);
        logDebug(`フレーム走査完了: ${result.times.length}コマ（実時刻表）`
            + (result.skipped ? `／重複 ${result.skipped} コマを自動除外` : '')
            + (result.seeks ? `／seek ${result.seeks}回` : ''));
    } else {
        // 走査不能（古い端末等）→ fps 換算フォールバック
        appState.frameTimes = [];
        appState.videoFps = appState.videoFps || 30;
        appState.totalFrames = Math.max(0, Math.floor(appState.videoDuration * appState.videoFps));
        logDebug('フレーム走査不可。fps換算にフォールバックします（精度はやや低下）。');
    }
    refreshFpsUI();
    const slider = document.getElementById('frame-slider');
    if (slider) slider.max = appState.totalFrames;
    resetAnalysisRange();
    seekToFrame(0);
    updateTimeDisplay();
    persistState();
    updateGraph();
    updateStepGuide();
    updateHitMap();
}

// 全フレームをシークで列挙し、{実時刻, 複製フラグ} を作る。
async function scanAllFrames(v) {
    const dur = v.duration;
    if (!dur || !isFinite(dur)) return null;
    const MAX_SEEKS = 5000;
    let seeks = 0;
    const frames = []; // { t, sig, dup }

    // フレーム0
    let f0 = await getFrameAt(v, 0); seeks++;
    frames.push({ t: f0.mediaTime, sig: f0.sig, dup: false });
    let lastT = f0.mediaTime, lastSig = f0.sig;

    // 最初の間隔を測る（次フレームに当たるまでステップを倍々で広げる）
    let step = 1 / 240;
    let probe = await getFrameAt(v, lastT + step); seeks++;
    let guard = 0;
    while (probe.mediaTime <= lastT + 1e-4 && guard < 40 && seeks < MAX_SEEKS) {
        step *= 1.6; probe = await getFrameAt(v, lastT + step); seeks++; guard++;
    }
    let interval = Math.max(1e-4, probe.mediaTime - lastT);
    let pending = probe;       // 取得済みの「次フレーム」
    let curT = lastT;

    while (seeks < MAX_SEEKS) {
        let fr = pending; pending = null;
        if (!fr) {
            // 控えめ(半間隔)から始め、当たるまで少しずつ広げる。1フレームを飛び越えないため
            // 常に「次フレーム境界の手前」から漸増する → スキップ無しで必ず隣のコマに当たる。
            const grow = Math.max(interval * 0.34, 1 / 1000);
            let st = interval * 0.5;
            let target = curT + st;
            if (target >= dur - 1e-4) break;
            fr = await getFrameAt(v, target); seeks++;
            let g2 = 0;
            while (fr.mediaTime <= lastT + 1e-4 && g2 < 30 && seeks < MAX_SEEKS) {
                st += grow;
                target = curT + st;
                if (target >= dur - 1e-4) { fr = null; break; }
                fr = await getFrameAt(v, target); seeks++; g2++;
            }
            if (!fr || fr.mediaTime <= lastT + 1e-4) break; // 末尾に到達
        }
        const gap = fr.mediaTime - lastT;
        // 直近間隔へ追従（VFR対応）。ただし飛び越え(>1.4倍)時は更新せず基準を保つ。
        if (gap > 0 && gap < interval * 1.4) interval = gap;
        const isDup = changedFraction(fr.sig, lastSig) < DUP_FRACTION;
        frames.push({ t: fr.mediaTime, sig: fr.sig, dup: isDup });
        if (!isDup) lastSig = fr.sig;           // 複製でない時だけ基準署名を更新
        lastT = fr.mediaTime; curT = fr.mediaTime;
        showScanProgress(curT / dur);
    }

    // 複製除外（誤検出セーフティ：多すぎるなら除外しない）
    const dupCount = frames.filter(f => f.dup).length;
    let times, skipped = 0;
    if (dupCount > 0 && dupCount <= frames.length * DUP_SAFETY_MAX) {
        times = frames.filter(f => !f.dup).map(f => f.t);
        skipped = dupCount;
    } else {
        times = frames.map(f => f.t);
    }
    times = buildFrameTimeTable(times); // 昇順保証＋近接(1ms)重複除去
    return { times, skipped, seeks };
}

// rVFC非対応の古い端末向けフォールバック：細かいグリッドでシークし、画素変化で
// 「新しい実フレーム」を検出してその初出時刻を記録する。VFRも近似でき、複製は自然に除外。
async function scanGridFallback(v) {
    const dur = v.duration;
    if (!dur || !isFinite(dur)) return null;
    const step = 1 / (240 * 2);   // 最大240fps想定の細かさ
    const MAX_SEEKS = 6000;
    let seeks = 0;
    const times = [];
    let f0 = await getFrameAt(v, 0); seeks++;
    times.push(0); let lastSig = f0.sig;
    for (let t = step; t < dur - 1e-4 && seeks < MAX_SEEKS; t += step) {
        const fr = await getFrameAt(v, t); seeks++;
        if (changedFraction(fr.sig, lastSig) >= DUP_FRACTION) { // 画素が明確に変化＝次フレーム
            times.push(t); lastSig = fr.sig;
        }
        showScanProgress(t / dur);
    }
    let out = buildFrameTimeTable(times);
    // 初出時刻はグリッド分（±step）のジッタを含む。ほぼ等間隔(CFR)なら一様間隔へスナップして
    // 数値微分(加速度)のノイズを抑える。VFRはそのまま。
    if (out.length >= 3) {
        const dts = out.slice(1).map((t, i) => t - out[i]);
        const sorted = [...dts].sort((a, b) => a - b);
        const med = sorted[Math.floor(sorted.length / 2)];
        if (med > 0 && dts.every(d => Math.abs(d - med) < med * 0.45)) {
            out = out.map((_, i) => out[0] + i * med); // CFRスナップ
        }
    }
    return { times: out, skipped: 0, seeks };
}

// 実フレーム時刻表から表示用の「親しみやすいfps」を求める（中央値間隔→常用値スナップ）
function friendlyFpsFromTimes(times) {
    if (times.length < 2) return appState.videoFps || 30;
    const dts = [];
    for (let i = 1; i < times.length; i++) dts.push(times[i] - times[i - 1]);
    return fpsFromSamples(dts) || (appState.videoFps || 30);
}


// フレーム間隔サンプルの中央値からFPSを推定。近ければ常用値にスナップ。
function fpsFromSamples(samples) {
    const sorted = [...samples].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    if (!median || median <= 0) return null;
    let fps = 1 / median;
    const common = [23.976, 24, 25, 29.97, 30, 50, 59.94, 60, 100, 120, 240];
    let best = null, bestErr = 0.03; // 3%以内で最も近い常用値にスナップ
    for (const c of common) {
        const err = Math.abs(fps - c) / c;
        if (err < bestErr) { bestErr = err; best = c; }
    }
    if (best !== null) return Math.round(best * 1000) / 1000;
    return Math.round(fps * 100) / 100;
}

// 観測した mediaTime 列 → 昇順・重複除去したフレーム時刻表
function buildFrameTimeTable(times) {
    const sorted = [...times].sort((a, b) => a - b);
    const out = [];
    const eps = 1e-3; // 1ms 以内は同一フレームとみなす
    for (const t of sorted) {
        if (out.length === 0 || t - out[out.length - 1] > eps) out.push(t);
    }
    return out;
}

// コマ番号 → そのフレームの物理時刻（s）。表が無ければ fps 換算にフォールバック。
// physicsFpsMultiplier(既定1)で補正する。スロー動画がコンテナ上は見かけのfpsを
// 名乗りつつ、実際の経過時間はもっと短い（真の撮影fpsの方が高い）ケースに対応するため。
// この関数の戻り値だけが運動学計算(computeKinematics)やストロボの時間基準に使われ、
// 動画そのもののシーク(seekTimeOf)には一切影響しない＝コマ送りや再生位置は今まで通り正確。
function frameTimeOf(i) {
    const ft = appState.frameTimes;
    const containerT = (ft && ft.length)
        ? ft[Math.max(0, Math.min(ft.length - 1, i))]
        : i / appState.videoFps;
    return containerT / (appState.physicsFpsMultiplier || 1);
}

// コマ番号 → シーク先の currentTime（s）。表があればフレーム表示区間の中央を狙い、
// デコード境界の丸めズレを避けて確実にそのフレームを表示させる。
function seekTimeOf(i) {
    const ft = appState.frameTimes;
    if (ft && ft.length) {
        const n = Math.max(0, Math.min(ft.length - 1, i));
        if (n < ft.length - 1) return (ft[n] + ft[n + 1]) / 2;
        if (ft.length >= 2)    return Math.min(appState.videoDuration - 0.001, ft[n] + (ft[n] - ft[n - 1]) / 2);
        return ft[n];
    }
    return (i + 0.5) / appState.videoFps;
}

// FPS表示（インジケータ＋入力欄）を現在値に同期
function refreshFpsUI() {
    const lbl = document.getElementById('lbl-fps');
    if (lbl) lbl.textContent = appState.videoFps + (appState.fpsMeasured && !appState.fpsManual ? '' : '*');
    const input = document.getElementById('fps-input');
    if (input && document.activeElement !== input) input.value = appState.videoFps;
}

// 手動FPS上書き
function setFpsManual(val) {
    const fps = parseFloat(val);
    if (isNaN(fps) || fps <= 0) { refreshFpsUI(); return; }
    appState.videoFps = Math.round(fps * 100) / 100;
    appState.fpsManual = true;
    appState.fpsMeasured = false;
    appState.frameTimes = []; // 手動fps指定時は実測時刻表を破棄し、一様fpsを採用
    if (appState.videoDuration) {
        appState.totalFrames = Math.max(0, Math.floor(appState.videoDuration * appState.videoFps));
        const slider = document.getElementById('frame-slider');
        if (slider) slider.max = appState.totalFrames;
    }
    // 既存点の時刻を新FPSで再計算
    appState.trackingData.forEach(p => { p.time = frameTimeOf(p.frame); });
    refreshFpsUI();
    persistState();
    updateDataTable();
    updateGraph();
    logDebug(`FPSを手動設定: ${appState.videoFps}`);
}

function setupFpsInput() {
    const input = document.getElementById('fps-input');
    if (input) {
        input.addEventListener('change', (e) => setFpsManual(e.target.value));
    }
}

// --- スロー動画の物理時間補正 ------------------------------------------
// 「実際に撮影したfps」を入力させ、コンテナの見かけfps(videoFps)との比を
// physicsFpsMultiplierとして保持する。videoFps自体（シークに使う）は触らない。
// val が空/不正なら補正なし(1倍)に戻す。
function setSlowMotionCaptureFps(val) {
    const trueFps = parseFloat(val);
    if (!val || isNaN(trueFps) || trueFps <= 0) {
        appState.physicsFpsMultiplier = 1;
        appState.slowMotionCaptureFps = null;
        logDebug('スロー補正を解除しました（通常速度として扱います）');
    } else {
        appState.physicsFpsMultiplier = trueFps / appState.videoFps;
        appState.slowMotionCaptureFps = Math.round(trueFps * 100) / 100;
        logDebug(`スロー補正を設定: 撮影${appState.slowMotionCaptureFps}fps ÷ コンテナ${appState.videoFps}fps = ${appState.physicsFpsMultiplier.toFixed(3)}倍`);
    }
    // 既存点の物理時刻を再計算（スケール変更時と同じパターン）
    appState.trackingData.forEach(p => { p.time = frameTimeOf(p.frame); });
    refreshCalibrationLabels();
    persistState();
    updateDataTable();
    updateGraph();
}

// スロー設定ダイアログを開く。hintedがtrueなら「検出されたので確認してほしい」文面にする。
function openSlowMotionDialog(hinted) {
    const current = appState.slowMotionCaptureFps;
    const intro = hinted
        ? `この動画にはスロー撮影の痕跡（QuickTimeの再生意図メタデータ）が見つかりました。<br>
           見かけ上は${appState.videoFps}fpsですが、実際はもっと高いfpsで撮影されている可能性があります。`
        : `動画の見かけ上のfpsと、実際の撮影fpsが異なる（スロー撮影を書き出したファイルである）場合、
           ここで実際の撮影fpsを指定すると、速度・加速度の計算に正しく反映されます。`;
    const body = `
        <p style="margin-bottom:6px;">${intro}</p>
        <p style="font-size:0.8rem; color:#52606D; margin-bottom:8px;">
            カメラの「設定 &gt; カメラ &gt; スローモーション撮影」で選んだfpsを入力してください。
            分からない/スローで撮っていない場合は「通常速度」のままでOKです。
        </p>
        <div style="display:flex; gap:8px; margin-bottom:8px;">
            <button class="btn btn-secondary" id="slowmo-preset-120" style="flex:1;">120fps</button>
            <button class="btn btn-secondary" id="slowmo-preset-240" style="flex:1;">240fps</button>
            <button class="btn btn-secondary" id="slowmo-preset-none" style="flex:1;">通常速度</button>
        </div>
        <label style="font-size:0.85rem;">実際の撮影fps（任意入力）:
            <input type="text" id="dialog-input-val" value="${current || ''}" placeholder="例: 240" style="width:100%; margin-top:4px;">
        </label>
    `;
    showInputDialog('スロー設定', body, current || '', (val) => setSlowMotionCaptureFps(val));
    const presetBtn = (id, v) => {
        const b = document.getElementById(id);
        if (b) b.addEventListener('click', () => { document.getElementById('dialog-input-val').value = v; });
    };
    presetBtn('slowmo-preset-120', '120');
    presetBtn('slowmo-preset-240', '240');
    presetBtn('slowmo-preset-none', '');
}

function setupSlowMotionUI() {
    const btn = document.getElementById('btn-set-slowmo');
    if (btn) btn.addEventListener('click', () => openSlowMotionDialog(false));
}

// --- スロー撮影の"痕跡"を軽量に検出する（ベストエフォート・厳密パース不要） -----
// iOS/iPadOS18+のスロー動画には com.apple.quicktime.full-frame-rate-playback-intent
// というQuickTimeキーが付くことがある（0ならスロー再生意図）。正確な値までは
// パースせず、「そのキー文字列がファイル中に存在するか」だけを見るヒントに留める
// （Q4で合意した通り、誤検出しても実害はヒントの有無だけなので厳密なボックス解析は行わない）。
// moov(メタデータ)は先頭 or 末尾寄りにあることが多いので、両端の数MBだけ走査すれば
// 100MB超の動画でも全部デコードせずに済む。
const SLOWMO_HINT_KEY = 'com.apple.quicktime.full-frame-rate-playback-intent';
const SLOWMO_SCAN_BYTES = 4 * 1024 * 1024;
async function detectSlowMotionHint(blob) {
    if (!blob || typeof blob.slice !== 'function') return false;
    try {
        const head = await blob.slice(0, SLOWMO_SCAN_BYTES).arrayBuffer();
        if (containsAscii(head, SLOWMO_HINT_KEY)) return true;
        if (blob.size > SLOWMO_SCAN_BYTES) {
            const tail = await blob.slice(Math.max(0, blob.size - SLOWMO_SCAN_BYTES), blob.size).arrayBuffer();
            if (containsAscii(tail, SLOWMO_HINT_KEY)) return true;
        }
    } catch (e) { /* 読めなければヒント無しとして無視 */ }
    return false;
}
function containsAscii(buf, needle) {
    const bytes = new Uint8Array(buf);
    const pat = new TextEncoder().encode(needle);
    outer:
    for (let i = 0; i <= bytes.length - pat.length; i++) {
        for (let j = 0; j < pat.length; j++) {
            if (bytes[i + j] !== pat[j]) continue outer;
        }
        return true;
    }
    return false;
}

// 再生/一時停止アイコンの切替（共通化）
function setPlayPauseIcon(playing) {
    const btnPlay = document.getElementById('btn-play-pause');
    if (btnPlay) {
        const span = btnPlay.querySelector('span');
        if (span) span.textContent = playing ? 'pause' : 'play_arrow';
    }
}

// --- オフスクリーン Canvas の更新 ---
function updateOffscreenCanvas() {
    if (!appState.videoElement || appState.videoElement.readyState < 2) return;
    if (!offscreenCanvas) {
        offscreenCanvas = document.createElement('canvas');
        offscreenCtx = offscreenCanvas.getContext('2d');
    }
    if (offscreenCanvas.width !== appState.videoElement.videoWidth || offscreenCanvas.height !== appState.videoElement.videoHeight) {
        offscreenCanvas.width = appState.videoElement.videoWidth;
        offscreenCanvas.height = appState.videoElement.videoHeight;
    }
    offscreenCtx.drawImage(appState.videoElement, 0, 0);
}

// --- コマ送り・シークなどのコントロール ---
function setupPlaybackControls() {
    const btnPlay = document.getElementById('btn-play-pause');
    const btnPrev1 = document.getElementById('btn-prev-1');
    const btnNext1 = document.getElementById('btn-next-1');
    const btnPrev10 = document.getElementById('btn-prev-10');
    const btnNext10 = document.getElementById('btn-next-10');
    const slider = document.getElementById('frame-slider');
    
    if (btnPlay) {
        btnPlay.addEventListener('click', () => {
            if (!appState.videoElement.src) return;
            if (appState.isPlaying) {
                pauseVideo();
            } else {
                playVideo();
            }
        });
    }
    
    attachJogButton(btnPrev1, -1);
    attachJogButton(btnNext1, 1);
    attachJogButton(btnPrev10, -10);
    attachJogButton(btnNext10, 10);
    
    if (slider) {
        slider.addEventListener('input', (e) => {
            cancelDeferredConfirm();
            const targetFrame = parseInt(e.target.value);
            // 解析範囲内にクランプ（範囲外へはドラッグで出られない）
            seekToFrame(Math.max(appState.rangeIn, Math.min(appState.rangeOut, targetFrame)));
        });
    }
}

// --- コマ送り（パラパラ送り付き） ------------------------------------
// ±1コマは即シーク＋バッジ表示。±複数コマは中間のコマを1枚ずつ表示して
// パラパラ漫画のように移動する（「押したのに変わらない」を無くす）。
// 各コマを最低 FLIP_MIN_FRAME_MS 表示して「めくれる」感じを保証しつつ、
// シークが遅い端末では時間予算を超えた時点で残りを直行し、体感を保つ。
const FLIP_BUDGET_MS = 1200;
const FLIP_MIN_FRAME_MS = 60;
const sleepMs = (ms) => new Promise(r => setTimeout(r, ms));
let flipTarget = null;       // パラパラ送り実行中の目的コマ（追加入力で更新）

// シークキューが空になった瞬間を待つ（パラパラ送りの歩調合わせ）
let seekIdleWaiters = [];
function whenSeekIdle() {
    if (!seekBusy && seekPendingFrame === null) return Promise.resolve();
    return new Promise(resolve => seekIdleWaiters.push(resolve));
}
function notifySeekIdleIfDone() {
    if (seekBusy || seekPendingFrame !== null || !seekIdleWaiters.length) return;
    const waiters = seekIdleWaiters;
    seekIdleWaiters = [];
    waiters.forEach(fn => fn());
}

function clampToRange(frame) {
    return Math.max(appState.rangeIn, Math.min(appState.rangeOut, frame));
}

// --- プッシュ遷移（パワポの「プッシュ」） -----------------------------
// 新しいコマが送りの向きから入り、古いコマを押し出す。映像の中身や背景色に
// 依存せず「ページが変わった」ことが必ず見える（真っ黒な動画でも分かる）。
const PUSH_MS_STEP = 130;  // ±1コマ
const PUSH_MS_FLIP = 60;   // パラパラ送り中の1コマあたり
const prefersReducedMotion = typeof window !== 'undefined' && window.matchMedia
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
let pushAnimating = false;

function snapshotCanvas() {
    const c = appState.canvas;
    if (!c || !c.width || !c.height) return null;
    const s = document.createElement('canvas');
    s.width = c.width; s.height = c.height;
    s.getContext('2d').drawImage(c, 0, 0);
    return s;
}

function runPushTransition(snapOld, snapNew, dir, durMs) {
    return new Promise(resolve => {
        const ctx = appState.ctx;
        const W = appState.canvas ? appState.canvas.width : 0;
        const H = appState.canvas ? appState.canvas.height : 0;
        // 別のアニメが走行中なら二重再生しない（rAFループ同士が喧嘩してチラつく）
        if (!ctx || !snapOld || !snapNew || !W || prefersReducedMotion || pushAnimating) { resolve(); return; }
        pushAnimating = true;
        const t0 = performance.now();
        const tick = () => {
            const p = Math.min(1, (performance.now() - t0) / durMs);
            const e = 1 - (1 - p) * (1 - p); // easeOut
            ctx.clearRect(0, 0, W, H);
            ctx.drawImage(snapOld, Math.round(-dir * e * W), 0);
            ctx.drawImage(snapNew, Math.round(dir * (1 - e) * W), 0);
            if (p < 1) {
                requestAnimationFrame(tick);
            } else {
                pushAnimating = false;
                drawVideoFrame(); // 通常描画（照準・マーカー込み）へ戻す
                resolve();
            }
        };
        requestAnimationFrame(tick);
    });
}

// シークしてからプッシュ遷移で見せる（コマ送りボタン用）
async function seekWithPush(target, durMs) {
    const from = appState.currentFrame;
    const dir = target >= from ? 1 : -1;
    const snapOld = (!prefersReducedMotion && !pushAnimating) ? snapshotCanvas() : null;
    seekToFrame(target);
    await whenSeekIdle();
    // 実際にコマが変わった時だけアニメーションする（シーク補正等で元のコマに
    // 留まった場合に「アニメは出るのに同じコマ」という偽の動きを見せない）
    if (snapOld && appState.currentFrame !== from) {
        updateOffscreenCanvas();
        drawVideoFrame();
        await runPushTransition(snapOld, snapshotCanvas(), dir, durMs);
    } else if (snapOld) {
        drawVideoFrame();
    }
}

// ジョグボタン: タップ＝1回、長押し＝連続コマ送り（450ms後から150ms間隔）
function attachJogButton(btn, delta) {
    if (!btn) return;
    let holdTimer = null, repeatTimer = null, held = false;
    const stop = () => {
        if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; }
        if (repeatTimer) { clearInterval(repeatTimer); repeatTimer = null; }
    };
    btn.addEventListener('pointerdown', () => {
        held = false;
        stop();
        holdTimer = setTimeout(() => {
            held = true;
            stepFrame(delta);
            repeatTimer = setInterval(() => stepFrame(delta), 150);
        }, 450);
    });
    btn.addEventListener('pointerup', stop);
    btn.addEventListener('pointercancel', stop);
    btn.addEventListener('pointerleave', stop);
    // 長押しで連続送りした場合は、指を離した時の click で余計に1コマ進めない
    btn.addEventListener('click', () => { if (!held) stepFrame(delta); held = false; });
    btn.addEventListener('contextmenu', (e) => e.preventDefault());
}

function stepFrame(delta, isAutoAdvance) {
    if (!appState.videoElement.src) return;
    // ユーザーの明示的なコマ移動は、保留中の確定（連打の残り）を破棄する。
    // 確定後の自動コマ送り(isAutoAdvance)では破棄しない（2連タップの2打目を守る）
    if (!isAutoAdvance) cancelDeferredConfirm();
    pauseVideo();
    // 実行中のパラパラ送りがあれば、その目的地を基準に「押した分だけ」延長する
    const base = (flipTarget !== null) ? flipTarget : appState.currentFrame;
    const target = clampToRange(base + delta);
    if (target === base) {
        // 端に到達していてこれ以上動けない：理由をバッジで返す（無言にしない）
        const atCustomEdge = delta > 0 ? appState.rangeOut < appState.totalFrames
                                       : appState.rangeIn > 0;
        showStepBadge(delta > 0
            ? (atCustomEdge ? 'アウト点です' : '最後のコマです')
            : (atCustomEdge ? 'イン点です' : '最初のコマです'));
        return;
    }
    if (flipTarget !== null) {
        flipTarget = target;
        return;
    }
    if (Math.abs(target - appState.currentFrame) <= 1) {
        showStepBadge(delta > 0 ? '+1' : '−1');
        pulseFrameLabel();
        seekWithPush(target, PUSH_MS_STEP);
        return;
    }
    runFlipTo(target);
}

async function runFlipTo(target) {
    flipTarget = target;
    const startFrame = appState.currentFrame;
    const deadline = performance.now() + FLIP_BUDGET_MS;
    // 暴走ブレーキ: シーク補正などで進行しなくなったら打ち切る（flipTargetが
    // 残留すると、以後の±1入力が「目標の書き換え」だけになり無反応に見える）
    const maxIters = Math.abs(target - startFrame) * 3 + 20;
    let iters = 0, stagnant = 0, lastFrame = appState.currentFrame;
    try {
        while (flipTarget !== null && appState.currentFrame !== flipTarget) {
            if (++iters > maxIters) { logDebug('パラパラ送りを打ち切り（回数上限）'); break; }
            const frameStart = performance.now();
            const dir = flipTarget > appState.currentFrame ? 1 : -1;
            // 時間予算を使い切ったら残りは直行（遅い端末でも待たせない）
            const next = (performance.now() > deadline) ? flipTarget
                                                        : appState.currentFrame + dir;
            // 1コマごとに短いプッシュ遷移（背景が真っ黒でもめくれが見える）
            await seekWithPush(next, PUSH_MS_FLIP);
            if (appState.currentFrame === lastFrame) {
                if (++stagnant >= 2) { logDebug('パラパラ送りを打ち切り（コマが進まない）'); break; }
            } else {
                stagnant = 0;
                lastFrame = appState.currentFrame;
            }
            const moved = appState.currentFrame - startFrame;
            showStepBadge(`${moved > 0 ? '+' : ''}${moved}`, true);
            pulseFrameLabel();
            // 速すぎる端末では1コマの表示時間を確保する（パラパラ感）
            const remain = FLIP_MIN_FRAME_MS - (performance.now() - frameStart);
            if (remain > 0 && appState.currentFrame !== flipTarget) await sleepMs(remain);
        }
    } finally {
        flipTarget = null;
        showStepBadge(null); // stickyを解除（表示中の値からフェードアウト）
    }
}

// キャンバス上の一時バッジ（コマ送り量・端到達の理由を短時間表示）
let stepBadgeTimer = null;
function showStepBadge(text, sticky) {
    const badge = document.getElementById('step-badge');
    if (!badge) return;
    if (stepBadgeTimer) { clearTimeout(stepBadgeTimer); stepBadgeTimer = null; }
    if (text !== null && text !== undefined) badge.textContent = text;
    badge.classList.add('visible');
    if (!sticky) stepBadgeTimer = setTimeout(() => badge.classList.remove('visible'), 700);
}

// コマ番号は常に「現在 / 総数」で表示（今どのあたりか一目で分かる）。
// 再生バーの表示に加え、映像右上の常設カウンタ・トリミングダイアログ・
// 打点マップの現在位置にも同期する。
function updateFrameLabel(frame) {
    updateHitMapCurrent();
    const text = `${frame} / ${appState.totalFrames}`;
    const lbl = document.getElementById('lbl-frame');
    if (lbl) lbl.textContent = text;
    const counter = document.getElementById('frame-counter');
    if (counter) { counter.textContent = text; counter.hidden = false; }
    const trimLbl = document.getElementById('trim-frame-lbl');
    if (trimLbl) trimLbl.textContent = `コマ ${text}`;
    const trimSlider = document.getElementById('trim-slider');
    if (trimSlider) trimSlider.value = frame;
}

// コマ番号表示をひと呼吸光らせる（アニメーション再トリガのためクラスを付け直す）
function pulseFrameLabel() {
    const lbl = document.getElementById('lbl-frame');
    if (!lbl) return;
    lbl.classList.remove('pulse');
    void lbl.offsetWidth;
    lbl.classList.add('pulse');
}

// --- 解析範囲（イン/アウト点） ---------------------------------------
function inAnalysisRange(frame) {
    return frame >= appState.rangeIn && frame <= appState.rangeOut;
}

function resetAnalysisRange() {
    appState.rangeIn = 0;
    appState.rangeOut = appState.totalFrames;
    updateRangeUI();
}

// シークバー上に選択範囲をシアン（計器/校正の色）で示す
function updateRangeUI() {
    const slider = document.getElementById('frame-slider');
    const lbl = document.getElementById('lbl-range');
    const total = Math.max(1, appState.totalFrames);
    const full = appState.rangeIn === 0 && appState.rangeOut === appState.totalFrames;
    if (slider) {
        if (full) {
            slider.style.background = '';
        } else {
            const a = (appState.rangeIn / total) * 100;
            const b = (appState.rangeOut / total) * 100;
            slider.style.background =
                `linear-gradient(90deg, var(--line) 0%, var(--line) ${a}%, ` +
                `var(--accent) ${a}%, var(--accent) ${b}%, var(--line) ${b}%, var(--line) 100%)`;
        }
    }
    if (lbl) lbl.textContent = full ? '全体' : `${appState.rangeIn}–${appState.rangeOut}`;
}

// 範囲確定時にその範囲だけ複製コマを除外（読込時に持ち越した分。1動画につき1回）
const DEDUP_RANGE_MAX = 300;
async function maybeDedupRange() {
    if (appState.dedupDone || !appState.frameTimes.length) return;
    if (appState.trackingData.length > 0) {
        logDebug('計測データがあるためコマ番号を変えられません（重複除外スキップ）');
        return;
    }
    const len = appState.rangeOut - appState.rangeIn + 1;
    if (len < 2 || len > DEDUP_RANGE_MAX) return;
    appState.isScanning = true;
    showScanProgress(0);
    const seg = appState.frameTimes.slice(appState.rangeIn, appState.rangeOut + 1);
    let d = null;
    try { d = await dedupTimesByPixel(appState.videoElement, seg); }
    catch (e) { logDebug('範囲の重複確認に失敗: ' + (e && e.message)); }
    appState.isScanning = false;
    hideScanProgress();
    if (!d) return;
    if (d.skipped > 0) {
        const before = appState.frameTimes.slice(0, appState.rangeIn);
        const after = appState.frameTimes.slice(appState.rangeOut + 1);
        appState.frameTimes = buildFrameTimeTable([...before, ...d.times, ...after]);
        appState.totalFrames = appState.frameTimes.length - 1;
        appState.rangeOut = Math.max(appState.rangeIn, appState.rangeOut - d.skipped);
        appState.videoFps = friendlyFpsFromTimes(appState.frameTimes);
        const slider = document.getElementById('frame-slider');
        if (slider) slider.max = appState.totalFrames;
        refreshFpsUI();
        logDebug(`解析範囲の複製コマ ${d.skipped} 枚を除外しました`);
    }
    appState.dedupDone = true;
    updateRangeUI();
    updateTimeDisplay();
}

function toggleRangeIn() {
    if (!appState.videoElement.src) return;
    pauseVideo();
    // 既にイン点と同じコマでもう一度押すと解除（先頭へ戻す）
    appState.rangeIn = (appState.rangeIn === appState.currentFrame) ? 0
        : Math.min(appState.currentFrame, appState.rangeOut);
    updateRangeUI(); updateDataTable(); updateGraph();
    maybeDedupRange();
}

function toggleRangeOut() {
    if (!appState.videoElement.src) return;
    pauseVideo();
    appState.rangeOut = (appState.rangeOut === appState.currentFrame) ? appState.totalFrames
        : Math.max(appState.currentFrame, appState.rangeIn);
    updateRangeUI(); updateDataTable(); updateGraph();
    maybeDedupRange();
}

function setupRangeControls() {
    const btnIn = document.getElementById('btn-range-in');
    const btnOut = document.getElementById('btn-range-out');
    if (btnIn) btnIn.addEventListener('click', toggleRangeIn);
    if (btnOut) btnOut.addEventListener('click', toggleRangeOut);
}

// --- 読込直後のトリミングダイアログ ----------------------------------
// 読み込めたことを数字（コマ数/fps/長さ）で示し、その場で動きのない前後を
// カットさせる全画面ダイアログ。サンプル動画でも表示する（練習を兼ねる）。
// プレビューはメインの動画要素をそのままシークして映す。
let trimPreviewCanvas = null; // 開いている間だけ非null。seekedハンドラが参照する

function drawTrimPreview() {
    const cv = trimPreviewCanvas;
    const v = appState.videoElement;
    if (!cv || !v || v.readyState < 2) return;
    const ctx = cv.getContext('2d');
    ctx.fillStyle = '#14181D';
    ctx.fillRect(0, 0, cv.width, cv.height);
    const fit = Math.min(cv.width / v.videoWidth, cv.height / v.videoHeight);
    const w = v.videoWidth * fit, h = v.videoHeight * fit;
    ctx.drawImage(v, (cv.width - w) / 2, (cv.height - h) / 2, w, h);
}

function trimRangeText() {
    const full = appState.rangeIn === 0 && appState.rangeOut === appState.totalFrames;
    return full ? '解析範囲: 全体（未カット）'
        : `解析範囲: コマ ${appState.rangeIn} 〜 ${appState.rangeOut}（${appState.rangeOut - appState.rangeIn + 1} コマ）`;
}

function showTrimDialog(onClose) {
    // テスト・自動化から動画を読み込む場合はダイアログを出さない
    if (typeof window !== 'undefined' && window.__suppressTrimDialog) {
        if (onClose) onClose();
        return;
    }
    const overlay = document.getElementById('dialog-overlay');
    const titleEl = document.getElementById('dialog-title');
    const bodyEl = document.getElementById('dialog-body');
    const btnCancel = document.getElementById('dialog-btn-cancel');
    const btnOk = document.getElementById('dialog-btn-ok');
    if (!overlay) { if (onClose) onClose(); return; }

    const fps = appState.videoFps ? `${+appState.videoFps.toFixed(2)} fps` : '-- fps';
    const dur = appState.videoDuration ? `${appState.videoDuration.toFixed(2)} 秒` : '';
    titleEl.textContent = '読み込み完了';
    const longVideo = appState.totalFrames + 1 > 600;
    bodyEl.innerHTML = `
        <div class="trim-info">${appState.totalFrames + 1} コマ / ${fps} / ${dur}</div>
        ${longVideo ? `<p class="trim-long-warn">長い動画です。解析したい運動の<b>数秒だけ</b>に
            「ここから」「ここまで」で必ず絞ってください（絞らないと打点マップなど一部の表示が制限されます）。</p>` : ''}
        <p class="trim-guide">運動していない<b>前後のコマをカット</b>しておくと、あとの点打ちがラクです。<br>
           スライダで運動の<b>開始</b>コマへ→「ここから」、<b>終了</b>コマへ→「ここまで」。</p>
        <canvas id="trim-preview" width="640" height="300"></canvas>
        <div class="trim-controls">
            <button class="btn-icon" id="trim-prev" title="1コマ戻る"><span class="material-icons-round">chevron_left</span></button>
            <input type="range" id="trim-slider" min="0" max="${appState.totalFrames}" value="${appState.currentFrame}">
            <button class="btn-icon" id="trim-next" title="1コマ進む"><span class="material-icons-round">chevron_right</span></button>
        </div>
        <div class="trim-controls">
            <button class="btn btn-secondary btn-small" id="trim-set-in"><span class="material-icons-round">first_page</span>ここから</button>
            <button class="btn btn-secondary btn-small" id="trim-set-out"><span class="material-icons-round">last_page</span>ここまで</button>
            <span class="trim-frame" id="trim-frame-lbl">コマ ${appState.currentFrame} / ${appState.totalFrames}</span>
        </div>
        <div class="trim-range" id="trim-range-lbl">${trimRangeText()}</div>
    `;

    // ボタンを「はじめる」1つに（cleanupで元へ戻す）
    const okOriginal = btnOk.textContent;
    btnOk.textContent = 'はじめる';
    btnCancel.style.display = 'none';
    overlay.style.display = 'flex';

    trimPreviewCanvas = document.getElementById('trim-preview');
    drawTrimPreview();

    const refreshRange = () => {
        const lbl = document.getElementById('trim-range-lbl');
        if (lbl) lbl.textContent = trimRangeText();
    };
    document.getElementById('trim-slider').addEventListener('input', (e) => {
        seekToFrame(parseInt(e.target.value));
    });
    document.getElementById('trim-prev').addEventListener('click', () => seekToFrame(appState.currentFrame - 1));
    document.getElementById('trim-next').addEventListener('click', () => seekToFrame(appState.currentFrame + 1));
    document.getElementById('trim-set-in').addEventListener('click', () => { toggleRangeIn(); refreshRange(); });
    document.getElementById('trim-set-out').addEventListener('click', () => { toggleRangeOut(); refreshRange(); });

    const cleanup = () => {
        overlay.style.display = 'none';
        trimPreviewCanvas = null;
        btnOk.textContent = okOriginal;
        btnCancel.style.display = '';
        const newOk = btnOk.cloneNode(true);
        btnOk.parentNode.replaceChild(newOk, btnOk);
        // 範囲の先頭から作業を始められるように頭出ししておく
        seekToFrame(appState.rangeIn);
        if (onClose) onClose();
    };
    btnOk.addEventListener('click', cleanup);
}

// --- シーク直列化キュー ---------------------------------------------
// Safariは連続する currentTime 設定を間引く（コアレスする）ため、投げっぱなしの
// シークはボタン連打で「内部コマ番号」と「表示フレーム」がずれる。ここでは
// 常に1件だけ実行し、連打時は「最後の要求」だけを次に実行する（中間は捨てる）。
let seekBusy = false;
let seekPendingFrame = null;

function seekToFrame(frame) {
    appState.currentFrame = Math.max(0, Math.min(appState.totalFrames, frame));
    const slider = document.getElementById('frame-slider');
    if (slider) slider.value = appState.currentFrame;
    seekPendingFrame = appState.currentFrame;
    pumpSeekQueue();
}

function pumpSeekQueue() {
    if (seekBusy || seekPendingFrame === null) return;
    const frame = seekPendingFrame;
    seekPendingFrame = null;
    seekBusy = true;

    const v = appState.videoElement;
    // 実フレーム時刻表があればその区間中央へ、無ければ fps 換算でフレーム中央へ。
    // 境界でのデコードずれ（特にSafari/iPad）を避けやすい。
    const targetTime = Math.min(appState.videoDuration - 0.001, Math.max(0, seekTimeOf(frame)));

    let done = false;
    const finish = (mediaTime) => {
        if (done) return;
        done = true;
        // 後続の要求が無ければ、実際に表示されたフレームを真実として補正。
        // ただし要求コマから大きく（3コマ以上）離れた mediaTime は、非表示video
        // の遅発rVFCが返す「古い提示」の可能性が高く、信じると大ジャンプや
        // 押し戻しが起きる。近傍(±2コマ)の食い違いだけを実測として採用する。
        if (mediaTime !== null && seekPendingFrame === null && appState.frameTimes.length) {
            const shown = frameIndexOfTime(mediaTime);
            if (shown !== appState.currentFrame) {
                if (Math.abs(shown - appState.currentFrame) <= 2) {
                    logDebug(`シーク補正: 要求コマ${appState.currentFrame} → 表示コマ${shown}`);
                    appState.currentFrame = shown;
                    const slider = document.getElementById('frame-slider');
                    if (slider) slider.value = shown;
                } else {
                    logDebug(`シーク補正を棄却: 要求コマ${appState.currentFrame} に対し表示コマ${shown}（乖離が大きく古い提示の疑い）`);
                }
            }
        }
        seekBusy = false;
        pumpSeekQueue(); // 連打中に溜まった最後の要求を実行
        notifySeekIdleIfDone();
    };

    // 同一時刻へのシークは seeked も rVFC も発火しない（キューが安全網の
    // 1.5秒まで詰まり、直後のコマ送りが無反応になる）。即完了扱いにする。
    if (Math.abs(v.currentTime - targetTime) < 1e-4) {
        finish(null);
        return;
    }

    // rVFC と seeked の両方を張り、先に来た方で完了する。
    // 非表示videoのrVFCはスマホで発火しないことがあり、rVFC頼みだと全シークが
    // 安全網の1.5秒待ちになって「押しても動かない→たまに一気に飛ぶ」が起きる。
    // seeked が先に来たら、実測(mediaTime)を80msだけ待ってから補正なしで完了する。
    let seekedHandler = null;
    const finishAndCleanup = (mediaTime) => {
        if (seekedHandler) { v.removeEventListener('seeked', seekedHandler); seekedHandler = null; }
        finish(mediaTime);
    };
    const useRvfc = rvfcSupported && !appState.isScanning;
    if (useRvfc) {
        v.requestVideoFrameCallback((now, meta) => finishAndCleanup(meta.mediaTime));
    }
    seekedHandler = () => {
        v.removeEventListener('seeked', seekedHandler);
        seekedHandler = null;
        if (useRvfc) setTimeout(() => finishAndCleanup(null), 80);
        else finishAndCleanup(null);
    };
    v.addEventListener('seeked', seekedHandler);
    v.currentTime = targetTime;
    setTimeout(() => finishAndCleanup(null), 1500); // どちらも来ない場合の安全網
}

// 再生時刻 t(s) → コマ番号（実時刻表を二分探索。表が無ければfps換算）
function frameIndexOfTime(t) {
    const ft = appState.frameTimes;
    if (!ft || !ft.length) return Math.floor(t * appState.videoFps);
    let lo = 0, hi = ft.length - 1;
    while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (ft[mid] <= t + 1e-6) lo = mid; else hi = mid - 1;
    }
    return Math.min(lo, appState.totalFrames);
}

// 「今まさに画面に表示されているコマ」を返す。シーク直列化キューは要求時点で
// appState.currentFrame を先に進めるため、連打・素早い操作では表示が追いつかず
// 食い違うことがある（進む→即確定、で違うコマに点が付く）。確定・校正はこちらを
// 信頼する（見えているものと記録が必ず一致する）。
function displayedFrame() {
    return frameIndexOfTime(appState.videoElement.currentTime);
}

function playVideo() {
    appState.isPlaying = true;
    setPlayPauseIcon(true);
    appState.videoElement.play();
    logDebug("再生開始");
    requestAnimationFrame(renderLoop);
}

function pauseVideo() {
    appState.isPlaying = false;
    setPlayPauseIcon(false);
    appState.videoElement.pause();
    logDebug("一時停止");
}

function renderLoop() {
    if (!appState.isPlaying) return;
    
    // 再生中も実時刻表と同じ座標系でコマ番号を出す（floor(t*fps)だと停止後のコマ送りとずれる）
    appState.currentFrame = frameIndexOfTime(appState.videoElement.currentTime);
    const slider = document.getElementById('frame-slider');
    if (slider) slider.value = appState.currentFrame;
    
    updateFrameLabel(appState.currentFrame);

    updateOffscreenCanvas();
    drawVideoFrame();
    updateTimeDisplay();
    
    if (!appState.videoElement.paused && !appState.videoElement.ended) {
        requestAnimationFrame(renderLoop);
    } else if (appState.videoElement.ended) {
        pauseVideo();
    }
}

// タイム表示の更新
function updateTimeDisplay() {
    const timeDisplay = document.getElementById('time-display');
    if (!timeDisplay) return;
    
    // フレーム基準の時刻（実フレーム時刻表 or fps換算）
    const curSec = frameTimeOf(appState.currentFrame);
    const durSec = appState.videoDuration;
    
    const format = (sec) => {
        const m = Math.floor(sec / 60).toString().padStart(2, '0');
        const s = Math.floor(sec % 60).toString().padStart(2, '0');
        const ms = Math.floor((sec % 1) * 100).toString().padStart(2, '0');
        return `${m}:${s}.${ms}`;
    };
    
    timeDisplay.textContent = `${format(curSec)} / ${format(durSec)}`;
}

// Canvasリサイズ処理
// 画面の大きさが実際に変わったときだけ描き直す。
// iOS Safari は、寸法が変わっていないのに resize を投げることがある（幽霊resize）。
// また回転直後の innerWidth/innerHeight は古い値のことがあるため、実測は
// 描画を2フレーム待ってからコンテナの実サイズで行う。
let lastLayoutSize = { w: -1, h: -1 };
function relayoutNow() {
    const c = document.getElementById('canvas-container');
    if (!c) return;
    const w = c.clientWidth, h = c.clientHeight;
    if (w === lastLayoutSize.w && h === lastLayoutSize.h) return;
    lastLayoutSize = { w, h };
    handleResize();
    updateGraph();
}
function scheduleRelayout() {
    if (typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(() => requestAnimationFrame(relayoutNow));
    }
    setTimeout(relayoutNow, 250);   // rAFが動かない状況（背面タブ等）の保険
}

function handleResize() {
    const container = document.getElementById('canvas-container');
    if (!container || !appState.videoElement.src || appState.videoElement.videoWidth === 0) return;
    
    const containerWidth = container.clientWidth;
    const containerHeight = container.clientHeight;

    const vWidth = appState.videoElement.videoWidth;
    const vHeight = appState.videoElement.videoHeight;

    // Canvas はコンテナ全面。動画は getFitMetrics() でレターボックス配置するため、
    // 縦長動画でもズーム/パン時に左右いっぱいまで使える。
    appState.canvas.width = containerWidth;
    appState.canvas.height = containerHeight;

    const m = getFitMetrics();
    logDebug(`Canvasリサイズ: ${containerWidth}x${containerHeight} (Video: ${vWidth}x${vHeight}, fit: ${m.fit.toFixed(3)})`);

    drawVideoFrame();
}

// --- Canvasへの描画処理 ---
function drawVideoFrame() {
    if (!appState.videoElement.src || appState.videoElement.readyState < 2) return;
    
    appState.ctx.clearRect(0, 0, appState.canvas.width, appState.canvas.height);
    
    appState.ctx.save();
    // アフィン変換の適用（ユーザーのズーム・パン）
    appState.ctx.translate(appState.viewState.offsetX, appState.viewState.offsetY);
    appState.ctx.scale(appState.viewState.scale, appState.viewState.scale);

    // 動画フレームの描画（コンテナ内にレターボックス配置）
    const m = getFitMetrics();
    appState.ctx.drawImage(appState.videoElement, m.baseX, m.baseY, m.fitW, m.fitH);
    
    // キャリブレーションマーカーとトラックポイントの描画
    drawCalibrationMarkers();
    drawTrackingPoints();

    appState.ctx.restore();

    // 画面中央の固定十字（スクリーン座標・ズーム非依存）
    drawCrosshair();
}

// --- 中央十字（照準）の描画 ---
function drawCrosshair() {
    const ctx = appState.ctx;
    const cx = appState.canvas.width / 2;
    const cy = appState.canvas.height / 2;
    const isCalib = appState.pendingCapture !== null;
    // 照準 = 操作の青。校正中は校正系のアンバー（映像上は明るい版＋縁取り）。
    const color = isCalib ? UI_COLORS.calBright : UI_COLORS.accent;

    ctx.save();
    ctx.lineWidth = 1.5;

    // 外側の縁取りで視認性確保（青には白縁、明るいアンバーには黒縁）
    ctx.strokeStyle = isCalib ? 'rgba(0,0,0,0.65)' : 'rgba(255,255,255,0.9)';
    ctx.lineWidth = 3;
    drawReticlePath(ctx, cx, cy);
    ctx.stroke();

    // 本体
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    drawReticlePath(ctx, cx, cy);
    ctx.stroke();

    // 中心の小さなドット
    ctx.beginPath();
    ctx.arc(cx, cy, 2, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.restore();
}

function drawReticlePath(ctx, cx, cy) {
    const gap = 6;   // 中心の空き
    const len = 16;  // 線の長さ
    const r = 14;    // 円の半径
    ctx.beginPath();
    // 上下左右の線（中心を空ける）
    ctx.moveTo(cx, cy - gap); ctx.lineTo(cx, cy - gap - len);
    ctx.moveTo(cx, cy + gap); ctx.lineTo(cx, cy + gap + len);
    ctx.moveTo(cx - gap, cy); ctx.lineTo(cx - gap - len, cy);
    ctx.moveTo(cx + gap, cy); ctx.lineTo(cx + gap + len, cy);
    // 円
    ctx.moveTo(cx + r, cy);
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
}

// --- 座標変換関数 ---
// Canvas はコンテナ全面サイズ。動画はその中にレターボックス配置（contain-fit・中央寄せ）。
// fit と base(余白) を毎回算出することで状態を持たず、テストでも純粋に検証できる。
function getFitMetrics() {
    const vW = (appState.videoElement && appState.videoElement.videoWidth) || 1;
    const vH = (appState.videoElement && appState.videoElement.videoHeight) || 1;
    const cW = (appState.canvas && appState.canvas.width) || 1;
    const cH = (appState.canvas && appState.canvas.height) || 1;
    const fit = Math.min(cW / vW, cH / vH) || 1;
    const fitW = vW * fit, fitH = vH * fit;
    return { fit, fitW, fitH, baseX: (cW - fitW) / 2, baseY: (cH - fitH) / 2, vW, vH, cW, cH };
}

function canvasToVideo(cx, cy) {
    const m = getFitMetrics();
    const lx = (cx - appState.viewState.offsetX) / appState.viewState.scale;
    const ly = (cy - appState.viewState.offsetY) / appState.viewState.scale;
    return { x: (lx - m.baseX) / m.fit, y: (ly - m.baseY) / m.fit };
}

function videoToCanvas(vx, vy) {
    const local = videoToLocalCanvas(vx, vy);

    const cx = local.x * appState.viewState.scale + appState.viewState.offsetX;
    const cy = local.y * appState.viewState.scale + appState.viewState.offsetY;
    return { x: cx, y: cy };
}

// 動画座標 → Canvasローカル座標（ユーザーズーム適用前。レターボックスの余白を含む）
function videoToLocalCanvas(vx, vy) {
    const m = getFitMetrics();
    return { x: m.baseX + vx * m.fit, y: m.baseY + vy * m.fit };
}

// --- Pointer Events によるズーム・パン、ドラッグ ---
function setupCanvasTouch() {
    appState.canvas.addEventListener('pointerdown', handlePointerDown);
    appState.canvas.addEventListener('pointermove', handlePointerMove);
    appState.canvas.addEventListener('pointerup', handlePointerUp);
    appState.canvas.addEventListener('pointercancel', handlePointerUp);
    appState.canvas.addEventListener('wheel', handleWheel, { passive: false });
}

function handlePointerDown(e) {
    e.preventDefault();
    appState.canvas.setPointerCapture(e.pointerId);
    
    activePointers.push({
        id: e.pointerId,
        x: e.clientX,
        y: e.clientY
    });
    
    const rect = appState.canvas.getBoundingClientRect();
    const localX = e.clientX - rect.left;
    const localY = e.clientY - rect.top;
    
    if (activePointers.length === 1) {
        // 1本指は常に映像のパン（点打ちは「確定」ボタンに集約）
        lastPointerPos = { x: localX, y: localY };
        isPanning = false;
    } else if (activePointers.length === 2) {
        const p1 = activePointers[0];
        const p2 = activePointers[1];
        
        const p1Local = { x: p1.x - rect.left, y: p1.y - rect.top };
        const p2Local = { x: p2.x - rect.left, y: p2.y - rect.top };
        
        lastPinchDist = Math.hypot(p1Local.x - p2Local.x, p1Local.y - p2Local.y);
        lastPinchCenter = {
            x: (p1Local.x + p2Local.x) / 2,
            y: (p1Local.y + p2Local.y) / 2
        };
        isPanning = true;
        logDebug("ピンチ開始（吸い付きズーム有効）");
    }
}

function handlePointerMove(e) {
    e.preventDefault();
    const pointer = activePointers.find(p => p.id === e.pointerId);
    if (!pointer) return;
    
    pointer.x = e.clientX;
    pointer.y = e.clientY;
    
    const rect = appState.canvas.getBoundingClientRect();
    const localX = e.clientX - rect.left;
    const localY = e.clientY - rect.top;
    
    if (activePointers.length === 1) {
        // 1本指ドラッグ = 映像のパン（十字に対象を合わせるための操作）
        if (lastPointerPos) {
            const dx = localX - lastPointerPos.x;
            const dy = localY - lastPointerPos.y;
            appState.viewState.offsetX += dx;
            appState.viewState.offsetY += dy;
            lastPointerPos = { x: localX, y: localY };
            drawVideoFrame();
        }
    } else if (activePointers.length === 2 && isPanning) {
        const p1 = activePointers[0];
        const p2 = activePointers[1];
        
        const p1Local = { x: p1.x - rect.left, y: p1.y - rect.top };
        const p2Local = { x: p2.x - rect.left, y: p2.y - rect.top };
        
        const currentDist = Math.hypot(p1Local.x - p2Local.x, p1Local.y - p2Local.y);
        const currentCenter = {
            x: (p1Local.x + p2Local.x) / 2,
            y: (p1Local.y + p2Local.y) / 2
        };
        
        if (lastPinchDist > 0 && lastPinchCenter) {
            const dScale = currentDist / lastPinchDist;
            let newScale = appState.viewState.scale * dScale;
            newScale = Math.max(0.5, Math.min(10, newScale));
            
            const actualRatio = newScale / appState.viewState.scale;
            const dx = currentCenter.x - lastPinchCenter.x;
            const dy = currentCenter.y - lastPinchCenter.y;
            
            appState.viewState.offsetX = currentCenter.x - (currentCenter.x - appState.viewState.offsetX) * actualRatio + dx;
            appState.viewState.offsetY = currentCenter.y - (currentCenter.y - appState.viewState.offsetY) * actualRatio + dy;
            appState.viewState.scale = newScale;
            
            drawVideoFrame();
        }
        
        lastPinchDist = currentDist;
        lastPinchCenter = currentCenter;
    }
}

function handlePointerUp(e) {
    appState.canvas.releasePointerCapture(e.pointerId);
    activePointers = activePointers.filter(p => p.id !== e.pointerId);
    
    if (activePointers.length < 2) {
        isPanning = false;
        lastPinchDist = 0;
        lastPinchCenter = null;
    }
    
    const rect = appState.canvas.getBoundingClientRect();
    if (activePointers.length === 1) {
        const p = activePointers[0];
        lastPointerPos = { x: p.x - rect.left, y: p.y - rect.top };
    } else if (activePointers.length === 0) {
        lastPointerPos = null;
        if (isDraggingPoint) {
            isDraggingPoint = false;
            draggedPointIndex = -1;
            logDebug("ドラッグ完了");
        }
    }
}

function handleWheel(e) {
    e.preventDefault();
    const zoomIntensity = 0.08;
    const rect = appState.canvas.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;
    
    const wheel = e.deltaY < 0 ? 1 : -1;
    const zoomFactor = Math.exp(wheel * zoomIntensity);
    
    const oldScale = appState.viewState.scale;
    let newScale = oldScale * zoomFactor;
    newScale = Math.max(0.5, Math.min(10, newScale));
    
    const actualRatio = newScale / oldScale;
    
    appState.viewState.offsetX = mouseX - (mouseX - appState.viewState.offsetX) * actualRatio;
    appState.viewState.offsetY = mouseY - (mouseY - appState.viewState.offsetY) * actualRatio;
    appState.viewState.scale = newScale;
    
    drawVideoFrame();
}

function resetZoom() {
    appState.viewState = { scale: 1, offsetX: 0, offsetY: 0 };
    drawVideoFrame();
    logDebug("ズームリセット");
}

// --- 保留アクション（原点/スケール設定）の切替 ---
function setPendingCapture(mode) {
    appState.pendingCapture = mode;
    // スケール設定を抜けるときは一時始点をクリア
    if (mode !== 'scale') appState.calibration.scaleTempStart = null;

    const btnScale = document.getElementById('btn-set-scale');
    if (btnScale) btnScale.classList.toggle('active', mode === 'scale');
    document.body.classList.toggle('calibrating', mode === 'scale');

    updateActionHint();
    if (typeof updateScaleBanner === 'function') updateScaleBanner();
    logDebug(`保留アクション: ${mode || 'なし（トラッキング）'}`);
}

// 確定ボタンのラベルと、今やるべき操作のヒントを更新
function updateActionHint() {
    const btnConfirm = document.getElementById('btn-confirm');
    const hint = document.getElementById('action-hint');
    // ボタンの文字は「.confirm-sub の部分＋確定」で作る。狭い画面では
    // .confirm-sub がCSSで畳まれ「確定」だけになる（何を確定するかは上のヒントが言う）。
    let label = '確定<span class="confirm-sub">（点を打つ）</span>';
    let text = '十字を対象に合わせて「確定」';

    if (appState.pendingCapture === 'scale') {
        if (appState.calibration.scaleTempStart) {
            label = '<span class="confirm-sub">スケール終点を</span>確定';
            text = '十字を「既知の長さ」の終点に合わせて「確定」';
        } else {
            label = '<span class="confirm-sub">スケール始点を</span>確定';
            text = '十字を「既知の長さ」の始点に合わせて「確定」';
        }
    }
    if (btnConfirm) {
        const span = btnConfirm.querySelector('.confirm-label');
        if (span) span.innerHTML = label;
    }
    if (hint) hint.textContent = text;
}

// --- ② スケール設定ステップ ---------------------------------------------
// 「モード」ではなく「ステップ」として扱う。設定中は下部バーから
// 「点を打つ」ボタン自体を消し、帯と枠の色も変える（手がかりを3つ同時に変える）。
// 誤って別のモードだと思い込む余地をなくすのが狙い。
function scaleStepActive() {
    return appState.pendingCapture === 'scale';
}

function needsScale() {
    return !appState.calibration.scaleRatio && !appState.scaleSkipped;
}

// 動画を読み込んで最初のトラッキングに入る前に、必ずここを通す
function enterScaleStep() {
    setPendingCapture('scale');
    updateScaleBanner();
}

function skipScaleStep() {
    appState.scaleSkipped = true;
    setPendingCapture(null);
    updateScaleBanner();
    updateStepGuide();
    showStepBadge('スケールなしで続けます（単位は px）');
    logDebug('スケール設定を省略しました。長さの単位は px のままです。');
}

function restartScaleStep() {
    appState.calibration.scaleTempStart = null;
    updateActionHint();
    updateScaleBanner();
    drawVideoFrame();
    logDebug('スケール設定をやり直します。');
}

// 帯の内容と、px単位で進んでいることを示す常設チップを同期する
function updateScaleBanner() {
    const banner = document.getElementById('scale-banner');
    if (banner) {
        const on = scaleStepActive();
        banner.hidden = !on;
        if (on) {
            const second = !!appState.calibration.scaleTempStart;
            const stepEl = document.getElementById('scale-banner-step');
            const textEl = document.getElementById('scale-banner-text');
            if (stepEl) stepEl.textContent = second ? '2 / 2' : '1 / 2';
            if (textEl) {
                textEl.textContent = second
                    ? '十字を「もう一方の端」に合わせて確定してください。'
                    : '長さが分かるもの（ものさし等）の片方の端に十字を合わせて確定してください。';
            }
        }
    }
    // 警告チップは「どう抜けたか」に関係なく、スケールが無い間ずっと出す。
    // 帯のリンクで抜けても、[スケール設定]をもう一度押して抜けても同じ。
    // 抜け道が2本あって片方だけ黙っている、という状態を作らないため。
    const warn = document.getElementById('scale-warn-chip');
    if (warn) {
        const hasVideo = !!(appState.videoElement && appState.videoElement.src);
        warn.hidden = !(hasVideo && !appState.calibration.scaleRatio && !scaleStepActive());
    }
    const bar = document.querySelector('.action-bar');
    if (bar) bar.classList.toggle('scale-step', scaleStepActive());
}

function setupScaleBanner() {
    const skip = document.getElementById('scale-banner-skip');
    if (skip) skip.addEventListener('click', skipScaleStep);
    const redo = document.getElementById('btn-scale-redo');
    if (redo) redo.addEventListener('click', restartScaleStep);
    const warn = document.getElementById('scale-warn-chip');
    if (warn) warn.addEventListener('click', () => { appState.scaleSkipped = false; enterScaleStep(); });
}

// 手順ガイド: 今やるべき最初の未完ステップを点灯する
function updateStepGuide() {
    const steps = document.querySelectorAll('.step-guide .step');
    if (!steps.length) return;
    // ① 動画 → ② スケール → ③ トラッキング → ④ 提出（原点は最初の打点で自動）
    const hasVideo = !!(appState.videoElement && appState.videoElement.src);
    const hasScale = !!(appState.calibration.scaleRatio || appState.scaleSkipped);
    const hasData = appState.trackingData.length > 0;

    let active = 0;
    if (hasVideo) active = 1;
    if (hasVideo && hasScale) active = 2;
    if (hasVideo && hasData) active = Math.max(active, 2);
    if (hasVideo && hasData && hasScale) active = 3;

    steps.forEach((el, i) => el.classList.toggle('active', i === active));
    if (typeof updateScaleBanner === 'function') updateScaleBanner();
}

function setupModeButtons() {
    const btnConfirm = document.getElementById('btn-confirm');
    const btnScale = document.getElementById('btn-set-scale');
    const btnZoomReset = document.getElementById('btn-zoom-reset');

    if (btnConfirm) btnConfirm.addEventListener('click', confirmAtCrosshair);
    // スケールボタンはトグル: 押すと設定ステップへ、もう一度押すと抜ける
    if (btnScale) btnScale.addEventListener('click', () => {
        setPendingCapture(appState.pendingCapture === 'scale' ? null : 'scale');
    });
    if (btnZoomReset) btnZoomReset.addEventListener('click', resetZoom);
}

// 物体選択（色ボタン）
function setupObjectButtons() {
    const selector = document.getElementById('object-selector');
    if (!selector) return;
    // 各ボタンのスウォッチ色を COLOR_MAP に合わせる
    selector.querySelectorAll('.obj-btn').forEach(btn => {
        const oid = parseInt(btn.dataset.oid);
        const swatch = btn.querySelector('.obj-swatch');
        if (swatch) swatch.style.background = COLOR_MAP[(oid - 1) % COLOR_MAP.length];
        btn.addEventListener('click', () => setActiveObject(oid));
    });
    updateObjectButtons();
}

function setActiveObject(oid) {
    appState.activeObjectId = Math.max(1, oid);
    updateObjectButtons();
    persistState();
    updateDataTable();
    drawVideoFrame();
    updateGraph();
    logDebug(`物体${appState.activeObjectId}を選択`);
}

function updateObjectButtons() {
    document.querySelectorAll('#object-selector .obj-btn').forEach(btn => {
        btn.classList.toggle('active', parseInt(btn.dataset.oid) === appState.activeObjectId);
    });
}

// 設定入力欄のイベント設定
function setupSettingsInputs() {
    const stepInput = document.getElementById('step-size-select');

    if (stepInput) {
        stepInput.addEventListener('change', (e) => {
            appState.trackingStepSize = Math.max(1, parseInt(e.target.value) || 1);
            logDebug(`ステップ幅: ${appState.trackingStepSize}`);
        });
    }
}

// --- 十字（画面中央）が指す動画座標を取得 ---
function getCrosshairVideoCoord() {
    return canvasToVideo(appState.canvas.width / 2, appState.canvas.height / 2);
}

// --- 「確定」ボタン: 十字位置を現在の保留アクションに応じて確定する ---
// 保留できる確定は1件だけ。誤連打した確定が延々とキューに残って
// 自動コマ送りし続けると、その後の「戻る」操作と喧嘩して操作不能に見える。
// また、保留中にユーザーが手動でコマ移動したら保留確定は破棄する（意図が変わったため）。
let confirmDeferred = false;
let navGeneration = 0;
function cancelDeferredConfirm() { navGeneration++; }

function confirmAtCrosshair() {
    const v = appState.videoElement;
    if (!v.src) {
        logDebug("動画が読み込まれていません。");
        return;
    }
    // シーク直後は readyState が一時的に 2 未満へ落ちる。ここで黙って捨てると
    // 連打時・遅い端末でタップが飲み込まれるので、1件だけシーク完了を待って実行する。
    if (v.readyState < 2 || seekBusy || seekPendingFrame !== null) {
        if (confirmDeferred) {
            showStepBadge('処理中…'); // 2件目以降の連打は捨てる（暴走防止）
            return;
        }
        confirmDeferred = true;
        const gen = navGeneration;
        whenSeekIdle().then(() => setTimeout(() => {
            confirmDeferred = false;
            if (gen !== navGeneration) return; // 保留中に手動でコマ移動した → 破棄
            if (v.readyState >= 2) confirmAtCrosshair();
            else logDebug('動画データの準備待ちで確定できませんでした。もう一度押してください。');
        }, 30));
        return;
    }
    const vPos = getCrosshairVideoCoord();

    // シーク要求中でも「今画面に見えているコマ」に記録する（要求先の未来コマではない）。
    // ここでUI(コマ番号・スライダ)も実態に合わせて同期しておく。
    const shown = displayedFrame();
    if (shown !== appState.currentFrame) {
        appState.currentFrame = shown;
        const slider = document.getElementById('frame-slider');
        if (slider) slider.value = shown;
        updateFrameLabel(shown);
    }

    if (appState.pendingCapture === 'scale') {
        captureScalePoint(vPos);
    } else {
        captureTrackPoint(vPos);
    }
}

// 通常: トラックポイントを現フレームに登録/上書きし、ステップ幅ぶん自動コマ送り
function captureTrackPoint(vPos) {
    pushHistory();
    const existingIndex = appState.trackingData.findIndex(p => p.frame === appState.currentFrame && p.objectId === appState.activeObjectId);
    const newPoint = {
        id: Date.now(),
        frame: appState.currentFrame,
        time: frameTimeOf(appState.currentFrame),
        x: vPos.x,
        y: vPos.y,
        objectId: appState.activeObjectId
    };

    if (existingIndex >= 0) {
        appState.trackingData[existingIndex] = newPoint;
    } else {
        appState.trackingData.push(newPoint);
    }

    appState.targetColor = sampleColor(vPos.x, vPos.y);
    if (appState.targetColor) {
        logDebug(`色をサンプリングしました: RGB(${appState.targetColor.r}, ${appState.targetColor.g}, ${appState.targetColor.b})`);
    }

    logDebug(`ポイント登録: Frame ${appState.currentFrame}, X: ${vPos.x.toFixed(1)}, Y: ${vPos.y.toFixed(1)}`
        + (existingIndex >= 0 ? '（上書き）' : ''));
    persistState();
    updateDataTable();
    drawVideoFrame();
    updateGraph();

    // 新規点は従来通り自動コマ送り。既存点の上書き(修正作業)はその場に留まり結果を確認できる。
    if (existingIndex < 0) stepFrame(appState.trackingStepSize, true);
}

function captureScalePoint(vPos) {
    const cal = appState.calibration;
    if (!cal.scaleTempStart) {
        cal.scaleTempStart = { x: vPos.x, y: vPos.y };
        logDebug("スケール始点を設定。十字を終点に合わせて、もう一度「確定」してください。");
        updateActionHint();
        updateScaleBanner();
        drawVideoFrame();
        return;
    }
    const start = cal.scaleTempStart;
    const end = { x: vPos.x, y: vPos.y };
    const pixelDistance = Math.hypot(end.x - start.x, end.y - start.y);

    showInputDialog("スケール設定", `2点間の距離は ${pixelDistance.toFixed(1)} px です。実際の距離を入力してください (cm):`, "100", (val) => {
        const actualDist = parseFloat(val);
        if (!isNaN(actualDist) && actualDist > 0) {
            cal.scaleRatio = actualDist / pixelDistance;
            cal.scaleStart = start;
            cal.scaleEnd = end;
            cal.scaleActual = actualDist;
            logDebug(`スケール設定完了: ${cal.scaleRatio.toFixed(4)} cm/px (実寸: ${actualDist} cm)`);
            document.getElementById('info-scale').textContent = `${cal.scaleRatio.toFixed(3)} cm/px`;
            appState.scaleSkipped = false;
            showStepBadge(`スケール ${actualDist} cm を設定`);
            persistState();
            updateDataTable();
            updateGraph();
        } else {
            logDebug("無効な距離が入力されました。");
        }
        cal.scaleTempStart = null;
        setPendingCapture(null);   // ここで自動的にトラッキングへ戻る
        updateScaleBanner();
        updateStepGuide();
        drawVideoFrame();
    });
}

// 選択ポイント状態の切り替え
function setSelectedPoint(id) {
    appState.selectedPointId = id;
    const btnDel = document.getElementById('btn-delete-selected');
    if (btnDel) {
        if (id !== null) {
            btnDel.disabled = false;
            btnDel.style.opacity = '1';
        } else {
            btnDel.disabled = true;
            btnDel.style.opacity = '0.5';
        }
    }
}

// 選択ポイント削除ボタンイベント設定
function setupDeletionEvent() {
    const btnDel = document.getElementById('btn-delete-selected');
    if (btnDel) {
        btnDel.addEventListener('click', () => {
            if (appState.selectedPointId !== null) {
                pushHistory();
                appState.trackingData = appState.trackingData.filter(p => p.id !== appState.selectedPointId);
                logDebug(`選択ポイント削除: ID ${appState.selectedPointId}`);
                setSelectedPoint(null);
                persistState();
                updateDataTable();
                drawVideoFrame();
                updateGraph();
            }
        });
    }
}

// --- 色サンプリングと色自動追跡 ---
function sampleColor(vx, vy) {
    if (!offscreenCtx) return null;
    
    const x = Math.round(vx);
    const y = Math.round(vy);
    const w = offscreenCanvas.width;
    const h = offscreenCanvas.height;
    
    if (x < 0 || x >= w || y < 0 || y >= h) return null;
    
    const radius = 2;
    let rSum = 0, gSum = 0, bSum = 0, count = 0;
    
    const startX = Math.max(0, x - radius);
    const endX = Math.min(w - 1, x + radius);
    const startY = Math.max(0, y - radius);
    const endY = Math.min(h - 1, y + radius);
    
    const imgData = offscreenCtx.getImageData(startX, startY, (endX - startX) + 1, (endY - startY) + 1);
    const data = imgData.data;
    
    for (let i = 0; i < data.length; i += 4) {
        rSum += data[i];
        gSum += data[i+1];
        bSum += data[i+2];
        count++;
    }
    
    return {
        r: Math.round(rSum / count),
        g: Math.round(gSum / count),
        b: Math.round(bSum / count)
    };
}

function trackColorStep() {
    if (!appState.targetColor) {
        logDebug("追跡対象の色が設定されていません。トラックモードで一度ポイントをタップして色を登録してください。");
        return Promise.resolve(false);
    }
    
    const currentPoint = appState.trackingData.find(p => p.frame === appState.currentFrame && p.objectId === appState.activeObjectId);
    if (!currentPoint) {
        logDebug("現在のフレームに基準ポイントがありません。");
        return Promise.resolve(false);
    }
    
    const prevX = currentPoint.x;
    const prevY = currentPoint.y;
    const nextFrame = appState.currentFrame + appState.trackingStepSize;
    
    if (nextFrame > appState.totalFrames) {
        logDebug("動画の末尾に達しました。");
        return Promise.resolve(false);
    }
    
    return new Promise((resolve) => {
        const onSeeked = () => {
            appState.videoElement.removeEventListener('seeked', onSeeked);
            
            updateOffscreenCanvas();
            
            const winSize = parseInt(document.getElementById('track-window-size').value) || 60;
            const threshold = parseInt(document.getElementById('track-threshold').value) || 40;
            
            const w = offscreenCanvas.width;
            const h = offscreenCanvas.height;
            
            const startX = Math.max(0, Math.round(prevX - winSize / 2));
            const endX = Math.min(w - 1, Math.round(prevX + winSize / 2));
            const startY = Math.max(0, Math.round(prevY - winSize / 2));
            const endY = Math.min(h - 1, Math.round(prevY + winSize / 2));
            
            const rectW = endX - startX + 1;
            const rectH = endY - startY + 1;
            
            if (rectW <= 0 || rectH <= 0) {
                logDebug("探索窓が動画範囲外です。");
                resolve(false);
                return;
            }
            
            const imgData = offscreenCtx.getImageData(startX, startY, rectW, rectH);
            const data = imgData.data;
            
            let sumX = 0;
            let sumY = 0;
            let matchCount = 0;
            
            for (let y = startY; y <= endY; y++) {
                for (let x = startX; x <= endX; x++) {
                    const localX = x - startX;
                    const localY = y - startY;
                    const idx = (localY * rectW + localX) * 4;
                    
                    const r = data[idx];
                    const g = data[idx+1];
                    const b = data[idx+2];
                    
                    const dist = Math.hypot(r - appState.targetColor.r, g - appState.targetColor.g, b - appState.targetColor.b);
                    
                    if (dist <= threshold) {
                        sumX += x;
                        sumY += y;
                        matchCount++;
                    }
                }
            }
            
            if (matchCount > 0) {
                const nextX = sumX / matchCount;
                const nextY = sumY / matchCount;
                
                const existingIndex = appState.trackingData.findIndex(p => p.frame === appState.currentFrame && p.objectId === appState.activeObjectId);
                const newPoint = {
                    id: Date.now(),
                    frame: appState.currentFrame,
                    time: frameTimeOf(appState.currentFrame),
                    x: nextX,
                    y: nextY,
                    objectId: appState.activeObjectId
                };
                
                if (existingIndex >= 0) {
                    appState.trackingData[existingIndex] = newPoint;
                } else {
                    appState.trackingData.push(newPoint);
                }
                
                persistState();
                updateDataTable();
                drawVideoFrame();
                updateGraph();
                logDebug(`追跡成功: Frame ${appState.currentFrame}, X: ${nextX.toFixed(1)}, Y: ${nextY.toFixed(1)}`);
                resolve(true);
            } else {
                logDebug(`追跡失敗: 一致する色が探索窓内で見つかりませんでした (閾値: ${threshold})`);
                resolve(false);
            }
        };
        
        appState.videoElement.addEventListener('seeked', onSeeked);
        seekToFrame(nextFrame);
    });
}

async function runAutoTracking() {
    if (appState.isAutoTracking) return;
    
    appState.isAutoTracking = true;
    document.getElementById('btn-auto-track-run').style.display = 'none';
    document.getElementById('btn-auto-track-stop').style.display = 'inline-flex';
    logDebug("自動色追跡を開始しました。");
    
    while (appState.isAutoTracking) {
        const success = await trackColorStep();
        if (!success) {
            stopAutoTracking();
            break;
        }
        await new Promise(r => setTimeout(r, 100));
    }
}

function stopAutoTracking() {
    appState.isAutoTracking = false;
    document.getElementById('btn-auto-track-run').style.display = 'inline-flex';
    document.getElementById('btn-auto-track-stop').style.display = 'none';
    logDebug("自動色追跡を停止しました。");
}

function setupAutoTrackerUI() {
    const btnStep = document.getElementById('btn-auto-track-step');
    const btnRun = document.getElementById('btn-auto-track-run');
    const btnStop = document.getElementById('btn-auto-track-stop');
    const thresholdInput = document.getElementById('track-threshold');
    const lblThreshold = document.getElementById('lbl-threshold');
    
    if (btnStep) btnStep.addEventListener('click', trackColorStep);
    if (btnRun) btnRun.addEventListener('click', runAutoTracking);
    if (btnStop) btnStop.addEventListener('click', stopAutoTracking);
    
    if (thresholdInput && lblThreshold) {
        thresholdInput.addEventListener('input', (e) => {
            lblThreshold.textContent = e.target.value;
        });
    }
}

// --- マーカー描画 ---
// 映像上に描くのは「現在コマの点」だけ（軌跡は描かない。過去の点は
// 打点マップ・y-x軌道グラフ・ストロボ点マーカーで見る）。
// マーカーは白＋黒の二重縁取りで、明るい背景でも暗い背景でも必ず浮く。
function drawTrackingPoints() {
    const scale = appState.viewState.scale;
    const baseRadius = 6;
    const r = baseRadius / scale;

    appState.trackingData.forEach(p => {
        if (p.frame !== appState.currentFrame) return;
        const local = videoToLocalCanvas(p.x, p.y);

        // 選択されている場合はハイライト表示を追加
        if (p.id === appState.selectedPointId) {
            appState.ctx.beginPath();
            appState.ctx.arc(local.x, local.y, r * 1.9, 0, Math.PI * 2);
            appState.ctx.strokeStyle = UI_COLORS.accentBright; // 選択強調の外枠
            appState.ctx.lineWidth = 2.0 / scale;
            appState.ctx.stroke();
        }

        // 外側の白リング（暗い背景対策）
        appState.ctx.beginPath();
        appState.ctx.arc(local.x, local.y, r + 1.5 / scale, 0, Math.PI * 2);
        appState.ctx.strokeStyle = '#FFFFFF';
        appState.ctx.lineWidth = 2.0 / scale;
        appState.ctx.stroke();

        // マーカー本体（物体色）＋黒縁（明るい背景対策）
        appState.ctx.beginPath();
        appState.ctx.arc(local.x, local.y, r, 0, Math.PI * 2);
        appState.ctx.fillStyle = COLOR_MAP[(p.objectId - 1) % COLOR_MAP.length];
        appState.ctx.fill();
        appState.ctx.strokeStyle = '#000000';
        appState.ctx.lineWidth = 1.2 / scale;
        appState.ctx.stroke();

        // 十字マーク
        appState.ctx.beginPath();
        appState.ctx.moveTo(local.x - r * 1.5, local.y);
        appState.ctx.lineTo(local.x + r * 1.5, local.y);
        appState.ctx.moveTo(local.x, local.y - r * 1.5);
        appState.ctx.lineTo(local.x, local.y + r * 1.5);
        appState.ctx.strokeStyle = '#ffffff';
        appState.ctx.lineWidth = 1.0 / scale;
        appState.ctx.stroke();
    });
}

function drawCalibrationMarkers() {
    const scale = appState.viewState.scale;
    
    // 原点（＝この物体の最初の打点）を軸で示す。設定させない代わりに、
    // 「どこが原点になっているか」は必ず目で確かめられるようにする。
    const originPts = appState.trackingData
        .filter(p => p.objectId === appState.activeObjectId && inAnalysisRange(p.frame));
    if (originPts.length) {
        const o = originOf(originPts);
        const localO = videoToLocalCanvas(o.x, o.y);
        appState.ctx.beginPath();
        appState.ctx.moveTo(localO.x - 40 / scale, localO.y);
        appState.ctx.lineTo(localO.x + 40 / scale, localO.y);
        appState.ctx.moveTo(localO.x, localO.y - 40 / scale);
        appState.ctx.lineTo(localO.x, localO.y + 40 / scale);
        appState.ctx.strokeStyle = UI_COLORS.calBright;
        appState.ctx.lineWidth = 1.5 / scale;
        appState.ctx.stroke();

        appState.ctx.fillStyle = UI_COLORS.calBright;
        appState.ctx.font = `bold ${10 / scale}px ${FONT_SANS}`;
        appState.ctx.fillText("原点", localO.x + 6 / scale, localO.y - 6 / scale);
    }
    
    // スケール描画
    const cal = appState.calibration;
    if (cal.scaleTempStart) {
        // 始点を確定した直後〜終点を確定するまで。十字に両矢印が追従し、
        // 「いまこの長さを選んでいる」ことが常に画面に出ているようにする。
        const localT = videoToLocalCanvas(cal.scaleTempStart.x, cal.scaleTempStart.y);
        const cross = getCrosshairVideoCoord();
        const localC = videoToLocalCanvas(cross.x, cross.y);
        const px = Math.hypot(cross.x - cal.scaleTempStart.x, cross.y - cal.scaleTempStart.y);
        drawMeasureArrow(appState.ctx, localT, localC, `${px.toFixed(0)} px`, { dashed: true });
    } else if (cal.scaleStart && cal.scaleEnd) {
        const localS = videoToLocalCanvas(cal.scaleStart.x, cal.scaleStart.y);
        const localE = videoToLocalCanvas(cal.scaleEnd.x, cal.scaleEnd.y);
        drawMeasureArrow(appState.ctx, localS, localE, `${cal.scaleActual} cm`);
    }
}

// 角丸矩形のパス。ctx.roundRect は少し前のSafariに無いので自前で持つ。
function roundRectPath(ctx, x, y, w, h, r) {
    const rr = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    if (typeof ctx.roundRect === 'function') { ctx.roundRect(x, y, w, h, rr); return; }
    ctx.moveTo(x + rr, y);
    ctx.arcTo(x + w, y, x + w, y + h, rr);
    ctx.arcTo(x + w, y + h, x, y + h, rr);
    ctx.arcTo(x, y + h, x, y, rr);
    ctx.arcTo(x, y, x + w, y, rr);
    ctx.closePath();
}

// スケール（既知の長さ）を表す両矢印。
// 「どこを何cmとして測ったのか」は測定全体の前提なので、映像の上でも埋もれない
// 太さ・大きさで常時出す。線の太さと文字サイズはズーム倍率で割って、拡大しても
// 画面上の見た目が変わらないようにする。
function drawMeasureArrow(ctx, a, b, label, opts = {}) {
    const s = appState.viewState.scale;
    const u = (v) => v / s;                       // 画面px → 現在のズームでの長さ
    const ang = Math.atan2(b.y - a.y, b.x - a.x);
    const perp = ang + Math.PI / 2;
    const headL = u(13), headW = u(7), cap = u(9);
    const dashed = !!opts.dashed;

    ctx.save();
    ctx.lineCap = 'butt';
    ctx.lineJoin = 'round';

    const strokePath = () => {
        ctx.beginPath();
        ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
        [a, b].forEach(p => {                     // 端の直交バー（測った位置を厳密に示す）
            ctx.moveTo(p.x - Math.cos(perp) * cap, p.y - Math.sin(perp) * cap);
            ctx.lineTo(p.x + Math.cos(perp) * cap, p.y + Math.sin(perp) * cap);
        });
        ctx.stroke();
    };
    const headPath = (tip, dir) => {
        ctx.beginPath();
        ctx.moveTo(tip.x, tip.y);
        ctx.lineTo(tip.x - Math.cos(dir) * headL - Math.cos(perp) * headW,
                   tip.y - Math.sin(dir) * headL - Math.sin(perp) * headW);
        ctx.lineTo(tip.x - Math.cos(dir) * headL + Math.cos(perp) * headW,
                   tip.y - Math.sin(dir) * headL + Math.sin(perp) * headW);
        ctx.closePath();
    };

    // 白フチ（明るい映像・暗い映像のどちらでも輪郭が残る）
    ctx.setLineDash([]);
    ctx.strokeStyle = 'rgba(255,255,255,0.92)';
    ctx.lineWidth = u(6.5);
    strokePath();
    ctx.lineWidth = u(3);
    headPath(b, ang); ctx.stroke();
    headPath(a, ang + Math.PI); ctx.stroke();

    // 本体（校正色のアンバー）
    if (dashed) ctx.setLineDash([u(9), u(6)]);
    ctx.strokeStyle = UI_COLORS.calBright;
    ctx.lineWidth = u(2.6);
    strokePath();
    ctx.setLineDash([]);
    ctx.fillStyle = UI_COLORS.calBright;
    headPath(b, ang); ctx.fill();
    headPath(a, ang + Math.PI); ctx.fill();

    // ラベルは塗りチップにして、映像の模様に負けないようにする
    const fs = u(13);
    ctx.font = `bold ${fs}px ${FONT_SANS}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const padX = u(7), padY = u(4.5);
    const w = ctx.measureText(label).width + padX * 2;
    const h = fs + padY * 2;
    // 線の上側へ少しずらして置く。ただし画面右下の[ズームリセット]ボタンに
    // 重なるなら反対側へ逃がす（ものさしを床際に置くと必ずぶつかるため）。
    const off = u(16) + h / 2;
    let sign = (Math.sin(perp) > 0) ? -1 : 1;
    const midX = (a.x + b.x) / 2, midY = (a.y + b.y) / 2;
    const toScreen = (lx, ly) => ({
        x: lx * s + appState.viewState.offsetX,
        y: ly * s + appState.viewState.offsetY
    });
    const hitsCorner = (sg) => {
        const p = toScreen(midX + Math.cos(perp) * off * sg, midY + Math.sin(perp) * off * sg);
        return p.x > appState.canvas.width - 72 && p.y > appState.canvas.height - 72;
    };
    if (hitsCorner(sign) && !hitsCorner(-sign)) sign = -sign;
    const mx = midX + Math.cos(perp) * off * sign;
    const my = midY + Math.sin(perp) * off * sign;
    roundRectPath(ctx, mx - w / 2, my - h / 2, w, h, u(5));
    ctx.fillStyle = UI_COLORS.calBright;
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.92)';
    ctx.lineWidth = u(1.5);
    ctx.stroke();
    ctx.fillStyle = '#1F2933';
    ctx.fillText(label, mx, my + u(0.5));
    ctx.restore();
}

// --- 測定データテーブルの更新 ---
function updateDataTable() {
    const tableBody = document.querySelector('#data-table tbody');
    if (!tableBody) return;

    // ヘッダの単位をスケール設定に合わせて更新
    const unit = appState.calibration.scaleRatio ? 'cm' : 'px';
    const ths = document.querySelectorAll('#data-table thead th');
    if (ths.length >= 3) { ths[1].textContent = `x (${unit})`; ths[2].textContent = `y (${unit})`; }

    tableBody.innerHTML = '';
    
    const filteredData = appState.trackingData
        .filter(p => p.objectId === appState.activeObjectId && inAnalysisRange(p.frame))
        .sort((a, b) => a.frame - b.frame);

    if (filteredData.length === 0) {
        tableBody.innerHTML = `<tr class="empty-row"><td colspan="4">データがありません</td></tr>`;
        updateHitMap();
        updateStepGuide();
        return;
    }
    
    const tableOrigin = originOf(filteredData);
    filteredData.forEach(p => {
        const tr = document.createElement('tr');
        
        // 原点・スケール・正の向きの適用はグラフや出力と同じ関数に任せる
        const ph = physCoordOf(p, tableOrigin);
        const physX = ph.x, physY = ph.y;
        
        tr.innerHTML = `
            <td>${p.time.toFixed(3)}</td>
            <td>${physX.toFixed(1)}</td>
            <td>${physY.toFixed(1)}</td>
            <td>
                <button class="btn-danger-small" onclick="deletePoint(${p.id})">削除</button>
            </td>
        `;
        
        // 選択された行のスタイルを変更
        if (p.id === appState.selectedPointId) {
            tr.style.background = '#E3EEF9';
            tr.style.fontWeight = 'bold';
        }
        
        tr.addEventListener('click', (e) => {
            if (e.target.tagName !== 'BUTTON') {
                cancelDeferredConfirm();
                setSelectedPoint(p.id);
                seekToFrame(p.frame);
                drawVideoFrame();
                updateDataTable(); // 行選択の再描画
            }
        });
        
        tableBody.appendChild(tr);
    });

    updateHitMap();
    updateStepGuide();
}

// --- 打点マップ --------------------------------------------------------
// 解析範囲のコマを番号チップで並べ、打点済み＝物体色・未打＝白抜き・
// 現在コマ＝太枠で示す。チップのタップでそのコマへジャンプ。
// 「どのコマに座標が決まっているか」「取消で何が消えたか」が一目で分かる。
const HIT_MAP_MAX_CHIPS = 400; // 長い動画対策: DOMを数千個作るとフリーズする

function hitChipHtml(frame, hasPoint) {
    const color = COLOR_MAP[(appState.activeObjectId - 1) % COLOR_MAP.length];
    const style = hasPoint ? ` style="background:${color};border-color:${color};"` : '';
    return `<button class="hit-chip${hasPoint ? ' has' : ''}" data-frame="${frame}"${style}>${frame}</button>`;
}

function updateHitMap() {
    const map = document.getElementById('hit-map');
    if (!map) return;
    if (!appState.videoElement || !appState.videoElement.src || appState.totalFrames <= 0) {
        map.innerHTML = '<span class="hit-map-hint">動画を読み込むと、コマごとの打点状況がここに並びます</span>';
        return;
    }
    const hitFrames = new Set(appState.trackingData
        .filter(p => p.objectId === appState.activeObjectId)
        .map(p => p.frame));
    const lo = appState.rangeIn, hi = appState.rangeOut;
    const len = hi - lo + 1;
    let html = '';
    if (len > HIT_MAP_MAX_CHIPS) {
        // 全コマ分のチップは作らない（長い動画でのフリーズ防止）。打点済みだけ並べる
        html = `<span class="hit-map-hint">範囲が ${len} コマと長いため打点済みのコマだけ表示中。`
            + `読み込み時のダイアログか [|&lt;][&gt;|] で範囲を絞ると全コマ表示になります。</span>`;
        html += [...hitFrames].filter(f => f >= lo && f <= hi).sort((a, b) => a - b)
            .map(f => hitChipHtml(f, true)).join('');
    } else {
        for (let f = lo; f <= hi; f++) html += hitChipHtml(f, hitFrames.has(f));
    }
    map.innerHTML = html;
    updateHitMapCurrent();
}

// 現在コマの太枠だけを差し替える（コマ送りのたびに全チップを作り直さない）
function updateHitMapCurrent() {
    const map = document.getElementById('hit-map');
    if (!map) return;
    map.querySelectorAll('.hit-chip.current').forEach(el => el.classList.remove('current'));
    const cur = map.querySelector(`.hit-chip[data-frame="${appState.currentFrame}"]`);
    if (cur) cur.classList.add('current');
}

// 取消などで変化したチップを短く点滅させて場所を教える
function flashHitChip(frame) {
    const map = document.getElementById('hit-map');
    if (!map) return;
    const el = map.querySelector(`.hit-chip[data-frame="${frame}"]`);
    if (el) {
        el.classList.remove('flash');
        void el.offsetWidth;
        el.classList.add('flash');
        el.scrollIntoView({ block: 'nearest' });
    }
}

function setupHitMap() {
    const map = document.getElementById('hit-map');
    if (!map) return;
    map.addEventListener('click', (e) => {
        const chip = e.target.closest('.hit-chip');
        if (chip) { cancelDeferredConfirm(); seekToFrame(parseInt(chip.dataset.frame)); }
    });
    updateHitMap();
}

function deletePoint(id) {
    pushHistory();
    appState.trackingData = appState.trackingData.filter(p => p.id !== id);
    if (appState.selectedPointId === id) {
        setSelectedPoint(null);
    }
    persistState();
    updateDataTable();
    drawVideoFrame();
    updateGraph();
    logDebug(`ポイント削除: ID ${id}`);
}

window.deletePoint = deletePoint;

// --- 物理座標・運動学（速度/加速度）の計算 --------------------------------
// 動画ピクセル座標 → 原点基準・スケール適用済みの物理座標へ
// 原点は「その物体の最初の打点」。生徒に原点を設定させないための自動化で、
// 同時に符号バグの根治でもある（原点未設定のときだけ画面座標のまま符号を掛けて
// しまい、自由落下なのに上が正になっていた）。原点は保存せず毎回ここで決めるので、
// 最初の点を打ち直せば原点も自動で追随する。
function originOf(sortedData) {
    if (!sortedData || !sortedData.length) return { x: 0, y: 0 };
    let first = sortedData[0];
    for (const p of sortedData) if (p.frame < first.frame) first = p;
    return { x: first.x, y: first.y };
}

// 正の向きは運動の種類で決まる（自由落下なら下が正、投げ上げなら上が正…）。
// 符号は表示上の変換なので、あとからモードを変えても打点データはそのまま使える。
function physCoordOf(p, origin) {
    const m = currentMode();
    const o = origin || { x: 0, y: 0 };
    let x = p.x - o.x;
    let y = o.y - p.y;                       // ここで必ず「上が正」に揃える
    const cal = appState.calibration;
    if (cal.scaleRatio) { x *= cal.scaleRatio; y *= cal.scaleRatio; }
    return { x: x * m.xSign, y: y * m.ySign, t: p.time, frame: p.frame, id: p.id };
}

// 不等間隔対応の3点公式で片方の微分を厳密に求める（端点は片側差分）。
// h0=h1なら単純な中心差分と完全一致、等加速度運動なら間隔がどれだけ
// 不揃いでも理論上厳密値になる。ただし3点だけの厳密内挿なので、
// クリック誤差（ノイズ）はそのまま増幅されて出る（StageE以前の唯一の方式）。
function derivExact(t, arr, n) {
    return arr.map((_, i) => {
        if (n === 1) return 0;
        if (i === 0)       return (arr[1] - arr[0]) / ((t[1] - t[0]) || 1e-9);
        if (i === n - 1)   return (arr[n - 1] - arr[n - 2]) / ((t[n - 1] - t[n - 2]) || 1e-9);
        const h0 = t[i] - t[i - 1], h1 = t[i + 1] - t[i];
        const denom = h0 * h1 * (h0 + h1);
        if (!denom) return (arr[i + 1] - arr[i - 1]) / ((t[i + 1] - t[i - 1]) || 1e-9);
        return (h0 * h0 * (arr[i + 1] - arr[i]) + h1 * h1 * (arr[i] - arr[i - 1])) / denom;
    });
}

// [lo,hi]区間の点にτ=t[k]-t[centerIdx]として2次関数を最小二乗フィットし、
// τ=0(=対象点)での微分値(1次係数)を返す。窓がちょうど3点なら、その3点を
// 厳密に通る唯一の2次関数になるため derivExact と同じ結果になる（後方互換）。
// 4点以上なら過剰決定の最小二乗になり、点ごとのクリック誤差を平均化できる。
function quadraticFitDerivativeAt(t, arr, lo, hi, centerIdx) {
    let S0 = 0, S1 = 0, S2 = 0, S3 = 0, S4 = 0, T0 = 0, T1 = 0, T2 = 0;
    const t0 = t[centerIdx];
    for (let k = lo; k <= hi; k++) {
        const tau = t[k] - t0, tau2 = tau * tau;
        S0++; S1 += tau; S2 += tau2; S3 += tau2 * tau; S4 += tau2 * tau2;
        T0 += arr[k]; T1 += tau * arr[k]; T2 += tau2 * arr[k];
    }
    // 正規方程式 [S4 S3 S2; S3 S2 S1; S2 S1 S0][a;b;c] = [T2;T1;T0] をクラメルの公式で解く。
    // 欲しいのは1次係数bのみ（=τ=0での微分値）。
    const det3 = (m) => m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * m[7] - m[4] * m[6]);
    const D = det3([S4, S3, S2, S3, S2, S1, S2, S1, S0]);
    if (!D) return (arr[hi] - arr[lo]) / ((t[hi] - t[lo]) || 1e-9); // 縮退時のフォールバック
    const Db = det3([S4, T2, S2, S3, T1, S1, S2, T0, S0]); // bの列をRHSに置換
    return Db / D;
}

// 窓の取り方: 端点でも点数を保ったまま横へずらす（縮めない）。
// 窓を縮めると、端では少ない点で「窓の端での傾き」を求めることになり、
// クリック誤差の増幅が中央の8倍（加速度はそれを2回かけるので23倍）に達する。
// 横へずらせば端点でも 8倍→2倍程度に収まる（30fps・25点での実測）。
function kinematicsWindow(i, n, half) {
    const w = Math.min(n, 2 * half + 1);
    let lo = i - half, hi = i + half;
    if (lo < 0) { lo = 0; hi = w - 1; }
    if (hi > n - 1) { hi = n - 1; lo = n - w; }
    return [lo, hi];
}

// 窓付き2次回帰で微分する。窓の点数が3未満(=全体でn<3)の場合のみ
// derivExactにフォールバックする。
const KINEMATICS_WINDOW_HALF = 2;   // 速度: 前後2点＝5点の窓で位置を回帰
const ACCEL_WINDOW_HALF = 3;        // 加速度: 前後3点＝7点の窓で速度を回帰
// 加速度は端に近いほど誤差が大きい（端から順に 296 / 221 / 147 / 80 cm/s²。
// クリック誤差1px・1px=0.5cm・30fps換算）。両端2点は捨てて、残りだけを示す。
const ACCEL_EDGE_DROP = 2;
function derivSmoothed(t, arr, n, half) {
    const h = (half === undefined) ? KINEMATICS_WINDOW_HALF : half;
    if (n < 3) return derivExact(t, arr, n);
    return arr.map((_, i) => {
        const [lo, hi] = kinematicsWindow(i, n, h);
        return quadraticFitDerivativeAt(t, arr, lo, hi, i);
    });
}

// 加速度で捨てる端点の数。点が少ないときに全部消えてしまわないよう手加減する。
function accelEdgeDrop(n, smoothed) {
    if (!smoothed) return 0;          // 生データ表示は一切加工しない
    if (n >= 7) return ACCEL_EDGE_DROP;
    return n >= 5 ? 1 : 0;
}

// 位置→速度→加速度の数値微分。
// トラッキングは毎コマ打つとは限らず、コマ飛ばし（ステップ幅>1・手動ジャンプ）で
// 前後の間隔が不揃いになることが普通にある。特に+1コマと+10コマ等を同じ対象で
// 混在させると、区間比が極端な点でderivExact(3点厳密内挿)はノイズを増幅しやすい。
// 既定ではderivSmoothed(窓付き最小二乗)を使い、appState.rawKinematics=trueの
// 時だけderivExactに切り替える（精度検証や上級者向け）。
function computeKinematics(sortedData, smoothedOverride) {
    const smoothed = (smoothedOverride !== undefined) ? smoothedOverride : !appState.rawKinematics;
    const origin = originOf(sortedData);
    const pts = sortedData.map(p => physCoordOf(p, origin));
    const n = pts.length;
    const t = pts.map(p => p.t);
    const deriv = smoothed
        ? (arr, half) => derivSmoothed(t, arr, n, half)
        : (arr) => derivExact(t, arr, n);
    const x = pts.map(p => p.x), y = pts.map(p => p.y);
    // 速度は5点窓。加速度は「v-tのデータに直線を当てて傾きを読む」操作なので、
    // 7点窓に広げて安定させる（＝加速度はv-tグラフの傾き、という意味は保つ）。
    const vx = deriv(x, KINEMATICS_WINDOW_HALF), vy = deriv(y, KINEMATICS_WINDOW_HALF);
    const ax = deriv(vx, ACCEL_WINDOW_HALF), ay = deriv(vy, ACCEL_WINDOW_HALF);
    const drop = accelEdgeDrop(n, smoothed);
    return pts.map((p, i) => {
        const edge = (i < drop || i >= n - drop);   // 端の加速度は精度が出ないので出さない
        return {
            t: t[i], x: x[i], y: y[i],
            vx: vx[i], vy: vy[i], v: Math.hypot(vx[i], vy[i]),
            ax: edge ? null : ax[i],
            ay: edge ? null : ay[i],
            a: edge ? null : Math.hypot(ax[i], ay[i]),
            id: p.id, frame: p.frame,
            smoothed
        };
    });
}

// --- リアルタイムグラフ（複数表示・縦積み） ---
const GRAPH_TYPES_KEY = 'tracker_for_ipad_graph_types_v1';
// 既定は y-t と vy-t。「v-tグラフの傾き＝重力加速度」に自然に到達させるため、
// 符号が見える vy-t を速さ(v-t)より優先する。
const DEFAULT_GRAPH_TYPES = ['y-t', 'vy-t'];
let renderedGraphSignature = null; // 現在 DOM 上に組まれているグラフ種別の署名

function getSelectedGraphTypes() {
    const sel = [];
    document.querySelectorAll('#graph-type-checklist input[type="checkbox"]').forEach(b => {
        if (b.checked) sel.push(b.value);
    });
    return sel;
}

function persistGraphTypes(types) {
    try { localStorage.setItem(GRAPH_TYPES_KEY, JSON.stringify(types)); } catch (e) { /* 無視 */ }
}

// チェックボックスを指定の構成に切り替えて保存し、再描画する
function applyGraphTypes(types) {
    const checklist = document.getElementById('graph-type-checklist');
    if (!checklist || !Array.isArray(types)) return;
    checklist.querySelectorAll('input[type="checkbox"]').forEach(b => {
        b.checked = types.includes(b.value);
    });
    persistGraphTypes(types);
    if (typeof updateGraph === 'function') updateGraph();
}

function loadGraphTypes() {
    try {
        const raw = localStorage.getItem(GRAPH_TYPES_KEY);
        if (raw) { const a = JSON.parse(raw); if (Array.isArray(a)) return a; }
    } catch (e) { /* 破損は無視 */ }
    return DEFAULT_GRAPH_TYPES.slice();
}

function setupGraphEvents() {
    const checklist = document.getElementById('graph-type-checklist');
    if (!checklist) return;
    // 前回の選択（無ければデフォルト y-t / v-t）をチェック状態へ反映
    const saved = loadGraphTypes();
    checklist.querySelectorAll('input[type="checkbox"]').forEach(b => {
        b.checked = saved.includes(b.value);
    });
    checklist.addEventListener('change', () => {
        persistGraphTypes(getSelectedGraphTypes());
        updateGraph();
    });

    // 運動の種類に合わせたグラフのプリセット（チェックを一括切替するだけの近道）
    const PRESETS = {
        fall:       ['y-t', 'vy-t'],               // 自由落下・鉛直投げ上げ
        projectile: ['x-t', 'y-t', 'vx-t', 'vy-t'] // 水平投射・斜方投射
    };
    document.querySelectorAll('#graph-presets .preset-btn').forEach(btn => {
        btn.addEventListener('click', () => applyGraphTypes(PRESETS[btn.dataset.preset]));
    });

    // 生データ/スムージング切替（既定はスムージングON＝チェックOFF）
    const rawChk = document.getElementById('chk-raw-kinematics');
    if (rawChk) {
        try { rawChk.checked = localStorage.getItem(RAW_KINEMATICS_KEY) === '1'; } catch (e) { /* 無視 */ }
        appState.rawKinematics = rawChk.checked;
        rawChk.addEventListener('change', () => {
            appState.rawKinematics = rawChk.checked;
            try { localStorage.setItem(RAW_KINEMATICS_KEY, rawChk.checked ? '1' : '0'); } catch (e) { /* 無視 */ }
            updateGraph();
            logDebug(appState.rawKinematics ? '生データ表示に切替（スムージングなし）' : 'スムージング表示に切替');
        });
    }
}
const RAW_KINEMATICS_KEY = 'tracker_for_ipad_raw_kinematics_v1';

// 1枚のグラフ canvas にクリックハンドラを取り付ける（当たり判定座標は canvas._plotPoints）
function attachGraphClick(cv) {
    cv.addEventListener('click', (e) => {
        const pts = cv._plotPoints || [];
        const rect = cv.getBoundingClientRect();
        const mx = (e.clientX - rect.left) * (cv.width / (rect.width || 1));
        const my = (e.clientY - rect.top) * (cv.height / (rect.height || 1));
        let best = null, bestDist = 16;
        pts.forEach(p => {
            const d = Math.hypot(p.cx - mx, p.cy - my);
            if (d < bestDist) { bestDist = d; best = p; }
        });
        if (best) {
            cancelDeferredConfirm();
            setSelectedPoint(best.id);
            seekToFrame(best.frame);
            drawVideoFrame();
            updateDataTable();
            updateGraph();
        } else {
            // 点以外の場所をタップ → そのグラフを拡大（範囲指定して傾きを測れる）
            openGraphDialog(cv.dataset.type);
        }
    });
}

// グラフ種別 → 系列の定義（速度・加速度を含む）
function graphSeriesFor(graphType, kin, unit) {
    const t = kin.map(p => p.t);
    // 縦軸ラベルに「どちらが正か」を添える。運動の種類で符号が変わるので、
    // グラフを見ただけで正の向きが分かる状態を常に保つ。
    const m = currentMode();
    const dir = m.ySign > 0 ? ' ↑正' : ' ↓正';
    const map = {
        'y-t':  { xv: t, yv: kin.map(p => p.y),  lx: 't (s)',     ly: `y (${unit})${dir}` },
        'x-t':  { xv: t, yv: kin.map(p => p.x),  lx: 't (s)',     ly: `x (${unit}) →正` },
        'y-x':  { xv: kin.map(p => p.x), yv: kin.map(p => p.y), lx: `x (${unit}) →正`, ly: `y (${unit})${dir}`, traj: true },
        'vx-t': { xv: t, yv: kin.map(p => p.vx), lx: 't (s)', ly: `vx (${unit}/s) →正` },
        'vy-t': { xv: t, yv: kin.map(p => p.vy), lx: 't (s)', ly: `vy (${unit}/s)${dir}` },
        'v-t':  { xv: t, yv: kin.map(p => p.v),  lx: 't (s)', ly: `速さ (${unit}/s)` },
        'ax-t': { xv: t, yv: kin.map(p => p.ax), lx: 't (s)', ly: `ax (${unit}/s²) →正`, edgeCut: true },
        'ay-t': { xv: t, yv: kin.map(p => p.ay), lx: 't (s)', ly: `ay (${unit}/s²)${dir}`, edgeCut: true },
        'a-t':  { xv: t, yv: kin.map(p => p.a),  lx: 't (s)', ly: `加速度 (${unit}/s²)`, edgeCut: true }
    };
    return map[graphType] || map['y-t'];
}

// 選択されたグラフ種別ぶんのミニ canvas を縦積みし、それぞれ描画する。
function updateGraph() {
    const stack = document.getElementById('graph-stack');
    if (!stack) return;

    const types = getSelectedGraphTypes();
    const sig = types.join(',');

    // 選択が変わったときだけ DOM を組み直す（毎回の再描画では作り直さない）
    if (sig !== renderedGraphSignature) {
        stack.innerHTML = '';
        if (types.length === 0) {
            const hint = document.createElement('div');
            hint.className = 'graph-empty-hint';
            hint.textContent = '上のチェックで表示する量を選んでください';
            stack.appendChild(hint);
        } else {
            types.forEach(type => {
                const box = document.createElement('div');
                box.className = 'mini-graph';
                const cv = document.createElement('canvas');
                cv.dataset.type = type;
                box.appendChild(cv);
                // 拡大ボタン（グラフの空き地タップでも開くが、明示の入口も置く）
                const expand = document.createElement('button');
                expand.className = 'mini-graph-expand';
                expand.title = '拡大して範囲の傾きを測る';
                expand.innerHTML = '<span class="material-icons-round">open_in_full</span>';
                expand.addEventListener('click', (e) => { e.stopPropagation(); openGraphDialog(type); });
                box.appendChild(expand);
                stack.appendChild(box);
                attachGraphClick(cv);
            });
        }
        renderedGraphSignature = sig;
    }

    const data = appState.trackingData
        .filter(p => p.objectId === appState.activeObjectId && inAnalysisRange(p.frame))
        .sort((a, b) => a.frame - b.frame);
    const unit = appState.calibration.scaleRatio ? "cm" : "px";
    const kin = data.length ? computeKinematics(data) : [];

    stack.querySelectorAll('canvas').forEach(cv => {
        drawOneGraph(cv, cv.dataset.type, data, kin, unit);
    });
}

// 画面用は等倍。提出用レポート（高解像度）では倍率を上げて、文字と線が
// 縮小されて潰れないようにする。composeReport が一時的に切り替える。
let GRAPH_SCALE = 1;

// グラフ1枚を canvas に描画。当たり判定座標は cv._plotPoints に保持。
function drawOneGraph(graphCanvas, graphType, data, kin, unit) {
    // 親要素のサイズに Canvas の物理解像度をフィットさせる
    const container = graphCanvas.parentElement;
    if (container.clientWidth > 0 && container.clientHeight > 0) {
        graphCanvas.width = container.clientWidth;
        graphCanvas.height = container.clientHeight;
    }

    const gCtx = graphCanvas.getContext('2d');
    gCtx.clearRect(0, 0, graphCanvas.width, graphCanvas.height);
    const plotPoints = [];
    graphCanvas._plotPoints = plotPoints;

    if (!data || data.length === 0) {
        gCtx.fillStyle = UI_COLORS.textSub;
        gCtx.font = `${11 * GRAPH_SCALE}px ${FONT_SANS}`;
        gCtx.textAlign = 'center';
        gCtx.textBaseline = 'middle';
        gCtx.fillText("測定が開始されると自動で描画されます", graphCanvas.width / 2, graphCanvas.height / 2);
        return;
    }

    const series = graphSeriesFor(graphType, kin, unit);
    const valX = series.xv, valY = series.yv;
    const labelX = series.lx, labelY = series.ly;

    // 加速度は両端の点を空欄にしてあるので、値を持つ点だけを描く
    // （軸の自動スケールにも混ぜない）。
    const idxs = valX.map((_, i) => i)
        .filter(i => Number.isFinite(valX[i]) && Number.isFinite(valY[i]));
    if (idxs.length === 0) {
        gCtx.fillStyle = UI_COLORS.textSub;
        gCtx.font = `${11 * GRAPH_SCALE}px ${FONT_SANS}`;
        gCtx.textAlign = 'center';
        gCtx.textBaseline = 'middle';
        gCtx.fillText("加速度を出すには点がもう少し必要です", graphCanvas.width / 2, graphCanvas.height / 2);
        return;
    }
    // 横軸は「値が空欄の点も含めた全範囲」で取る。こうすると縦に積んだ
    // y-t・v-t・a-t の時間軸が揃い、a-t は両端が空くことで「端は捨てた」と
    // ひと目で分かる。縦軸だけを、値のある点で決める。
    const xsIn = valX.filter(Number.isFinite);
    const ysIn = idxs.map(i => valY[i]);

    let minX = Math.min(...xsIn);
    let maxX = Math.max(...xsIn);
    let minY = Math.min(...ysIn);
    let maxY = Math.max(...ysIn);

    // 最大最小が一致する場合のフラット防止
    if (maxX === minX) { maxX += 1; minX -= 1; }
    if (maxY === minY) { maxY += 1; minY -= 1; }

    // マージン（レポート出力時は GRAPH_SCALE 倍で描き、文字が潰れないようにする）
    const gs = GRAPH_SCALE;
    const padL = 35 * gs;
    const padR = 15 * gs;
    const padT = 15 * gs;
    const padB = 22 * gs;

    const plotW = graphCanvas.width - padL - padR;
    const plotH = graphCanvas.height - padT - padB;

    // 軌跡グラフ(y-x)は縦横を同縮尺にして、放物線の形を歪めずに見せる
    if (series.traj && plotW > 0 && plotH > 0) {
        const scalePerPx = Math.max((maxX - minX) / plotW, (maxY - minY) / plotH);
        const cxm = (minX + maxX) / 2, cym = (minY + maxY) / 2;
        minX = cxm - scalePerPx * plotW / 2; maxX = cxm + scalePerPx * plotW / 2;
        minY = cym - scalePerPx * plotH / 2; maxY = cym + scalePerPx * plotH / 2;
    }

    const toCanvasX = (val) => padL + ((val - minX) / (maxX - minX)) * plotW;
    const toCanvasY = (val) => padT + plotH - ((val - minY) / (maxY - minY)) * plotH;
    
    // グリッド背景線
    gCtx.strokeStyle = UI_COLORS.grid;
    gCtx.lineWidth = 1;
    
    // X軸の補助線と目盛りラベル
    const xSteps = 4;
    for (let i = 0; i <= xSteps; i++) {
        const ratio = i / xSteps;
        const val = minX + ratio * (maxX - minX);
        const cx = toCanvasX(val);
        
        gCtx.beginPath();
        gCtx.moveTo(cx, padT);
        gCtx.lineTo(cx, padT + plotH);
        gCtx.stroke();
        
        gCtx.fillStyle = UI_COLORS.textSub;
        gCtx.font = `${8 * gs}px ${FONT_MONO}`;
        gCtx.textAlign = 'center';
        gCtx.fillText(val.toFixed(2), cx, padT + plotH + 11 * gs);
    }
    
    // Y軸の補助線と目盛りラベル
    const ySteps = 4;
    for (let i = 0; i <= ySteps; i++) {
        const ratio = i / ySteps;
        const val = minY + ratio * (maxY - minY);
        const cy = toCanvasY(val);
        
        gCtx.beginPath();
        gCtx.moveTo(padL, cy);
        gCtx.lineTo(padL + plotW, cy);
        gCtx.stroke();
        
        gCtx.fillStyle = UI_COLORS.textSub;
        gCtx.font = `${8 * gs}px ${FONT_MONO}`;
        gCtx.textAlign = 'right';
        gCtx.fillText(val.toFixed(1), padL - 5 * gs, cy + 3 * gs);
    }
    
    // 主軸線
    gCtx.strokeStyle = UI_COLORS.axis;
    gCtx.lineWidth = 1.2;
    gCtx.beginPath();
    gCtx.moveTo(padL, padT);
    gCtx.lineTo(padL, padT + plotH);
    gCtx.lineTo(padL + plotW, padT + plotH);
    gCtx.stroke();

    // 値が0をまたぐグラフでは、y=0 の横線（x軸）を濃く引く。
    // 投げ上げの vy が正→負に変わる瞬間＝最高点が、ひと目で分かるようにするため。
    if (minY < 0 && maxY > 0) {
        const zeroY = toCanvasY(0);
        gCtx.save();
        gCtx.strokeStyle = UI_COLORS.text;
        gCtx.lineWidth = 1.6 * gs;
        gCtx.beginPath();
        gCtx.moveTo(padL, zeroY);
        gCtx.lineTo(padL + plotW, zeroY);
        gCtx.stroke();
        // 目盛りラベルと重ならないよう、プロットの内側に白フチ付きで置く
        gCtx.font = `bold ${8 * gs}px ${FONT_MONO}`;
        gCtx.textAlign = 'left';
        gCtx.lineWidth = 3 * gs;
        gCtx.strokeStyle = UI_COLORS.surface;
        gCtx.strokeText('0', padL + 3 * gs, zeroY - 3 * gs);
        gCtx.fillStyle = UI_COLORS.text;
        gCtx.fillText('0', padL + 3 * gs, zeroY - 3 * gs);
        gCtx.restore();
    }
    
    // 軸名ラベルの描画
    gCtx.fillStyle = UI_COLORS.textSub;
    gCtx.font = `${8 * gs}px ${FONT_SANS}`;
    gCtx.textAlign = 'right';
    gCtx.fillText(labelX, graphCanvas.width - 4 * gs, graphCanvas.height - 4 * gs);
    gCtx.textAlign = 'left';
    gCtx.fillText(labelY, 4 * gs, 8 * gs);
    
    // 線グラフ描画
    gCtx.strokeStyle = COLOR_MAP[(appState.activeObjectId - 1) % COLOR_MAP.length];
    gCtx.lineWidth = 1.8 * gs;
    gCtx.beginPath();
    
    idxs.forEach((idx, k) => {
        const cx = toCanvasX(valX[idx]);
        const cy = toCanvasY(valY[idx]);
        if (k === 0) {
            gCtx.moveTo(cx, cy);
        } else {
            gCtx.lineTo(cx, cy);
        }
    });
    gCtx.stroke();

    // ドットプロット描画 ＆ クリック当たり判定座標の記録
    idxs.forEach((idx) => {
        const cx = toCanvasX(valX[idx]);
        const cy = toCanvasY(valY[idx]);
        plotPoints.push({ cx, cy, id: data[idx].id, frame: data[idx].frame });

        gCtx.beginPath();
        // 選択されたポイントはプロット上でも大きく＆アンバーで強調（三者連動）
        const isSel = (data[idx].id === appState.selectedPointId);
        gCtx.arc(cx, cy, (isSel ? 5.0 : 3.0) * gs, 0, Math.PI * 2);
        gCtx.fillStyle = isSel ? UI_COLORS.accent : COLOR_MAP[(appState.activeObjectId - 1) % COLOR_MAP.length];
        gCtx.fill();
        gCtx.strokeStyle = isSel ? UI_COLORS.accent : UI_COLORS.surface;
        gCtx.lineWidth = (isSel ? 2 : 1) * gs;
        gCtx.stroke();
    });

    // 拡大ダイアログの範囲選択が座標変換を使えるように保持しておく
    graphCanvas._transform = { minX, maxX, minY, maxY, padL, padT, plotW, plotH };
}

// 3桁の有効数字で表示（1234.5→1230, 9.784→9.78）
function fmtSig3(v) {
    if (!isFinite(v)) return '--';
    return Number(v.toPrecision(3)).toString();
}

// 決定係数 R^2（回帰直線のあてはまりの良さ）。表示用に文字列で返す。
function r2Of(xs, ys) {
    const n = xs.length;
    if (n < 3) return '--';
    const a = slopeOf(xs, ys);
    if (a === null) return '--';
    const mx = xs.reduce((p, q) => p + q, 0) / n;
    const my = ys.reduce((p, q) => p + q, 0) / n;
    const b = my - a * mx;
    let ssr = 0, sst = 0;
    for (let i = 0; i < n; i++) { ssr += (ys[i] - (a * xs[i] + b)) ** 2; sst += (ys[i] - my) ** 2; }
    if (!sst) return '--';
    return (1 - ssr / sst).toFixed(4);
}

// 最小二乗の傾き。点が2つ以上なければ null
function slopeOf(xs, ys) {
    const n = xs.length;
    if (n < 2) return null;
    const mx = xs.reduce((a, b) => a + b, 0) / n;
    const my = ys.reduce((a, b) => a + b, 0) / n;
    let sxx = 0, sxy = 0;
    for (let i = 0; i < n; i++) {
        sxx += (xs[i] - mx) * (xs[i] - mx);
        sxy += (xs[i] - mx) * (ys[i] - my);
    }
    if (sxx <= 0) return null;
    return sxy / sxx;
}

// グラフ種別ごとの「傾き」の単位と物理的な意味
function slopeMeaning(graphType, unit) {
    if (graphType === 'y-t' || graphType === 'x-t') return { unit: `${unit}/s`, meaning: '平均速度' };
    if (graphType === 'vx-t' || graphType === 'vy-t' || graphType === 'v-t') return { unit: `${unit}/s²`, meaning: '平均加速度' };
    if (graphType === 'y-x') return { unit: '', meaning: '軌道の傾き' };
    return { unit: `${unit}/s³`, meaning: '' };
}

// --- グラフ拡大ダイアログ（範囲を指定して傾きを測る） -----------------
// ミニグラフの空き地タップ / 拡大ボタンで開く。グラフ上を横にドラッグして
// 範囲を選ぶと、その範囲の点だけで回帰直線を引き、傾きを大きく表示する。
// v-tグラフなら傾き＝平均加速度（重力加速度の測定がアプリ内で完結する）。
const GRAPH_TYPE_LABELS = {
    'y-t': 'y-t', 'x-t': 'x-t', 'y-x': 'y-x（軌道）',
    'vx-t': 'vx-t', 'vy-t': 'vy-t', 'v-t': '速さ-t',
    'ax-t': 'ax-t', 'ay-t': 'ay-t', 'a-t': '加速度-t'
};

function openGraphDialog(graphType) {
    const overlay = document.getElementById('dialog-overlay');
    const titleEl = document.getElementById('dialog-title');
    const bodyEl = document.getElementById('dialog-body');
    const btnCancel = document.getElementById('dialog-btn-cancel');
    const btnOk = document.getElementById('dialog-btn-ok');
    if (!overlay) return;

    const data = appState.trackingData
        .filter(p => p.objectId === appState.activeObjectId && inAnalysisRange(p.frame))
        .sort((a, b) => a.frame - b.frame);
    if (data.length < 2) return;
    const unit = appState.calibration.scaleRatio ? 'cm' : 'px';
    const kin = computeKinematics(data);
    const series = graphSeriesFor(graphType, kin, unit);

    titleEl.textContent = `${GRAPH_TYPE_LABELS[graphType] || graphType} グラフ`;
    bodyEl.innerHTML = `
        <div class="graph-dialog-readout" id="ggd-readout"></div>
        <div class="graph-dialog-canvas-wrap"><canvas id="ggd-canvas"></canvas></div>
        <div class="graph-dialog-foot">
            <span class="graph-dialog-hint">グラフ上を横にドラッグ → その範囲だけの傾きを測定${
                series.edgeCut ? '<br>両端の点は加速度の精度が出ないため表示していません' : ''}</span>
            <button class="btn btn-secondary btn-small" id="ggd-clear">選択解除</button>
        </div>
    `;
    const okOriginal = btnOk.textContent;
    btnOk.textContent = '閉じる';
    btnCancel.style.display = 'none';
    // グラフを大きく見せるためダイアログを広げる（cleanupで戻す）
    const dialogEl = overlay.querySelector('.dialog');
    if (dialogEl) dialogEl.classList.add('dialog-wide');
    overlay.style.display = 'flex';

    const cv = document.getElementById('ggd-canvas');
    const readout = document.getElementById('ggd-readout');
    let selRange = null; // 横軸(データ座標)の選択範囲 {a, b}

    const redraw = () => {
        drawOneGraph(cv, graphType, data, kin, unit);
        const tr = cv._transform;
        if (!tr) return;
        const ctx = cv.getContext('2d');
        const toCX = (v) => tr.padL + ((v - tr.minX) / (tr.maxX - tr.minX)) * tr.plotW;
        const toCY = (v) => tr.padT + tr.plotH - ((v - tr.minY) / (tr.maxY - tr.minY)) * tr.plotH;

        // 空欄（加速度の両端）は傾きの計算にも入れない
        const valid = series.xv.map((_, i) => i)
            .filter(i => Number.isFinite(series.xv[i]) && Number.isFinite(series.yv[i]));
        let xs = valid.map(i => series.xv[i]), ys = valid.map(i => series.yv[i]);
        let lo = tr.minX, hi = tr.maxX;
        if (selRange) {
            lo = Math.min(selRange.a, selRange.b);
            hi = Math.max(selRange.a, selRange.b);
            // 選択帯
            ctx.save();
            ctx.fillStyle = 'rgba(11, 107, 203, 0.10)';
            ctx.fillRect(toCX(lo), tr.padT, toCX(hi) - toCX(lo), tr.plotH);
            ctx.strokeStyle = UI_COLORS.accent;
            ctx.lineWidth = 1;
            ctx.setLineDash([4, 3]);
            ctx.beginPath();
            ctx.moveTo(toCX(lo), tr.padT); ctx.lineTo(toCX(lo), tr.padT + tr.plotH);
            ctx.moveTo(toCX(hi), tr.padT); ctx.lineTo(toCX(hi), tr.padT + tr.plotH);
            ctx.stroke();
            ctx.restore();
            const pairs = xs.map((x, i) => [x, ys[i]]).filter(([x]) => x >= lo && x <= hi);
            xs = pairs.map(p => p[0]); ys = pairs.map(p => p[1]);
        }

        const slope = slopeOf(xs, ys);
        if (slope !== null) {
            // 回帰直線（選択範囲＝無選択なら全体＝の上に引く）
            const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
            const my = ys.reduce((a, b) => a + b, 0) / ys.length;
            ctx.save();
            ctx.beginPath();
            ctx.rect(tr.padL, tr.padT, tr.plotW, tr.plotH);
            ctx.clip();
            ctx.strokeStyle = UI_COLORS.accent;
            ctx.lineWidth = 2;
            ctx.setLineDash([7, 4]);
            ctx.beginPath();
            ctx.moveTo(toCX(lo), toCY(my + slope * (lo - mx)));
            ctx.lineTo(toCX(hi), toCY(my + slope * (hi - mx)));
            ctx.stroke();
            ctx.restore();
        }

        const m = slopeMeaning(graphType, unit);
        if (readout) {
            readout.innerHTML = (slope === null)
                ? '選択範囲に点が2つ以上必要です'
                : `傾き <b>${fmtSig3(slope)}</b> ${m.unit}`
                  + (m.meaning ? ` <span class="ggd-meaning">＝ ${m.meaning}</span>` : '')
                  + `<span class="ggd-count">${xs.length}点${selRange ? '・選択範囲' : '・全体'}`
                  + `<br>R² = ${r2Of(xs, ys)}</span>`;
        }
    };

    // 横ドラッグで範囲選択（タッチ・マウス共通。ほぼ動かなければ選択解除）
    const dataXOf = (e) => {
        const tr = cv._transform;
        const rect = cv.getBoundingClientRect();
        const px = (e.clientX - rect.left) * (cv.width / (rect.width || 1));
        return tr.minX + ((px - tr.padL) / tr.plotW) * (tr.maxX - tr.minX);
    };
    let dragging = false, dragStartX = 0;
    cv.style.touchAction = 'none';
    cv.addEventListener('pointerdown', (e) => {
        if (!cv._transform) return;
        dragging = true;
        dragStartX = e.clientX;
        try { cv.setPointerCapture(e.pointerId); } catch (err) { /* 合成イベント等では不可 */ }
        selRange = { a: dataXOf(e), b: dataXOf(e) };
        redraw();
    });
    cv.addEventListener('pointermove', (e) => {
        if (!dragging || !selRange) return;
        selRange.b = dataXOf(e);
        redraw();
    });
    cv.addEventListener('pointerup', (e) => {
        dragging = false;
        if (Math.abs(e.clientX - dragStartX) < 6) { selRange = null; } // タップ＝解除
        redraw();
    });
    document.getElementById('ggd-clear').addEventListener('click', () => { selRange = null; redraw(); });

    const cleanup = () => {
        overlay.style.display = 'none';
        btnOk.textContent = okOriginal;
        btnCancel.style.display = '';
        if (dialogEl) dialogEl.classList.remove('dialog-wide');
        const newOk = btnOk.cloneNode(true);
        btnOk.parentNode.replaceChild(newOk, btnOk);
    };
    btnOk.addEventListener('click', cleanup);

    // ダイアログ表示後にサイズが確定してから描く
    requestAnimationFrame(redraw);
}

// --- 照合コード（提出物の取り違え・使い回しの検出） ---------------------
// 「打った点そのもの」からハッシュを作る。動画が同じでも、タップした座標は
// 人によって必ず違うので、コードが一致する＝同じ打点データを使った、と言える。
// スケールを引き直してもコードは変わらない（校正のやり直しで慌てさせないため）。
// 防止ではなく検出であることに注意: 画像をそのまま転送されれば同じコードが出るので、
// 教員側は「同じコードが2人から出た」ことで気づける。
function trackingSignatureSource() {
    const pts = appState.trackingData
        .filter(p => p.objectId === appState.activeObjectId && inAnalysisRange(p.frame))
        .sort((a, b) => a.frame - b.frame)
        .map(p => `${p.frame}:${p.x.toFixed(1)},${p.y.toFixed(1)}`);
    // 動画のファイル名・サイズも混ぜる（別の動画なら別のコードになる）
    return [`v1`, appState.videoName || '', appState.videoSize || 0, ...pts].join('|');
}

// SHA-256 の先頭40bitを、読み間違えにくい文字だけの8桁に畳む。
// 紛らわしい 0/O/1/I/L は使わない（生徒が目で書き写す前提）。
const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
async function computeVerificationCode() {
    const src = trackingSignatureSource();
    const buf = new TextEncoder().encode(src);
    let hex;
    if (window.crypto && window.crypto.subtle) {
        const digest = await window.crypto.subtle.digest('SHA-256', buf);
        hex = [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
    } else {
        hex = fallbackHashHex(src);   // 古い端末・http接続でも動くように
    }
    let n = BigInt('0x' + hex.slice(0, 12));   // 先頭48bit
    let code = '';
    for (let i = 0; i < 8; i++) {
        code = CODE_ALPHABET[Number(n % 31n)] + code;
        n /= 31n;
    }
    return { code: code.slice(0, 4) + '-' + code.slice(4), hex, points: appState.trackingData.length };
}

// Web Crypto が使えない環境（file:// や古い端末）向けの代替。
// 暗号強度は無いが、偶然の一致を避ける用途には足りる。
function fallbackHashHex(str) {
    let h1 = 0x811c9dc5, h2 = 0x01000193, h3 = 0x9e3779b9, h4 = 0x85ebca6b;
    for (let i = 0; i < str.length; i++) {
        const c = str.charCodeAt(i);
        h1 = Math.imul(h1 ^ c, 16777619) >>> 0;
        h2 = Math.imul(h2 + c, 2246822519) >>> 0;
        h3 = Math.imul(h3 ^ (c + i), 3266489917) >>> 0;
        h4 = Math.imul(h4 + (c * (i + 1)), 668265263) >>> 0;
    }
    return [h1, h2, h3, h4].map(v => v.toString(16).padStart(8, '0')).join('');
}

// --- PNG に文字列メタデータ(tEXt)を差し込む -----------------------------
// PNG は「長さ・型・データ・CRC」のチャンクの並び。IHDR の直後に tEXt を足せば、
// 画像の見た目を変えずに検証用の情報を持たせられる。ExifTool や Python の
// Pillow で読めるので、教員側は一括チェックできる。
const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        t[n] = c >>> 0;
    }
    return t;
})();
function crc32(bytes) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
}
function pngTextChunk(keyword, text) {
    const key = new TextEncoder().encode(keyword);
    const val = new TextEncoder().encode(text);
    const data = new Uint8Array(key.length + 1 + val.length);
    data.set(key, 0); data[key.length] = 0; data.set(val, key.length + 1);
    const type = new TextEncoder().encode('tEXt');
    const out = new Uint8Array(12 + data.length);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, data.length);
    out.set(type, 4);
    out.set(data, 8);
    const crcSrc = new Uint8Array(4 + data.length);
    crcSrc.set(type, 0); crcSrc.set(data, 4);
    dv.setUint32(8 + data.length, crc32(crcSrc));
    return out;
}
async function pngWithMetadata(blob, entries) {
    const src = new Uint8Array(await blob.arrayBuffer());
    // 署名8バイト + IHDR(長さ4+型4+データ13+CRC4 = 25) の直後に差し込む
    const insertAt = 8 + 25;
    if (src.length < insertAt || src[1] !== 0x50 || src[2] !== 0x4E) return blob;
    const chunks = Object.entries(entries).map(([k, v]) => pngTextChunk(k, String(v)));
    const extra = chunks.reduce((n, c) => n + c.length, 0);
    const out = new Uint8Array(src.length + extra);
    out.set(src.subarray(0, insertAt), 0);
    let off = insertAt;
    for (const c of chunks) { out.set(c, off); off += c.length; }
    out.set(src.subarray(insertAt), off);
    return new Blob([out], { type: 'image/png' });
}

// --- エクスポート ---
// 全物体について 位置・速度・加速度 を計算した行列を作る
function buildExportTable() {
    const unit = appState.calibration.scaleRatio ? 'cm' : 'px';
    const header = ['object_id', 'frame', 't (s)',
        `x (${unit})`, `y (${unit})`,
        `vx (${unit}/s)`, `vy (${unit}/s)`, `v (${unit}/s)`,
        `ax (${unit}/s^2)`, `ay (${unit}/s^2)`, `a (${unit}/s^2)`];
    const rows = [];

    const objectIds = [...new Set(appState.trackingData.map(p => p.objectId))].sort((a, b) => a - b);
    objectIds.forEach(oid => {
        const sorted = appState.trackingData
            .filter(p => p.objectId === oid && inAnalysisRange(p.frame))
            .sort((a, b) => a.frame - b.frame);
        const kin = computeKinematics(sorted);
        kin.forEach(k => {
            rows.push([oid, k.frame,
                round(k.t, 4), round(k.x, 3), round(k.y, 3),
                round(k.vx, 3), round(k.vy, 3), round(k.v, 3),
                round(k.ax, 3), round(k.ay, 3), round(k.a, 3)]);
        });
    });
    // 後から見て「どの条件で出力したか」が分かるよう、先頭にメモ行を付ける
    // （旧バージョンで書き出したデータかどうかを見分けられず苦労した反省。StageE参照）。
    const notes = [
        `# ${APP_VERSION} / 速度・加速度: ${appState.rawKinematics
            ? '生データ（スムージングなし・端点も含む）'
            : `速度=計${KINEMATICS_WINDOW_HALF * 2 + 1}点の2次回帰 / 加速度=計${ACCEL_WINDOW_HALF * 2 + 1}点の2次回帰・両端${ACCEL_EDGE_DROP}点は精度が出ないため空欄`}`,
        appState.slowMotionCaptureFps
            ? `# スロー補正: 撮影${appState.slowMotionCaptureFps}fps相当 (${appState.physicsFpsMultiplier.toFixed(3)}倍)`
            : '# スロー補正: なし（通常速度として計算）'
    ];
    return { header, rows, notes };
}

// 空欄（加速度の両端）は空文字にする。0で埋めると表計算で平均に混ざってしまう。
function round(v, d) {
    if (v === null || v === undefined || !isFinite(v)) return '';
    const m = Math.pow(10, d);
    return Math.round(v * m) / m;
}

function tableToTSV(table) {
    const lines = [...(table.notes || []), table.header.join('\t')];
    table.rows.forEach(r => lines.push(r.join('\t')));
    return lines.join('\n') + '\n';
}

function setupExport() {
    const btnExport = document.getElementById('btn-export');
    if (!btnExport) return;

    btnExport.addEventListener('click', () => {
        if (appState.trackingData.length === 0) {
            logDebug("エクスポートするデータがありません。");
            return;
        }
        const table = buildExportTable();
        const tsv = tableToTSV(table);
        const hasXlsx = typeof XLSX !== 'undefined';

        const dialogText = `
            <p style="margin-bottom:6px;">位置に加え、速度・加速度（数値微分）も含みます。</p>
            <textarea style="width:100%; height:120px; font-family:Menlo,Consolas,monospace; background:#F1F3F6; color:#1F2933; border:1px solid #CBD2D9; border-radius:5px; padding:8px; font-size:0.78rem;" readonly>${tsv}</textarea>
            <div style="margin-top:10px; display:flex; gap:8px;">
                <button class="btn btn-secondary" id="btn-copy-tsv" style="flex:1;">TSVをコピー</button>
                <button class="btn btn-secondary" id="btn-download-tsv" style="flex:1;">TSV保存</button>
                <button class="btn btn-primary" id="btn-download-xlsx" style="flex:1;" ${hasXlsx ? '' : 'disabled title="xlsxライブラリ未読込（ネット接続が必要）"'}>xlsx保存</button>
            </div>
        `;

        showInputDialog("データエクスポート", dialogText, "", () => {});

        document.getElementById('btn-copy-tsv').addEventListener('click', () => {
            navigator.clipboard.writeText(tsv)
                .then(() => logDebug("TSVをクリップボードにコピーしました（表計算に貼り付け可）"))
                .catch(() => logDebug("コピー失敗"));
        });

        document.getElementById('btn-download-tsv').addEventListener('click', () => {
            downloadBlob(new Blob([tsv], { type: 'text/tab-separated-values;charset=utf-8;' }), 'tracking_data.tsv');
            logDebug("TSVファイルを保存しました");
        });

        const xlsxBtn = document.getElementById('btn-download-xlsx');
        if (xlsxBtn && hasXlsx) {
            xlsxBtn.addEventListener('click', () => {
                const noteRows = (table.notes || []).map(n => [n]);
                const ws = XLSX.utils.aoa_to_sheet([...noteRows, table.header, ...table.rows]);
                const wb = XLSX.utils.book_new();
                XLSX.utils.book_append_sheet(wb, ws, 'tracking');
                XLSX.writeFile(wb, 'tracking_data.xlsx');
                logDebug("xlsxファイルを保存しました");
            });
        }
    });
}

// --- ストロボ写真 -----------------------------------------------------
// 追跡点周辺の円形パッチ切り貼り方式：基準フレーム（最初の点のコマ）の上に、
// 各確定点の周囲だけをそのコマの映像から切り出して重ねる。明合成と違い
// 背景の明暗に依存せず、明るい教室の映像でも確実に「残像列」になる。
// フレームは1枚ずつシークして合成し、キャッシュしない（iPad Safariの
// canvas総メモリ上限≈384MB対策）。
const STROBE_MAX_DIM = 4096; // iOS Safariのcanvas1辺上限（安全側）

// 「Nコマおき」を打刻順のインデックスではなく、時間的な等間隔で選ぶ。
// +1/+10混在等で打刻自体が不等間隔でも、ストロボ写真は正しく等間隔になる。
// 目標時刻(先頭点の時刻からN/実効fps刻み)に最も近い実打刻点を選び、
// 目標間隔の半分を超えて離れている場合はその回を静かにスキップする
// （無理に遠い点を採用すると「見た目は等間隔だが実は違う」という最悪の結果になるため）。
function strobePoints(everyN) {
    const pts = appState.trackingData
        .filter(p => p.objectId === appState.activeObjectId && inAnalysisRange(p.frame))
        .sort((a, b) => a.frame - b.frame);
    if (pts.length < 2) return pts;

    const effectiveFps = appState.videoFps * (appState.physicsFpsMultiplier || 1);
    const targetDt = everyN / effectiveFps;
    const tol = targetDt / 2;
    const lastT = pts[pts.length - 1].time;

    const out = [];
    let targetT = pts[0].time;
    let guard = 0;
    const guardMax = pts.length * 20 + 100; // 無限ループ対策（通常は到達しない）
    while (targetT <= lastT + tol && guard++ < guardMax) {
        let best = null, bestDiff = Infinity;
        for (const p of pts) {
            const diff = Math.abs(p.time - targetT);
            if (diff < bestDiff) { bestDiff = diff; best = p; }
        }
        if (best && bestDiff <= tol && out[out.length - 1] !== best) out.push(best);
        targetT += targetDt;
    }
    return out;
}

// 投げ上げモードのときだけ、各点が「上昇中(vy>0)」か「下降中(vy<0)」かを返す。
// 色は Okabe-Ito 系で、色覚多様性でも分離する組み合わせ（マゼンタ / 青）。
const STROBE_UP_COLOR = '#D81B8C';    // 上昇中
const STROBE_DOWN_COLOR = '#0072B2';  // 下降中
function strobePhaseInfo(pts) {
    if (appState.motionMode !== 'vertical-throw') return null;
    const data = appState.trackingData
        .filter(p => p.objectId === appState.activeObjectId && inAnalysisRange(p.frame))
        .sort((a, b) => a.frame - b.frame);
    if (data.length < 3) return null;
    const kin = computeKinematics(data);
    const vyByFrame = new Map(kin.map(k => [k.frame, k.vy]));
    const vy = pts.map(p => vyByFrame.has(p.frame) ? vyByFrame.get(p.frame) : 0);
    // 符号が入れ替わる境目＝最高点。境目の手前側の点を印の対象にする
    let apex = -1;
    for (let i = 1; i < vy.length; i++) {
        if (vy[i - 1] > 0 && vy[i] <= 0) { apex = Math.abs(vy[i - 1]) <= Math.abs(vy[i]) ? i - 1 : i; break; }
    }
    return {
        colorAt: (i) => (vy[i] > 0 ? STROBE_UP_COLOR : STROBE_DOWN_COLOR),
        apex, vy
    };
}

// 画像単体で意味が通るように、上昇/下降の凡例を焼き込む
function drawPhaseLegend(ctx, canvas, r) {
    const fs = Math.max(14, Math.round(canvas.width * 0.026));
    const pad = Math.round(fs * 0.6);
    const dot = fs * 0.46;
    ctx.save();
    ctx.font = `bold ${fs}px ${FONT_SANS}`;
    const t1 = '上昇中', t2 = '下降中';
    const w = pad * 2 + dot * 2 + 8 + ctx.measureText(t1).width
            + pad + dot * 2 + 8 + ctx.measureText(t2).width;
    const h = fs + pad * 2;
    const x = pad, y = pad;
    roundRectPath(ctx, x, y, w, h, h / 2);
    ctx.fillStyle = 'rgba(255,255,255,0.92)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(31,41,51,0.3)';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    const cy = y + h / 2;
    let cx = x + pad + dot;
    ctx.beginPath(); ctx.arc(cx, cy, dot, 0, Math.PI * 2);
    ctx.fillStyle = STROBE_UP_COLOR; ctx.fill();
    ctx.fillStyle = '#1F2933';
    ctx.fillText(t1, cx + dot + 8, cy);
    cx += dot + 8 + ctx.measureText(t1).width + pad + dot;
    ctx.beginPath(); ctx.arc(cx, cy, dot * 0.72, 0, Math.PI * 2);
    ctx.lineWidth = dot * 0.56; ctx.strokeStyle = STROBE_DOWN_COLOR; ctx.stroke();
    ctx.fillStyle = '#1F2933';
    ctx.fillText(t2, cx + dot + 8, cy);
    ctx.restore();
}

function drawApexMark(ctx, pts, phase, s, r) {
    if (phase.apex < 0) return;
    const p = pts[phase.apex];
    const x = p.x * s, y = p.y * s;
    const fs = Math.max(13, r * 0.5);
    ctx.save();
    ctx.font = `bold ${fs}px ${FONT_SANS}`;
    ctx.textBaseline = 'middle';
    const label = '最高点';
    const w = ctx.measureText(label).width + fs * 0.8;
    const h = fs * 1.6;
    const bx = x + r + fs * 0.4, by = y - h / 2;
    roundRectPath(ctx, bx, by, w, h, h / 2);
    ctx.fillStyle = 'rgba(31,41,51,0.88)';
    ctx.fill();
    ctx.fillStyle = '#FFFFFF';
    ctx.textAlign = 'center';
    ctx.fillText(label, bx + w / 2, y);
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.lineWidth = Math.max(2, r * 0.06);
    ctx.beginPath();
    ctx.moveTo(x + r * 0.4, y); ctx.lineTo(bx, y);
    ctx.stroke();
    ctx.restore();
}

async function generateStrobe(canvas, everyN, radius, onProgress, mode) {
    const v = appState.videoElement;
    const pts = strobePoints(everyN);
    if (pts.length < 2) return 0;
    mode = mode || 'photo';

    // 動画実解像度で合成（上限超過時のみ縮小）
    const s = Math.min(1, STROBE_MAX_DIM / Math.max(v.videoWidth, v.videoHeight));
    canvas.width = Math.round(v.videoWidth * s);
    canvas.height = Math.round(v.videoHeight * s);
    const ctx = canvas.getContext('2d');

    const returnFrame = appState.currentFrame;
    appState.isScanning = true; // 大量シーク中の本描画をスキップ（高速化）
    try {
        // 基準フレーム＝最初の点のコマを全面に敷く
        await getFrameAt(v, seekTimeOf(pts[0].frame));
        ctx.drawImage(v, 0, 0, canvas.width, canvas.height);

        const phase = strobePhaseInfo(pts);   // 投げ上げのときだけ上昇/下降を返す
        if (mode === 'dots') {
            // 点マーカーモード: 映像は基準フレームのまま、認識した点だけを
            // 物体色の丸で打つ（散布図風。シーク不要なので一瞬で終わる）
            const r = Math.max(4, radius * s * 0.2);
            const ring = Math.max(1.5, r * 0.25);
            if (!phase) {
                const color = COLOR_MAP[(appState.activeObjectId - 1) % COLOR_MAP.length];
                pts.forEach(p => {
                    ctx.beginPath();
                    ctx.arc(p.x * s, p.y * s, r, 0, Math.PI * 2);
                    ctx.fillStyle = color; ctx.fill();
                    ctx.lineWidth = ring; ctx.strokeStyle = '#FFFFFF'; ctx.stroke();
                });
            } else {
                // 投げ上げは同じ高さを上りと下りで2回通る。塗りつぶし同士だと
                // 後から描いた方が完全に隠してしまうので、下降は「中空の輪」にする。
                // 重なった場所では、マゼンタの芯＋青い輪 として両方が読み取れる。
                pts.forEach((p, i) => {
                    if (phase.vy[i] <= 0) return;
                    ctx.beginPath();
                    ctx.arc(p.x * s, p.y * s, r, 0, Math.PI * 2);
                    ctx.fillStyle = STROBE_UP_COLOR; ctx.fill();
                    ctx.lineWidth = ring; ctx.strokeStyle = '#FFFFFF'; ctx.stroke();
                });
                pts.forEach((p, i) => {
                    if (phase.vy[i] > 0) return;
                    const rr = r * 0.98;
                    ctx.beginPath();
                    ctx.arc(p.x * s, p.y * s, rr, 0, Math.PI * 2);
                    ctx.lineWidth = ring * 1.2; ctx.strokeStyle = '#FFFFFF'; ctx.stroke();
                    ctx.beginPath();
                    ctx.arc(p.x * s, p.y * s, rr * 0.72, 0, Math.PI * 2);
                    ctx.lineWidth = rr * 0.56; ctx.strokeStyle = STROBE_DOWN_COLOR; ctx.stroke();
                });
                drawPhaseLegend(ctx, canvas, r);
            }
            if (phase) drawApexMark(ctx, pts, phase, s, r);
            if (onProgress) onProgress(1);
        } else {
            // 写真モード: 2点目以降、そのコマの映像から点の周囲だけを円形に切り貼り
            for (let i = 1; i < pts.length; i++) {
                await getFrameAt(v, seekTimeOf(pts[i].frame));
                ctx.save();
                ctx.beginPath();
                ctx.arc(pts[i].x * s, pts[i].y * s, radius * s, 0, Math.PI * 2);
                ctx.clip();
                ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
                ctx.restore();
                if (onProgress) onProgress((i + 1) / pts.length);
            }
            // 投げ上げのときは、各パッチの縁を上昇/下降で塗り分ける
            // （映像そのものは触らず、輪郭だけで位相を見せる）
            if (phase) {
                // 写真モードは輪郭だけで位相を見せる。上りと下りが重なっても
                // 実線と破線で区別できるようにする。
                const lw = Math.max(2, radius * s * 0.07);
                pts.forEach((p, i) => {
                    const up = phase.vy[i] > 0;
                    ctx.save();
                    ctx.lineWidth = lw;
                    ctx.setLineDash(up ? [] : [lw * 3, lw * 2.2]);
                    ctx.strokeStyle = up ? STROBE_UP_COLOR : STROBE_DOWN_COLOR;
                    ctx.beginPath();
                    ctx.arc(p.x * s, p.y * s, radius * s * (up ? 1 : 0.92), 0, Math.PI * 2);
                    ctx.stroke();
                    ctx.restore();
                });
                drawPhaseLegend(ctx, canvas, radius * s * 0.22);
                drawApexMark(ctx, pts, phase, s, radius * s);
            }
        }
    } finally {
        appState.isScanning = false;
        seekToFrame(returnFrame);
    }
    return pts.length;
}

// --- 提出用レポート画像 --------------------------------------------------
// ストロボ写真＋既定グラフ＋照合コードを A4縦（1:1.414）の1枚にまとめる。
// 動画が縦長なら「左にストロボ・右にグラフ縦積み」、横長なら「上にストロボ・
// 下にグラフを格子」に自動で切り替える（縦長動画で横並びにすると軌道が潰れるため）。
const REPORT_W = 1654;                                   // A4 @ 200dpi 相当
const REPORT_H = Math.round(REPORT_W * Math.SQRT2);      // 2339

async function composeReport(target, strobeCanvas, verify) {
    const pad = 46;
    const headH = 96;
    const footH = 104;
    target.width = REPORT_W;
    target.height = REPORT_H;
    const ctx = target.getContext('2d');
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, REPORT_W, REPORT_H);

    const m = currentMode();
    const unit = appState.calibration.scaleRatio ? 'cm' : 'px';
    const portrait = strobeCanvas.height >= strobeCanvas.width;
    const types = getSelectedGraphTypes().slice(0, 4);

    // ---- 見出し ----
    ctx.fillStyle = UI_COLORS.text;
    ctx.font = `bold 42px ${FONT_SANS}`;
    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'left';
    ctx.fillText(m.label, pad, pad + 44);
    ctx.font = `24px ${FONT_SANS}`;
    ctx.fillStyle = UI_COLORS.textSub;
    ctx.fillText(`${m.axisText}　/　単位 ${unit}`, pad, pad + 80);
    ctx.textAlign = 'right';
    ctx.fillText(reportDateText(), REPORT_W - pad, pad + 44);
    ctx.textAlign = 'left';
    ctx.strokeStyle = UI_COLORS.grid;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(pad, pad + headH); ctx.lineTo(REPORT_W - pad, pad + headH); ctx.stroke();

    const bodyTop = pad + headH + 26;
    const bodyBottom = REPORT_H - pad - footH;
    const bodyH = bodyBottom - bodyTop;
    const bodyW = REPORT_W - pad * 2;

    // ---- ストロボとグラフの領域を決める ----
    let strobeBox, graphBoxes;
    if (portrait) {
        const gw = Math.round(bodyW * 0.36);
        const sw = bodyW - gw - 26;
        strobeBox = { x: pad, y: bodyTop, w: sw, h: bodyH };
        const n = Math.max(1, types.length);
        const gh = Math.floor((bodyH - (n - 1) * 18) / n);
        graphBoxes = types.map((t, i) => ({ x: pad + sw + 26, y: bodyTop + i * (gh + 18), w: gw, h: gh, type: t }));
    } else {
        const sh = Math.round(bodyH * 0.52);
        strobeBox = { x: pad, y: bodyTop, w: bodyW, h: sh };
        const rest = bodyH - sh - 26;
        const cols = types.length >= 3 ? 2 : Math.max(1, types.length);
        const rows = Math.ceil(types.length / cols);
        const gw = Math.floor((bodyW - (cols - 1) * 18) / cols);
        const gh = Math.floor((rest - (rows - 1) * 18) / rows);
        graphBoxes = types.map((t, i) => ({
            x: pad + (i % cols) * (gw + 18),
            y: bodyTop + sh + 26 + Math.floor(i / cols) * (gh + 18),
            w: gw, h: gh, type: t
        }));
    }

    // ---- ストロボを枠に収めて貼る ----
    drawFramedImage(ctx, strobeCanvas, strobeBox);

    // ---- グラフを1枚ずつ、レポート用の解像度で描き直す ----
    const data = appState.trackingData
        .filter(p => p.objectId === appState.activeObjectId && inAnalysisRange(p.frame))
        .sort((a, b) => a.frame - b.frame);
    const kin = data.length ? computeKinematics(data) : [];
    const tmp = document.createElement('canvas');
    GRAPH_SCALE = 2.6;   // レポートは実寸が大きいので、文字も線も太らせる
    for (const b of graphBoxes) {
        tmp.width = b.w; tmp.height = b.h;
        const holder = document.createElement('div');
        Object.defineProperty(tmp, 'parentElement', { value: holder, configurable: true });
        Object.defineProperty(holder, 'clientWidth', { value: b.w, configurable: true });
        Object.defineProperty(holder, 'clientHeight', { value: b.h, configurable: true });
        drawOneGraph(tmp, b.type, data, kin, unit);
        ctx.drawImage(tmp, b.x, b.y);
        ctx.strokeStyle = UI_COLORS.grid;
        ctx.lineWidth = 2;
        ctx.strokeRect(b.x + 1, b.y + 1, b.w - 2, b.h - 2);
        drawSlopeChip(ctx, b, b.type, kin, unit);
    }
    GRAPH_SCALE = 1;

    // ---- 帯: 照合コードと条件 ----
    const fy = bodyBottom + 20;
    ctx.fillStyle = '#F1F3F6';
    roundRectPath(ctx, pad, fy, bodyW, footH - 20, 10);
    ctx.fill();
    ctx.fillStyle = UI_COLORS.textSub;
    ctx.font = `22px ${FONT_SANS}`;
    ctx.fillText('照合コード', pad + 26, fy + 34);
    ctx.fillStyle = UI_COLORS.text;
    ctx.font = `bold 46px ${FONT_MONO}`;
    ctx.fillText(verify.code, pad + 26, fy + 74);
    ctx.textAlign = 'right';
    ctx.font = `22px ${FONT_SANS}`;
    ctx.fillStyle = UI_COLORS.textSub;
    const scaleText = appState.calibration.scaleRatio
        ? `スケール ${appState.calibration.scaleActual} cm`
        : 'スケール未設定（px）';
    ctx.fillText(`打点 ${data.length} 点　/　${scaleText}　/　${appState.videoName || ''}`,
        REPORT_W - pad - 26, fy + 40);
    ctx.fillText(`v${APP_VERSION}`, REPORT_W - pad - 26, fy + 74);
    ctx.textAlign = 'left';
}

// 速度－時刻グラフには、全区間の傾き（＝平均加速度）と R² をその場に印字する。
// 授業の成果は「重力加速度の大きさを求める」ことなので、提出物の中に数値が
// 無いと、生徒が画面から書き写す一手間が増えるし、班ごとの比較もしにくい。
const SLOPE_CHIP_TYPES = { 'vy-t': 'vy', 'vx-t': 'vx', 'v-t': '速さ' };
function drawSlopeChip(ctx, box, type, kin, unit) {
    if (!SLOPE_CHIP_TYPES[type]) return;
    const series = graphSeriesFor(type, kin, unit);
    const idx = series.xv.map((_, i) => i)
        .filter(i => Number.isFinite(series.xv[i]) && Number.isFinite(series.yv[i]));
    if (idx.length < 3) return;
    const xs = idx.map(i => series.xv[i]), ys = idx.map(i => series.yv[i]);
    const slope = slopeOf(xs, ys);
    if (slope === null) return;

    const lines = [`傾き ${fmtSig3(slope)} ${unit}/s²  ＝ 平均加速度`];
    // cm で測っていれば m/s² も添える（板書の g = 9.8 m/s² と直接見比べられる）
    if (unit === 'cm') lines.push(`= ${fmtSig3(slope / 100)} m/s²    R² = ${r2Of(xs, ys)}`);
    else lines.push(`R² = ${r2Of(xs, ys)}`);

    const fs = 20;
    const pad = 10;
    ctx.save();
    ctx.font = `bold ${fs}px ${FONT_SANS}`;
    const w = Math.max(...lines.map(t => ctx.measureText(t).width)) + pad * 2;
    const h = fs * lines.length * 1.35 + pad * 1.6;
    const x = box.x + box.w - w - 10, y = box.y + 10;
    roundRectPath(ctx, x, y, w, h, 8);
    ctx.fillStyle = 'rgba(255,255,255,0.94)';
    ctx.fill();
    ctx.strokeStyle = UI_COLORS.accent;
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    lines.forEach((t, i) => {
        ctx.fillStyle = i === 0 ? UI_COLORS.accentStrong || UI_COLORS.text : UI_COLORS.textSub;
        ctx.font = i === 0 ? `bold ${fs}px ${FONT_SANS}` : `${fs * 0.92}px ${FONT_SANS}`;
        ctx.fillText(t, x + pad, y + pad * 0.8 + i * fs * 1.35);
    });
    ctx.restore();
}

function reportDateText() {
    const d = new Date();
    const p2 = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
}

// 画像を枠の中に、縦横比を保って中央に収める
function drawFramedImage(ctx, img, box) {
    const k = Math.min(box.w / img.width, box.h / img.height);
    const w = img.width * k, h = img.height * k;
    const x = box.x + (box.w - w) / 2, y = box.y + (box.h - h) / 2;
    ctx.drawImage(img, x, y, w, h);
    ctx.strokeStyle = UI_COLORS.grid;
    ctx.lineWidth = 2;
    ctx.strokeRect(x + 1, y + 1, w - 2, h - 2);
}

// 画像の隅に照合コードを焼き込む。スクリーンショットで提出されても、
// 画面に見えている文字列で照合できるようにするため。
function stampVerificationCode(canvas, code) {
    const ctx = canvas.getContext('2d');
    const fs = Math.max(16, Math.round(canvas.width * 0.028));
    const pad = Math.round(fs * 0.5);
    ctx.save();
    ctx.font = `bold ${fs}px ${FONT_MONO}`;
    const text = `照合 ${code}`;
    const w = ctx.measureText(text).width + pad * 2;
    const h = fs + pad * 2;
    const x = canvas.width - w - pad, y = canvas.height - h - pad;
    roundRectPath(ctx, x, y, w, h, pad);
    ctx.fillStyle = 'rgba(255,255,255,0.92)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(31,41,51,0.35)';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fillStyle = '#1F2933';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';
    ctx.fillText(text, x + w / 2, y + h / 2);
    ctx.restore();
}

function setupStrobe() {
    const btn = document.getElementById('btn-strobe');
    if (!btn) return;
    btn.addEventListener('click', () => {
        if (strobePoints(1).length < 2) {
            showInputDialog('ストロボ写真', '<p>この物体の追跡点が2点以上必要です。<br>十字を対象に合わせて「確定」で点を打ってから使ってください。</p>', '', () => {});
            return;
        }
        const body = `
            <div style="display:flex; gap:14px; margin-bottom:6px; font-size:0.85rem; align-items:center; flex-wrap:wrap;">
                <span>表示:</span>
                <label style="display:inline-flex; align-items:center; gap:4px; white-space:nowrap;">
                    <input type="radio" name="strobe-mode" value="photo" checked>写真（残像）
                </label>
                <label style="display:inline-flex; align-items:center; gap:4px; white-space:nowrap;">
                    <input type="radio" name="strobe-mode" value="dots">点マーカー
                </label>
                <label style="display:inline-flex; align-items:center; gap:4px; white-space:nowrap; margin-left:auto;">
                    <input type="checkbox" id="strobe-report" checked>グラフを付けて提出用にする
                </label>
            </div>
            <canvas id="strobe-preview" style="width:100%; border:1px solid #CBD2D9; border-radius:5px; background:#14181D;"></canvas>
            <img id="strobe-final" alt="提出用の画像" hidden
                 style="width:100%; border:1px solid #CBD2D9; border-radius:5px; background:#14181D;">
            <div style="display:flex; gap:14px; margin-top:8px; font-size:0.8rem;">
                <label style="flex:1;">間引き（Nコマおき）: <span id="strobe-n-val">1</span>
                    <input type="range" id="strobe-n" min="1" max="10" value="1" style="width:100%;">
                </label>
                <label style="flex:1;"><span id="strobe-r-label">パッチ半径(px)</span>: <span id="strobe-r-val">60</span>
                    <input type="range" id="strobe-r" min="10" max="200" value="60" style="width:100%;">
                </label>
            </div>
            <div style="margin-top:8px; display:flex; gap:8px; align-items:center;">
                <button class="btn btn-primary" id="btn-strobe-save" style="flex:1;">PNG保存</button>
                <span id="strobe-status" style="font-size:0.75rem; color:#52606D;"></span>
            </div>
            <p style="margin-top:8px; font-size:0.74rem; color:#52606D; line-height:1.55;">
                画像には<b>照合コード</b>（打った点から作られる8桁）が印字され、PNGの中にも記録されます。
                同じ動画でも、タップした位置が違えばコードは必ず変わります。<br>
                <span id="strobe-longpress" hidden>うまく保存できないときは、上の画像を<b>長押し</b>して
                「写真に追加」でも保存できます。</span>
            </p>
        `;
        showInputDialog('提出用の画像を作る', body, '', () => {});

        const cv = document.getElementById('strobe-preview');
        const status = document.getElementById('strobe-status');
        const strobeDisplayMode = () => {
            const el = document.querySelector('input[name="strobe-mode"]:checked');
            return el ? el.value : 'photo';
        };
        // 合成中に設定が変わったら捨てずに覚えておき、終わり次第もう一度生成する
        let busy = false, again = false;
        const regen = async () => {
            if (busy) { again = true; return; }
            busy = true;
            do {
                again = false;
                const n = parseInt(document.getElementById('strobe-n').value);
                const r = parseInt(document.getElementById('strobe-r').value);
                const mode = strobeDisplayMode();
                document.getElementById('strobe-n-val').textContent = n;
                document.getElementById('strobe-r-val').textContent = r;
                const rLabel = document.getElementById('strobe-r-label');
                if (rLabel) rLabel.textContent = mode === 'dots' ? '点の大きさ' : 'パッチ半径(px)';
                if (status) status.textContent = '合成中…';
                const count = await generateStrobe(cv, n, r,
                    (p) => { if (status) status.textContent = `合成中… ${Math.round(p * 100)}%`; }, mode);
                if (status) status.textContent = count
                    ? (mode === 'dots' ? `${count}点を表示` : `${count}コマを合成`)
                    : '点が不足しています';
            } while (again);
            busy = false;
        };
        // --- 提出画像を「押す前に」作っておく -------------------------------
        // iOS Safari は、タップから時間の空いた（await をまたいだ）保存を黙って
        // 無視することがある。合成・ハッシュ・メタデータ埋め込みは重いので、
        // 設定が変わるたびに先に完成PNGまで作っておき、[保存] のタップでは
        // 同期的に共有／ダウンロードを呼ぶだけにする。
        const finalImg = document.getElementById('strobe-final');
        const longPress = document.getElementById('strobe-longpress');
        let prepared = null, preparedURL = null, preparing = null;

        const clearPrepared = () => {
            prepared = null;
            if (preparedURL) { URL.revokeObjectURL(preparedURL); preparedURL = null; }
            if (finalImg) { finalImg.hidden = true; finalImg.removeAttribute('src'); }
            if (longPress) longPress.hidden = true;
            cv.hidden = false;
        };

        // 実際に保存されるものと同じ画像を作る（プレビューにもこれを出す）
        const buildSubmission = async () => {
            const verify = await computeVerificationCode();
            const wantReport = document.getElementById('strobe-report').checked;
            let out = cv;
            if (wantReport) {
                out = document.createElement('canvas');
                await composeReport(out, cv, verify);
            } else {
                // 写真だけのときも、画像の中に照合コードは必ず焼き込む
                stampVerificationCode(cv, verify.code);
            }
            const blob = await new Promise(res => out.toBlob(res, 'image/png'));
            if (!blob) throw new Error('PNGの生成に失敗しました');
            const kind = wantReport ? 'report' : (strobeDisplayMode() === 'dots' ? 'strobe_dots' : 'strobe');
            const tagged = await pngWithMetadata(blob, {
                'tracker-code': verify.code,
                'tracker-hash': verify.hex,
                'tracker-mode': currentMode().label,
                'tracker-points': String(strobePoints(1).length),
                'tracker-video': appState.videoName || '',
                'tracker-version': APP_VERSION,
                'Software': '動画解析トラッカー'
            });
            return { blob: tagged, code: verify.code,
                     filename: `${kind}_${verify.code.replace('-', '')}.png` };
        };

        const prepare = async () => {
            clearPrepared();
            if (!strobePoints(1).length) return;
            if (status) status.textContent = '書き出しの準備中…';
            try {
                const p = await buildSubmission();
                prepared = p;
                // 完成画像を <img> で出す。iOS では長押しで「写真に追加」ができる
                preparedURL = URL.createObjectURL(p.blob);
                if (finalImg) { finalImg.src = preparedURL; finalImg.hidden = false; cv.hidden = true; }
                if (longPress) longPress.hidden = false;
                if (status) status.textContent = `保存できます（照合コード ${p.code}）`;
            } catch (e) {
                if (status) status.textContent = '準備に失敗しました: ' + (e && e.message);
                logDebug('提出画像の準備に失敗: ' + (e && e.message));
            }
        };
        // 設定変更 → ストロボを描き直し → 完成PNGを作り直す、を1本にまとめる
        const refresh = () => { preparing = regen().then(prepare); return preparing; };

        document.getElementById('strobe-n').addEventListener('change', refresh);
        document.getElementById('strobe-r').addEventListener('change', refresh);
        document.getElementById('strobe-report').addEventListener('change', refresh);
        document.querySelectorAll('input[name="strobe-mode"]').forEach(el =>
            el.addEventListener('change', refresh));
        // [保存] のタップは同期で完結させる（iOS Safari の保存はここが命）
        document.getElementById('btn-strobe-save').addEventListener('click', () => {
            if (!prepared) {
                if (status) status.textContent = '準備中です。数秒待ってもう一度押してください。';
                if (!preparing) refresh();
                (preparing || Promise.resolve()).then(() => {
                    if (prepared && status) status.textContent =
                        `準備できました。もう一度［PNG保存］を押してください（照合コード ${prepared.code}）`;
                });
                return;
            }
            deliverSubmission(prepared, status);
            if (prepared) logDebug(`提出用画像を保存: 照合コード ${prepared.code}`);
        });
        refresh();
    });
}

// 提出画像を届ける。共有シート（写真に保存が選べる）が使える端末ではそちらを
// 優先し、使えなければ従来のダウンロードに落とす。iOS ではタップの文脈が切れると
// どちらも黙って無視されるため、この関数は同期的に呼ぶこと（await をまたがない）。
function deliverSubmission(p, status) {
    const done = () => { if (status) status.textContent = `保存しました（照合コード ${p.code}）`; };
    try {
        const file = new File([p.blob], p.filename, { type: 'image/png' });
        if (navigator.canShare && navigator.share && navigator.canShare({ files: [file] })) {
            navigator.share({ files: [file] }).then(done).catch(err => {
                if (err && err.name === 'AbortError') {
                    if (status) status.textContent = '保存をやめました';
                    return;   // 生徒がシートを閉じただけ
                }
                logDebug('共有に失敗したのでダウンロードに切り替え: ' + (err && err.message));
                downloadBlob(p.blob, p.filename);
                done();
            });
            return;
        }
    } catch (e) {
        logDebug('共有を試せませんでした: ' + (e && e.message));
    }
    downloadBlob(p.blob, p.filename);
    done();
}

function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.setAttribute("href", url);
    link.setAttribute("download", filename);
    document.body.appendChild(link);
    link.click();
    // iOS Safari はクリック直後に revoke すると保存が空振りすることがあるので、
    // 少し待ってから片付ける（他のブラウザでも害はない）。
    setTimeout(() => {
        try { document.body.removeChild(link); } catch (e) { /* 既に外れている */ }
        URL.revokeObjectURL(url);
    }, 10000);
}

// --- ダイアログの制御 ---
function showInputDialog(title, bodyText, defaultValue, onOk) {
    const overlay = document.getElementById('dialog-overlay');
    const titleEl = document.getElementById('dialog-title');
    const bodyEl = document.getElementById('dialog-body');
    const btnCancel = document.getElementById('dialog-btn-cancel');
    const btnOk = document.getElementById('dialog-btn-ok');
    
    if (!overlay) return;
    
    titleEl.textContent = title;
    
    if (bodyText.includes("<textarea") || bodyText.includes("<input") || bodyText.includes("<button")) {
        bodyEl.innerHTML = bodyText;
    } else {
        bodyEl.innerHTML = `
            <p>${bodyText}</p>
            <input type="text" id="dialog-input-val" value="${defaultValue}">
        `;
    }
    
    overlay.style.display = 'flex';
    
    const cleanup = () => {
        overlay.style.display = 'none';
        const newOk = btnOk.cloneNode(true);
        const newCancel = btnCancel.cloneNode(true);
        btnOk.parentNode.replaceChild(newOk, btnOk);
        btnCancel.parentNode.replaceChild(newCancel, btnCancel);
    };
    
    document.getElementById('dialog-btn-ok').addEventListener('click', () => {
        const inputEl = document.getElementById('dialog-input-val');
        const val = inputEl ? inputEl.value : "";
        cleanup();
        onOk(val);
    });
    
    document.getElementById('dialog-btn-cancel').addEventListener('click', () => {
        cleanup();
    });
}


// --- Node.js テスト用および統合テスト用エクスポート ---
// 内部状態をテストから差し替えるヘルパ（node・ブラウザ両方で使う）
function test_setVars(vars) {
    if (vars.canvas !== undefined) appState.canvas = vars.canvas;
    if (vars.videoElement !== undefined) appState.videoElement = vars.videoElement;
    if (vars.viewState !== undefined) appState.viewState = vars.viewState;
    if (vars.calibration !== undefined) appState.calibration = vars.calibration;
    if (vars.trackingData !== undefined) appState.trackingData = vars.trackingData;
    if (vars.frameTimes !== undefined) appState.frameTimes = vars.frameTimes;
    if (vars.videoFps !== undefined) appState.videoFps = vars.videoFps;
    if (vars.videoDuration !== undefined) appState.videoDuration = vars.videoDuration;
}

window.canvasToVideo = canvasToVideo;
window.videoToCanvas = videoToCanvas;
window.videoToLocalCanvas = videoToLocalCanvas;
window.getFitMetrics = getFitMetrics;
window.frameTimeOf = frameTimeOf;
window.seekTimeOf = seekTimeOf;
window.loadSampleVideo = loadSampleVideo;
window.loadSampleByUrl = loadSampleByUrl;
window.persistState = persistState;
window.setMotionMode = setMotionMode;
window.openModePanel = openModePanel;
window.closeModePanel = closeModePanel;
window.MOTION_MODES = MOTION_MODES;
window.computeVerificationCode = computeVerificationCode;
window.pngWithMetadata = pngWithMetadata;
window.composeReport = composeReport;
window.strobePhaseInfo = strobePhaseInfo;
window.strobePoints = strobePoints;
window.generateStrobe = generateStrobe;
window.strobePoints = strobePoints;
window.frameIndexOfTime = frameIndexOfTime;
window.displayedFrame = displayedFrame;
window.buildFrameTimeTable = buildFrameTimeTable;
window.seekToFrame = seekToFrame;
window.stepFrame = stepFrame;
window.setPendingCapture = setPendingCapture;
window.confirmAtCrosshair = confirmAtCrosshair;
window.buildDebugReport = buildDebugReport;
window.getCrosshairVideoCoord = getCrosshairVideoCoord;
window.resetZoom = resetZoom;
window.updateGraph = updateGraph;
window.openGraphDialog = openGraphDialog;
window.deletePoint = deletePoint;
window.undo = undo;
window.computeKinematics = computeKinematics;
window.buildExportTable = buildExportTable;
window.startFrameScan = startFrameScan;
window.test_setVars = test_setVars;

if (typeof module !== 'undefined') {
    module.exports = {
        appState,
        canvasToVideo,
        videoToCanvas,
        videoToLocalCanvas,
        getFitMetrics,
        frameTimeOf,
        seekTimeOf,
        buildFrameTimeTable,
        seekToFrame,
        stepFrame,
        sampleColor,
        computeKinematics,
        setMotionMode,
        MOTION_MODES,
        derivExact,
        derivSmoothed,
        strobePoints,
        setSlowMotionCaptureFps,
        buildExportTable,
        tableToTSV,
        test_setVars
    };
}
