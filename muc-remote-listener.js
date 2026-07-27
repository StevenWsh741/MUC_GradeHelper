'use strict';

const https = require('https');
const path = require('path');
const { spawn } = require('child_process');
const {
  loadRemoteConfig,
  encryptPayload,
  decryptPayload,
  postCiphertext,
  sendRemoteStatus
} = require('./muc-remote-notify');

const ROOT = __dirname;
const CHECKER_PATH = path.join(ROOT, 'muc-score-checker.js');
const MAX_COMMAND_AGE_MS = 2 * 60 * 1000;
const seenNonces = new Set();
let checkerProcess = null;
let stopping = false;
let activeRequest = null;
let selfTestCompleted = false;
const selfTestMode = process.argv.includes('--self-test');

function log(message, color = '') {
  const colors = { red: '\x1b[91m', green: '\x1b[92m', yellow: '\x1b[93m', cyan: '\x1b[96m' };
  const prefix = colors[color] || '';
  console.log(`${prefix}[${new Date().toLocaleString('zh-CN', { hour12: false })}] ${message}${prefix ? '\x1b[0m' : ''}`);
}

function rememberNonce(nonce) {
  if (!/^[a-zA-Z0-9_-]{12,128}$/.test(nonce || '') || seenNonces.has(nonce)) return false;
  seenNonces.add(nonce);
  if (seenNonces.size > 200) seenNonces.delete(seenNonces.values().next().value);
  return true;
}

function validCredentials(username, password) {
  return typeof username === 'string' && username.trim().length >= 1 && username.length <= 100
    && typeof password === 'string' && password.length >= 1 && password.length <= 300;
}

async function handleEncryptedCommand(remoteConfig, ciphertext) {
  let message;
  try {
    message = decryptPayload(remoteConfig, ciphertext);
  } catch (_) {
    return;
  }
  if (message.v !== 1 || message.type !== 'start_checker') return;
  if (!Number.isFinite(message.timestamp) || Math.abs(Date.now() - message.timestamp) > MAX_COMMAND_AGE_MS) {
    log('已拒绝过期的手机启动指令。', 'yellow');
    return;
  }
  if (!rememberNonce(message.nonce)) return;
  if (!validCredentials(message.username, message.password)) {
    log('已拒绝格式无效的手机启动指令。', 'yellow');
    await sendRemoteStatus('invalid_credentials').catch(() => {});
    return;
  }
  if (selfTestMode) {
    message.username = '';
    message.password = '';
    selfTestCompleted = true;
    stopping = true;
    log('远程启动指令的加密、订阅、解密和防重放自检通过。', 'green');
    if (activeRequest) activeRequest.destroy();
    return;
  }
  if (checkerProcess && checkerProcess.exitCode === null) {
    log('查分程序已在运行，忽略重复启动。', 'yellow');
    await sendRemoteStatus('already_running').catch(() => {});
    return;
  }

  const childEnvironment = {
    ...process.env,
    MUC_USERNAME: message.username.trim(),
    MUC_PASSWORD: message.password,
    MUC_REMOTE_STARTED: '1'
  };
  checkerProcess = spawn(process.execPath, [CHECKER_PATH, '--loop'], {
    cwd: ROOT,
    env: childEnvironment,
    stdio: 'inherit',
    windowsHide: false
  });
  childEnvironment.MUC_USERNAME = '';
  childEnvironment.MUC_PASSWORD = '';
  message.username = '';
  message.password = '';

  checkerProcess.on('spawn', () => {
    log('已收到手机指令，网页版查分正在启动。', 'green');
    sendRemoteStatus('started').catch(error => log(`手机回执发送失败：${error.message}`, 'yellow'));
  });
  checkerProcess.on('error', error => {
    log(`查分程序启动失败：${error.message}`, 'red');
    sendRemoteStatus('failed').catch(() => {});
  });
  checkerProcess.on('exit', code => {
    log(`查分程序已退出（代码 ${code ?? 'unknown'}），继续等待手机指令。`, 'cyan');
    if (code && code !== 0) sendRemoteStatus('failed').catch(() => {});
    checkerProcess = null;
  });
}

function subscribeOnce(remoteConfig) {
  return new Promise((resolve, reject) => {
    const since = Math.floor(Date.now() / 1000);
    const endpoint = new URL(
      remoteConfig.endpoint.replace(/\/$/, '') + '/' + remoteConfig.topic + '/json?since=' + since
    );
    let buffered = '';
    const request = https.get(endpoint, {
      timeout: 95000,
      headers: { Accept: 'application/x-ndjson', 'User-Agent': 'MUC-GradeHelper-Desktop/1.1' }
    }, response => {
      if (response.statusCode < 200 || response.statusCode >= 300) {
        response.resume();
        reject(new Error(`HTTP ${response.statusCode}`));
        return;
      }
      log('电脑已连接，正在等待手机远程启动指令。', 'cyan');
      if (selfTestMode) {
        setTimeout(() => {
          const ciphertext = encryptPayload(remoteConfig, {
            type: 'start_checker',
            username: 'synthetic-self-test-user',
            password: 'synthetic-self-test-password'
          });
          postCiphertext(remoteConfig, ciphertext, { cache: false })
            .catch(error => log(`自检指令发送失败：${error.message}`, 'red'));
        }, 700);
      }
      response.setEncoding('utf8');
      response.on('data', chunk => {
        buffered += chunk;
        const lines = buffered.split(/\r?\n/);
        buffered = lines.pop() || '';
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const event = JSON.parse(line);
            if (event.event === 'message') {
              handleEncryptedCommand(remoteConfig, event.message || '')
                .catch(error => log(`指令处理失败：${error.message}`, 'red'));
            }
          } catch (_) {}
        }
      });
      response.on('end', resolve);
      response.on('error', reject);
    });
    activeRequest = request;
    request.on('timeout', () => request.destroy());
    request.on('close', resolve);
    request.on('error', reject);
  });
}

async function main() {
  const remoteConfig = loadRemoteConfig();
  if (!remoteConfig) throw new Error('尚未配置手机配对信息，请先运行“配置手机提醒.cmd”。');
  log('远程启动监听器已运行。请保持此窗口开启，电脑也不能休眠。', 'green');
  const selfTestTimeout = selfTestMode ? setTimeout(() => {
    stopping = true;
    if (activeRequest) activeRequest.destroy();
  }, 25000) : null;
  while (!stopping) {
    try {
      await subscribeOnce(remoteConfig);
    } catch (error) {
      if (!stopping) log(`连接暂时中断：${error.message}，5 秒后重连。`, 'yellow');
    }
    if (!stopping) await new Promise(resolve => setTimeout(resolve, 5000));
  }
  if (selfTestTimeout) clearTimeout(selfTestTimeout);
  if (selfTestMode && !selfTestCompleted) throw new Error('远程启动闭环自检超时。');
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    stopping = true;
    if (checkerProcess && checkerProcess.exitCode === null) checkerProcess.kill();
  });
}

main().catch(error => {
  log(error.message, 'red');
  process.exitCode = 1;
});
