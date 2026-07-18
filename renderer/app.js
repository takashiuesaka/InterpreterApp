const translatedText = document.getElementById('translatedText');
const inputSttText = document.getElementById('inputSttText');
const inputDevice = document.getElementById('inputDevice');
const targetLanguage = document.getElementById('targetLanguage');
const audioMuteToggleButton = document.getElementById('audioMuteToggleButton');
const settingsButton = document.getElementById('settingsButton');
const startButton = document.getElementById('startButton');
const stopButton = document.getElementById('stopButton');
const saveButton = document.getElementById('saveButton');
const clearButton = document.getElementById('clearButton');
const toggleEventLogButton = document.getElementById('toggleEventLogButton');
const clearEventLogButton = document.getElementById('clearEventLogButton');
const statusBox = document.getElementById('status');
const micLevelBar = document.getElementById('micLevelBar');
const micLevelValue = document.getElementById('micLevelValue');
const eventLog = document.getElementById('eventLog');
const eventLogPanel = document.getElementById('eventLogPanel');
const configModal = document.getElementById('configModal');
const configEndpointInput = document.getElementById('configEndpointInput');
const configDeploymentInput = document.getElementById('configDeploymentInput');
const configTenantInput = document.getElementById('configTenantInput');
const configModalError = document.getElementById('configModalError');
const configSaveButton = document.getElementById('configSaveButton');
const configCancelButton = document.getElementById('configCancelButton');

let unsubscribeDeltaListener = null;
let unsubscribeDoneListener = null;
let unsubscribeErrorListener = null;
let unsubscribeSessionListener = null;
let unsubscribeRealtimeEventListener = null;
let unsubscribeAudioDeltaListener = null;
let unsubscribeInputSttDeltaListener = null;
let unsubscribeInputSttDoneListener = null;

let mediaStream = null;
let audioContext = null;
let sourceNode = null;
let processorNode = null;
let muteGainNode = null;
let running = false;
let playbackCursorTime = 0;
let isTranslatedAudioMuted = false;
let selectedInputDeviceId = 'default';
let isSwitchingInputDevice = false;
let deviceChangeListener = null;
let isEventLogVisible = true;
let persistOutputTimer = null;
let isConfigReady = false;
let isConfigModalRequired = false;
let isSavingConfig = false;
let hasInputSttDeltaSinceLastDone = false;

const TARGET_SAMPLE_RATE = 24000;
const OUTPUT_SAMPLE_RATE = 24000;
const MAX_EVENT_LOG_LINES = 200;
const RUNNING_STATUS_MESSAGE = 'WebSocket Realtime翻訳中... マイク入力を日本語へ変換しています。';
const OUTPUT_PERSIST_DEBOUNCE_MS = 400;

function formatTimestamp(epochMillis) {
  const date = new Date(epochMillis);
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  const ss = String(date.getSeconds()).padStart(2, '0');
  const ms = String(date.getMilliseconds()).padStart(3, '0');
  return `${hh}:${mm}:${ss}.${ms}`;
}

function pushEventLogLine(text, isError) {
  const line = document.createElement('div');
  line.className = isError ? 'event-log-line error' : 'event-log-line';
  line.textContent = text;
  eventLog.appendChild(line);

  while (eventLog.childElementCount > MAX_EVENT_LOG_LINES) {
    eventLog.removeChild(eventLog.firstElementChild);
  }

  eventLog.scrollTop = eventLog.scrollHeight;
}

function clearEventLog() {
  eventLog.textContent = '';
}

function renderConfigModalState() {
  configSaveButton.disabled = isSavingConfig;
  configCancelButton.disabled = isSavingConfig;
}

function setConfigModalError(message) {
  if (!message) {
    configModalError.hidden = true;
    configModalError.textContent = '';
    return;
  }

  configModalError.hidden = false;
  configModalError.textContent = message;
}

function openConfigModal(required) {
  isConfigModalRequired = required;
  configModal.hidden = false;
  setConfigModalError('');
  renderConfigModalState();
}

function closeConfigModal() {
  isConfigModalRequired = false;
  configModal.hidden = true;
  setConfigModalError('');
}

function fillConfigInputs(config) {
  configEndpointInput.value = config?.FOUNDRY_ENDPOINT || '';
  configDeploymentInput.value = config?.FOUNDRY_DEPLOYMENT || '';
  configTenantInput.value = config?.AZURE_TENANT_ID || '';
}

function readConfigFromInputs() {
  return {
    FOUNDRY_ENDPOINT: configEndpointInput.value.trim(),
    FOUNDRY_DEPLOYMENT: configDeploymentInput.value.trim(),
    AZURE_TENANT_ID: configTenantInput.value.trim(),
  };
}

async function loadConfigState() {
  try {
    const result = await window.translatorApi.getAppConfig();
    if (!result?.ok) {
      isConfigReady = false;
      updateButtons(running);
      return { valid: false, reason: result?.error || 'Failed to load configuration.' };
    }

    fillConfigInputs(result.config || {});
    isConfigReady = Boolean(result.valid);
    updateButtons(running);

    return result;
  } catch (error) {
    isConfigReady = false;
    updateButtons(running);
    return {
      valid: false,
      reason: error instanceof Error ? error.message : String(error),
      config: readConfigFromInputs(),
    };
  }
}

async function refreshHealthStatus() {
  try {
    const health = await window.translatorApi.healthCheck();
    if (health.ready) {
      if (!running) {
        setStatus('準備完了。Start でWebSocket Realtime翻訳を開始してください。');
      }
      return true;
    }

    setStatus(`構成または認証エラー: ${health.reason}`, true);
    return false;
  } catch (error) {
    setStatus(`初期化エラー: ${String(error)}`, true);
    pushEventLogLine(`[${formatTimestamp(Date.now())}] init error: ${String(error)}`, true);
    return false;
  }
}

function renderEventLogVisibility() {
  if (isEventLogVisible) {
    eventLogPanel.classList.remove('event-log-collapsed');
    toggleEventLogButton.textContent = 'Hide Event Log';
    return;
  }

  eventLogPanel.classList.add('event-log-collapsed');
  toggleEventLogButton.textContent = 'Show Event Log';
}

function playPcm16AudioBase64(audioBase64) {
  if (!audioContext || !audioBase64) {
    return;
  }

  let binary;
  try {
    binary = atob(audioBase64);
  } catch {
    return;
  }

  const byteLength = binary.length;
  if (byteLength < 2) {
    return;
  }

  const alignedLength = byteLength - (byteLength % 2);
  const int16Length = alignedLength / 2;
  const float32 = new Float32Array(int16Length);

  for (let i = 0; i < int16Length; i += 1) {
    const lo = binary.charCodeAt(i * 2);
    const hi = binary.charCodeAt(i * 2 + 1);
    const value = (hi << 8) | lo;
    const signed = value >= 0x8000 ? value - 0x10000 : value;
    float32[i] = signed / 0x8000;
  }

  const buffer = audioContext.createBuffer(1, int16Length, OUTPUT_SAMPLE_RATE);
  buffer.copyToChannel(float32, 0);

  const source = audioContext.createBufferSource();
  source.buffer = buffer;
  source.connect(audioContext.destination);

  const now = audioContext.currentTime;
  const startTime = Math.max(now, playbackCursorTime);
  source.start(startTime);
  playbackCursorTime = startTime + buffer.duration;
}

function updateMicLevel(levelRatio) {
  const clamped = Math.max(0, Math.min(1, levelRatio));
  const percent = Math.round(clamped * 100);
  micLevelBar.style.width = `${percent}%`;
  micLevelValue.textContent = `${percent}%`;
}

function calculateRmsLevel(float32Samples) {
  if (!float32Samples || float32Samples.length === 0) {
    return 0;
  }

  let sumSquares = 0;
  for (let i = 0; i < float32Samples.length; i += 1) {
    const sample = float32Samples[i];
    sumSquares += sample * sample;
  }

  const rms = Math.sqrt(sumSquares / float32Samples.length);
  return Math.min(1, rms * 6);
}

function setStatus(message, isError) {
  statusBox.textContent = message;
  statusBox.classList.toggle('error', Boolean(isError));
}

function renderAudioMuteToggle() {
  audioMuteToggleButton.classList.toggle('muted', isTranslatedAudioMuted);
  audioMuteToggleButton.setAttribute('aria-pressed', isTranslatedAudioMuted ? 'true' : 'false');
  audioMuteToggleButton.setAttribute(
    'aria-label',
    isTranslatedAudioMuted ? '翻訳音声をミュート解除' : '翻訳音声をミュート',
  );
  audioMuteToggleButton.title = isTranslatedAudioMuted
    ? '翻訳音声: ミュート中'
    : '翻訳音声: 再生中';
}

function appendTranslationDelta(delta) {
  if (!delta) {
    return;
  }

  translatedText.value += delta;
  translatedText.scrollTop = translatedText.scrollHeight;
  schedulePersistedOutputSave();
}

function appendInputSttDelta(delta) {
  if (!delta || !inputSttText) {
    return;
  }

  inputSttText.value += delta;
  inputSttText.scrollTop = inputSttText.scrollHeight;
}

async function persistOutputNow() {
  try {
    await window.translatorApi.savePersistedTranslation(translatedText.value);
  } catch {
    // Keep the translation flow alive even if persistence fails.
  }
}

function schedulePersistedOutputSave() {
  if (persistOutputTimer) {
    clearTimeout(persistOutputTimer);
  }

  persistOutputTimer = setTimeout(() => {
    persistOutputTimer = null;
    persistOutputNow();
  }, OUTPUT_PERSIST_DEBOUNCE_MS);
}

async function flushPersistedOutputSave() {
  if (persistOutputTimer) {
    clearTimeout(persistOutputTimer);
    persistOutputTimer = null;
  }

  await persistOutputNow();
}

function buildSaveFileName() {
  const now = new Date();
  const date = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
  const time = `${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}`;
  return `translation-output-${date}-${time}.txt`;
}

function downsampleFloat32(input, inputSampleRate, outputSampleRate) {
  if (outputSampleRate >= inputSampleRate) {
    return input;
  }

  const sampleRateRatio = inputSampleRate / outputSampleRate;
  const newLength = Math.floor(input.length / sampleRateRatio);
  const result = new Float32Array(newLength);
  let offsetResult = 0;
  let offsetBuffer = 0;

  while (offsetResult < result.length) {
    const nextOffsetBuffer = Math.floor((offsetResult + 1) * sampleRateRatio);
    let accum = 0;
    let count = 0;

    for (let i = offsetBuffer; i < nextOffsetBuffer && i < input.length; i += 1) {
      accum += input[i];
      count += 1;
    }

    result[offsetResult] = count > 0 ? accum / count : 0;
    offsetResult += 1;
    offsetBuffer = nextOffsetBuffer;
  }

  return result;
}

function convertFloat32ToInt16(float32Samples) {
  const int16 = new Int16Array(float32Samples.length);
  for (let i = 0; i < float32Samples.length; i += 1) {
    const s = Math.max(-1, Math.min(1, float32Samples[i]));
    int16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return int16;
}

function int16ToBase64(int16Samples) {
  const bytes = new Uint8Array(int16Samples.buffer);
  let binary = '';
  const chunkSize = 0x8000;

  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode.apply(null, chunk);
  }

  return btoa(binary);
}

function updateButtons(isRunning) {
  startButton.disabled = isRunning || !isConfigReady || isSavingConfig;
  stopButton.disabled = !isRunning;
}

function updateInputDeviceDisabledState() {
  inputDevice.disabled = isSwitchingInputDevice;
}

function buildAudioConstraints(deviceId) {
  const audioConstraints = {
    channelCount: 1,
    echoCancellation: true,
    noiseSuppression: true,
  };

  if (deviceId && deviceId !== 'default') {
    audioConstraints.deviceId = { exact: deviceId };
  }

  return audioConstraints;
}

async function requestAudioStreamWithFallback(preferredDeviceId) {
  const requestedDeviceId = preferredDeviceId || 'default';

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: buildAudioConstraints(requestedDeviceId),
      video: false,
    });
    return { stream, activeDeviceId: requestedDeviceId };
  } catch (error) {
    if (requestedDeviceId !== 'default') {
      pushEventLogLine(
        `[${formatTimestamp(Date.now())}] client: selected input unavailable, fallback to default`,
        false,
      );
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: buildAudioConstraints('default'),
        video: false,
      });
      return { stream, activeDeviceId: 'default' };
    }

    throw error;
  }
}

function getDisplayNameForDevice(device, index) {
  if (device.label) {
    return device.label;
  }

  return `Microphone ${index + 1}`;
}

async function loadInputDevices(options = {}) {
  const { announce = false } = options;
  const previousSelection = selectedInputDeviceId || 'default';

  const devices = await navigator.mediaDevices.enumerateDevices();
  const audioInputs = devices.filter((device) => device.kind === 'audioinput');

  inputDevice.textContent = '';

  const defaultOption = document.createElement('option');
  defaultOption.value = 'default';
  defaultOption.textContent = 'System Default Microphone';
  inputDevice.appendChild(defaultOption);

  audioInputs.forEach((device, index) => {
    const option = document.createElement('option');
    option.value = device.deviceId;
    option.textContent = getDisplayNameForDevice(device, index);
    inputDevice.appendChild(option);
  });

  const availableIds = new Set(['default', ...audioInputs.map((device) => device.deviceId)]);
  const resolvedSelection = availableIds.has(previousSelection) ? previousSelection : 'default';
  const selectionChanged = resolvedSelection !== previousSelection;

  selectedInputDeviceId = resolvedSelection;
  inputDevice.value = resolvedSelection;

  if (announce) {
    pushEventLogLine(
      `[${formatTimestamp(Date.now())}] client: input devices refreshed (${audioInputs.length})`,
      false,
    );
  }

  return { selectionChanged, previousSelection, resolvedSelection };
}

async function setupAudioInputPipeline(preferredDeviceId) {
  const { stream, activeDeviceId } = await requestAudioStreamWithFallback(preferredDeviceId);
  mediaStream = stream;

  audioContext = new AudioContext();
  await audioContext.resume();

  sourceNode = audioContext.createMediaStreamSource(mediaStream);
  processorNode = audioContext.createScriptProcessor(4096, 1, 1);
  muteGainNode = audioContext.createGain();
  muteGainNode.gain.value = 0;

  processorNode.onaudioprocess = (event) => {
    if (!running) {
      return;
    }

    const inputSamples = event.inputBuffer.getChannelData(0);
    const level = calculateRmsLevel(inputSamples);
    updateMicLevel(level);

    const downsampled = downsampleFloat32(inputSamples, audioContext.sampleRate, TARGET_SAMPLE_RATE);
    const int16 = convertFloat32ToInt16(downsampled);
    const audioBase64 = int16ToBase64(int16);
    window.translatorApi.appendAudioChunk(audioBase64);
  };

  sourceNode.connect(processorNode);
  processorNode.connect(muteGainNode);
  muteGainNode.connect(audioContext.destination);
  playbackCursorTime = audioContext.currentTime;

  mediaStream.getAudioTracks().forEach((track) => {
    track.addEventListener('ended', async () => {
      if (!running || isSwitchingInputDevice) {
        return;
      }

      pushEventLogLine(
        `[${formatTimestamp(Date.now())}] client: active input ended, fallback to default`,
        true,
      );

      try {
        await switchActiveInputDevice('default', true);
      } catch {
        // switchActiveInputDevice handles status and stop on failure.
      }
    });
  });

  return { activeDeviceId };
}

async function teardownAudioPipeline() {
  if (processorNode) {
    try {
      processorNode.disconnect();
    } catch {
      // no-op
    }
    processorNode.onaudioprocess = null;
    processorNode = null;
  }

  if (sourceNode) {
    try {
      sourceNode.disconnect();
    } catch {
      // no-op
    }
    sourceNode = null;
  }

  if (muteGainNode) {
    try {
      muteGainNode.disconnect();
    } catch {
      // no-op
    }
    muteGainNode = null;
  }

  if (mediaStream) {
    mediaStream.getTracks().forEach((track) => track.stop());
    mediaStream = null;
  }

  if (audioContext) {
    try {
      await audioContext.close();
    } catch {
      // no-op
    }
    audioContext = null;
  }
}

async function switchActiveInputDevice(nextDeviceId, triggeredByFallback) {
  if (!running || isSwitchingInputDevice) {
    return;
  }

  isSwitchingInputDevice = true;
  updateInputDeviceDisabledState();
  setStatus('入力デバイスを切り替えています...');

  try {
    await teardownAudioPipeline();
    const { activeDeviceId } = await setupAudioInputPipeline(nextDeviceId);

    selectedInputDeviceId = activeDeviceId;
    inputDevice.value = activeDeviceId;

    if (triggeredByFallback || activeDeviceId !== nextDeviceId) {
      pushEventLogLine(
        `[${formatTimestamp(Date.now())}] client: input switched to default`,
        false,
      );
    } else {
      pushEventLogLine(
        `[${formatTimestamp(Date.now())}] client: input switched`,
        false,
      );
    }

    setStatus(RUNNING_STATUS_MESSAGE);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setStatus(`入力デバイス切替エラー: ${message}`, true);
    pushEventLogLine(`[${formatTimestamp(Date.now())}] client error: ${message}`, true);
    await stopRealtimeTranslation();
  } finally {
    isSwitchingInputDevice = false;
    updateInputDeviceDisabledState();
  }
}

async function stopRealtimeTranslation() {
  running = false;
  updateButtons(false);
  isSwitchingInputDevice = false;
  updateInputDeviceDisabledState();
  updateMicLevel(0);
  playbackCursorTime = 0;

  await teardownAudioPipeline();

  try {
    await window.translatorApi.stopRealtimeAudioTranslation();
  } catch {
    // no-op
  }

  await flushPersistedOutputSave();

  if (!statusBox.classList.contains('error')) {
    setStatus('停止しました。Start で再開できます。');
  }

  pushEventLogLine(`[${formatTimestamp(Date.now())}] client: stop requested`, false);
}

async function startRealtimeTranslation() {
  if (running) {
    return;
  }

  if (!isConfigReady) {
    setStatus('構成設定が未完了です。設定を保存してください。', true);
    openConfigModal(true);
    return;
  }

  clearEventLog();
  if (inputSttText) {
    inputSttText.value = '';
  }
  hasInputSttDeltaSinceLastDone = false;
  pushEventLogLine(`[${formatTimestamp(Date.now())}] client: start requested`, false);
  setStatus('Realtime翻訳セッションを開始しています...');

  try {
    const { activeDeviceId } = await setupAudioInputPipeline(selectedInputDeviceId);
    selectedInputDeviceId = activeDeviceId;
    inputDevice.value = activeDeviceId;

    await window.translatorApi.startRealtimeAudioTranslation(targetLanguage.value);

    running = true;

    updateButtons(true);
    updateInputDeviceDisabledState();

    await loadInputDevices();
    inputDevice.value = selectedInputDeviceId;

    setStatus(RUNNING_STATUS_MESSAGE);
    pushEventLogLine(`[${formatTimestamp(Date.now())}] client: audio stream active`, false);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setStatus(`開始エラー: ${message}`, true);
    pushEventLogLine(`[${formatTimestamp(Date.now())}] client error: ${message}`, true);
    await stopRealtimeTranslation();
  }
}

startButton.addEventListener('click', async () => {
  await startRealtimeTranslation();
});

stopButton.addEventListener('click', async () => {
  await stopRealtimeTranslation();
});

clearButton.addEventListener('click', () => {
  translatedText.value = '';
  if (inputSttText) {
    inputSttText.value = '';
  }
  hasInputSttDeltaSinceLastDone = false;
  flushPersistedOutputSave();
});

saveButton.addEventListener('click', async () => {
  const content = translatedText.value;
  if (!content.trim()) {
    setStatus('保存する翻訳結果がありません。');
    return;
  }

  const result = await window.translatorApi.saveTranslationAs(buildSaveFileName(), content);

  if (result?.canceled) {
    return;
  }

  if (result?.ok) {
    setStatus(`保存しました: ${result.filePath}`);
    return;
  }

  setStatus(`保存エラー: ${result?.error || 'Unknown error'}`, true);
});

settingsButton.addEventListener('click', async () => {
  const state = await loadConfigState();
  openConfigModal(!state.valid);
});

configCancelButton.addEventListener('click', () => {
  closeConfigModal();
});

configSaveButton.addEventListener('click', async () => {
  const config = readConfigFromInputs();

  isSavingConfig = true;
  updateButtons(running);
  renderConfigModalState();

  try {
    const result = await window.translatorApi.saveAppConfig(config);
    if (!result?.ok) {
      isConfigReady = false;
      setStatus(`構成保存エラー: ${result?.error || 'Failed to save configuration.'}`, true);
      return;
    }

    isConfigReady = true;
    updateButtons(running);
    setStatus('構成を保存しました。接続確認中です...');
    await refreshHealthStatus();
  } catch (error) {
    isConfigReady = false;
    setStatus(`構成保存エラー: ${error instanceof Error ? error.message : String(error)}`, true);
  } finally {
    closeConfigModal();
    isSavingConfig = false;
    updateButtons(running);
    renderConfigModalState();
  }
});

inputDevice.addEventListener('change', async () => {
  const nextDeviceId = inputDevice.value || 'default';
  selectedInputDeviceId = nextDeviceId;

  pushEventLogLine(
    `[${formatTimestamp(Date.now())}] client: input device selected (${nextDeviceId})`,
    false,
  );

  if (running) {
    await switchActiveInputDevice(nextDeviceId, false);
  }
});

audioMuteToggleButton.addEventListener('click', () => {
  isTranslatedAudioMuted = !isTranslatedAudioMuted;
  renderAudioMuteToggle();
  pushEventLogLine(
    `[${formatTimestamp(Date.now())}] client: translated audio ${isTranslatedAudioMuted ? 'muted' : 'unmuted'}`,
    false,
  );
});

clearEventLogButton.addEventListener('click', () => {
  clearEventLog();
  pushEventLogLine(`[${formatTimestamp(Date.now())}] client: event log cleared`, false);
});

toggleEventLogButton.addEventListener('click', () => {
  isEventLogVisible = !isEventLogVisible;
  renderEventLogVisibility();
});

async function initialize() {
  updateButtons(false);
  updateMicLevel(0);
  updateInputDeviceDisabledState();
  renderConfigModalState();

  try {
    const persisted = await window.translatorApi.loadPersistedTranslation();
    if (persisted?.ok && typeof persisted?.content === 'string' && persisted.content.length > 0) {
      translatedText.value = persisted.content;
    }
  } catch {
    // no-op
  }

  try {
    await loadInputDevices();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    pushEventLogLine(
      `[${formatTimestamp(Date.now())}] init warning: input device list unavailable (${message})`,
      true,
    );
  }

  if (navigator.mediaDevices && typeof navigator.mediaDevices.addEventListener === 'function') {
    deviceChangeListener = async () => {
      try {
        const { selectionChanged } = await loadInputDevices({ announce: true });

        if (selectionChanged && running) {
          await switchActiveInputDevice(selectedInputDeviceId, true);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        pushEventLogLine(
          `[${formatTimestamp(Date.now())}] devicechange warning: ${message}`,
          true,
        );
      }
    };

    navigator.mediaDevices.addEventListener('devicechange', deviceChangeListener);
  }

  unsubscribeDeltaListener = window.translatorApi.onTranslationDelta((payload) => {
    const delta = payload?.delta;
    if (typeof delta !== 'string') {
      return;
    }

    appendTranslationDelta(delta);
    pushEventLogLine(
      `[${formatTimestamp(Date.now())}] ui: translate:delta (${delta.length}) ${delta.slice(0, 80)}`,
      false,
    );
  });

  unsubscribeDoneListener = window.translatorApi.onTranslationDone((payload) => {
    appendTranslationDelta('\n');
    const text = typeof payload?.text === 'string' ? payload.text : '';
    pushEventLogLine(
      `[${formatTimestamp(Date.now())}] ui: translate:done (${text.length}) ${text.slice(0, 80)}`,
      false,
    );
  });

  unsubscribeErrorListener = window.translatorApi.onTranslationError((payload) => {
    const message = payload?.message || 'Unknown realtime translation error.';
    setStatus(`翻訳エラー: ${message}`, true);
    pushEventLogLine(`[${formatTimestamp(Date.now())}] ui error: ${message}`, true);
  });

  unsubscribeSessionListener = window.translatorApi.onSessionState((payload) => {
    pushEventLogLine(
      `[${formatTimestamp(Date.now())}] ui: session state = ${payload?.state || 'unknown'}`,
      false,
    );
    if (payload?.state === 'closed' && running) {
      setStatus('Realtimeセッションが切断されました。再開してください。', true);
      stopRealtimeTranslation();
    }
  });

  unsubscribeRealtimeEventListener = window.translatorApi.onRealtimeEvent((payload) => {
    const eventType = payload?.eventType || 'unknown';
    const message = payload?.message || 'event received';
    const timestamp = typeof payload?.timestamp === 'number' ? payload.timestamp : Date.now();
    const isError = eventType === 'error';
    pushEventLogLine(`[${formatTimestamp(timestamp)}] server: ${eventType} | ${message}`, isError);
  });

  unsubscribeAudioDeltaListener = window.translatorApi.onTranslationAudioDelta((payload) => {
    if (isTranslatedAudioMuted) {
      return;
    }

    const audioBase64 = payload?.audio;
    if (typeof audioBase64 !== 'string' || audioBase64.length === 0) {
      return;
    }

    playPcm16AudioBase64(audioBase64);
  });

  unsubscribeInputSttDeltaListener = window.translatorApi.onInputSttDelta((payload) => {
    const delta = payload?.delta;
    if (typeof delta !== 'string') {
      return;
    }

    appendInputSttDelta(delta);
    hasInputSttDeltaSinceLastDone = true;
    pushEventLogLine(
      `[${formatTimestamp(Date.now())}] ui: input-stt:delta (${delta.length}) ${delta.slice(0, 80)}`,
      false,
    );
  });

  unsubscribeInputSttDoneListener = window.translatorApi.onInputSttDone((payload) => {
    const text = typeof payload?.text === 'string' ? payload.text : '';
    if (!hasInputSttDeltaSinceLastDone && text) {
      appendInputSttDelta(text);
    }
    appendInputSttDelta('\n');
    hasInputSttDeltaSinceLastDone = false;
    pushEventLogLine(
      `[${formatTimestamp(Date.now())}] ui: input-stt:done (${text.length}) ${text.slice(0, 80)}`,
      false,
    );
  });

  try {
    const configState = await loadConfigState();
    if (!configState.valid) {
      const reason = configState.reason || 'Foundry 構成が未設定です。';
      setStatus(`構成設定が必要です: ${reason}`, true);
      openConfigModal(true);
      return;
    }

    const healthy = await refreshHealthStatus();
    if (!healthy) {
      openConfigModal(true);
    }
  } catch {
    setStatus('構成の初期化に失敗しました。', true);
    openConfigModal(true);
  }
}

initialize();
renderAudioMuteToggle();
renderEventLogVisibility();

window.addEventListener('beforeunload', () => {
  flushPersistedOutputSave();
  stopRealtimeTranslation();

  if (typeof unsubscribeDeltaListener === 'function') {
    unsubscribeDeltaListener();
  }

  if (typeof unsubscribeDoneListener === 'function') {
    unsubscribeDoneListener();
  }

  if (typeof unsubscribeErrorListener === 'function') {
    unsubscribeErrorListener();
  }

  if (typeof unsubscribeSessionListener === 'function') {
    unsubscribeSessionListener();
  }

  if (typeof unsubscribeRealtimeEventListener === 'function') {
    unsubscribeRealtimeEventListener();
  }

  if (typeof unsubscribeAudioDeltaListener === 'function') {
    unsubscribeAudioDeltaListener();
  }

  if (typeof unsubscribeInputSttDeltaListener === 'function') {
    unsubscribeInputSttDeltaListener();
  }

  if (typeof unsubscribeInputSttDoneListener === 'function') {
    unsubscribeInputSttDoneListener();
  }

  if (deviceChangeListener && navigator.mediaDevices) {
    navigator.mediaDevices.removeEventListener('devicechange', deviceChangeListener);
    deviceChangeListener = null;
  }
});
