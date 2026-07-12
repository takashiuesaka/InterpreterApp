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

function buildRealtimeTranslateUrlCandidates(config) {
  const wsEndpoint = config.endpoint.replace(/^http/i, 'ws');
  const deployment = encodeURIComponent(config.deployment);

  const ga = {
    mode: 'ga',
    url: `${wsEndpoint}/openai/v1/realtime/translations?model=${deployment}`,
  };

  const preview = {
    mode: 'preview',
    url: `${wsEndpoint}/openai/realtime/translations?api-version=${encodeURIComponent(config.realtimeApiVersion)}&deployment=${deployment}`,
  };

  if (config.realtimeMode === 'ga') {
    return [ga];
  }

  if (config.realtimeMode === 'preview') {
    return [preview];
  }

  return [ga, preview];
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
          new Error(
            `WebSocket handshake failed (${status} ${statusText}) for ${url}. ${compactBody}`,
          ),
        );
      });
    });

    ws.once('error', (error) => {
      finishError(new Error(`WebSocket connection error for ${url}: ${error.message}`));
    });
  });
}

async function connectWithFallback(urlCandidates, accessToken) {
  const failures = [];

  for (const candidate of urlCandidates) {
    try {
      const ws = await openWebSocketWithBearer(candidate.url, accessToken);
      return {
        ws,
        mode: candidate.mode,
        url: candidate.url,
      };
    } catch (error) {
      failures.push(`[${candidate.mode}] ${error.message}`);
    }
  }

  throw new Error(`Failed to connect Realtime endpoint. ${failures.join(' | ')}`);
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
  const urlCandidates = buildRealtimeTranslateUrlCandidates(config);
  const { ws, mode, url } = await connectWithFallback(urlCandidates, accessToken);

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
            url,
          });
          webContents.send('translate:session', { state: 'ready', mode, url });
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
