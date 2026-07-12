const translatedText = document.getElementById('translatedText');
const targetLanguage = document.getElementById('targetLanguage');
const startButton = document.getElementById('startButton');
const stopButton = document.getElementById('stopButton');
const clearButton = document.getElementById('clearButton');
const statusBox = document.getElementById('status');

let mediaStream = null;
let peerConnection = null;
let dataChannel = null;
let running = false;
let remoteAudioElement = null;

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

function updateButtons(isRunning) {
  startButton.disabled = isRunning;
  stopButton.disabled = !isRunning;
}

async function stopRealtimeTranslation() {
  running = false;
  updateButtons(false);

  if (dataChannel) {
    try {
      dataChannel.close();
    } catch {
      // no-op
    }
    dataChannel = null;
  }

  if (peerConnection) {
    try {
      peerConnection.close();
    } catch {
      // no-op
    }
    peerConnection = null;
  }

  if (mediaStream) {
    mediaStream.getTracks().forEach((track) => track.stop());
    mediaStream = null;
  }

  if (remoteAudioElement) {
    remoteAudioElement.srcObject = null;
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
    const session = await window.translatorApi.startRealtimeAudioTranslation(targetLanguage.value);

    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
      },
      video: false,
    });

    const { ephemeralKey, callsUrl } = session || {};
    if (!ephemeralKey || !callsUrl) {
      throw new Error('WebRTC session parameters were not returned from main process.');
    }

    peerConnection = new RTCPeerConnection();

    remoteAudioElement = document.createElement('audio');
    remoteAudioElement.autoplay = true;
    remoteAudioElement.style.display = 'none';
    document.body.appendChild(remoteAudioElement);

    peerConnection.ontrack = (event) => {
      if (event.streams.length > 0) {
        remoteAudioElement.srcObject = event.streams[0];
      }
    };

    const audioTrack = mediaStream.getAudioTracks()[0];
    if (!audioTrack) {
      throw new Error('No microphone audio track found.');
    }

    peerConnection.addTrack(audioTrack, mediaStream);
    dataChannel = peerConnection.createDataChannel('realtime-channel');

    dataChannel.addEventListener('message', (event) => {
      let realtimeEvent;
      try {
        realtimeEvent = JSON.parse(event.data);
      } catch {
        return;
      }

      if (realtimeEvent?.type === 'error') {
        const message = realtimeEvent?.error?.message || 'Unknown realtime error.';
        setStatus(`翻訳エラー: ${message}`, true);
        return;
      }

      if (realtimeEvent?.type === 'response.output_text.delta') {
        appendTranslationDelta(realtimeEvent?.delta || '');
        return;
      }

      if (realtimeEvent?.type === 'response.audio_transcript.delta') {
        appendTranslationDelta(realtimeEvent?.delta || '');
        return;
      }

      if (realtimeEvent?.type === 'response.output_text.done') {
        appendTranslationDelta('\n');
      }
    });

    dataChannel.addEventListener('open', () => {
      dataChannel.send(
        JSON.stringify({
          type: 'session.update',
          session: {
            instructions:
              targetLanguage.value === 'ja'
                ? 'Translate user speech from English to Japanese. Output Japanese text only.'
                : `Translate user speech into ${targetLanguage.value}. Output translated text only.`,
            audio: {
              output: {
                language: targetLanguage.value,
              },
            },
          },
        }),
      );
    });

    peerConnection.onconnectionstatechange = () => {
      if (peerConnection && peerConnection.connectionState === 'failed') {
        setStatus('WebRTC接続が失敗しました。再開してください。', true);
      }
    };

    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);

    const sdpResponse = await fetch(callsUrl, {
      method: 'POST',
      body: offer.sdp,
      headers: {
        Authorization: `Bearer ${ephemeralKey}`,
        'Content-Type': 'application/sdp',
      },
    });

    if (!sdpResponse.ok) {
      const responseText = await sdpResponse.text();
      throw new Error(
        `SDP exchange failed (${sdpResponse.status} ${sdpResponse.statusText}): ${responseText.slice(0, 500)}`,
      );
    }

    const answerSdp = await sdpResponse.text();
    await peerConnection.setRemoteDescription({
      type: 'answer',
      sdp: answerSdp,
    });

    running = true;
    updateButtons(true);

    setStatus('WebRTC Realtime翻訳中... マイク入力を日本語へ変換しています。');
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

  try {
    const health = await window.translatorApi.healthCheck();
    if (health.ready) {
      setStatus('準備完了。Start でWebRTC Realtime翻訳を開始してください。');
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
});
