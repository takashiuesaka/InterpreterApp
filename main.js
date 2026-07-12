const path = require('node:path');
const { app, BrowserWindow, ipcMain } = require('electron');
const { InteractiveBrowserCredential } = require('@azure/identity');

try {
  require('dotenv').config();
} catch {
  // dotenv is optional at runtime; environment variables can be supplied by shell.
}

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

function buildSessionConfig(deployment, targetLanguage) {
  return {
    session: {
      type: 'realtime',
      model: deployment,
      instructions:
        targetLanguage === 'ja'
          ? 'Translate user speech from English to Japanese. Output Japanese text only.'
          : `Translate user speech into ${targetLanguage}. Output translated text only.`,
      input_audio_format: 'pcm16',
      turn_detection: {
        type: 'server_vad',
        create_response: true,
      },
    },
  };
}

function buildWebRtcEndpointCandidates(endpoint) {
  return [
    {
      label: 'realtime',
      clientSecretsUrl: `${endpoint}/openai/v1/realtime/client_secrets`,
      callsUrl: `${endpoint}/openai/v1/realtime/calls?webrtcfilter=on`,
    },
    {
      label: 'realtime-translations',
      clientSecretsUrl: `${endpoint}/openai/v1/realtime/translations/client_secrets`,
      callsUrl: `${endpoint}/openai/v1/realtime/translations/calls?webrtcfilter=on`,
    },
  ];
}

async function createEphemeralToken(targetLanguage) {
  const config = getFoundryConfig();
  const accessToken = await getAccessToken();
  const endpointCandidates = buildWebRtcEndpointCandidates(config.endpoint);
  const errors = [];

  for (const candidate of endpointCandidates) {
    const response = await fetch(candidate.clientSecretsUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(buildSessionConfig(config.deployment, targetLanguage)),
    });

    const bodyText = await response.text();
    if (!response.ok) {
      errors.push(
        `[${candidate.label}] ${response.status} ${response.statusText}: ${bodyText.slice(0, 240)}`,
      );
      continue;
    }

    let payload;
    try {
      payload = JSON.parse(bodyText);
    } catch {
      errors.push(`[${candidate.label}] 200 OK but response was not valid JSON.`);
      continue;
    }

    const token = typeof payload?.value === 'string' ? payload.value : '';
    if (!token) {
      errors.push(`[${candidate.label}] 200 OK but ephemeral token was missing in payload.`);
      continue;
    }

    return {
      ephemeralKey: token,
      callsUrl: candidate.callsUrl,
      transportPath: candidate.label,
    };
  }

  throw new Error(
    `Failed to create ephemeral token for deployment '${config.deployment}'. Tried ${endpointCandidates.length} endpoint variants. ${errors.join(' | ')}`,
  );
}

ipcMain.handle('translate:realtime-audio-start', async (_event, payload) => {
  const targetLanguage =
    typeof payload?.targetLanguage === 'string' && payload.targetLanguage.trim()
      ? payload.targetLanguage.trim()
      : 'ja';

  return createEphemeralToken(targetLanguage);
});

ipcMain.handle('translate:realtime-audio-stop', async () => {
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
