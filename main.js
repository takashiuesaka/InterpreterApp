const path = require('node:path');
const fs = require('node:fs/promises');
const { app, BrowserWindow, dialog, ipcMain } = require('electron');
const { InteractiveBrowserCredential } = require('@azure/identity');
const WebSocket = require('ws');

try {
  require('dotenv').config();
} catch {
  // dotenv is optional at runtime; environment variables can be supplied by shell.
}

const FOUNDRY_SCOPE = 'https://cognitiveservices.azure.com/.default';
const PERSISTED_TRANSLATION_FILENAME = 'translation-output.txt';
const realtimeSessions = new Map();

let cachedToken = null;
let startupAuthError = null;

function createInteractiveCredential() {
  const tenantId = process.env.AZURE_TENANT_ID;
  return new InteractiveBrowserCredential({ tenantId });
}

const credential = createInteractiveCredential();

async function getAccessToken(forceRefresh = false) {
  if (!forceRefresh && cachedToken && cachedToken.expiresOnTimestamp - Date.now() > 60_000) {
    return cachedToken.token;
  }

  const token = await credential.getToken(FOUNDRY_SCOPE);
  if (!token || !token.token) {
    throw new Error('Failed to acquire Entra ID access token.');
  }

  cachedToken = token;
  return token.token;
}

async function authenticateAtStartup() {
  try {
    await getAccessToken(true);
    startupAuthError = null;
  } catch (error) {
    startupAuthError = error;
  }
}

function getFoundryConfig() {
  const endpoint = process.env.FOUNDRY_ENDPOINT;
  const deployment = process.env.FOUNDRY_DEPLOYMENT;
  const realtimeMode = (process.env.FOUNDRY_REALTIME_MODE || 'auto').toLowerCase();
  const realtimeApiVersion = process.env.FOUNDRY_REALTIME_API_VERSION || '2025-04-01-preview';

  if (!endpoint || !deployment) {
    throw new Error(
      'Missing Foundry configuration. Set FOUNDRY_ENDPOINT and FOUNDRY_DEPLOYMENT.',
    );
  }

  return {
    endpoint: endpoint.replace(/\/$/, ''),
    deployment,
    realtimeMode,
    realtimeApiVersion,
  };
}

function buildRealtimeUrlCandidates(config) {
  const wsEndpoint = config.endpoint.replace(/^http/i, 'ws');
  const encodedModel = encodeURIComponent(config.deployment);

  const candidates = [
    {
      label: 'realtime-translations-ga',
      mode: 'ga',
      appendEventType: 'session.input_audio_buffer.append',
      url: `${wsEndpoint}/openai/v1/realtime/translations?model=${encodedModel}`,
    },
    {
      label: 'realtime-ga',
      mode: 'ga',
      appendEventType: 'input_audio_buffer.append',
      url: `${wsEndpoint}/openai/v1/realtime?model=${encodedModel}`,
    },
    {
      label: 'realtime-preview',
      mode: 'preview',
      appendEventType: 'input_audio_buffer.append',
      url: `${wsEndpoint}/openai/realtime?api-version=${encodeURIComponent(config.realtimeApiVersion)}&deployment=${encodedModel}`,
    },
  ];

  if (config.realtimeMode === 'ga') {
    return candidates.filter((candidate) => candidate.mode === 'ga');
  }

  if (config.realtimeMode === 'preview') {
    return candidates.filter((candidate) => candidate.mode === 'preview');
  }

  return candidates;
}

function openWebSocketWithBearer(url, accessToken) {
  return new Promise((resolve, reject) => {
    let settled = false;

    const ws = new WebSocket(url, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    const timer = setTimeout(() => {
      if (settled) {
        return;
      }

      settled = true;
      try {
        ws.close();
      } catch {
        // no-op
      }
      reject(new Error(`WebSocket connect timeout: ${url}`));
    }, 10000);

    const finishSuccess = () => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timer);
      resolve(ws);
    };

    const finishError = (error) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        // no-op
      }
      reject(error);
    };

    ws.once('open', finishSuccess);

    ws.once('unexpected-response', (_request, response) => {
      let body = '';
      response.on('data', (chunk) => {
        body += chunk.toString();
      });
      response.on('end', () => {
        const status = response.statusCode || 'unknown';
        const statusText = response.statusMessage || '';
        const compactBody = body.replace(/\s+/g, ' ').trim().slice(0, 500);
        finishError(
          new Error(`WebSocket handshake failed (${status} ${statusText}) for ${url}. ${compactBody}`),
        );
      });
    });

    ws.once('error', (error) => {
      finishError(new Error(`WebSocket connection error for ${url}: ${error.message}`));
    });
  });
}

async function connectWithFallback(candidates, accessToken) {
  const failures = [];

  for (const candidate of candidates) {
    try {
      const ws = await openWebSocketWithBearer(candidate.url, accessToken);
      return {
        ws,
        label: candidate.label,
        mode: candidate.mode,
        url: candidate.url,
        appendEventType: candidate.appendEventType,
      };
    } catch (error) {
      failures.push(`[${candidate.label}] ${error.message}`);
    }
  }

  throw new Error(`Failed to connect realtime websocket endpoint. ${failures.join(' | ')}`);
}

function closeRealtimeSession(webContentsId) {
  const current = realtimeSessions.get(webContentsId);
  if (!current) {
    return;
  }

  try {
    current.ws.close();
  } catch {
    // no-op
  }

  realtimeSessions.delete(webContentsId);
}

function extractTextFromResponseDone(event) {
  const outputs = event?.response?.output;
  if (!Array.isArray(outputs)) {
    return '';
  }

  return outputs
    .flatMap((output) => output?.content || [])
    .map((content) => {
      if (content?.type === 'text') {
        return content?.text || '';
      }

      if (content?.type === 'audio') {
        return content?.transcript || '';
      }

      return '';
    })
    .join('')
    .trim();
}

function summarizeRealtimeEvent(event) {
  const eventType = event?.type || 'unknown';

  if (eventType === 'error') {
    return event?.error?.message || 'Unknown error';
  }

  if (
    eventType === 'response.output_text.delta' ||
    eventType === 'response.text.delta' ||
    eventType === 'response.audio_transcript.delta' ||
    eventType === 'session.output_text.delta' ||
    eventType === 'session.output_transcript.delta' ||
    eventType === 'session.output_audio_transcript.delta'
  ) {
    const delta =
      typeof event?.delta === 'string'
        ? event.delta
        : typeof event?.text === 'string'
          ? event.text
          : '';
    return `delta(${delta.length}): ${delta.slice(0, 80)}`;
  }

  if (
    eventType === 'response.output_text.done' ||
    eventType === 'response.text.done' ||
    eventType === 'response.done' ||
    eventType === 'session.output_text.done' ||
    eventType === 'session.output_transcript.done' ||
    eventType === 'session.output_audio_transcript.done'
  ) {
    const doneText =
      typeof event?.text === 'string' ? event.text : extractTextFromResponseDone(event);
    return `done(${doneText.length}): ${doneText.slice(0, 80)}`;
  }

  if (eventType === 'session.updated') {
    return 'session updated';
  }

  return 'event received';
}

function getPersistedTranslationPath() {
  return path.join(app.getPath('userData'), PERSISTED_TRANSLATION_FILENAME);
}

async function startRealtimeSession(webContents, targetLanguage) {
  const webContentsId = webContents.id;
  closeRealtimeSession(webContentsId);

  const config = getFoundryConfig();
  const accessToken = await getAccessToken();
  const candidates = buildRealtimeUrlCandidates(config);
  const { ws, mode, label, url, appendEventType } = await connectWithFallback(candidates, accessToken);

  return new Promise((resolve, reject) => {
    let setupCompleted = false;

    const setupTimeout = setTimeout(() => {
      if (setupCompleted) {
        return;
      }

      setupCompleted = true;
      ws.close();
      reject(new Error('Timed out waiting for session.updated event.'));
    }, 15000);

    ws.send(
      JSON.stringify({
        type: 'session.update',
        session: {
          audio: {
            output: {
              language: targetLanguage,
            },
          },
        },
      }),
    );

    ws.on('message', (rawData) => {
      let event;
      try {
        event = JSON.parse(rawData.toString());
      } catch {
        return;
      }

      webContents.send('translate:event', {
        source: 'server',
        eventType: event?.type || 'unknown',
        message: summarizeRealtimeEvent(event),
        timestamp: Date.now(),
      });

      if (event?.type === 'error') {
        const message = event?.error?.message || 'Realtime API error';
        webContents.send('translate:error', { message });

        if (!setupCompleted) {
          setupCompleted = true;
          clearTimeout(setupTimeout);
          reject(new Error(message));
        }
        return;
      }

      if (event?.type === 'session.updated') {
        if (!setupCompleted) {
          setupCompleted = true;
          clearTimeout(setupTimeout);
          realtimeSessions.set(webContentsId, {
            ws,
            targetLanguage,
            mode,
            label,
            url,
            appendEventType,
          });
          webContents.send('translate:session', { state: 'ready', mode, label, url });
          resolve({ ok: true, mode, label, url });
        }
        return;
      }

      const isTextDeltaEvent =
        event?.type === 'response.output_text.delta' ||
        event?.type === 'response.text.delta' ||
        event?.type === 'response.audio_transcript.delta' ||
        event?.type === 'session.output_text.delta' ||
        event?.type === 'session.output_transcript.delta' ||
        event?.type === 'session.output_audio_transcript.delta';

      if (isTextDeltaEvent) {
        const delta =
          typeof event?.delta === 'string'
            ? event.delta
            : typeof event?.text === 'string'
              ? event.text
              : '';
        if (delta) {
          webContents.send('translate:delta', { delta });
        }
        return;
      }

      const isTextDoneEvent =
        event?.type === 'response.output_text.done' ||
        event?.type === 'response.text.done' ||
        event?.type === 'response.done' ||
        event?.type === 'session.output_text.done' ||
        event?.type === 'session.output_audio_transcript.done';

      if (isTextDoneEvent) {
        const doneText =
          typeof event?.text === 'string' ? event.text : extractTextFromResponseDone(event);
        webContents.send('translate:done', { text: doneText });
        return;
      }

      const isAudioDeltaEvent = event?.type === 'session.output_audio.delta';
      if (isAudioDeltaEvent) {
        const audio = typeof event?.delta === 'string' ? event.delta : '';
        if (audio) {
          webContents.send('translate:audio-delta', { audio });
        }
      }
    });

    ws.on('close', () => {
      clearTimeout(setupTimeout);
      const current = realtimeSessions.get(webContentsId);
      if (current && current.ws === ws) {
        realtimeSessions.delete(webContentsId);
      }

      webContents.send('translate:session', { state: 'closed' });

      if (!setupCompleted) {
        setupCompleted = true;
        reject(new Error('Realtime session closed before setup completed.'));
      }
    });

    ws.on('error', (error) => {
      clearTimeout(setupTimeout);
      const message = error instanceof Error ? error.message : String(error);
      webContents.send('translate:error', { message });

      if (!setupCompleted) {
        setupCompleted = true;
        reject(new Error(message));
      }
    });
  });
}

ipcMain.handle('translate:realtime-audio-start', async (event, payload) => {
  const targetLanguage =
    typeof payload?.targetLanguage === 'string' && payload.targetLanguage.trim()
      ? payload.targetLanguage.trim()
      : 'ja';

  return startRealtimeSession(event.sender, targetLanguage);
});

ipcMain.on('translate:audio-append', (event, payload) => {
  const session = realtimeSessions.get(event.sender.id);
  if (!session) {
    event.sender.send('translate:error', {
      message: 'Realtime translation session is not active.',
    });
    return;
  }

  const audioBase64 = payload?.audio;
  if (typeof audioBase64 !== 'string' || audioBase64.length === 0) {
    return;
  }

  session.ws.send(
    JSON.stringify({
      type: session.appendEventType,
      audio: audioBase64,
    }),
  );
});

ipcMain.handle('translate:realtime-audio-stop', async (event) => {
  closeRealtimeSession(event.sender.id);
  return { ok: true };
});

ipcMain.handle('translate:health', async () => {
  try {
    getFoundryConfig();

    if (startupAuthError) {
      await getAccessToken(true);
      startupAuthError = null;
    } else {
      await getAccessToken();
    }

    return { ready: true };
  } catch (error) {
    return { ready: false, reason: error.message };
  }
});

ipcMain.handle('app:load-persisted-translation', async () => {
  try {
    const persistedPath = getPersistedTranslationPath();
    const content = await fs.readFile(persistedPath, 'utf8');
    return { ok: true, content };
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') {
      return { ok: true, content: '' };
    }

    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
});

ipcMain.handle('app:save-persisted-translation', async (_event, payload) => {
  const content = typeof payload?.content === 'string' ? payload.content : '';

  try {
    const persistedPath = getPersistedTranslationPath();
    await fs.mkdir(path.dirname(persistedPath), { recursive: true });
    await fs.writeFile(persistedPath, content, 'utf8');
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
});

ipcMain.handle('app:save-translation-as', async (event, payload) => {
  const content = typeof payload?.content === 'string' ? payload.content : '';
  const defaultFileName =
    typeof payload?.defaultFileName === 'string' && payload.defaultFileName.trim()
      ? payload.defaultFileName.trim()
      : 'translation-output.txt';

  const ownerWindow = BrowserWindow.fromWebContents(event.sender);
  const defaultPath = path.join(app.getPath('documents'), defaultFileName);

  const saveResult = await dialog.showSaveDialog(ownerWindow, {
    title: 'Save Translation Output',
    defaultPath,
    filters: [
      { name: 'Text Files', extensions: ['txt'] },
      { name: 'All Files', extensions: ['*'] },
    ],
  });

  if (saveResult.canceled || !saveResult.filePath) {
    return { canceled: true };
  }

  try {
    await fs.writeFile(saveResult.filePath, content, 'utf8');
    return { ok: true, filePath: saveResult.filePath };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
});

function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

app.whenReady().then(async () => {
  await authenticateAtStartup();
  createWindow();

  app.on('web-contents-created', (_appEvent, contents) => {
    contents.once('destroyed', () => {
      closeRealtimeSession(contents.id);
    });
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
