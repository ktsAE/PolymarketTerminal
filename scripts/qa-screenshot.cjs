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
  await window.webContents.executeJavaScript(`
    [...document.querySelectorAll('.market-item')].slice(2).forEach((item) => item.click());
  `);
  await new Promise((resolve) => setTimeout(resolve, 250));
  const uiStats = await window.webContents.executeJavaScript(`
    (() => ({
      books: document.querySelectorAll('.book-panel').length,
      prints: document.querySelectorAll('.trade-print').length,
      autoActive: document.querySelector('.layout-switcher button.active')?.textContent?.trim(),
    }))()
  `);
  if (uiStats.books !== 6 || uiStats.prints < 12 || uiStats.autoActive !== "AUTO") {
    throw new Error(`Workspace QA failed: ${JSON.stringify(uiStats)}`);
  }
  const autoLayoutImage = await window.webContents.capturePage();
  const autoLayoutOutput = path.join("/tmp", "polymarket-terminal-auto-layout.png");
  fs.writeFileSync(autoLayoutOutput, autoLayoutImage.toPNG());
  window.setSize(1100, 800);
  await new Promise((resolve) => setTimeout(resolve, 250));
  const compactImage = await window.webContents.capturePage();
  const compactOutput = path.join("/tmp", "polymarket-terminal-compact.png");
  fs.writeFileSync(compactOutput, compactImage.toPNG());
  const compactVisible = await window.webContents.executeJavaScript(`
    [...document.querySelectorAll('.book-panel')].every((panel) => panel.getBoundingClientRect().bottom <= window.innerHeight + 1)
  `);
  if (!compactVisible) throw new Error("AUTO layout did not fit all books inside the compact viewport");
  await window.webContents.executeJavaScript(`
    const star = document.querySelector('.market-star');
    if (star && !star.classList.contains('active')) star.click();
    [...document.querySelectorAll('.market-view-tabs button')].find((button) => button.textContent.includes('Favorites'))?.click();
  `);
  await new Promise((resolve) => setTimeout(resolve, 100));
  const favoriteCount = await window.webContents.executeJavaScript(`document.querySelectorAll('.market-item').length`);
  if (favoriteCount < 1) throw new Error("Favorite filter did not retain the starred market");
  window.setSize(1440, 960);
  await new Promise((resolve) => setTimeout(resolve, 150));
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
  process.stdout.write(`${output}\n${autoLayoutOutput}\n${compactOutput}\n${accountOutput}\n${loginOutput}\n${orderToast}\n${JSON.stringify(uiStats)}\n`);
  app.quit();
});
