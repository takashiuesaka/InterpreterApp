const translatedText = document.getElementById('translatedText');
const targetLanguage = document.getElementById('targetLanguage');
const startButton = document.getElementById('startButton');
const stopButton = document.getElementById('stopButton');
const clearButton = document.getElementById('clearButton');
const statusBox = document.getElementById('status');
const micLevelBar = document.getElementById('micLevelBar');
const micLevelValue = document.getElementById('micLevelValue');

let unsubscribeDeltaListener = null;
let unsubscribeDoneListener = null;
let unsubscribeErrorListener = null;
let unsubscribeSessionListener = null;

let mediaStream = null;
let audioContext = null;
let sourceNode = null;
let processorNode = null;
let muteGainNode = null;
let running = false;

const TARGET_SAMPLE_RATE = 24000;

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

function appendTranslationDelta(delta) {
  if (!delta) {
    return;
  }

  translatedText.value += delta;
  translatedText.scrollTop = translatedText.scrollHeight;
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
  startButton.disabled = isRunning;
  stopButton.disabled = !isRunning;
}

async function stopRealtimeTranslation() {
  running = false;
  updateButtons(false);
  updateMicLevel(0);

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

  try {
    await window.translatorApi.stopRealtimeAudioTranslation();
  } catch {
    // no-op
  }

  if (!statusBox.classList.contains('error')) {
    setStatus('停止しました。Start で再開できます。');
  }
}

async function startRealtimeTranslation() {
  if (running) {
    return;
  }

  translatedText.value = '';
  setStatus('Realtime翻訳セッションを開始しています...');

  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
      },
      video: false,
    });

    audioContext = new AudioContext();
    await audioContext.resume();

    await window.translatorApi.startRealtimeAudioTranslation(targetLanguage.value);

    sourceNode = audioContext.createMediaStreamSource(mediaStream);
    processorNode = audioContext.createScriptProcessor(4096, 1, 1);
    muteGainNode = audioContext.createGain();
    muteGainNode.gain.value = 0;

    running = true;

    processorNode.onaudioprocess = (event) => {
      if (!running) {
        return;
      }

      const inputSamples = event.inputBuffer.getChannelData(0);
      const level = calculateRmsLevel(inputSamples);
      updateMicLevel(level);

      const downsampled = downsampleFloat32(
        inputSamples,
        audioContext.sampleRate,
        TARGET_SAMPLE_RATE,
      );
      const int16 = convertFloat32ToInt16(downsampled);
      const audioBase64 = int16ToBase64(int16);
      window.translatorApi.appendAudioChunk(audioBase64);
    };

    sourceNode.connect(processorNode);
    processorNode.connect(muteGainNode);
    muteGainNode.connect(audioContext.destination);

    updateButtons(true);

    setStatus('WebSocket Realtime翻訳中... マイク入力を日本語へ変換しています。');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setStatus(`開始エラー: ${message}`, true);
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
});

async function initialize() {
  updateButtons(false);
  updateMicLevel(0);

  unsubscribeDeltaListener = window.translatorApi.onTranslationDelta((payload) => {
    const delta = payload?.delta;
    if (typeof delta !== 'string') {
      return;
    }

    appendTranslationDelta(delta);
  });

  unsubscribeDoneListener = window.translatorApi.onTranslationDone(() => {
    appendTranslationDelta('\n');
  });

  unsubscribeErrorListener = window.translatorApi.onTranslationError((payload) => {
    const message = payload?.message || 'Unknown realtime translation error.';
    setStatus(`翻訳エラー: ${message}`, true);
  });

  unsubscribeSessionListener = window.translatorApi.onSessionState((payload) => {
    if (payload?.state === 'closed' && running) {
      setStatus('Realtimeセッションが切断されました。再開してください。', true);
      stopRealtimeTranslation();
    }
  });

  try {
    const health = await window.translatorApi.healthCheck();
    if (health.ready) {
      setStatus('準備完了。Start でWebSocket Realtime翻訳を開始してください。');
      return;
    }

    setStatus(
      `Foundry設定が不足しています: ${health.reason}\nFOUNDRY_ENDPOINT / FOUNDRY_DEPLOYMENT を設定してください。`,
      true,
    );
  } catch (error) {
    setStatus(`初期化エラー: ${String(error)}`, true);
  }
}

initialize();

window.addEventListener('beforeunload', () => {
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
});
