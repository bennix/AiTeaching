const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('closing and reopening macOS windows reuses one LAN server and one store', async () => {
  const listeners = {};
  const windows = [];
  let starts = 0;
  let stops = 0;
  class Window {
    constructor() { this.events = {}; this.webContents = { setWindowOpenHandler() {} }; windows.push(this); }
    static getAllWindows() { return windows.filter((w) => !w.destroyed); }
    on(name, handler) { this.events[name] = handler; }
    async loadURL(url) { this.url = url; }
    isDestroyed() { return Boolean(this.destroyed); }
    isMinimized() { return false; }
    show() {}
    focus() {}
    close() { this.destroyed = true; this.events.closed(); }
  }
  const app = {
    requestSingleInstanceLock: () => true,
    whenReady: () => Promise.resolve(),
    getPath: () => '/test/data',
    on: (event, handler) => { listeners[event] = handler; },
    quit() {},
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8'), {
    require: (name) => name === 'electron' ? { app, BrowserWindow: Window, shell: {} }
      : name === './server' ? { createLanServer: async () => { starts++; return { port: 5000, close() { stops++; } }; } }
        : require(name),
    process: { env: {}, platform: 'darwin' }, __dirname: path.join(__dirname, '..'),
  });
  await new Promise(setImmediate);
  windows[0].close();
  await Promise.all([listeners.activate(), listeners.activate()]);
  assert.equal(starts, 1);
  assert.equal(Window.getAllWindows().length, 1);
  assert.equal(windows[1].url, 'http://127.0.0.1:5000');
  listeners['second-instance']();
  await new Promise(setImmediate);
  assert.equal(starts, 1);
  assert.equal(Window.getAllWindows().length, 1);
  listeners['before-quit']();
  assert.equal(stops, 1);
});
