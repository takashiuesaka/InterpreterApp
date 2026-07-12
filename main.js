const path = require('node:path');
const { app, BrowserWindow, ipcMain } = require('electron');
const { InteractiveBrowserCredential } = require('@azure/identity');
const WebSocket = require('ws');

try {
  require('dotenv').config();
} catch {
  // dotenv is optional at runtime; environment variables can be supplied by shell.
}

const realtimeSessions = new Map();
const FOUNDRY_SCOPE = 'https://cognitiveservices.azure.com/.default';

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

  if (!endpoint || !deployment) {
    throw new Error(
      'Missing Foundry configuration. Set FOUNDRY_ENDPOINT and FOUNDRY_DEPLOYMENT.',
    );
  }

  return {
    endpoint: endpoint.replace(/\/$/, ''),
    deployment,
  };
}

function buildRealtimeTranslationUrl(config) {
  const wsEndpoint = config.endpoint.replace(/^http/i, 'ws');
  return `${wsEndpoint}/openai/v1/realtime/translations?model=${encodeURIComponent(config.deployment)}`;
}

function closeRealtimeSession(webContentsId) {
  const current = realtimeSessions.get(webContentsId);
  if (!current) {
    return;
  }

  try {
    current.ws.close();
  } catch {
    // Ignore close errors during cleanup.
  }

  realtimeSessions.delete(webContentsId);
}

async function startRealtimeSession(webContents, targetLanguage) {
  const webContentsId = webContents.id;
  closeRealtimeSession(webContentsId);

  const config = getFoundryConfig();
  const accessToken = await getAccessToken();
  const realtimeUrl = buildRealtimeTranslationUrl(config);

  return new Promise((resolve, reject) => {
    let setupCompleted = false;

    const ws = new WebSocket(realtimeUrl, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    const setupTimeout = setTimeout(() => {
      if (setupCompleted) {
        return;
      }

      setupCompleted = true;
      ws.close();
      reject(new Error('Timed out waiting for session.updated event.'));
    }, 15000);

    ws.on('open', () => {
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
    });

    ws.on('message', (rawData) => {
      let event;
      try {
        event = JSON.parse(rawData.toString());
      } catch {
        return;
      }

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
          });
          webContents.send('translate:session', { state: 'ready' });
          resolve({ ok: true });
        }
        return;
      }

      if (event?.type === 'response.text.delta') {
        const delta = typeof event?.text === 'string' ? event.text : '';
        if (delta) {
          webContents.send('translate:delta', { delta });
        }
        return;
      }

      if (event?.type === 'response.text.done') {
        webContents.send('translate:done', {
          text: typeof event?.text === 'string' ? event.text : '',
        });
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
      type: 'session.input_audio_buffer.append',
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
