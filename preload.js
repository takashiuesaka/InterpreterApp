const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('translatorApi', {
  startRealtimeAudioTranslation: async (targetLanguage = 'ja') => {
    return ipcRenderer.invoke('translate:realtime-audio-start', {
      targetLanguage,
    });
  },
  appendAudioChunk: (audioBase64) => {
    ipcRenderer.send('translate:audio-append', {
      audio: audioBase64,
    });
  },
  stopRealtimeAudioTranslation: async () => {
    return ipcRenderer.invoke('translate:realtime-audio-stop');
  },
  onTranslationDelta: (callback) => {
    const listener = (_event, payload) => {
      callback(payload);
    };
    ipcRenderer.on('translate:delta', listener);
    return () => {
      ipcRenderer.removeListener('translate:delta', listener);
    };
  },
  onTranslationDone: (callback) => {
    const listener = (_event, payload) => {
      callback(payload);
    };
    ipcRenderer.on('translate:done', listener);
    return () => {
      ipcRenderer.removeListener('translate:done', listener);
    };
  },
  onTranslationError: (callback) => {
    const listener = (_event, payload) => {
      callback(payload);
    };
    ipcRenderer.on('translate:error', listener);
    return () => {
      ipcRenderer.removeListener('translate:error', listener);
    };
  },
  onSessionState: (callback) => {
    const listener = (_event, payload) => {
      callback(payload);
    };
    ipcRenderer.on('translate:session', listener);
    return () => {
      ipcRenderer.removeListener('translate:session', listener);
    };
  },
  onRealtimeEvent: (callback) => {
    const listener = (_event, payload) => {
      callback(payload);
    };
    ipcRenderer.on('translate:event', listener);
    return () => {
      ipcRenderer.removeListener('translate:event', listener);
    };
  },
  onTranslationAudioDelta: (callback) => {
    const listener = (_event, payload) => {
      callback(payload);
    };
    ipcRenderer.on('translate:audio-delta', listener);
    return () => {
      ipcRenderer.removeListener('translate:audio-delta', listener);
    };
  },
  healthCheck: async () => {
    return ipcRenderer.invoke('translate:health');
  },
  loadPersistedTranslation: async () => {
    return ipcRenderer.invoke('app:load-persisted-translation');
  },
  savePersistedTranslation: async (content) => {
    return ipcRenderer.invoke('app:save-persisted-translation', {
      content,
    });
  },
  saveTranslationAs: async (defaultFileName, content) => {
    return ipcRenderer.invoke('app:save-translation-as', {
      defaultFileName,
      content,
    });
  },
  getAppConfig: async () => {
    return ipcRenderer.invoke('app:config:get');
  },
  saveAppConfig: async (config) => {
    return ipcRenderer.invoke('app:config:save', {
      config,
    });
  },
});
