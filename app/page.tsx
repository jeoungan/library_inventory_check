'use client';

import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { BrowserMultiFormatReader, IScannerControls } from '@zxing/browser';

type ScanItem = {
  id: string;
  value: string;
  format: string;
  scannedAt: number;
};

type InventoryList = {
  id: string;
  name: string;
  codes: ScanItem[];
  duplicateCount: number;
  createdAt: number;
  updatedAt: number;
};

type InventoryStore = {
  activeId: string;
  lists: InventoryList[];
};

type Toast = {
  kind: 'success' | 'duplicate' | 'error' | 'info';
  message: string;
};

type InstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
};

const STORAGE_KEY = 'library-inventory-scanner-v1';
const DEFAULT_LIST_ID = 'august-2026-inventory';

function defaultStore(): InventoryStore {
  const now = Date.now();
  return {
    activeId: DEFAULT_LIST_ID,
    lists: [{
      id: DEFAULT_LIST_ID,
      name: '2026년 8월 장서점검',
      codes: [],
      duplicateCount: 0,
      createdAt: now,
      updatedAt: now,
    }],
  };
}

function makeId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return 'item-' + Date.now() + '-' + Math.random().toString(36).slice(2);
}

function formatTime(value: number) {
  return new Intl.DateTimeFormat('ko-KR', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(value);
}

function safeFilename(value: string) {
  return value.replace(/[\\/:*?"<>|]/g, '_').trim() || '장서점검';
}

export default function Home() {
  const [store, setStore] = useState<InventoryStore>(defaultStore);
  const [ready, setReady] = useState(false);
  const [manualCode, setManualCode] = useState('');
  const [isScanning, setIsScanning] = useState(false);
  const [isStarting, setIsStarting] = useState(false);
  const [isTorchOn, setIsTorchOn] = useState(false);
  const [torchAvailable, setTorchAvailable] = useState(false);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [currentDeviceId, setCurrentDeviceId] = useState<string>();
  const [toast, setToast] = useState<Toast | null>(null);
  const [managerOpen, setManagerOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [newListName, setNewListName] = useState('');
  const [installPrompt, setInstallPrompt] = useState<InstallPromptEvent | null>(null);

  const videoRef = useRef<HTMLVideoElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const controlsRef = useRef<IScannerControls | null>(null);
  const readerRef = useRef<BrowserMultiFormatReader | null>(null);
  const storeRef = useRef(store);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastDetectedRef = useRef({ value: '', at: 0 });

  const activeList = useMemo(
    () => store.lists.find((list) => list.id === store.activeId) ?? store.lists[0],
    [store],
  );

  const notify = useCallback((nextToast: Toast) => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    setToast(nextToast);
    toastTimerRef.current = setTimeout(() => setToast(null), 2400);
  }, []);

  const commitStore = useCallback((next: InventoryStore) => {
    storeRef.current = next;
    setStore(next);
  }, []);

  useEffect(() => {
    let restoredStore: InventoryStore | null = null;
    let restoreFailed = false;
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved) as InventoryStore;
        if (parsed.lists?.length && parsed.lists.some((list) => list.id === parsed.activeId)) {
          restoredStore = parsed;
        }
      }
    } catch {
      restoreFailed = true;
    }

    const restoreTimer = window.setTimeout(() => {
      if (restoredStore) {
        storeRef.current = restoredStore;
        setStore(restoredStore);
      }
      if (restoreFailed) {
        notify({ kind: 'error', message: '이전 저장 내용을 불러오지 못했습니다.' });
      }
      setReady(true);
    }, 0);

    const handleInstallPrompt = (event: Event) => {
      event.preventDefault();
      setInstallPrompt(event as InstallPromptEvent);
    };

    window.addEventListener('beforeinstallprompt', handleInstallPrompt);
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch(() => undefined);
    }

    return () => {
      window.clearTimeout(restoreTimer);
      window.removeEventListener('beforeinstallprompt', handleInstallPrompt);
    };
  }, [notify]);

  useEffect(() => {
    if (!ready) return;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  }, [ready, store]);

  useEffect(() => {
    return () => {
      controlsRef.current?.stop();
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    };
  }, []);

  const playFeedback = useCallback((success: boolean) => {
    if (navigator.vibrate) navigator.vibrate(success ? 55 : [35, 45, 35]);
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
      // Sound feedback is optional when the browser blocks audio.
    }
  }, []);

  const addCode = useCallback((rawValue: string, format = '직접 입력') => {
    const value = rawValue.trim();
    if (!value) {
      notify({ kind: 'error', message: '바코드 번호를 입력해주세요.' });
      return false;
    }

    const currentStore = storeRef.current;
    const currentList = currentStore.lists.find((list) => list.id === currentStore.activeId);
    if (!currentList) return false;

    const isDuplicate = currentList.codes.some((item) => item.value === value);
    const now = Date.now();
    const updatedList: InventoryList = isDuplicate
      ? { ...currentList, duplicateCount: currentList.duplicateCount + 1, updatedAt: now }
      : {
        ...currentList,
        codes: [...currentList.codes, { id: makeId(), value, format, scannedAt: now }],
        updatedAt: now,
      };

    commitStore({
      ...currentStore,
      lists: currentStore.lists.map((list) => list.id === updatedList.id ? updatedList : list),
    });

    if (isDuplicate) {
      notify({ kind: 'duplicate', message: '이미 목록에 있는 바코드입니다.' });
      playFeedback(false);
      return false;
    }

    notify({ kind: 'success', message: value + ' 저장 완료' });
    playFeedback(true);
    return true;
  }, [commitStore, notify, playFeedback]);

  const handleDetected = useCallback((value: string, format: string) => {
    const now = Date.now();
    if (lastDetectedRef.current.value === value && now - lastDetectedRef.current.at < 2200) return;
    lastDetectedRef.current = { value, at: now };
    addCode(value, format);
  }, [addCode]);

  const stopCamera = useCallback(() => {
    controlsRef.current?.stop();
    controlsRef.current = null;
    if (videoRef.current?.srcObject) {
      (videoRef.current.srcObject as MediaStream).getTracks().forEach((track) => track.stop());
      videoRef.current.srcObject = null;
    }
    setIsScanning(false);
    setIsStarting(false);
    setIsTorchOn(false);
    setTorchAvailable(false);
  }, []);

  const startCamera = useCallback(async (deviceId?: string) => {
    if (!navigator.mediaDevices?.getUserMedia) {
      notify({ kind: 'error', message: '카메라는 HTTPS 주소에서만 사용할 수 있습니다.' });
      setHelpOpen(true);
      return;
    }

    stopCamera();
    setIsStarting(true);

    try {
      const zxing = await import('@zxing/browser');
      const reader = readerRef.current ?? new zxing.BrowserMultiFormatReader(undefined, {
        delayBetweenScanAttempts: 120,
        delayBetweenScanSuccess: 500,
      });
      readerRef.current = reader;

      if (!videoRef.current) throw new Error('Video element is unavailable');
      const videoConstraints: MediaTrackConstraints = deviceId
        ? { deviceId: { exact: deviceId }, width: { ideal: 1920 }, height: { ideal: 1080 } }
        : { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } };

      const controls = await reader.decodeFromConstraints(
        { audio: false, video: videoConstraints },
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
    } catch (error) {
      stopCamera();
      const name = error instanceof DOMException ? error.name : '';
      const message = name === 'NotAllowedError'
        ? '카메라 권한이 필요합니다. 브라우저 설정에서 허용해주세요.'
        : name === 'NotFoundError'
          ? '사용 가능한 카메라를 찾지 못했습니다.'
          : '카메라를 시작하지 못했습니다. 다시 시도해주세요.';
      notify({ kind: 'error', message });
    }
  }, [handleDetected, notify, stopCamera]);

  const switchCamera = async () => {
    if (devices.length < 2) {
      notify({ kind: 'info', message: '선택할 수 있는 다른 카메라가 없습니다.' });
      return;
    }
    const index = devices.findIndex((device) => device.deviceId === currentDeviceId);
    const next = devices[(index + 1 + devices.length) % devices.length];
    setCurrentDeviceId(next.deviceId);
    await startCamera(next.deviceId);
  };

  const toggleTorch = async () => {
    const switchTorch = controlsRef.current?.switchTorch;
    if (!switchTorch) return;
    try {
      const next = !isTorchOn;
      await switchTorch(next);
      setIsTorchOn(next);
    } catch {
      notify({ kind: 'error', message: '이 기기에서는 손전등을 켤 수 없습니다.' });
    }
  };

  const handleManualSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (addCode(manualCode)) setManualCode('');
  };

  const handleImage = async (file?: File) => {
    if (!file) return;
    const url = URL.createObjectURL(file);
    try {
      const zxing = await import('@zxing/browser');
      const reader = readerRef.current ?? new zxing.BrowserMultiFormatReader();
      readerRef.current = reader;
      const result = await reader.decodeFromImageUrl(url);
      const format = zxing.BarcodeFormat[result.getBarcodeFormat()] ?? '이미지';
      handleDetected(result.getText(), format);
    } catch {
      notify({ kind: 'error', message: '사진에서 바코드를 찾지 못했습니다.' });
    } finally {
      URL.revokeObjectURL(url);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const removeItem = (id: string) => {
    const currentStore = storeRef.current;
    const list = currentStore.lists.find((item) => item.id === currentStore.activeId);
    if (!list) return;
    commitStore({
      ...currentStore,
      lists: currentStore.lists.map((item) => item.id === list.id
        ? { ...item, codes: item.codes.filter((code) => code.id !== id), updatedAt: Date.now() }
        : item),
    });
    notify({ kind: 'info', message: '항목을 삭제했습니다.' });
  };

  const undoLast = () => {
    if (!activeList?.codes.length) return;
    removeItem(activeList.codes[activeList.codes.length - 1].id);
  };

  const clearActiveList = () => {
    if (!activeList?.codes.length) return;
    if (!window.confirm('현재 목록의 모든 바코드를 삭제할까요? 이 작업은 되돌릴 수 없습니다.')) return;
    const currentStore = storeRef.current;
    commitStore({
      ...currentStore,
      lists: currentStore.lists.map((list) => list.id === currentStore.activeId
        ? { ...list, codes: [], duplicateCount: 0, updatedAt: Date.now() }
        : list),
    });
    notify({ kind: 'info', message: '현재 목록을 비웠습니다.' });
  };

  const createList = (event: FormEvent) => {
    event.preventDefault();
    const name = newListName.trim();
    if (!name) return;
    const now = Date.now();
    const nextList: InventoryList = {
      id: makeId(),
      name,
      codes: [],
      duplicateCount: 0,
      createdAt: now,
      updatedAt: now,
    };
    const currentStore = storeRef.current;
    commitStore({ activeId: nextList.id, lists: [...currentStore.lists, nextList] });
    setNewListName('');
    setManagerOpen(false);
    stopCamera();
    notify({ kind: 'success', message: '새 점검 목록을 만들었습니다.' });
  };

  const selectList = (id: string) => {
    const currentStore = storeRef.current;
    commitStore({ ...currentStore, activeId: id });
    setManagerOpen(false);
    stopCamera();
  };

  const renameList = (list: InventoryList) => {
    const name = window.prompt('목록 이름을 입력하세요.', list.name)?.trim();
    if (!name || name === list.name) return;
    const currentStore = storeRef.current;
    commitStore({
      ...currentStore,
      lists: currentStore.lists.map((item) => item.id === list.id
        ? { ...item, name, updatedAt: Date.now() }
        : item),
    });
  };

  const deleteList = (list: InventoryList) => {
    const currentStore = storeRef.current;
    if (currentStore.lists.length === 1) {
      notify({ kind: 'error', message: '목록은 하나 이상 있어야 합니다.' });
      return;
    }
    if (!window.confirm('“' + list.name + '” 목록을 삭제할까요?')) return;
    const lists = currentStore.lists.filter((item) => item.id !== list.id);
    const activeId = currentStore.activeId === list.id ? lists[0].id : currentStore.activeId;
    commitStore({ activeId, lists });
  };

  const exportText = () => {
    if (!activeList?.codes.length) return;
    const text = '\uFEFF' + activeList.codes.map((item) => item.value).join('\r\n') + '\r\n';
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    const date = new Date().toISOString().slice(0, 10);
    anchor.href = url;
    anchor.download = safeFilename(activeList.name) + '_' + date + '.txt';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    notify({ kind: 'success', message: 'TXT 파일을 저장했습니다.' });
  };

  const copyAll = async () => {
    if (!activeList?.codes.length) return;
    try {
      await navigator.clipboard.writeText(activeList.codes.map((item) => item.value).join('\n'));
      notify({ kind: 'success', message: '전체 목록을 복사했습니다.' });
    } catch {
      notify({ kind: 'error', message: '복사하지 못했습니다. TXT 저장을 이용해주세요.' });
    }
  };

  const requestInstall = async () => {
    if (!installPrompt) {
      setHelpOpen(true);
      return;
    }
    await installPrompt.prompt();
    await installPrompt.userChoice;
    setInstallPrompt(null);
  };

  const newestFirst = activeList ? [...activeList.codes].reverse() : [];

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">▥</span>
          <div>
            <p className="eyebrow">LIBRARY INVENTORY</p>
            <h1>장서점검</h1>
          </div>
        </div>
        <div className="header-actions">
          <button className="quiet-button" type="button" onClick={requestInstall}>홈 화면 설치</button>
          <div className="save-state"><span /> 기기에 자동 저장됨</div>
        </div>
      </header>

      <section className="summary" aria-label="점검 현황">
        <button className="current-list" type="button" onClick={() => setManagerOpen(true)}>
          <span>현재 목록</span>
          <strong>{activeList?.name}</strong>
          <b aria-hidden="true">⌄</b>
        </button>
        <div className="summary-number"><span>스캔</span><strong>{activeList?.codes.length ?? 0}</strong></div>
        <div className="summary-number"><span>중복</span><strong>{activeList?.duplicateCount ?? 0}</strong></div>
      </section>

      <div className="workspace">
        <section className="scanner-card">
          <div className="section-heading">
            <div>
              <p className="step">01 · 바코드 읽기</p>
              <h2>{isScanning ? '바코드를 화면 안에 맞춰주세요' : '카메라로 책 바코드를 읽어보세요'}</h2>
            </div>
            <span className={'camera-pill ' + (isScanning ? 'live' : '')}>
              {isScanning ? '스캔 중' : '대기 중'}
            </span>
          </div>

          <div className={'camera-stage ' + (isScanning ? 'camera-live' : '')}>
            <video ref={videoRef} muted playsInline aria-label="바코드 스캔 카메라 화면" />
            <div className="scan-frame" aria-hidden="true">
              <i /><i /><i /><i />
              {isScanning && <span className="scan-line" />}
            </div>
            {!isScanning && !isStarting && (
              <div className="camera-placeholder">
                <span aria-hidden="true">◎</span>
                <p>카메라를 켜면 이곳에 화면이 표시됩니다</p>
              </div>
            )}
            {isStarting && <div className="camera-placeholder"><span className="loader" /><p>카메라를 준비하고 있습니다</p></div>}
            {isScanning && (
              <div className="camera-tools">
                {torchAvailable && (
                  <button type="button" onClick={toggleTorch} aria-pressed={isTorchOn}>
                    {isTorchOn ? '손전등 끄기' : '손전등'}
                  </button>
                )}
                {devices.length > 1 && <button type="button" onClick={switchCamera}>카메라 전환</button>}
              </div>
            )}
          </div>

          <button
            className={'primary-button ' + (isScanning ? 'stop-button' : '')}
            type="button"
            onClick={isScanning ? stopCamera : () => startCamera()}
            disabled={isStarting}
          >
            <span aria-hidden="true">{isScanning ? '■' : '◎'}</span>
            {isStarting ? '카메라 준비 중…' : isScanning ? '스캔 멈추기' : '카메라로 스캔 시작'}
          </button>

          <div className="secondary-actions">
            <button type="button" onClick={() => fileInputRef.current?.click()}>사진에서 읽기</button>
            <button type="button" onClick={() => setHelpOpen(true)}>사용 안내</button>
            <input
              ref={fileInputRef}
              className="visually-hidden"
              type="file"
              accept="image/*"
              capture="environment"
              onChange={(event) => handleImage(event.target.files?.[0])}
            />
          </div>

          <form className="manual-row" onSubmit={handleManualSubmit}>
            <label htmlFor="manual-code">직접 입력</label>
            <div>
              <input
                id="manual-code"
                value={manualCode}
                onChange={(event) => setManualCode(event.target.value)}
                autoComplete="off"
                inputMode="numeric"
                placeholder="바코드 번호"
              />
              <button type="submit">추가</button>
            </div>
          </form>
        </section>

        <section className="list-card">
          <div className="section-heading list-heading">
            <div>
              <p className="step">02 · 스캔 목록</p>
              <h2>저장할 바코드</h2>
            </div>
            <div className="list-tools">
              <button type="button" onClick={undoLast} disabled={!activeList?.codes.length}>마지막 취소</button>
              <button type="button" onClick={() => setManagerOpen(true)}>목록 관리</button>
            </div>
          </div>

          {newestFirst.length === 0 ? (
            <div className="empty-state">
              <span aria-hidden="true">▤</span>
              <h3>아직 읽은 바코드가 없어요</h3>
              <p>스캔한 순서대로 여기에 쌓입니다.<br />같은 바코드는 한 번만 저장됩니다.</p>
            </div>
          ) : (
            <ol className="barcode-list" aria-label="스캔한 바코드 목록">
              {newestFirst.map((item) => {
                const originalIndex = activeList.codes.findIndex((code) => code.id === item.id) + 1;
                return (
                  <li key={item.id}>
                    <span className="scan-index">{String(originalIndex).padStart(3, '0')}</span>
                    <div>
                      <strong>{item.value}</strong>
                      <small>{item.format} · {formatTime(item.scannedAt)}</small>
                    </div>
                    <button type="button" onClick={() => removeItem(item.id)} aria-label={item.value + ' 삭제'}>×</button>
                  </li>
                );
              })}
            </ol>
          )}

          <div className="export-bar">
            <div><span>내보낼 항목</span><strong>{activeList?.codes.length ?? 0}개</strong></div>
            <div className="export-actions">
              <button className="copy-button" type="button" onClick={copyAll} disabled={!activeList?.codes.length}>전체 복사</button>
              <button type="button" onClick={exportText} disabled={!activeList?.codes.length}>TXT로 저장</button>
            </div>
          </div>
        </section>
      </div>

      <footer>
        <span>카메라 영상과 바코드 목록은 서버로 전송되지 않습니다.</span>
        <button type="button" onClick={clearActiveList} disabled={!activeList?.codes.length}>현재 목록 비우기</button>
      </footer>

      {toast && (
        <div className={'toast toast-' + toast.kind} role="status" aria-live="polite">
          <span aria-hidden="true">{toast.kind === 'success' ? '✓' : toast.kind === 'duplicate' ? '↺' : toast.kind === 'error' ? '!' : 'i'}</span>
          {toast.message}
        </div>
      )}

      {managerOpen && (
        <div className="modal-backdrop" role="presentation" onMouseDown={() => setManagerOpen(false)}>
          <section className="modal" role="dialog" aria-modal="true" aria-labelledby="list-manager-title" onMouseDown={(event) => event.stopPropagation()}>
            <div className="modal-header">
              <div><p className="step">점검 단위 나누기</p><h2 id="list-manager-title">목록 관리</h2></div>
              <button type="button" onClick={() => setManagerOpen(false)} aria-label="닫기">×</button>
            </div>
            <form className="new-list-form" onSubmit={createList}>
              <input value={newListName} onChange={(event) => setNewListName(event.target.value)} placeholder="새 목록 이름" maxLength={40} />
              <button type="submit">새로 만들기</button>
            </form>
            <div className="managed-lists">
              {store.lists.map((list) => (
                <article className={list.id === store.activeId ? 'active' : ''} key={list.id}>
                  <button className="list-select" type="button" onClick={() => selectList(list.id)}>
                    <span>{list.id === store.activeId ? '✓' : ''}</span>
                    <div><strong>{list.name}</strong><small>{list.codes.length}개 · 중복 {list.duplicateCount}회</small></div>
                  </button>
                  <button type="button" onClick={() => renameList(list)}>이름 변경</button>
                  <button className="danger-link" type="button" onClick={() => deleteList(list)}>삭제</button>
                </article>
              ))}
            </div>
          </section>
        </div>
      )}

      {helpOpen && (
        <div className="modal-backdrop" role="presentation" onMouseDown={() => setHelpOpen(false)}>
          <section className="modal help-modal" role="dialog" aria-modal="true" aria-labelledby="help-title" onMouseDown={(event) => event.stopPropagation()}>
            <div className="modal-header">
              <div><p className="step">처음 사용하시나요?</p><h2 id="help-title">사용 안내</h2></div>
              <button type="button" onClick={() => setHelpOpen(false)} aria-label="닫기">×</button>
            </div>
            <ol className="help-steps">
              <li><span>1</span><div><strong>카메라 권한 허용</strong><p>‘스캔 시작’을 누르고 브라우저의 카메라 요청을 허용하세요.</p></div></li>
              <li><span>2</span><div><strong>바코드를 가로로 맞추기</strong><p>흔들리지 않게 10~20cm 거리를 두면 더 빠르게 읽힙니다.</p></div></li>
              <li><span>3</span><div><strong>TXT로 바로 저장</strong><p>스캔을 마치면 목록 아래의 버튼을 눌러 한 줄에 한 번호씩 저장하세요.</p></div></li>
            </ol>
            <div className="install-note">
              <strong>iPhone 홈 화면에 설치</strong>
              <p>Safari의 공유 버튼을 누른 뒤 ‘홈 화면에 추가’를 선택하세요. Android는 브라우저 메뉴의 ‘앱 설치’를 이용할 수 있습니다.</p>
            </div>
            <button className="modal-primary" type="button" onClick={() => setHelpOpen(false)}>확인</button>
          </section>
        </div>
      )}
    </main>
  );
}
