const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('translatorApi', {
  startRealtimeAudioTranslation: async (targetLanguage = 'ja') => {
    return ipcRenderer.invoke('translate:realtime-audio-start', {
      targetLanguage,
    });
  },
  stopRealtimeAudioTranslation: async () => {
    return ipcRenderer.invoke('translate:realtime-audio-stop');
  },
  healthCheck: async () => {
    return ipcRenderer.invoke('translate:health');
  },
});
