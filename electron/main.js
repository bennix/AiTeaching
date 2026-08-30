const path = require('node:path');
const { app, BrowserWindow, shell } = require('electron');
const { createLanServer } = require('./server');

let mainWindow = null;
let lanServer = null;

async function createWindow() {
  const runtimeDir = process.env.AIAID_DATA_DIR || app.getPath('userData');
  lanServer = await createLanServer({
    runtimeDir,
    rendererDir: path.join(__dirname, 'renderer'),
    preferredPort: Number(process.env.AIAID_PORT || 5000),
  });

  mainWindow = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 980,
    minHeight: 680,
    title: 'AI 教学助手',
    backgroundColor: '#f4f7fb',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  await mainWindow.loadURL(`http://127.0.0.1:${lanServer.port}`);
}

app.whenReady().then(async () => {
  await createWindow();
  app.on('activate', async () => {
    if (BrowserWindow.getAllWindows().length === 0) await createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  if (lanServer) lanServer.close();
});
