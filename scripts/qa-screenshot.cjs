const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

app.commandLine.appendSwitch("headless");
app.commandLine.appendSwitch("disable-gpu");
app.commandLine.appendSwitch("no-sandbox");

app.whenReady().then(async () => {
  const window = new BrowserWindow({
    show: false,
    width: 1440,
    height: 960,
    webPreferences: { offscreen: true },
  });
  await window.loadFile(path.join(__dirname, "..", "dist", "index.html"));
  await new Promise((resolve) => setTimeout(resolve, 800));
  const orderToast = await window.webContents.executeJavaScript(`
    document.querySelector('.ask-size:not([disabled])')?.click();
    new Promise((resolve) => setTimeout(() => resolve(document.querySelector('.toast')?.textContent || ''), 100));
  `);
  const image = await window.webContents.capturePage();
  const output = path.join("/tmp", "polymarket-terminal-mvp.png");
  fs.writeFileSync(output, image.toPNG());
  await window.webContents.executeJavaScript(`document.querySelector('.account-button')?.click()`);
  await new Promise((resolve) => setTimeout(resolve, 100));
  const accountImage = await window.webContents.capturePage();
  const accountOutput = path.join("/tmp", "polymarket-terminal-account.png");
  fs.writeFileSync(accountOutput, accountImage.toPNG());
  await window.webContents.executeJavaScript(`document.querySelector('.account-empty .primary-button')?.click()`);
  await new Promise((resolve) => setTimeout(resolve, 100));
  const loginImage = await window.webContents.capturePage();
  const loginOutput = path.join("/tmp", "polymarket-terminal-login.png");
  fs.writeFileSync(loginOutput, loginImage.toPNG());
  process.stdout.write(`${output}\n${accountOutput}\n${loginOutput}\n${orderToast}\n`);
  app.quit();
});
