'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { chromium } = require('playwright-core');
const { sendRemoteScores, sendRemoteStatus } = require('./muc-remote-notify');

const ROOT = __dirname;
const CONFIG_PATH = path.join(ROOT, 'config.json');
const PROFILE_PATH = path.join(ROOT, '.browser-profile');
const ALERT_SCRIPT_PATH = path.join(ROOT, 'muc-alert.ps1');
// The portal's HTTP -> HTTPS proxy currently rewrites /user/ into the invalid
// /qser/ path. Ask CAS to return directly to the real HTTPS endpoint instead.
const SSO_CALLBACK_URL = 'https://my.muc.edu.cn/user/simpleSSOLogin';
const LOGIN_URL = `https://ca.muc.edu.cn/zfca/login?service=${encodeURIComponent(SSO_CALLBACK_URL)}`;
const PORTAL_URL = 'https://my.muc.edu.cn/page/11#/';

const DEFAULT_CONFIG = {
  checkIntervalSeconds: 60,
  checkJitterSeconds: 10,
  manualNavigationTimeoutMinutes: 10,
  loginTimeoutMinutes: 5,
  alertIncludeScores: true,
  voiceRepeatCount: 2,
  speechRate: 3,
  announceExistingScoresOnLogin: true,
  phoenixVideo: '凤凰视频.mp4'
};

const username = process.env.MUC_USERNAME || '';
const password = process.env.MUC_PASSWORD || '';
const loopMode = process.argv.includes('--loop');
let sessionRecords = null;

function nowText() {
  return new Date().toLocaleString('zh-CN', { hour12: false });
}

function log(message, color = '') {
  const colors = { red: '\x1b[91m', green: '\x1b[92m', yellow: '\x1b[93m', cyan: '\x1b[96m' };
  const start = colors[color] || '';
  const end = start ? '\x1b[0m' : '';
  console.log(`${start}[${nowText()}] ${message}${end}`);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getNextCheckDelayMs() {
  const baseSeconds = Math.max(10, Number(config.checkIntervalSeconds) || 60);
  const jitterSeconds = Math.max(0, Math.min(baseSeconds - 1, Number(config.checkJitterSeconds) || 0));
  const randomOffset = jitterSeconds ? (Math.random() * 2 - 1) * jitterSeconds : 0;
  return Math.round((baseSeconds + randomOffset) * 1000);
}

function loadJson(file, fallback) {
  try {
    return { ...fallback, ...JSON.parse(fs.readFileSync(file, 'utf8')) };
  } catch (_) {
    return { ...fallback };
  }
}

function findBrowserExecutable() {
  const env = process.env;
  const candidates = [
    path.join(env['PROGRAMFILES(X86)'] || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(env.PROGRAMFILES || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(env.LOCALAPPDATA || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(env.PROGRAMFILES || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(env['PROGRAMFILES(X86)'] || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe')
  ];
  return candidates.find(candidate => candidate && fs.existsSync(candidate));
}

function isCasUrl(url) {
  return /(^|\.)ca\.muc\.edu\.cn/i.test(safeHost(url));
}

function isBrokenCallbackUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.hostname === 'my.muc.edu.cn' && /\/qser\/simpleSSOLogin/i.test(parsed.pathname);
  } catch (_) {
    return false;
  }
}

function safeHost(url) {
  try { return new URL(url).hostname; } catch (_) { return ''; }
}

async function firstOpenPage(context) {
  const pages = context.pages().filter(p => !p.isClosed());
  return pages[0] || context.newPage();
}

async function findVisibleLoginControls(page) {
  const frames = page.frames().slice().reverse();
  for (const frame of frames) {
    try {
      const usernameInput = frame.locator('input[name="username"]:visible').first();
      const passwordInput = frame.locator('input[name="password"]:visible').first();
      if (await usernameInput.count() && await passwordInput.count()) {
        const submitButton = frame.locator('button.btn-submit:visible, input[type="submit"]:visible').first();
        return { frame, usernameInput, passwordInput, submitButton };
      }
    } catch (_) {}
  }
  return null;
}

async function fillVisibleLoginForm(page, submit) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline && isCasUrl(page.url())) {
    const controls = await findVisibleLoginControls(page);
    if (controls) {
      await controls.usernameInput.fill(username);
      await controls.passwordInput.fill(password);
      if (submit) {
        if (!await controls.submitButton.count()) return false;
        await controls.submitButton.click({ timeout: 5000 });
      }
      return true;
    }
    await sleep(400);
  }
  return false;
}

async function readVisibleLoginError(page) {
  for (const frame of page.frames().slice().reverse()) {
    try {
      const messages = frame.locator('.errMsg:visible, .error:visible, .login-error:visible');
      const count = Math.min(await messages.count(), 10);
      for (let index = 0; index < count; index += 1) {
        const value = (await messages.nth(index).innerText()).replace(/\s+/g, ' ').trim();
        if (value) return value;
      }
    } catch (_) {}
  }
  return '';
}

async function submitLoginCredentials(page) {
  if (await fillVisibleLoginForm(page, true)) {
    log('已填写可见登录表单并点击“账号登录”。', 'cyan');
    return true;
  }

  log('未找到可见登录表单，尝试兼容接口提交……', 'yellow');
  await page.waitForFunction(() => typeof window.doLogin === 'function', null, { timeout: 15000 });
  if (!isCasUrl(page.url())) return true;
  await page.evaluate(({ username, password }) => {
    window.doLogin({ username, password, type: 'username_password' });
  }, { username, password });
  return true;
}

async function loginIfNeeded(context, forcePortal = true) {
  let page = context.pages().find(p => !p.isClosed() && isCasUrl(p.url())) || await firstOpenPage(context);
  const deadline = Date.now() + config.loginTimeoutMinutes * 60_000;
  let credentialsSubmitted = false;
  let submittedAt = 0;
  let manualFallbackPrepared = false;
  let recoveryCount = 0;

  while (Date.now() < deadline) {
    if (page.isClosed()) page = await firstOpenPage(context);
    const url = page.url();
    const host = safeHost(url);

    if (!host || url === 'about:blank') {
      await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
      credentialsSubmitted = false;
      manualFallbackPrepared = false;
      continue;
    }

    if (isBrokenCallbackUrl(url)) {
      recoveryCount += 1;
      if (recoveryCount > 3) {
        throw new Error('学校门户连续返回 /qser/ 错误地址，HTTPS 认证回调未能生效。');
      }
      log('检测到学校门户的 /qser/ 错误回跳，正在改用 HTTPS 认证入口重试……', 'yellow');
      await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
      credentialsSubmitted = false;
      manualFallbackPrepared = false;
      continue;
    }

    if (isCasUrl(url)) {
      if (!credentialsSubmitted) {
        log('正在通过统一身份认证登录……', 'cyan');
        try {
          credentialsSubmitted = await submitLoginCredentials(page);
          submittedAt = Date.now();
        } catch (_) {
          log('自动填写未完成，请在浏览器中手动完成登录/验证码。', 'yellow');
          credentialsSubmitted = true;
          submittedAt = Date.now();
        }
      } else if (!manualFallbackPrepared && Date.now() - submittedAt > 6000) {
        const errorMessage = await readVisibleLoginError(page);
        if (!page.url().includes('service=')) {
          await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
        }
        await fillVisibleLoginForm(page, false).catch(() => false);
        const reason = errorMessage ? `网页提示：${errorMessage}` : '可能需要验证码、身份确认，或上次提交未被接受';
        log(`自动登录尚未完成（${reason}）。已重新填好账号密码，请在网页确认后手动点击“账号登录”。`, 'yellow');
        manualFallbackPrepared = true;
      }
      await sleep(1200);
      continue;
    }

    if (forcePortal) {
      if (host === 'my.muc.edu.cn' && url.includes('/page/11')) {
        log('信息门户登录状态已确认。', 'green');
        return page;
      }
      try {
        await page.goto(PORTAL_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
      } catch (_) {}
      credentialsSubmitted = false;
      manualFallbackPrepared = false;
      continue;
    }

    log('统一身份认证已完成。', 'green');
    return page;
  }
  throw new Error(`登录等待超时（${config.loginTimeoutMinutes} 分钟）。请重新运行，并及时完成网页中的验证。`);
}

async function clickTextInContext(context, labels) {
  const pages = context.pages().filter(p => !p.isClosed()).reverse();
  for (const page of pages) {
    for (const frame of page.frames()) {
      for (const label of labels) {
        for (const exact of [true, false]) {
          try {
            const matches = frame.getByText(label, { exact });
            const count = Math.min(await matches.count(), 12);
            for (let index = 0; index < count; index += 1) {
              const locator = matches.nth(index);
              if (await locator.isVisible({ timeout: 500 })) {
                await locator.scrollIntoViewIfNeeded({ timeout: 1500 }).catch(() => {});
                await locator.click({ timeout: 4000 });
                log(`已点击“${label}”。`, 'cyan');
                return true;
              }
            }
          } catch (_) {}
        }
      }
    }
  }
  return false;
}

async function tryAutomatedNavigation(context) {
  await loginIfNeeded(context, true);
  await sleep(2500);

  if (await clickTextInContext(context, ['本科生教务系统'])) await sleep(5000);
  if (await clickTextInContext(context, ['综合查询'])) await sleep(1800);
  if (await clickTextInContext(context, ['本学期成绩', '本学期成绩查询'])) await sleep(3500);
}

async function extractBestScoreTable(context) {
  const candidates = [];
  const pages = context.pages().filter(p => !p.isClosed());
  for (const page of pages) {
    for (const frame of page.frames()) {
      try {
        const tables = await frame.locator('table').evaluateAll(allTables => {
          const clean = value => (value || '').replace(/\s+/g, ' ').trim();
          return allTables.map(table => {
            const rows = Array.from(table.querySelectorAll('tr')).map(tr =>
              Array.from(tr.querySelectorAll(':scope > th, :scope > td')).map(td => clean(td.innerText))
            ).filter(row => row.some(Boolean));
            if (!rows.length) return null;

            let headerIndex = rows.findIndex((row, index) => index < 6 &&
              row.some(cell => /课程|科目/.test(cell)) &&
              row.some(cell => /成绩|分数|总评|最终/.test(cell)));
            if (headerIndex < 0) return null;
            const headers = rows[headerIndex];
            const width = headers.length;
            const dataRows = rows.slice(headerIndex + 1)
              .filter(row => row.length >= Math.max(2, width - 2))
              .map(row => row.slice(0, width));
            return { headers, rows: dataRows, text: clean(table.innerText).slice(0, 500) };
          }).filter(Boolean);
        });
        for (const table of tables) {
          const score = table.rows.length * 2 + table.headers.filter(h => /课程|成绩|分数|学分|绩点/.test(h)).length * 5;
          candidates.push({ ...table, score, page, frameUrl: frame.url() });
        }
      } catch (_) {}
    }
  }
  candidates.sort((a, b) => b.score - a.score);
  return candidates[0] || null;
}

function normalizeRecords(table) {
  const headers = table.headers.map(h => h.replace(/\s+/g, ' ').trim());
  const findColumn = patterns => headers.findIndex(header => patterns.some(pattern => pattern.test(header)));
  const codeIndex = findColumn([/课程代码/, /课程编号/, /^课程号$/, /^课号$/]);
  const courseIndex = findColumn([/课程名称/, /^课程名$/, /^课程$/, /科目名称/, /^科目名$/, /^科目$/]);
  const scoreIndex = findColumn([/^成绩$/, /总评成绩/, /最终成绩/, /分数/, /成绩/]);

  return table.rows.map((rawCells, index) => {
    const cells = rawCells.map(value => String(value || '').replace(/\s+/g, ' ').trim());
    const code = codeIndex >= 0 ? cells[codeIndex] : '';
    const course = courseIndex >= 0 ? cells[courseIndex] : (cells.find(cell => /[\u4e00-\u9fa5A-Za-z]{2,}/.test(cell)) || `第${index + 1}行`);
    const score = scoreIndex >= 0 ? cells[scoreIndex] : '';
    const keyParts = [code, course].filter(Boolean);
    const key = keyParts.length ? keyParts.join(' | ') : cells.slice(0, 3).join(' | ');
    return { key, course, score, cells };
  }).filter(record => record.key && record.cells.some(Boolean));
}

function isPublishedScore(score) {
  const value = String(score || '').trim();
  if (!value) return false;
  return !/^(--+|-|—|暂无|未公布|未录入|未出|无|null|undefined)$/i.test(value);
}

function detectNewScores(previousRecords, currentRecords) {
  const oldRecords = previousRecords || [];
  const previous = new Map(oldRecords.map(record => [record.key, record]));
  return currentRecords.filter(record => {
    if (!isPublishedScore(record.score)) return false;
    let old = previous.get(record.key);
    if (!old && record.course) {
      const sameCourse = oldRecords.filter(candidate => candidate.course === record.course);
      if (sameCourse.length === 1) old = sameCourse[0];
    }
    if (!old) return true;
    return old.score !== record.score && (!isPublishedScore(old.score) || old.score !== record.score);
  });
}

function getPublishedScores(records) {
  return (records || []).filter(record => isPublishedScore(record.score));
}

async function waitForScoreTable(context, timeoutMinutes) {
  const deadline = Date.now() + timeoutMinutes * 60_000;
  let lastHint = 0;
  while (Date.now() < deadline) {
    const table = await extractBestScoreTable(context);
    if (table) return table;
    if (Date.now() - lastHint > 30_000) {
      log('尚未识别到成绩表；如未自动进入，请在浏览器中手动打开“综合查询 → 本学期成绩”。', 'yellow');
      lastHint = Date.now();
    }
    await sleep(2000);
  }
  return null;
}

function buildAlertCommand(newScores, publishedCount = newScores.length, totalCount = publishedCount) {
  const scoreDetails = newScores.map(item => `${item.course}：${item.score}`).join('\r\n');
  const details = scoreDetails;
  const titleText = '新成绩已发布';
  const speechDetails = newScores.map(item => {
    const score = String(item.score || '').trim();
    const spokenScore = /^\d+(?:\.\d+)?$/.test(score) ? `${score}分` : score;
    return `${item.course}，${spokenScore}`;
  }).join('。');
  const speechText = `${speechDetails}。`;
  const titleBase64 = Buffer.from(titleText, 'utf8').toString('base64');
  const detailsBase64 = Buffer.from(details, 'utf8').toString('base64');
  const speechBase64 = Buffer.from(speechText, 'utf8').toString('base64');
  const repeatCount = Math.max(1, Math.min(5, Number(config.voiceRepeatCount) || 2));
  return [
    'Add-Type -AssemblyName System.Windows.Forms',
    'Add-Type -AssemblyName System.Drawing',
    'Add-Type -AssemblyName System.Speech',
    `$titleText = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${titleBase64}'))`,
    `$detailsText = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${detailsBase64}'))`,
    `$speechText = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${speechBase64}'))`,
    '$form = New-Object System.Windows.Forms.Form',
    '$form.Text = "MUC 新成绩提醒"',
    '$form.WindowState = [System.Windows.Forms.FormWindowState]::Maximized',
    '$form.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::None',
    '$form.TopMost = $true',
    '$form.ShowInTaskbar = $true',
    '$form.BackColor = [System.Drawing.Color]::FromArgb(150, 0, 0)',
    '$form.KeyPreview = $true',
    '$title = New-Object System.Windows.Forms.Label',
    '$title.Dock = [System.Windows.Forms.DockStyle]::Top',
    '$title.Height = 220',
    '$title.TextAlign = [System.Drawing.ContentAlignment]::MiddleCenter',
    '$title.ForeColor = [System.Drawing.Color]::White',
    '$title.BackColor = [System.Drawing.Color]::FromArgb(210, 0, 0)',
    '$title.Font = New-Object System.Drawing.Font("Microsoft YaHei UI", 54, [System.Drawing.FontStyle]::Bold)',
    '$title.Text = $titleText',
    '$details = New-Object System.Windows.Forms.Label',
    '$details.Dock = [System.Windows.Forms.DockStyle]::Fill',
    '$details.TextAlign = [System.Drawing.ContentAlignment]::MiddleCenter',
    '$details.ForeColor = [System.Drawing.Color]::Yellow',
    '$details.Font = New-Object System.Drawing.Font("Microsoft YaHei UI", 34, [System.Drawing.FontStyle]::Bold)',
    '$details.Text = $detailsText',
    '$close = New-Object System.Windows.Forms.Button',
    '$close.Dock = [System.Windows.Forms.DockStyle]::Bottom',
    '$close.Height = 110',
    '$close.Text = "我知道了（也可按 Esc 关闭）"',
    '$close.Font = New-Object System.Drawing.Font("Microsoft YaHei UI", 26, [System.Drawing.FontStyle]::Bold)',
    '$close.BackColor = [System.Drawing.Color]::White',
    '$close.ForeColor = [System.Drawing.Color]::DarkRed',
    '$close.FlatStyle = [System.Windows.Forms.FlatStyle]::Flat',
    '$close.Add_Click({ $form.Close() })',
    '$form.Add_KeyDown({ if ($_.KeyCode -eq [System.Windows.Forms.Keys]::Escape) { $form.Close() } })',
    '$form.Controls.Add($details)',
    '$form.Controls.Add($title)',
    '$form.Controls.Add($close)',
    '$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer',
    '$zhVoice = $synth.GetInstalledVoices() | Where-Object { $_.VoiceInfo.Culture.Name -eq "zh-CN" } | Select-Object -First 1',
    'if ($null -ne $zhVoice) { $synth.SelectVoice($zhVoice.VoiceInfo.Name) }',
    '$synth.Volume = 100',
    `$synth.Rate = ${Math.max(-10, Math.min(10, Number(config.speechRate) || 3))}`,
    `$form.Add_Shown({ [System.Media.SystemSounds]::Exclamation.Play(); 1..${repeatCount} | ForEach-Object { $null = $synth.SpeakAsync($speechText) }; $form.Activate(); $form.BringToFront() })`,
    '$null = $form.ShowDialog()',
    '$synth.SpeakAsyncCancelAll()',
    '$synth.Dispose()',
    '$form.Dispose()'
  ].join(';\r\n');
}

function buildPhoenixAlertPayload(scores, publishedCount, totalCount, mode = 'new') {
  const scoreDetails = scores.map(item => `${item.course}：${item.score}`).join('\r\n');
  const speechDetails = scores.map(item => {
    const score = String(item.score || '').trim();
    const spokenScore = /^\d+(?:\.\d+)?$/.test(score) ? `${score}分` : score;
    return `${item.course}，${spokenScore}`;
  }).join('。');

  if (mode === 'startup') {
    return {
      title: '全屏语音提醒测试 · 虚构数据',
      details: `${scoreDetails}\r\n\r\n以上均为随机测试数据`,
      speech: `${speechDetails}。`
    };
  }
  if (mode === 'initial') {
    return {
      title: '当前已有成绩',
      details: scoreDetails,
      speech: `${speechDetails}。`
    };
  }
  return {
    title: '新成绩已发布',
    details: scoreDetails,
    speech: `${speechDetails}。`
  };
}

function launchPhoenixAlert(scores, publishedCount, totalCount, mode = 'new') {
  const videoPath = path.join(ROOT, config.phoenixVideo || '凤凰视频.mp4');
  if (!fs.existsSync(ALERT_SCRIPT_PATH) || !fs.existsSync(videoPath)) {
    log('未找到凤凰提醒脚本或视频，改用普通全屏提醒。', 'yellow');
    const command = buildAlertCommand(scores, publishedCount, totalCount);
    const encoded = Buffer.from(command, 'utf16le').toString('base64');
    const fallback = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-EncodedCommand', encoded], {
      detached: true,
      stdio: 'ignore',
      windowsHide: false
    });
    fallback.unref();
    return;
  }

  const payload = buildPhoenixAlertPayload(scores, publishedCount, totalCount, mode);
  const encode = value => Buffer.from(value, 'utf8').toString('base64');
  const repeatCount = mode === 'startup' || mode === 'initial'
    ? 1
    : Math.max(1, Math.min(5, Number(config.voiceRepeatCount) || 2));
  const alertArgs = [
    '-Sta',
    '-NoLogo',
    '-NoProfile',
    '-ExecutionPolicy', 'Bypass',
    '-File', ALERT_SCRIPT_PATH,
    '-TitleBase64', encode(payload.title),
    '-DetailsBase64', encode(payload.details),
    '-SpeechBase64', encode(payload.speech),
    '-VideoPathBase64', encode(videoPath),
    '-RepeatCount', String(repeatCount),
    '-SpeechRate', String(Math.max(-10, Math.min(10, Number(config.speechRate) || 3)))
  ];
  const diagnosticAutoClose = Math.max(0, Number(process.env.MUC_ALERT_AUTO_CLOSE_SECONDS) || 0);
  if (diagnosticAutoClose > 0) alertArgs.push('-AutoCloseSeconds', String(diagnosticAutoClose));
  const child = spawn('powershell.exe', alertArgs, {
    detached: false,
    stdio: 'ignore',
    windowsHide: false
  });
  child.on('spawn', () => log('凤凰全屏视频与语音提醒进程已启动。', 'cyan'));
  child.on('error', error => log(`凤凰提醒启动失败：${error.message}`, 'red'));
  child.on('exit', code => {
    if (code && code !== 0) {
      let detail = '';
      try { detail = fs.readFileSync(path.join(ROOT, '.alert-error.log'), 'utf8').trim(); } catch (_) {}
      log(`凤凰提醒异常退出（代码 ${code}）。${detail}`, 'red');
    }
  });
  return child;
}

function showAlert(newScores) {
  const details = newScores.map(item => `${item.course}：${item.score}`).join('\r\n');
  const message = config.alertIncludeScores
    ? `本次新成绩：\r\n${details}`
    : `有新课程发布成绩。`;

  process.stdout.write('\x1b[41m\x1b[97m\x1b[1m');
  console.log('\n============================================================');
  console.log(message.replace(/\r\n/g, '\n'));
  console.log('============================================================\n');
  process.stdout.write('\x1b[0m');

  launchPhoenixAlert(newScores, newScores.length, newScores.length, 'new');
  if (config.remoteNotificationsEnabled !== false) {
    sendRemoteScores(newScores).then(result => {
      if (result.sent) log('新成绩已端到端加密推送到手机。', 'cyan');
      else if (result.reason === 'not_configured') log('手机提醒尚未配置，本次仅本机提醒。', 'yellow');
    }).catch(error => log(`手机提醒发送失败：${error.message}`, 'yellow'));
  }
}

function createRandomTestScores() {
  const courses = ['示例课程甲（测试数据）', '示例课程乙（测试数据）', '示例课程丙（测试数据）'];
  const course = courses[Math.floor(Math.random() * courses.length)];
  const score = String(70 + Math.floor(Math.random() * 30));
  return [{ key: 'random-test', course, score, cells: [] }];
}

function announceExistingScores(published) {
  if (!published.length) {
    log('首次读取完成：当前没有已公布成绩。', 'yellow');
    return;
  }
  log(`首次读取完成：正在播报当前已有的 ${published.length} 门成绩。`, 'cyan');
  launchPhoenixAlert(published, published.length, published.length, 'initial');
}

async function captureAndCompare(context, isStartup = false) {
  const table = await extractBestScoreTable(context);
  if (!table) return { found: false, count: 0 };
  const records = normalizeRecords(table);
  const published = getPublishedScores(records);
  if (sessionRecords === null) {
    sessionRecords = records;
    log('已在内存中建立本次运行基线；关闭程序后自动清除，不写入磁盘。', 'green');
    if (isStartup && config.announceExistingScoresOnLogin) announceExistingScores(published);
    return { found: true, count: published.length, total: records.length, alerted: 0 };
  }

  const newScores = detectNewScores(sessionRecords, records);
  sessionRecords = records;

  if (newScores.length) {
    newScores.forEach(record => log(`本次新成绩：${record.course}：${record.score}`, 'green'));
    showAlert(newScores);
    return { found: true, count: published.length, total: records.length, alerted: newScores.length };
  }
  log('检查完成：没有新增已公布成绩。', 'green');
  return { found: true, count: published.length, total: records.length, alerted: 0 };
}

async function refreshAndFind(context) {
  let table = await extractBestScoreTable(context);
  if (table && table.page && !table.page.isClosed()) {
    try {
      await table.page.reload({ waitUntil: 'domcontentloaded', timeout: 45000 });
      await sleep(3500);
    } catch (_) {}
  }

  table = await extractBestScoreTable(context);
  if (table) return table;

  const pages = context.pages().filter(p => !p.isClosed());
  if (pages.some(p => isCasUrl(p.url()))) {
    await loginIfNeeded(context, false);
  }
  await tryAutomatedNavigation(context);
  return waitForScoreTable(context, Math.min(2, config.manualNavigationTimeoutMinutes));
}

const config = loadJson(CONFIG_PATH, DEFAULT_CONFIG);

async function main() {
  if (process.argv.includes('--test-alert')) {
    const testScores = createRandomTestScores();
    log('正在使用随机虚构数据测试全屏语音提醒。', 'cyan');
    launchPhoenixAlert(testScores, testScores.length, testScores.length, 'startup');
    await sleep(2500);
    return;
  }
  if (!username || !password) {
    throw new Error('缺少用户名或密码。请双击“启动查分.cmd”运行，不要直接双击 JS 文件。');
  }
  const executablePath = findBrowserExecutable();
  if (!executablePath) {
    throw new Error('未找到 Microsoft Edge 或 Google Chrome，请先安装其中一个浏览器。');
  }

  const baseSeconds = Math.max(10, Number(config.checkIntervalSeconds) || 60);
  const jitterSeconds = Math.max(0, Math.min(baseSeconds - 1, Number(config.checkJitterSeconds) || 0));
  log(`每次将在 ${baseSeconds - jitterSeconds}–${baseSeconds + jitterSeconds} 秒之间随机检查。密码和成绩均不写入磁盘。`, 'cyan');
  let context;
  try {
    context = await chromium.launchPersistentContext(PROFILE_PATH, {
      executablePath,
      headless: false,
      chromiumSandbox: true,
      viewport: null,
      acceptDownloads: false,
      args: ['--start-maximized']
    });
  } catch (error) {
    if (/profile|user data|SingletonLock|process/i.test(error.message)) {
      throw new Error('浏览器数据目录正在使用。请关闭另一个查分窗口和它打开的浏览器后再试。');
    }
    throw error;
  }

  process.on('SIGINT', async () => {
    log('正在安全退出……', 'yellow');
    await context.close().catch(() => {});
    process.exit(0);
  });

  try {
    await loginIfNeeded(context, true);
    await tryAutomatedNavigation(context);
    const firstTable = await waitForScoreTable(context, config.manualNavigationTimeoutMinutes);
    if (!firstTable) {
      throw new Error(`等待 ${config.manualNavigationTimeoutMinutes} 分钟后仍未识别到成绩表。请确认已打开“本学期成绩”页面。`);
    }
    await captureAndCompare(context, true);
    if (process.env.MUC_REMOTE_STARTED === '1') {
      await sendRemoteStatus('ready')
        .catch(error => log(`手机就绪回执发送失败：${error.message}`, 'yellow'));
    }

    if (!loopMode) return;
    while (true) {
      const waitMs = getNextCheckDelayMs();
      const waitSeconds = Math.round(waitMs / 1000);
      log(`本次随机等待 ${waitSeconds} 秒；下次检查时间：${new Date(Date.now() + waitMs).toLocaleTimeString('zh-CN', { hour12: false })}`, 'cyan');
      await sleep(waitMs);
      const table = await refreshAndFind(context);
      if (!table) {
        log('本次未找到成绩表，稍后会再次尝试；也可在浏览器中手动返回成绩页。', 'yellow');
        continue;
      }
      await captureAndCompare(context);
    }
  } finally {
    if (!loopMode) await context.close().catch(() => {});
  }
}

if (require.main === module) {
  main().catch(error => {
    log(error.message || String(error), 'red');
    process.exitCode = 1;
  });
}

module.exports = {
  normalizeRecords,
  detectNewScores,
  isPublishedScore,
  getPublishedScores,
  buildAlertCommand,
  buildPhoenixAlertPayload,
  createRandomTestScores,
  getNextCheckDelayMs,
  launchPhoenixAlert,
  findVisibleLoginControls,
  fillVisibleLoginForm,
  readVisibleLoginError,
  findBrowserExecutable,
  isBrokenCallbackUrl
};
