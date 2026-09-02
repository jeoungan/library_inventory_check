'use client';

import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { BrowserMultiFormatReader, IScannerControls } from '@zxing/browser';

type ScanItem = { id: string; value: string; format: string; scannedAt: number };
type InventoryList = {
  id: string;
  name: string;
  codes: ScanItem[];
  duplicateCount: number;
  createdAt: number;
  updatedAt: number;
};
type ScannerSettings = {
  sound: boolean;
  vibration: boolean;
  keepAwake: boolean;
  allowDuplicates: boolean;
  formats: string[];
  scanInterval: number;
  manualDelay: number;
};
type InventoryStore = { activeId: string; lists: InventoryList[]; settings: ScannerSettings };
type Toast = { kind: 'success' | 'duplicate' | 'error' | 'info'; message: string };
type Screen = 'categories' | 'detail' | 'scanner' | 'manual' | 'settings';
type Sheet = 'main' | 'sort' | 'category' | 'detail' | 'formats' | null;
type DialogMode = 'create' | 'rename' | null;
type InstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
};
type WakeLockSentinelLike = { release: () => Promise<void> };
type NavigatorWithWakeLock = Navigator & {
  wakeLock?: { request: (type: 'screen') => Promise<WakeLockSentinelLike> };
};

const STORAGE_KEY = 'library-inventory-scanner-v1';
const ALL_FORMATS = [
  ['CODE_128', 'Code 128'],
  ['CODE_39', 'Code 39'],
  ['CODABAR', 'Codabar'],
  ['EAN_13', 'EAN-13 / ISBN'],
  ['EAN_8', 'EAN-8'],
  ['ITF', 'ITF'],
  ['UPC_A', 'UPC-A'],
  ['UPC_E', 'UPC-E'],
  ['QR_CODE', 'QR 코드'],
  ['DATA_MATRIX', 'Data Matrix'],
] as const;
const DEFAULT_SETTINGS: ScannerSettings = {
  sound: true,
  vibration: true,
  keepAwake: true,
  allowDuplicates: false,
  formats: ALL_FORMATS.map(([value]) => value),
  scanInterval: 1,
  manualDelay: 1,
};

function makeId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return 'item-' + Date.now() + '-' + Math.random().toString(36).slice(2);
}

function createInitialStore(): InventoryStore {
  const now = Date.now();
  const names = ['26.8_100번대', '26.8_000번대', '26.8_DVD'];
  const lists = names.map((name, index) => ({
    id: 'starter-category-' + index,
    name,
    codes: [],
    duplicateCount: 0,
    createdAt: now - index,
    updatedAt: now - index,
  }));
  return { activeId: lists[0].id, lists, settings: DEFAULT_SETTINGS };
}

function normalizeStore(value: unknown): InventoryStore {
  const fallback = createInitialStore();
  if (!value || typeof value !== 'object') return fallback;
  const candidate = value as Partial<InventoryStore>;
  if (!Array.isArray(candidate.lists)) return fallback;
  const lists = candidate.lists.filter((list) => list && typeof list.name === 'string').map((list) => ({
    ...list,
    codes: Array.isArray(list.codes) ? list.codes : [],
    duplicateCount: Number(list.duplicateCount) || 0,
    createdAt: Number(list.createdAt) || Date.now(),
    updatedAt: Number(list.updatedAt) || Date.now(),
  }));
  return {
    activeId: lists.some((list) => list.id === candidate.activeId) ? String(candidate.activeId) : (lists[0]?.id ?? ''),
    lists,
    settings: { ...DEFAULT_SETTINGS, ...(candidate.settings ?? {}) },
  };
}

function twoDigits(value: number) {
  return String(value).padStart(2, '0');
}
function formatDate(value: number) {
  const date = new Date(value);
  return twoDigits(date.getFullYear() % 100) + '/' + twoDigits(date.getMonth() + 1) + '/' + twoDigits(date.getDate());
}
function formatDateTime(value: number) {
  const date = new Date(value);
  return formatDate(value) + ' ' + twoDigits(date.getHours()) + ':' + twoDigits(date.getMinutes());
}
function safeFilename(value: string) {
  return value.replace(/[\\/:*?"<>|]/g, '_').trim() || '장서점검';
}

export default function Home() {
  const [store, setStore] = useState<InventoryStore>(createInitialStore);
  const [ready, setReady] = useState(false);
  const [screen, setScreen] = useState<Screen>('categories');
  const [sheet, setSheet] = useState<Sheet>(null);
  const [dialogMode, setDialogMode] = useState<DialogMode>(null);
  const [dialogName, setDialogName] = useState('');
  const [targetListId, setTargetListId] = useState<string | null>(null);
  const [sortMode, setSortMode] = useState<'name' | 'newest' | 'oldest'>('name');
  const [manualCode, setManualCode] = useState('');
  const [manualAdded, setManualAdded] = useState<ScanItem[]>([]);
  const [isScanning, setIsScanning] = useState(false);
  const [isStarting, setIsStarting] = useState(false);
  const [isTorchOn, setIsTorchOn] = useState(false);
  const [torchAvailable, setTorchAvailable] = useState(false);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [currentDeviceId, setCurrentDeviceId] = useState<string>();
  const [toast, setToast] = useState<Toast | null>(null);
  const [installPrompt, setInstallPrompt] = useState<InstallPromptEvent | null>(null);

  const videoRef = useRef<HTMLVideoElement>(null);
  const controlsRef = useRef<IScannerControls | null>(null);
  const readerRef = useRef<BrowserMultiFormatReader | null>(null);
  const wakeLockRef = useRef<WakeLockSentinelLike | null>(null);
  const storeRef = useRef(store);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastDetectedRef = useRef({ value: '', at: 0 });

  const activeList = useMemo(() => store.lists.find((list) => list.id === store.activeId), [store]);
  const targetList = useMemo(() => store.lists.find((list) => list.id === targetListId), [store.lists, targetListId]);
  const sortedLists = useMemo(() => [...store.lists].sort((a, b) => {
    if (sortMode === 'newest') return b.updatedAt - a.updatedAt;
    if (sortMode === 'oldest') return a.updatedAt - b.updatedAt;
    return a.name.localeCompare(b.name, 'ko');
  }), [sortMode, store.lists]);

  const notify = useCallback((nextToast: Toast) => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    setToast(nextToast);
    toastTimerRef.current = setTimeout(() => setToast(null), 2200);
  }, []);
  const commitStore = useCallback((next: InventoryStore) => {
    storeRef.current = next;
    setStore(next);
  }, []);

  useEffect(() => {
    let restoredStore: InventoryStore | null = null;
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) restoredStore = normalizeStore(JSON.parse(saved));
    } catch {
      restoredStore = null;
    }
    const restoreTimer = window.setTimeout(() => {
      if (restoredStore) {
        storeRef.current = restoredStore;
        setStore(restoredStore);
      }
      setReady(true);
    }, 0);
    const handleInstallPrompt = (event: Event) => {
      event.preventDefault();
      setInstallPrompt(event as InstallPromptEvent);
    };
    window.addEventListener('beforeinstallprompt', handleInstallPrompt);
    if ('serviceWorker' in navigator) {
      const manifestLink = document.querySelector<HTMLLinkElement>('link[rel="manifest"]');
      const serviceWorkerUrl = manifestLink
        ? new URL('sw.js', manifestLink.href).href
        : new URL('sw.js', window.location.href).href;
      navigator.serviceWorker.register(serviceWorkerUrl).catch(() => undefined);
    }
    return () => {
      window.clearTimeout(restoreTimer);
      window.removeEventListener('beforeinstallprompt', handleInstallPrompt);
    };
  }, []);

  useEffect(() => {
    if (ready) localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  }, [ready, store]);
  useEffect(() => () => {
    controlsRef.current?.stop();
    wakeLockRef.current?.release().catch(() => undefined);
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
  }, []);

  const playFeedback = useCallback((success: boolean) => {
    const settings = storeRef.current.settings;
    if (settings.vibration && navigator.vibrate) navigator.vibrate(success ? 55 : [35, 45, 35]);
    if (!settings.sound) return;
    try {
      const audioContext = new AudioContext();
      const oscillator = audioContext.createOscillator();
      const gain = audioContext.createGain();
      oscillator.frequency.value = success ? 880 : 260;
      gain.gain.setValueAtTime(0.06, audioContext.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, audioContext.currentTime + 0.1);
      oscillator.connect(gain);
      gain.connect(audioContext.destination);
      oscillator.start();
      oscillator.stop(audioContext.currentTime + 0.1);
    } catch {
      // Audio feedback is optional when blocked by the browser.
    }
  }, []);

  const addCode = useCallback((rawValue: string, format = '수동 입력') => {
    const value = rawValue.trim();
    if (!value) return null;
    const currentStore = storeRef.current;
    const list = currentStore.lists.find((item) => item.id === currentStore.activeId);
    if (!list) {
      notify({ kind: 'error', message: '먼저 카테고리를 만들어주세요.' });
      return null;
    }
    const duplicate = list.codes.some((item) => item.value === value);
    const now = Date.now();
    if (duplicate && !currentStore.settings.allowDuplicates) {
      const nextList = { ...list, duplicateCount: list.duplicateCount + 1, updatedAt: now };
      commitStore({ ...currentStore, lists: currentStore.lists.map((item) => item.id === list.id ? nextList : item) });
      notify({ kind: 'duplicate', message: '이미 등록된 바코드입니다.' });
      playFeedback(false);
      return null;
    }
    const scanItem: ScanItem = { id: makeId(), value, format, scannedAt: now };
    const nextList = {
      ...list,
      codes: [...list.codes, scanItem],
      duplicateCount: list.duplicateCount + (duplicate ? 1 : 0),
      updatedAt: now,
    };
    commitStore({ ...currentStore, lists: currentStore.lists.map((item) => item.id === list.id ? nextList : item) });
    notify({ kind: 'success', message: value + ' 추가됨' });
    playFeedback(true);
    return scanItem;
  }, [commitStore, notify, playFeedback]);

  const handleDetected = useCallback((value: string, format: string) => {
    const settings = storeRef.current.settings;
    if (!settings.formats.includes(format)) return;
    const now = Date.now();
    if (lastDetectedRef.current.value === value && now - lastDetectedRef.current.at < settings.scanInterval * 1000) return;
    lastDetectedRef.current = { value, at: now };
    addCode(value, format);
  }, [addCode]);

  const releaseWakeLock = useCallback(() => {
    wakeLockRef.current?.release().catch(() => undefined);
    wakeLockRef.current = null;
  }, []);
  const stopCamera = useCallback(() => {
    controlsRef.current?.stop();
    controlsRef.current = null;
    if (videoRef.current?.srcObject) {
      (videoRef.current.srcObject as MediaStream).getTracks().forEach((track) => track.stop());
      videoRef.current.srcObject = null;
    }
    releaseWakeLock();
    setIsScanning(false);
    setIsStarting(false);
    setIsTorchOn(false);
    setTorchAvailable(false);
  }, [releaseWakeLock]);

  const startCamera = useCallback(async (deviceId?: string) => {
    if (!navigator.mediaDevices?.getUserMedia) {
      notify({ kind: 'error', message: '카메라는 HTTPS 주소에서 사용할 수 있습니다.' });
      return;
    }
    stopCamera();
    setIsStarting(true);
    try {
      const zxing = await import('@zxing/browser');
      const reader = readerRef.current ?? new zxing.BrowserMultiFormatReader(undefined, {
        delayBetweenScanAttempts: 120,
        delayBetweenScanSuccess: 350,
      });
      readerRef.current = reader;
      if (!videoRef.current) throw new Error('Video element unavailable');
      const constraints: MediaTrackConstraints = deviceId
        ? { deviceId: { exact: deviceId }, width: { ideal: 1920 }, height: { ideal: 1080 } }
        : { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } };
      const controls = await reader.decodeFromConstraints(
        { audio: false, video: constraints },
        videoRef.current,
        (result) => {
          if (!result) return;
          const format = zxing.BarcodeFormat[result.getBarcodeFormat()] ?? 'BARCODE';
          handleDetected(result.getText(), format);
        },
      );
      controlsRef.current = controls;
      setTorchAvailable(Boolean(controls.switchTorch));
      setIsScanning(true);
      setIsStarting(false);
      const foundDevices = await zxing.BrowserCodeReader.listVideoInputDevices();
      setDevices(foundDevices);
      const actualDeviceId = (videoRef.current.srcObject as MediaStream | null)
        ?.getVideoTracks()[0]?.getSettings().deviceId;
      setCurrentDeviceId(actualDeviceId ?? deviceId);
      if (storeRef.current.settings.keepAwake) {
        const wakeLockNavigator = navigator as NavigatorWithWakeLock;
        wakeLockRef.current = await wakeLockNavigator.wakeLock?.request('screen') ?? null;
      }
    } catch (error) {
      stopCamera();
      const name = error instanceof DOMException ? error.name : '';
      const message = name === 'NotAllowedError'
        ? '브라우저 설정에서 카메라 권한을 허용해주세요.'
        : name === 'NotFoundError'
          ? '사용 가능한 카메라를 찾지 못했습니다.'
          : '카메라를 시작하지 못했습니다.';
      notify({ kind: 'error', message });
    }
  }, [handleDetected, notify, stopCamera]);

  useEffect(() => {
    if (screen !== 'scanner') return;
    const timer = window.setTimeout(() => startCamera(), 80);
    return () => {
      window.clearTimeout(timer);
      stopCamera();
    };
  }, [screen, startCamera, stopCamera]);

  useEffect(() => {
    if (screen !== 'manual' || !manualCode.trim() || store.settings.manualDelay <= 0) return;
    const timer = window.setTimeout(() => {
      const added = addCode(manualCode);
      if (added) {
        setManualAdded((items) => [added, ...items]);
        setManualCode('');
      }
    }, store.settings.manualDelay * 1000);
    return () => window.clearTimeout(timer);
  }, [addCode, manualCode, screen, store.settings.manualDelay]);

  const openList = (id: string) => {
    commitStore({ ...store, activeId: id });
    setScreen('detail');
  };
  const openDialog = (mode: Exclude<DialogMode, null>, list?: InventoryList) => {
    setSheet(null);
    setDialogMode(mode);
    setTargetListId(list?.id ?? null);
    setDialogName(list?.name ?? '');
  };
  const openScanner = () => {
    if (!storeRef.current.lists.length) {
      openDialog('create');
      return;
    }
    setSheet(null);
    setScreen('scanner');
  };
  const openManual = () => {
    if (!storeRef.current.lists.length) {
      openDialog('create');
      return;
    }
    setSheet(null);
    setManualAdded([]);
    setManualCode('');
    setScreen('manual');
  };
  const switchCamera = async () => {
    if (devices.length < 2) {
      notify({ kind: 'info', message: '다른 카메라가 없습니다.' });
      return;
    }
    const index = devices.findIndex((device) => device.deviceId === currentDeviceId);
    const next = devices[(index + 1 + devices.length) % devices.length];
    setCurrentDeviceId(next.deviceId);
    await startCamera(next.deviceId);
  };
  const toggleTorch = async () => {
    const switchTorch = controlsRef.current?.switchTorch;
    if (!switchTorch) {
      notify({ kind: 'info', message: '이 기기는 손전등을 지원하지 않습니다.' });
      return;
    }
    try {
      const next = !isTorchOn;
      await switchTorch(next);
      setIsTorchOn(next);
    } catch {
      notify({ kind: 'error', message: '손전등을 켤 수 없습니다.' });
    }
  };

  const submitDialog = (event: FormEvent) => {
    event.preventDefault();
    const name = dialogName.trim();
    if (!name) return;
    const currentStore = storeRef.current;
    if (dialogMode === 'create') {
      const now = Date.now();
      const nextList: InventoryList = {
        id: makeId(),
        name,
        codes: [],
        duplicateCount: 0,
        createdAt: now,
        updatedAt: now,
      };
      commitStore({ ...currentStore, activeId: nextList.id, lists: [...currentStore.lists, nextList] });
      setDialogMode(null);
      setScreen('detail');
      notify({ kind: 'success', message: '카테고리를 만들었습니다.' });
      return;
    }
    if (dialogMode === 'rename' && targetListId) {
      commitStore({
        ...currentStore,
        lists: currentStore.lists.map((list) => list.id === targetListId
          ? { ...list, name, updatedAt: Date.now() }
          : list),
      });
      setDialogMode(null);
      notify({ kind: 'success', message: '이름을 변경했습니다.' });
    }
  };
  const openCategoryMenu = (list: InventoryList) => {
    setTargetListId(list.id);
    setSheet('category');
  };
  const deleteList = (list: InventoryList) => {
    if (!window.confirm('“' + list.name + '” 카테고리를 삭제할까요?')) return;
    const currentStore = storeRef.current;
    const lists = currentStore.lists.filter((item) => item.id !== list.id);
    commitStore({
      ...currentStore,
      activeId: currentStore.activeId === list.id ? (lists[0]?.id ?? '') : currentStore.activeId,
      lists,
    });
    setSheet(null);
    setScreen('categories');
    notify({ kind: 'info', message: '카테고리를 삭제했습니다.' });
  };
  const removeLast = () => {
    const currentStore = storeRef.current;
    const list = currentStore.lists.find((item) => item.id === currentStore.activeId);
    if (!list?.codes.length) return;
    commitStore({
      ...currentStore,
      lists: currentStore.lists.map((item) => item.id === list.id
        ? { ...item, codes: item.codes.slice(0, -1), updatedAt: Date.now() }
        : item),
    });
    setSheet(null);
    notify({ kind: 'info', message: '마지막 항목을 삭제했습니다.' });
  };
  const clearList = () => {
    const currentStore = storeRef.current;
    const list = currentStore.lists.find((item) => item.id === currentStore.activeId);
    if (!list?.codes.length || !window.confirm('이 카테고리의 바코드를 모두 삭제할까요?')) return;
    commitStore({
      ...currentStore,
      lists: currentStore.lists.map((item) => item.id === list.id
        ? { ...item, codes: [], duplicateCount: 0, updatedAt: Date.now() }
        : item),
    });
    setSheet(null);
    notify({ kind: 'info', message: '바코드 목록을 비웠습니다.' });
  };
  const exportList = (list?: InventoryList) => {
    const target = list ?? activeList;
    if (!target) return;
    const text = '\uFEFF' + target.codes.map((item) => item.value).join('\r\n') + (target.codes.length ? '\r\n' : '');
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = safeFilename(target.name) + '_' + new Date().toISOString().slice(0, 10) + '.txt';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setSheet(null);
    notify({ kind: 'success', message: 'TXT 파일을 저장했습니다.' });
  };
  const copyList = async () => {
    if (!activeList) return;
    try {
      await navigator.clipboard.writeText(activeList.codes.map((item) => item.value).join('\n'));
      notify({ kind: 'success', message: '목록을 복사했습니다.' });
    } catch {
      notify({ kind: 'error', message: '복사하지 못했습니다.' });
    }
    setSheet(null);
  };
  const updateSettings = (patch: Partial<ScannerSettings>) => {
    const currentStore = storeRef.current;
    commitStore({ ...currentStore, settings: { ...currentStore.settings, ...patch } });
  };
  const toggleFormat = (value: string) => {
    const formats = storeRef.current.settings.formats;
    if (formats.includes(value) && formats.length === 1) {
      notify({ kind: 'error', message: '지원 형식을 하나 이상 선택해주세요.' });
      return;
    }
    updateSettings({
      formats: formats.includes(value) ? formats.filter((item) => item !== value) : [...formats, value],
    });
  };
  const handleManualSubmit = (event: FormEvent) => {
    event.preventDefault();
    const added = addCode(manualCode);
    if (added) {
      setManualAdded((items) => [added, ...items]);
      setManualCode('');
    }
  };
  const requestInstall = async () => {
    setSheet(null);
    if (!installPrompt) {
      notify({ kind: 'info', message: '브라우저 메뉴에서 “홈 화면에 추가”를 선택하세요.' });
      return;
    }
    await installPrompt.prompt();
    await installPrompt.userChoice;
    setInstallPrompt(null);
  };

  const renderCategories = () => (
    <>
      <header className="main-header">
        <h1>바코드 장서 점검</h1>
        <div className="header-buttons">
          <button className="sort-icon" type="button" onClick={() => setSheet('sort')} aria-label="정렬"><i /><i /><i /></button>
          <button className="more-icon" type="button" onClick={() => setSheet('main')} aria-label="더보기">⋮</button>
        </div>
      </header>
      <section className="category-section">
        <div className="category-title-row">
          <h2>카테고리</h2>
          <span>{sortedLists.length} 개</span>
        </div>
        <div className="category-list">
          {sortedLists.map((list) => (
            <article className="category-card" key={list.id}>
              <button className="category-open" type="button" onClick={() => openList(list.id)}>
                <span className="book-circle" aria-hidden="true"><i /></span>
                <span className="category-copy">
                  <strong>{list.name}</strong>
                  <small>{list.codes.length} 개</small>
                </span>
              </button>
              <button className="card-more" type="button" onClick={() => openCategoryMenu(list)} aria-label={list.name + ' 메뉴'}>⋮</button>
            </article>
          ))}
          {!sortedLists.length && (
            <button className="empty-categories" type="button" onClick={() => openDialog('create')}>
              <span>＋</span><strong>새 카테고리를 만들어주세요</strong>
            </button>
          )}
        </div>
      </section>
      <button className="camera-fab" type="button" onClick={openScanner} aria-label="바코드 스캔 시작">
        <span className="camera-glyph" aria-hidden="true" />
      </button>
    </>
  );

  const renderDetail = () => (
    <>
      <header className="sub-header">
        <button className="back-button" type="button" onClick={() => setScreen('categories')} aria-label="뒤로">←</button>
        <div className="sub-actions">
          <button className="download-icon" type="button" onClick={() => exportList()} aria-label="TXT 저장">⇩</button>
          <button className="more-icon" type="button" onClick={() => setSheet('detail')} aria-label="더보기">⋮</button>
        </div>
      </header>
      <section className="detail-content">
        <h1>{activeList?.name ?? '카테고리'}</h1>
        <p className="detail-date">날짜: {activeList ? formatDate(activeList.createdAt) : '-'}</p>
        <strong className="detail-count">{activeList?.codes.length ?? 0} 개</strong>
        <ol className="detail-list">
          {[...(activeList?.codes ?? [])].reverse().map((item) => (
            <li key={item.id}>
              <strong>{item.value}</strong>
              <small>{formatDateTime(item.scannedAt)}</small>
            </li>
          ))}
        </ol>
        {!activeList?.codes.length && (
          <div className="detail-empty">
            <span className="book-circle"><i /></span>
            <p>저장된 바코드가 없습니다.<br />아래 버튼을 눌러 스캔을 시작하세요.</p>
          </div>
        )}
      </section>
      <button className="scan-pill" type="button" onClick={openScanner}>
        <span className="camera-glyph" aria-hidden="true" />스캔하기
      </button>
    </>
  );

  const renderScanner = () => (
    <section className="scanner-screen">
      <header className="scanner-header">
        <button className="scanner-close" type="button" onClick={() => setScreen('detail')} aria-label="스캔 닫기">×</button>
        <div>
          {devices.length > 1 && (
            <button className="round-camera" type="button" onClick={switchCamera} aria-label="카메라 전환">
              <span className="camera-glyph" />
            </button>
          )}
          <button className="keyboard-icon" type="button" onClick={openManual} aria-label="수동 입력">⌨</button>
          <button className={'flash-icon ' + (isTorchOn ? 'active' : '')} type="button" onClick={toggleTorch} aria-label="손전등">ϟ</button>
        </div>
      </header>
      <div className="scanner-viewport">
        <video ref={videoRef} muted playsInline aria-label="바코드 스캔 카메라" />
        <div className="focus-box" aria-hidden="true"><i /><i /><i /><i /></div>
        <p>바코드를 사각형 안에 비춰주세요.</p>
        {isStarting && <div className="scanner-loading"><span /><b>카메라 준비 중</b></div>}
        {!isStarting && !isScanning && (
          <button className="scanner-retry" type="button" onClick={() => startCamera()}>카메라 다시 시작</button>
        )}
      </div>
      {!torchAvailable && isScanning && <small className="scanner-note">손전등 기능은 지원되는 기기에서만 표시됩니다.</small>}
    </section>
  );

  const renderManual = () => (
    <>
      <header className="manual-header">
        <button className="back-button" type="button" onClick={() => setScreen('detail')} aria-label="뒤로">←</button>
        <h1>{activeList?.name}</h1>
        <button className="manual-camera" type="button" onClick={openScanner} aria-label="카메라 스캔"><span className="camera-glyph" /></button>
      </header>
      <section className="manual-content">
        <form className="manual-input-card" onSubmit={handleManualSubmit}>
          <label htmlFor="barcode-input">바코드</label>
          <input
            id="barcode-input"
            value={manualCode}
            onChange={(event) => setManualCode(event.target.value)}
            inputMode="text"
            autoComplete="off"
            autoFocus
            aria-label="바코드 직접 입력"
          />
        </form>
        <div className="manual-list-card">
          <div className="manual-list-title">
            <h2>새로운 바코드</h2>
            <span>{manualAdded.length} 개</span>
          </div>
          <ol>
            {manualAdded.map((item) => (
              <li key={item.id}><strong>{item.value}</strong><small>{formatDateTime(item.scannedAt)}</small></li>
            ))}
          </ol>
        </div>
      </section>
    </>
  );

  const renderSettings = () => (
    <>
      <header className="settings-header">
        <button className="back-button" type="button" onClick={() => setScreen('categories')} aria-label="뒤로">←</button>
        <h1>설정</h1>
      </header>
      <section className="settings-content">
        <h2>스캔 설정</h2>
        <div className="settings-card">
          <SettingToggle title="알림음 켜기" description="바코드가 추가되면 알림음을 재생합니다." checked={store.settings.sound} onChange={(checked) => updateSettings({ sound: checked })} />
          <SettingToggle title="진동 켜기" description="바코드가 추가되면 진동으로 알려줍니다." checked={store.settings.vibration} onChange={(checked) => updateSettings({ vibration: checked })} />
          <SettingToggle title="화면 항상 켜기" description="바코드 추가 중에는 화면을 항상 켭니다." checked={store.settings.keepAwake} onChange={(checked) => updateSettings({ keepAwake: checked })} />
          <SettingToggle title="바코드 중복 등록 허용" description="한 카테고리 안에 같은 바코드를 추가할 수 있습니다." checked={store.settings.allowDuplicates} onChange={(checked) => updateSettings({ allowDuplicates: checked })} />
          <button className="settings-link" type="button" onClick={() => setSheet('formats')}>
            <span><strong>바코드 지원 형식</strong><small>스캔할 바코드 형식을 선택하세요.</small></span>
            <b>{store.settings.formats.length}개</b>
          </button>
          <label className="range-setting">
            <strong>스캔 주기</strong>
            <small>같은 바코드를 다시 인식할 간격입니다.</small>
            <span>
              <input type="range" min="1" max="5" value={store.settings.scanInterval} onChange={(event) => updateSettings({ scanInterval: Number(event.target.value) })} />
              <b>{store.settings.scanInterval}</b>
            </span>
          </label>
        </div>
        <h2>수동 입력 설정</h2>
        <div className="settings-card">
          <label className="range-setting">
            <strong>자동 저장 시간</strong>
            <small>키보드 입력시 자동 저장합니다. 0은 Enter로만 저장합니다.</small>
            <span>
              <input type="range" min="0" max="5" value={store.settings.manualDelay} onChange={(event) => updateSettings({ manualDelay: Number(event.target.value) })} />
              <b>{store.settings.manualDelay}</b>
            </span>
          </label>
        </div>
      </section>
    </>
  );

  return (
    <main className="phone-app">
      {screen === 'categories' && renderCategories()}
      {screen === 'detail' && renderDetail()}
      {screen === 'scanner' && renderScanner()}
      {screen === 'manual' && renderManual()}
      {screen === 'settings' && renderSettings()}

      {toast && (
        <div className={'toast toast-' + toast.kind} role="status" aria-live="polite">
          <span>{toast.kind === 'success' ? '✓' : toast.kind === 'duplicate' ? '↺' : toast.kind === 'error' ? '!' : 'i'}</span>
          {toast.message}
        </div>
      )}

      {sheet && (
        <div className="sheet-backdrop" role="presentation" onMouseDown={() => setSheet(null)}>
          <section className="bottom-sheet" role="dialog" aria-modal="true" onMouseDown={(event) => event.stopPropagation()}>
            <i className="sheet-handle" />
            {sheet === 'main' && (
              <>
                <h2>메뉴</h2>
                <button type="button" onClick={() => openDialog('create')}>새 카테고리</button>
                <button type="button" onClick={() => { setSheet(null); setScreen('settings'); }}>설정</button>
                <button type="button" onClick={requestInstall}>홈 화면에 추가</button>
              </>
            )}
            {sheet === 'sort' && (
              <>
                <h2>정렬</h2>
                <button className={sortMode === 'name' ? 'selected' : ''} type="button" onClick={() => { setSortMode('name'); setSheet(null); }}>이름 순</button>
                <button className={sortMode === 'newest' ? 'selected' : ''} type="button" onClick={() => { setSortMode('newest'); setSheet(null); }}>최근 날짜 순</button>
                <button className={sortMode === 'oldest' ? 'selected' : ''} type="button" onClick={() => { setSortMode('oldest'); setSheet(null); }}>오래된 날짜 순</button>
              </>
            )}
            {sheet === 'category' && targetList && (
              <>
                <h2>{targetList.name}</h2>
                <button type="button" onClick={() => openList(targetList.id)}>열기</button>
                <button type="button" onClick={() => openDialog('rename', targetList)}>이름 변경</button>
                <button type="button" onClick={() => { commitStore({ ...storeRef.current, activeId: targetList.id }); openManual(); }}>수동 입력</button>
                <button type="button" onClick={() => exportList(targetList)}>TXT로 저장</button>
                <button className="danger" type="button" onClick={() => deleteList(targetList)}>삭제</button>
              </>
            )}
            {sheet === 'detail' && (
              <>
                <h2>{activeList?.name}</h2>
                <button type="button" onClick={openManual}>수동 입력</button>
                <button type="button" onClick={copyList}>전체 복사</button>
                <button type="button" onClick={() => openDialog('rename', activeList)}>이름 변경</button>
                <button type="button" onClick={removeLast} disabled={!activeList?.codes.length}>마지막 항목 삭제</button>
                <button className="danger" type="button" onClick={clearList} disabled={!activeList?.codes.length}>목록 비우기</button>
              </>
            )}
            {sheet === 'formats' && (
              <>
                <h2>바코드 지원 형식</h2>
                <div className="format-options">
                  {ALL_FORMATS.map(([value, label]) => (
                    <label key={value}>
                      <input type="checkbox" checked={store.settings.formats.includes(value)} onChange={() => toggleFormat(value)} />
                      <span>{label}</span>
                    </label>
                  ))}
                </div>
                <button className="sheet-done" type="button" onClick={() => setSheet(null)}>확인</button>
              </>
            )}
            {sheet !== 'formats' && <button className="sheet-cancel" type="button" onClick={() => setSheet(null)}>취소</button>}
          </section>
        </div>
      )}

      {dialogMode && (
        <div className="dialog-backdrop" role="presentation" onMouseDown={() => setDialogMode(null)}>
          <form className="name-dialog" onSubmit={submitDialog} onMouseDown={(event) => event.stopPropagation()}>
            <h2>{dialogMode === 'create' ? '새 카테고리' : '이름 변경'}</h2>
            <input value={dialogName} onChange={(event) => setDialogName(event.target.value)} placeholder="카테고리 이름" autoFocus maxLength={40} />
            <div>
              <button type="button" onClick={() => setDialogMode(null)}>취소</button>
              <button type="submit">저장</button>
            </div>
          </form>
        </div>
      )}
    </main>
  );
}

function SettingToggle({
  title,
  description,
  checked,
  onChange,
}: {
  title: string;
  description: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="setting-toggle">
      <span><strong>{title}</strong><small>{description}</small></span>
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      <i />
    </label>
  );
}
