'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const https = require('https');

const ROOT = __dirname;
const REMOTE_CONFIG_PATH = path.join(ROOT, 'remote-config.local.json');
const PROTOCOL = 'muc-grade-helper-v1';

function base64UrlEncode(value) {
  return Buffer.from(value).toString('base64url');
}

function loadRemoteConfig() {
  try {
    const value = JSON.parse(fs.readFileSync(REMOTE_CONFIG_PATH, 'utf8'));
    if (!value.endpoint || !value.topic || !value.key) return null;
    if (!/^https:\/\//i.test(value.endpoint)) return null;
    if (!/^[a-zA-Z0-9_-]{16,128}$/.test(value.topic)) return null;
    if (Buffer.from(value.key, 'base64url').length !== 32) return null;
    return value;
  } catch (_) {
    return null;
  }
}

function encryptMessage(remoteConfig, scores, test = false) {
  const iv = crypto.randomBytes(12);
  const key = Buffer.from(remoteConfig.key, 'base64url');
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(`${PROTOCOL}|${remoteConfig.topic}`, 'utf8'));
  const body = Buffer.from(JSON.stringify({
    v: 1,
    timestamp: Date.now(),
    nonce: crypto.randomBytes(16).toString('base64url'),
    type: test ? 'test' : 'new_scores',
    scores: scores.map(item => ({
      course: String(item.course || '').slice(0, 200),
      score: String(item.score || '').slice(0, 50)
    }))
  }), 'utf8');
  const encrypted = Buffer.concat([cipher.update(body), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, encrypted, tag]).toString('base64url');
}

function decryptMessageForSelfTest(remoteConfig, ciphertext) {
  const packed = Buffer.from(ciphertext, 'base64url');
  if (packed.length < 29) throw new Error('invalid ciphertext');
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    Buffer.from(remoteConfig.key, 'base64url'),
    packed.subarray(0, 12)
  );
  decipher.setAAD(Buffer.from(`${PROTOCOL}|${remoteConfig.topic}`, 'utf8'));
  decipher.setAuthTag(packed.subarray(packed.length - 16));
  const plaintext = Buffer.concat([
    decipher.update(packed.subarray(12, packed.length - 16)),
    decipher.final()
  ]);
  return JSON.parse(plaintext.toString('utf8'));
}

function postCiphertext(remoteConfig, ciphertext) {
  return new Promise((resolve, reject) => {
    const endpoint = new URL(remoteConfig.endpoint.replace(/\/$/, '') + '/' + remoteConfig.topic);
    const body = Buffer.from(ciphertext, 'utf8');
    const request = https.request(endpoint, {
      method: 'POST',
      timeout: 20000,
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Content-Length': body.length,
        'Title': 'MUC encrypted notification',
        'Tags': 'lock',
        'Priority': 'high',
        'Cache': 'yes',
        'Expires': '1d'
      }
    }, response => {
      response.resume();
      response.on('end', () => {
        if (response.statusCode >= 200 && response.statusCode < 300) resolve();
        else reject(new Error(`HTTP ${response.statusCode}`));
      });
    });
    request.on('timeout', () => request.destroy(new Error('request timeout')));
    request.on('error', reject);
    request.end(body);
  });
}

async function sendRemoteScores(scores, options = {}) {
  const remoteConfig = loadRemoteConfig();
  if (!remoteConfig) return { sent: false, reason: 'not_configured' };
  if (!Array.isArray(scores) || !scores.length) return { sent: false, reason: 'empty' };
  const ciphertext = encryptMessage(remoteConfig, scores, Boolean(options.test));
  await postCiphertext(remoteConfig, ciphertext);
  return { sent: true };
}

async function runEndToEndSelfTest() {
  const remoteConfig = loadRemoteConfig();
  if (!remoteConfig) throw new Error('尚未配置手机提醒');
  const course = `虚构加密测试-${crypto.randomBytes(4).toString('hex')}`;
  const endpoint = new URL(
    remoteConfig.endpoint.replace(/\/$/, '') + '/' + remoteConfig.topic
      + '/json?since=' + Math.floor(Date.now() / 1000)
  );

  await new Promise((resolve, reject) => {
    let settled = false;
    let buffered = '';
    const finish = error => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      request.destroy();
      if (error) reject(error); else resolve();
    };
    const request = https.get(endpoint, {
      timeout: 20000,
      headers: { Accept: 'application/x-ndjson', 'User-Agent': 'MUC-GradeHelper-SelfTest/1.0' }
    }, response => {
      if (response.statusCode < 200 || response.statusCode >= 300) {
        finish(new Error(`subscribe HTTP ${response.statusCode}`));
        return;
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
            if (event.event !== 'message') continue;
            const decoded = decryptMessageForSelfTest(remoteConfig, event.message || '');
            if (decoded.type !== 'test' || decoded.scores?.[0]?.course !== course) continue;
            if (line.includes(course)) return finish(new Error('relay received plaintext'));
            return finish();
          } catch (_) {}
        }
      });
      response.on('error', finish);
      setTimeout(() => {
        sendRemoteScores([{ course, score: '88' }], { test: true }).catch(finish);
      }, 800);
    });
    const timeout = setTimeout(() => finish(new Error('self-test timeout')), 25000);
    request.on('error', finish);
  });
}

function createPairingCode(remoteConfig) {
  return `mucgrade-v1:${base64UrlEncode(JSON.stringify({
    endpoint: remoteConfig.endpoint,
    topic: remoteConfig.topic,
    key: remoteConfig.key
  }))}`;
}

if (require.main === module && process.argv.includes('--self-test')) {
  runEndToEndSelfTest()
    .then(() => console.log('实时订阅、密文传输与解密闭环测试通过。'))
    .catch(error => {
      console.error(`闭环测试失败：${error.message}`);
      process.exitCode = 1;
    });
} else if (require.main === module && process.argv.includes('--test')) {
  const samples = [
    '示例课程甲', '示例课程乙', '示例课程丙'
  ];
  const score = String(70 + Math.floor(Math.random() * 30));
  sendRemoteScores([{ course: samples[Math.floor(Math.random() * samples.length)], score }], { test: true })
    .then(result => {
      if (!result.sent) throw new Error('尚未配置手机提醒，请先运行“配置手机提醒.cmd”。');
      console.log('随机虚构测试消息已加密发送。');
    })
    .catch(error => {
      console.error(`发送失败：${error.message}`);
      process.exitCode = 1;
    });
}

module.exports = { loadRemoteConfig, sendRemoteScores, createPairingCode };
